import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { Settings } from "../settings/service.js";

/**
 * 説明会の開催予定（入城導線 Step 2/3）。
 *
 * 予定は「通常枠（settings）」と「日付ごとの例外（entry_session_overrides）」の2層で持ち、
 * **実際に開催されるか**は必ず `occurrences()` / `isOccurring()` の合成結果で答える。
 * 参加時DM・状態確認・5分前通知・`/説明会 予定`・門番用ボードが同じ答えを見るための一元窓口。
 */

// ── 通常枠（settings） ──
// 「月・木を除く 21/22/23時」は運用の取り決めであってコードの都合ではないので設定に置く。
// 既定値は現行運用そのままなので、設定していないサーバーの挙動は変わらない。

export const DEFAULT_SESSION_HOURS = [21, 22, 23];
export const DEFAULT_SESSION_SKIP_DOW = [1, 4]; // 0=日, 1=月, 4=木
export const SESSION_HOURS_KEY = "entry:session_hours";
export const SESSION_SKIP_DOW_KEY = "entry:session_skip_dow";
/**
 * 予定を探す既定の範囲（日）。案内・通知・ボード・コマンドで揃える。
 * これより先の臨時枠は nextOccurrence が別途拾う。
 */
export const SESSION_SEARCH_DAYS = 60;

export interface SessionSchedule {
  /** 開催時刻（JST・時のみ）。昇順・重複なし */
  hours: number[];
  /** 休みの曜日（0=日 … 6=土）。昇順・重複なし。空なら毎日開催 */
  skipDow: number[];
}

export type SessionOverrideKind = "skip" | "add";

export interface SessionOverrideRow {
  id: number;
  /** JSTの日付 'YYYY-MM-DD' */
  date: string;
  /** 時（JST）。skip で null ならその日の通常枠を全休 */
  hour: number | null;
  kind: SessionOverrideKind;
  reason: string | null;
  actor_id: string;
  created_at: number;
  canceled_at: number | null;
  canceled_by: string | null;
}

export interface SessionOccurrence {
  /** JSTの日付 'YYYY-MM-DD' */
  date: string;
  /** 開始時刻（JST・時のみ） */
  hour: number;
  /** 開始時刻の実時間 */
  at: Date;
  /** 臨時追加された枠か（表示で通常枠と区別するため） */
  extra: boolean;
}

export type SessionCalendarErrorCode =
  | "invalid_date"
  | "invalid_hour"
  | "past"
  | "not_regular_slot"
  | "no_regular_slots"
  | "already_open"
  | "duplicate"
  | "not_found";

export class SessionCalendarError extends Error {
  constructor(
    readonly code: SessionCalendarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionCalendarError";
  }
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const JST_OFFSET_MS = 9 * 3_600_000; // JSTは常にUTC+9（夏時間なし）
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** JSTでの日付文字列 'YYYY-MM-DD' */
export function jstDateStr(date: Date = new Date()): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JSTでの曜日（0=日 … 6=土） */
export function jstDayOfWeekFor(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** 'YYYY-MM-DD' + 時（JST）→ 実時間 */
export function sessionStartAt(dateStr: string, hour: number): Date {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + hour * 3_600_000 - JST_OFFSET_MS);
}

/** JSTの日付を n 日進める */
export function addJstDays(dateStr: string, days: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD'（実在する日付か）を検証して返す。'8/5' 等の揺れはアプリ層で正規化する */
export function normalizeDateStr(input: string): string {
  const text = input.trim();
  if (!DATE_PATTERN.test(text)) {
    throw new SessionCalendarError("invalid_date", `日付は YYYY-MM-DD の形式で指定してください（受け取った値: ${input}）`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new SessionCalendarError("invalid_date", `実在しない日付です: ${input}`);
  }
  return text;
}

export function formatJstDate(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  return `${month}/${day}(${DOW_LABELS[jstDayOfWeekFor(dateStr)]})`;
}

// ── 設定値の解析 ──

/** 同じ誤設定で毎分警告を出さないための既出記録 */
const warnedSettingValues = new Set<string>();

function warnOnce(key: string, raw: string, message: string): void {
  const seen = `${key}=${raw}`;
  if (warnedSettingValues.has(seen)) return;
  warnedSettingValues.add(seen);
  console.warn(`[説明会] ${key} の設定値を解釈できませんでした（${raw}）: ${message}`);
}

/** 10進の整数「文字列」だけを通す。`Number()` に任せると "" や "0x10" まで拾ってしまう */
const INTEGER_TEXT = /^[+-]?\d+$/;

/**
 * 設定値のトークンを整数に変換する。**number型の整数**と**空でない10進整数文字列**だけを認め、
 * `true` / `null` / `[]` / `{}` / 小数 / 空文字などは弾く（`Number(true)===1` を通さない）。
 */
function toInteger(token: unknown): number | null {
  if (typeof token === "number") return Number.isInteger(token) ? token : null;
  if (typeof token === "string" && INTEGER_TEXT.test(token.trim())) {
    const n = Number(token.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * 数値リスト設定の読み取り。`[21,22,23]`（JSON）でも `21,22,23`（区切り文字）でも受ける。
 * 未設定・空文字は null（＝既定値を使う）、整数として読めなかったぶんは dropped に数える。
 * `emptyArray` は **JSONの空配列 `[]` を明示的に書いた**ときだけ true（意思表示と誤設定を分けるため）。
 */
function parseNumberList(
  raw: string | undefined,
): { values: number[]; dropped: number; emptyArray: boolean } | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!text) return null;
  let tokens: unknown[];
  let emptyArray = false;
  try {
    const parsed: unknown = JSON.parse(text);
    tokens = Array.isArray(parsed) ? parsed : [parsed];
    emptyArray = Array.isArray(parsed) && parsed.length === 0;
  } catch {
    tokens = text.split(/[,\s、]+/).filter((t) => t !== "");
  }
  const values: number[] = [];
  let dropped = 0;
  for (const token of tokens) {
    const n = toInteger(token);
    if (n === null) dropped++;
    else values.push(n);
  }
  return { values, dropped, emptyArray };
}

function inRangeUnique(values: number[], min: number, max: number): { kept: number[]; dropped: number } {
  const kept: number[] = [];
  let dropped = 0;
  for (const n of values) {
    if (n < min || n > max) dropped++;
    else if (!kept.includes(n)) kept.push(n);
  }
  return { kept: kept.sort((a, b) => a - b), dropped };
}

/**
 * 通常枠を settings から読む。壊れた値は既定値へ落とす（説明会が黙って消えるほうが害が大きい）。
 * 「休みなし」として空を認めるのは `entry:session_skip_dow` に **JSONの `[]` を書いたときだけ**。
 * 区切り文字だけの値（`","` など）は誤設定として扱い、既定値へ落とす。
 */
export function sessionSchedule(settings: Pick<Settings, "getString">): SessionSchedule {
  const rawHours = settings.getString(SESSION_HOURS_KEY);
  const rawSkip = settings.getString(SESSION_SKIP_DOW_KEY);

  let hours = [...DEFAULT_SESSION_HOURS];
  const parsedHours = parseNumberList(rawHours);
  if (parsedHours) {
    const { kept, dropped } = inRangeUnique(parsedHours.values, 0, 23);
    // 開催時刻は空にできない（`[]` を書かれても定例が消えるだけなので既定値へ戻す）
    if (kept.length === 0) warnOnce(SESSION_HOURS_KEY, rawHours!, "0〜23の整数がひとつも無いため既定値を使います");
    else if (dropped + parsedHours.dropped > 0) warnOnce(SESSION_HOURS_KEY, rawHours!, "0〜23の整数以外を無視しました");
    if (kept.length > 0) hours = kept;
  }

  let skipDow = [...DEFAULT_SESSION_SKIP_DOW];
  const parsedSkip = parseNumberList(rawSkip);
  if (parsedSkip) {
    const { kept, dropped } = inRangeUnique(parsedSkip.values, 0, 6);
    const badTokens = dropped + parsedSkip.dropped;
    if (kept.length > 0) {
      if (badTokens > 0) warnOnce(SESSION_SKIP_DOW_KEY, rawSkip!, "0〜6の整数以外を無視しました");
      skipDow = kept;
    } else if (parsedSkip.emptyArray) {
      // `[]` と明示されたときだけ「休みなし」の意思表示として受ける
      skipDow = [];
    } else {
      warnOnce(SESSION_SKIP_DOW_KEY, rawSkip!, "0〜6の整数がひとつも無いため既定値を使います");
    }
  }

  return { hours, skipDow };
}

/** パネル・DMに載せる通常枠の文字列（例:「月・木を除く 21 / 22 / 23 時」） */
export function describeSessionSchedule(schedule: SessionSchedule): string {
  if (schedule.skipDow.length >= 7 || schedule.hours.length === 0) return "現在は定例の説明会がありません";
  const hours = schedule.hours.join(" / ");
  if (schedule.skipDow.length === 0) return `毎日 ${hours} 時`;
  return `${schedule.skipDow.map((d) => DOW_LABELS[d]).join("・")}を除く ${hours} 時`;
}

/**
 * 開催予定の読み書き。
 *
 * 例外は物理削除しない（誰がいつ休止・追加・取消したかを残す）。取り消した行は
 * `canceled_at` が入り、合成から外れる＝通常予定へ自然に復元される。
 */
export class SessionCalendar {
  constructor(
    private readonly db: Database.Database,
    private readonly settings: Settings,
    private readonly events: EventLog,
  ) {}

  /** 通常枠（settings） */
  schedule(): SessionSchedule {
    return sessionSchedule(this.settings);
  }

  /** 有効な例外（取消済みを除く）を日付範囲で取る。範囲は両端を含む */
  listOverrides(fromDate: string, toDate: string): SessionOverrideRow[] {
    return this.db
      .prepare(
        `SELECT * FROM entry_session_overrides
         WHERE canceled_at IS NULL AND date >= ? AND date <= ?
         ORDER BY date, hour IS NOT NULL, hour, id`,
      )
      .all(fromDate, toDate) as SessionOverrideRow[];
  }

  getOverride(id: number): SessionOverrideRow | undefined {
    return this.db.prepare("SELECT * FROM entry_session_overrides WHERE id = ?").get(id) as
      | SessionOverrideRow
      | undefined;
  }

  /** その日の通常枠（休みの曜日なら空） */
  regularHours(dateStr: string, schedule = this.schedule()): number[] {
    if (schedule.skipDow.includes(jstDayOfWeekFor(dateStr))) return [];
    return schedule.hours;
  }

  /**
   * 実際の開催予定。通常枠に例外を合成して返す。
   *
   * - 全休（hour なしの skip）は**通常枠に効く**。臨時追加は独立して開催する
   *   （「全部やめる」と「この枠はやる」を別々に記録できるほうが、後から意図を読める）
   * - `from` より後に始まる枠だけを返す
   */
  occurrences(options: { from?: Date; days?: number; limit?: number } = {}): SessionOccurrence[] {
    const from = options.from ?? new Date();
    const days = options.days ?? SESSION_SEARCH_DAYS;
    const schedule = this.schedule();
    const startDate = jstDateStr(from);
    const endDate = addJstDays(startDate, Math.max(0, days - 1));
    const overrides = this.listOverrides(startDate, endDate);

    const result: SessionOccurrence[] = [];
    for (let offset = 0; offset < days; offset++) {
      const date = addJstDays(startDate, offset);
      const dayOverrides = overrides.filter((o) => o.date === date);
      const fullSkip = dayOverrides.some((o) => o.kind === "skip" && o.hour === null);
      const skipped = new Set(
        dayOverrides.filter((o) => o.kind === "skip" && o.hour !== null).map((o) => o.hour as number),
      );
      const extras = new Set(dayOverrides.filter((o) => o.kind === "add" && o.hour !== null).map((o) => o.hour as number));

      const regular = fullSkip ? [] : this.regularHours(date, schedule).filter((h) => !skipped.has(h));
      const hours = [...new Set([...regular, ...extras])].sort((a, b) => a - b);
      for (const hour of hours) {
        const at = sessionStartAt(date, hour);
        if (at.getTime() <= from.getTime()) continue;
        result.push({ date, hour, at, extra: extras.has(hour) && !regular.includes(hour) });
        if (options.limit && result.length >= options.limit) return result;
      }
    }
    return result;
  }

  /**
   * 次の説明会。案内DM・状態確認・門番用ボード・`/説明会 予定` が同じ答えを見るための入口。
   *
   * まず SESSION_SEARCH_DAYS 日先まで探し、そこに無ければ**それより先の臨時枠**を拾う。
   * 通常枠は毎週繰り返すので範囲内に必ず現れる＝範囲外に取り残されるのは臨時枠だけ。
   * （全曜日休みにして数か月先の臨時枠だけを置いた場合でも「予定なし」と答えない）
   */
  nextOccurrence(from: Date = new Date()): SessionOccurrence | null {
    const within = this.occurrences({ from, days: SESSION_SEARCH_DAYS, limit: 1 })[0];
    if (within) return within;

    const horizonEnd = addJstDays(jstDateStr(from), SESSION_SEARCH_DAYS - 1);
    const rows = this.db
      .prepare(
        `SELECT date, hour FROM entry_session_overrides
         WHERE canceled_at IS NULL AND kind = 'add' AND hour IS NOT NULL AND date > ?
         ORDER BY date, hour`,
      )
      .all(horizonEnd) as Array<{ date: string; hour: number }>;
    const schedule = this.schedule();
    for (const row of rows) {
      const at = sessionStartAt(row.date, row.hour);
      if (at.getTime() <= from.getTime()) continue;
      if (!this.isOccurring(row.date, row.hour, schedule)) continue;
      return { date: row.date, hour: row.hour, at, extra: !this.regularHours(row.date, schedule).includes(row.hour) };
    }
    return null;
  }

  /** その日その時刻に説明会があるか（5分前通知の可否判定に使う） */
  isOccurring(dateStr: string, hour: number, schedule = this.schedule()): boolean {
    const dayOverrides = this.listOverrides(dateStr, dateStr);
    if (dayOverrides.some((o) => o.kind === "add" && o.hour === hour)) return true;
    if (dayOverrides.some((o) => o.kind === "skip" && o.hour === null)) return false;
    if (dayOverrides.some((o) => o.kind === "skip" && o.hour === hour)) return false;
    return this.regularHours(dateStr, schedule).includes(hour);
  }

  /**
   * 通常枠の休止。`hour` を省略するとその日を全休。
   * 「もともと開催がない枠」を休止しようとした操作は、成功にせずエラーで返す
   * （成功と表示すると、休めたつもりで別の枠が開いたままになる）。
   */
  skip(input: { date: string; hour?: number | null; reason?: string | null; actor: string; now?: Date }): SessionOverrideRow {
    const date = normalizeDateStr(input.date);
    const now = input.now ?? new Date();
    const hour = input.hour ?? null;
    const schedule = this.schedule();
    const regular = this.regularHours(date, schedule);

    if (hour === null) {
      if (regular.length === 0) {
        throw new SessionCalendarError("no_regular_slots", `${formatJstDate(date)} はもともと通常の説明会がありません。`);
      }
      const last = sessionStartAt(date, regular[regular.length - 1]!);
      if (last.getTime() <= now.getTime()) {
        throw new SessionCalendarError("past", `${formatJstDate(date)} の説明会はすべて終わっています。`);
      }
    } else {
      this.assertHour(hour);
      if (!regular.includes(hour)) {
        throw new SessionCalendarError(
          "not_regular_slot",
          `${formatJstDate(date)} の ${hour}時 は通常の開催枠ではありません（この日の通常枠: ${regular.length > 0 ? regular.map((h) => `${h}時`).join(" / ") : "なし"}）。`,
        );
      }
      this.assertFuture(date, hour, now);
    }

    return this.insert({ date, hour, kind: "skip", reason: input.reason ?? null, actor: input.actor, now });
  }

  /**
   * 臨時枠の追加。休みの曜日にも足せる。
   * 既に開催予定がある枠は追加できない（同じ時刻の二重案内を防ぐ）。
   */
  add(input: { date: string; hour: number; reason?: string | null; actor: string; now?: Date }): SessionOverrideRow {
    const date = normalizeDateStr(input.date);
    const now = input.now ?? new Date();
    this.assertHour(input.hour);
    this.assertFuture(date, input.hour, now);
    if (this.isOccurring(date, input.hour)) {
      throw new SessionCalendarError(
        "already_open",
        `${formatJstDate(date)} の ${input.hour}時 はすでに開催予定です。`,
      );
    }
    return this.insert({ date, hour: input.hour, kind: "add", reason: input.reason ?? null, actor: input.actor, now });
  }

  /** 例外の取消。休止を取り消せば通常どおり開催し、臨時追加を取り消せば無くなる */
  cancel(id: number, actor: string, now: Date = new Date()): SessionOverrideRow {
    const row = this.getOverride(id);
    if (!row || row.canceled_at !== null) {
      throw new SessionCalendarError("not_found", "その予定変更は見つかりません（すでに取り消された可能性があります）。");
    }
    const ts = Math.floor(now.getTime() / 1000);
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare("UPDATE entry_session_overrides SET canceled_at = ?, canceled_by = ? WHERE id = ? AND canceled_at IS NULL")
        .run(ts, actor, id);
      if (info.changes === 0) {
        throw new SessionCalendarError("not_found", "その予定変更は見つかりません（すでに取り消された可能性があります）。");
      }
      this.events.log("session_override_canceled", {
        actor,
        payload: { id, date: row.date, hour: row.hour, kind: row.kind },
      });
    });
    tx();
    return this.getOverride(id)!;
  }

  private assertHour(hour: number): void {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new SessionCalendarError("invalid_hour", `時刻は 0〜23 の整数で指定してください（受け取った値: ${hour}）`);
    }
  }

  private assertFuture(date: string, hour: number, now: Date): void {
    if (sessionStartAt(date, hour).getTime() <= now.getTime()) {
      throw new SessionCalendarError("past", `${formatJstDate(date)} ${hour}時 はすでに過ぎています。`);
    }
  }

  private insert(input: {
    date: string;
    hour: number | null;
    kind: SessionOverrideKind;
    reason: string | null;
    actor: string;
    now: Date;
  }): SessionOverrideRow {
    const ts = Math.floor(input.now.getTime() / 1000);
    let id!: number;
    const tx = this.db.transaction(() => {
      try {
        const info = this.db
          .prepare(
            `INSERT INTO entry_session_overrides (date, hour, kind, reason, actor_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(input.date, input.hour, input.kind, input.reason, input.actor, ts);
        id = Number(info.lastInsertRowid);
      } catch (e) {
        // 有効な行だけを対象にした UNIQUE インデックスで二重登録を弾く（同時実行でも漏れない）
        if (String((e as Error).message).includes("UNIQUE")) {
          throw new SessionCalendarError(
            "duplicate",
            input.kind === "skip"
              ? `${formatJstDate(input.date)} ${input.hour === null ? "の全休" : `${input.hour}時 の休止`} はすでに登録されています。`
              : `${formatJstDate(input.date)} ${input.hour}時 の臨時追加はすでに登録されています。`,
          );
        }
        throw e;
      }
      this.events.log(input.kind === "skip" ? "session_skipped" : "session_added", {
        actor: input.actor,
        payload: { id, date: input.date, hour: input.hour, reason: input.reason },
      });
    });
    tx();
    return this.getOverride(id)!;
  }
}
