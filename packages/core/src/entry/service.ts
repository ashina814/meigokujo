import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { SETTING_DEFAULTS, Settings } from "../settings/service.js";
import { EventLog } from "../events/service.js";

export type BookingStatus = "booked" | "attended" | "ghosted" | "dropped";
export type InviterSource = "user" | "disboard" | "lumina" | "none";
/** 招待経路が誰の手で分かったか: auto=招待リンクの自動検出 / staff=門番の補足 */
export type InviterOrigin = "auto" | "staff";

/**
 * 招待経路の「検出・補足」（未確定）。確定は invites 行 + souls.inviter_user_id。
 * legacy=true は PR #34 以前に entry_bookings へ入った検出結果を読んだもの。
 */
export interface InviterHint {
  inviterUserId: string | null;
  source: InviterSource;
  origin: InviterOrigin | null;
  detectedAt: number | null;
  legacy: boolean;
}

/** 確定済みの招待実績（invites 行） */
export interface ConfirmedInvite {
  inviterId: string;
  creditedAt: number;
}

export interface BookingRow {
  user_id: string;
  slot: string; // 'YYYY-MM-DD HH' (JST) または 'flex'（時間外・個別希望）
  status: BookingStatus;
  inviter_user_id: string | null;
  inviter_source: InviterSource;
  no_show_count: number;
  created_at: number;
  updated_at: number;
}

export interface SoulRow {
  user_id: string;
  status: "waiting" | "ghost" | "majin" | "kenma" | "mazoku" | "meirei" | "departed";
  joined_at: number | null;
  ghost_at: number | null;
  eval_deadline_at: number | null;
  eval_extension_days: number;
  eval_started_at: number | null;
  eval_policy_version: string | null;
  eval_promotion_required: number | null;
  eval_demotion_threshold: number | null;
  /** 旧モデルの名残。新しい評価サイクルでは書かない（列は既存行のために残す） */
  eval_invite_mark_per_person: number | null;
  eval_invite_mark_cap: number | null;
  /** そのサイクルで数える招待の起点。出戻り亡霊はここに過去分を焼いて持ち越さない */
  eval_invite_baseline: number | null;
  /** そのサイクルで適用する招待アリの閾値人数 */
  eval_invite_threshold: number | null;
  /** 出戻り関連。退出の記録と、退出時点の階級の退避先 */
  left_at: number | null;
  returned_at: number | null;
  rank_at_leave: SoulRow["status"] | null;
  ever_meirei: number;
  inviter_user_id: string | null;
  inviter_source: string | null;
  inviter_hint_user_id: string | null;
  inviter_hint_source: string | null;
  inviter_hint_origin: string | null;
  inviter_hint_at: number | null;
  updated_at: number;
}

export interface GhostifyResult {
  userId: string;
  granted: number; // 初期発行額（既発行なら 0）
  evalDeadlineAt: number;
  inviterExtendedDays: number; // 招待者の評価期限を何日延長したか
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** 入城を済ませている階級（departed は入城前の離脱と区別が付かないので含めない） */
const ENTERED_STATUSES: ReadonlySet<SoulRow["status"]> = new Set<SoulRow["status"]>([
  "ghost",
  "majin",
  "kenma",
  "mazoku",
  "meirei",
]);

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 入城導線（ボット設計.md 説明会予約制）。
 * 予約 → 出席 → 一括亡霊化（ロール変更はbot側、記帳・期限・招待実績はここ）。
 */
export class Entry {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly settings: Settings,
    private readonly events: EventLog,
  ) {}

  /**
   * サーバー参加の記録（魂台帳に waiting で登録）。
   * join の事件録は **INSERT が成立した時だけ** 残す。既存メンバーへの招待登録などで
   * 何度も呼ばれる経路があり、そこで join を重ねると参加日時の記録が壊れるため。
   * 戻り値は「新しく魂を作ったか」。
   */
  recordJoin(userId: string): boolean {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO souls (user_id, status, joined_at, updated_at) VALUES (?, 'waiting', ?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
      )
      .run(userId, ts, ts);
    if (info.changes === 0) return false;
    this.events.log("join", { target: userId });
    return true;
  }

  getSoul(userId: string): SoulRow | undefined {
    return this.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(userId) as SoulRow | undefined;
  }

  /** 指定ステータスの魂を列挙（評価スレッド日次更新等の一括処理用） */
  listSouls(status: SoulRow["status"]): SoulRow[] {
    return this.db.prepare("SELECT * FROM souls WHERE status = ? ORDER BY ghost_at").all(status) as SoulRow[];
  }

  /**
   * 魂を「案内待ち」にリセット（亡霊ロールが剥奪された時など）。
   * ghost_at・eval_deadline_at・eval_extension_days を消し、招待延長フラグも掃除する。
   * 台帳の初期発行は残るので、次回 ghostify では二重発行されない。
   */
  resetToWaiting(userId: string, actor: string): void {
    const ts = now();
    this.db
      .prepare(
        `UPDATE souls
         SET status='waiting',
             ghost_at=NULL,
             eval_deadline_at=NULL,
             eval_extension_days=0,
             eval_started_at=NULL,
             eval_policy_version=NULL,
             eval_promotion_required=NULL,
             eval_demotion_threshold=NULL,
             eval_invite_mark_per_person=NULL,
             eval_invite_mark_cap=NULL,
             updated_at=?
         WHERE user_id=?`,
      )
      .run(ts, userId);
    // 招待延長の後追い適用フラグを掃除（次に亡霊化した時にまた延長を受け付けられるように）
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(`invite_ext_applied:${userId}`);
    this.events.log("ghost_reset", { actor, target: userId });
  }

  getBooking(userId: string): BookingRow | undefined {
    return this.db.prepare("SELECT * FROM entry_bookings WHERE user_id = ?").get(userId) as
      | BookingRow
      | undefined;
  }

  // ---- 招待経路: 検出・補足（未確定）----

  /**
   * 招待経路の検出・補足を保存する。**招待実績は確定しない**（invites 行を作らない）。
   * 確定は亡霊化した時点（ghostify）か、亡霊化済み相手への後追い登録（recordInviterByStaff）。
   *
   * 予約行は作らない。waiting の人も魂は必ずあるので、置き場所は souls 側の hint 列。
   * 既に確定済み（invites 行あり）の相手は上書きしない — 付け替えは取り消し設計とセットの
   * 別操作にする（設計案 12節）。
   */
  recordInviterHint(
    inviteeId: string,
    inviter: { userId?: string; source: InviterSource },
    origin: InviterOrigin,
    actor: string,
  ): { saved: boolean; reason?: "self" | "already" } {
    if (inviter.userId && inviter.userId === inviteeId) return { saved: false, reason: "self" };
    if (this.getConfirmedInvite(inviteeId)) return { saved: false, reason: "already" };

    const ts = now();
    this.recordJoin(inviteeId); // 魂が無い相手（移行前からの在籍者など）でも受け付ける
    this.db
      .prepare(
        `UPDATE souls
         SET inviter_hint_user_id = ?, inviter_hint_source = ?, inviter_hint_origin = ?,
             inviter_hint_at = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(inviter.userId ?? null, inviter.source, origin, ts, ts, inviteeId);
    this.events.log("inviter_hint", {
      actor,
      target: inviteeId,
      payload: { inviter: inviter.userId ?? null, source: inviter.source, origin },
    });
    return { saved: true };
  }

  /**
   * 招待経路の検出・補足を読む。souls の hint 列を優先し、無ければ entry_bookings を見る
   * （PR #34 以前に予約行へ入った検出結果を捨てないための、読み取り専用フォールバック）。
   */
  getInviterHint(userId: string): InviterHint | null {
    const soul = this.getSoul(userId);
    if (soul?.inviter_hint_source) {
      return {
        inviterUserId: soul.inviter_hint_user_id,
        source: soul.inviter_hint_source as InviterSource,
        origin: (soul.inviter_hint_origin as InviterOrigin | null) ?? null,
        detectedAt: soul.inviter_hint_at,
        legacy: false,
      };
    }
    const booking = this.getBooking(userId);
    if (!booking) return null;
    // 旧データ: inviter_source は NOT NULL DEFAULT 'none' なので、招待者も経路も無い行は
    // 「未検出」として扱う（'none' を明示登録した行と区別が付かないため、安全側に倒す）
    if (!booking.inviter_user_id && booking.inviter_source === "none") return null;
    return {
      inviterUserId: booking.inviter_user_id,
      source: (booking.inviter_source as InviterSource) ?? "none",
      origin: null,
      detectedAt: booking.created_at,
      legacy: true,
    };
  }

  /**
   * 門番用の待ち人サマリ。
   *
   * 招待経路の未検出は**警告であって合格の条件ではない**（設計案 確定事項）。ここでは
   * 件数だけを出し、表示側で「止まらない」ことを明示する。旧データ（entry_bookings に
   * 検出結果が入っている行）も検出済みとして数える。
   */
  waitingSummary(options: { staleDays?: number; recentHours?: number; now?: number } = {}): {
    waiting: number;
    stale: number;
    recentJoins: number;
    missingInviterHint: number;
  } {
    const ts = options.now ?? now();
    const staleBefore = ts - (options.staleDays ?? 7) * DAY;
    const recentAfter = ts - (options.recentHours ?? 24) * 3_600;
    const count = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...(params as [])) as { c: number }).c;

    return {
      waiting: count("SELECT COUNT(*) AS c FROM souls WHERE status = 'waiting'"),
      stale: count(
        "SELECT COUNT(*) AS c FROM souls WHERE status = 'waiting' AND COALESCE(joined_at, updated_at) <= ?",
        staleBefore,
      ),
      // 参加の判定に updated_at を混ぜない（既存メンバーの情報更新まで新規参加として数えてしまう）
      recentJoins: count("SELECT COUNT(*) AS c FROM souls WHERE joined_at IS NOT NULL AND joined_at >= ?", recentAfter),
      missingInviterHint: count(
        `SELECT COUNT(*) AS c FROM souls s
         WHERE s.status = 'waiting'
           AND s.inviter_hint_source IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM entry_bookings b
             WHERE b.user_id = s.user_id
               AND (b.inviter_user_id IS NOT NULL OR b.inviter_source <> 'none')
           )`,
      ),
    };
  }

  /** 案内の配送結果（entry_guide_sent）の内訳。DM不達を門番用ボードに出すために使う */
  guideDeliverySummary(sinceDays = 7, nowSec = now()): { dm: number; channel: number; none: number } {
    const rows = this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.via') AS via, COUNT(*) AS c
         FROM events WHERE type = 'entry_guide_sent' AND created_at >= ?
         GROUP BY via`,
      )
      .all(nowSec - sinceDays * DAY) as Array<{ via: string | null; c: number }>;
    const pick = (via: string) => rows.find((r) => r.via === via)?.c ?? 0;
    return { dm: pick("dm"), channel: pick("channel"), none: pick("none") };
  }

  /** 確定済みの招待実績（invites 行）。無ければ null */
  getConfirmedInvite(inviteeId: string): ConfirmedInvite | null {
    const row = this.db
      .prepare("SELECT inviter_id, credited_at FROM invites WHERE invitee_id = ?")
      .get(inviteeId) as { inviter_id: string; credited_at: number } | undefined;
    return row ? { inviterId: row.inviter_id, creditedAt: row.credited_at } : null;
  }

  /**
   * @deprecated 予約制の名残。新しい導線は予約行を作らない（設計案 11節(3)）。
   * 過去データの互換のために残してある。招待経路の保存には recordInviterHint を使う。
   */
  book(userId: string, slot: string, inviter: { userId?: string; source: InviterSource }): BookingRow {
    const existing = this.getBooking(userId);
    if (existing?.status === "ghosted") return existing;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO entry_bookings (user_id, slot, status, inviter_user_id, inviter_source, no_show_count, created_at, updated_at)
         VALUES (?, ?, 'booked', ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           slot = excluded.slot, status = 'booked',
           inviter_user_id = excluded.inviter_user_id, inviter_source = excluded.inviter_source,
           updated_at = excluded.updated_at`,
      )
      .run(userId, slot, inviter.userId ?? null, inviter.source, existing?.no_show_count ?? 0, ts, ts);
    this.events.log("entry_booked", { target: userId, payload: { slot, inviter } });
    return this.getBooking(userId)!;
  }

  /** VC入室から出席を記録（booked → attended） */
  markAttended(userId: string): boolean {
    const changed = this.db
      .prepare("UPDATE entry_bookings SET status = 'attended', updated_at = ? WHERE user_id = ? AND status = 'booked'")
      .run(now(), userId);
    return changed.changes > 0;
  }

  /**
   * @deprecated 予約制の名残。現在の判定は VC 在室者を見る（presentWaiters）ので呼ばれていない。
   * 削除は統計項目を決めた後の別PRで（設計案 11節(3)）。
   */
  judgeSlot(slot: string): { attended: BookingRow[]; absent: BookingRow[] } {
    const rows = this.db
      .prepare("SELECT * FROM entry_bookings WHERE slot = ? AND status IN ('booked','attended')")
      .all(slot) as BookingRow[];
    return {
      attended: rows.filter((r) => r.status === "attended"),
      absent: rows.filter((r) => r.status === "booked"),
    };
  }

  /** @deprecated 予約制の名残。呼び出し元なし（設計案 11節(3)） */
  listBySlot(slot: string): BookingRow[] {
    return this.db
      .prepare("SELECT * FROM entry_bookings WHERE slot = ? AND status IN ('booked','attended') ORDER BY created_at")
      .all(slot) as BookingRow[];
  }

  /** 計器盤用のサマリー: 予約待ち人数・最古の予約日時・入城案内待ち（未申請含む）人数 */
  queueSummary(): { booked: number; oldestBookedAt: number | null; waiting: number } {
    const booked = (
      this.db.prepare("SELECT COUNT(*) AS c FROM entry_bookings WHERE status = 'booked'").get() as { c: number }
    ).c;
    const oldest = (
      this.db.prepare("SELECT MIN(created_at) AS t FROM entry_bookings WHERE status = 'booked'").get() as {
        t: number | null;
      }
    ).t;
    const waiting = (
      this.db.prepare("SELECT COUNT(*) AS c FROM souls WHERE status = 'waiting'").get() as { c: number }
    ).c;
    return { booked, oldestBookedAt: oldest, waiting };
  }

  /**
   * 亡霊化の一括処理（判定ボタンの本体）:
   * 魂台帳更新・評価期限起算・初期発行・招待実績の記帳と招待者の期限延長・事件録。
   * 冪等: 既に ghost なら何もしない。初期発行は台帳の冪等キーが守る。
   */
  ghostify(
    userId: string,
    actor: string,
    opts: { inviteeGender?: "male" | "female" | null } = {},
  ): GhostifyResult {
    const ts = now();
    const baseDays = this.settings.getNumber("eval_base_period_days");
    const soul = this.getSoul(userId);

    if (soul?.status === "ghost") {
      return {
        userId,
        granted: 0,
        evalDeadlineAt: soul.eval_deadline_at ?? ts,
        inviterExtendedDays: 0,
      };
    }

    const deadline = ts + baseDays * DAY;
    const promotionRequired = positiveInt(this.settings.getNumber("promotion_marks_required"), SETTING_DEFAULTS.promotion_marks_required);
    const demotionThreshold = positiveInt(this.settings.getNumber("demotion_marks_threshold"), SETTING_DEFAULTS.demotion_marks_threshold);
    const inviteThreshold = positiveInt(this.settings.getNumber("invite_marks_threshold"), SETTING_DEFAULTS.invite_marks_threshold);
    // 通常の入城は従来どおり過去の招待も数える（起点0）。
    // 過去分を切るのは**出戻り**のルールで、そちらは Returns 側で起点を焼く
    const inviteBaseline = 0;
    const policyVersion =
      this.settings.getString("eval_policy_version") ??
      `manual:${promotionRequired}:${demotionThreshold}:${inviteThreshold}:${ts}`;
    this.db
      .prepare(
        `INSERT INTO souls (
           user_id, status, joined_at, ghost_at, eval_deadline_at, eval_started_at,
           eval_policy_version, eval_promotion_required, eval_demotion_threshold,
           eval_invite_baseline, eval_invite_threshold, updated_at
         )
         VALUES (?, 'ghost', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           status = 'ghost', ghost_at = excluded.ghost_at,
           eval_deadline_at = excluded.eval_deadline_at,
           eval_started_at = excluded.eval_started_at,
           eval_policy_version = excluded.eval_policy_version,
           eval_promotion_required = excluded.eval_promotion_required,
           eval_demotion_threshold = excluded.eval_demotion_threshold,
           eval_invite_baseline = excluded.eval_invite_baseline,
           eval_invite_threshold = excluded.eval_invite_threshold,
           updated_at = excluded.updated_at`,
      )
      .run(userId, ts, ts, deadline, ts, policyVersion, promotionRequired, demotionThreshold, inviteBaseline, inviteThreshold, ts);

    // 初期発行（冪等キーで二重発行不可）
    const grant = this.settings.getNumber("initial_grant");
    const accountId = `user:${userId}`;
    this.ledger.ensureAccount(accountId, "user");
    const grantResult = this.ledger.transfer({
      from: TREASURY,
      to: accountId,
      amount: grant,
      type: "initial",
      actor,
      reason: "入城時の初期発行",
      idempotencyKey: `initial:user:${userId}`,
    });

    // 招待実績はここで初めて確定する（検出・補足だけでは確定しない）。
    // 実際に亡霊化した＝説明会に来た人の招待だけを実績にする、という線引き。
    const hint = this.getInviterHint(userId);
    let extended = 0;
    if (hint?.inviterUserId) {
      extended = this.creditInvite(
        userId,
        hint.inviterUserId,
        hint.source === "user" ? "user" : hint.source,
        opts.inviteeGender ?? null,
      ).extendedDays;
    }

    const booking = this.getBooking(userId);
    if (booking) {
      this.db
        .prepare("UPDATE entry_bookings SET status = 'ghosted', updated_at = ? WHERE user_id = ?")
        .run(ts, userId);
    }

    this.events.log("ghosted", {
      actor,
      target: userId,
      payload: {
        deadline,
        granted: grantResult.duplicate ? 0 : grant,
        evalPolicy: { version: policyVersion, promotionRequired, demotionThreshold, inviteThreshold, inviteBaseline, startedAt: ts },
      },
    });
    return {
      userId,
      granted: grantResult.duplicate ? 0 : grant,
      evalDeadlineAt: deadline,
      inviterExtendedDays: extended,
    };
  }

  /**
   * 入城済みか（＝招待実績をその場で確定してよいか）。
   *
   * 本来は ghost_at の有無で判断できるはずだが、2026-07-06 の移行でバックフィルされた
   * 行は階級だけ入って ghost_at が NULL のまま残っている（本番: 迷霊129 / 魔人2）。
   * ghost_at だけで見るとこの人たちが「入城前」と誤判定され、後追い登録が保存だけで
   * 止まって確定の機会を失うため、階級も補助条件にする。
   *
   * departed は入城前の離脱と区別が付かないので階級側には含めない。
   * 亡霊化を経ていれば ghost_at が残っているので、そちら側で拾える。
   */
  private hasEnteredCastle(soul: SoulRow | undefined): boolean {
    if (!soul) return false;
    if (soul.ghost_at !== null && soul.ghost_at !== undefined) return true;
    return ENTERED_STATUSES.has(soul.status);
  }

  /**
   * 招待実績の記帳（魂台帳・invites・招待者の期限延長・事件録）。
   *
   * 亡霊化のタイミングと、門番による後追い登録（/審判 招待）の両方から呼ばれる。
   * invites.invitee_id が UNIQUE なので「1人につき一度きり」。既に記帳済みなら
   * 何もせず credited=false を返すので、どちらの順序で来ても二重に延長されない。
   */
  creditInvite(
    inviteeId: string,
    inviterId: string,
    source: InviterSource,
    inviteeGender: "male" | "female" | null,
  ): { credited: boolean; extendedDays: number; reason?: "self" | "already" } {
    if (inviteeId === inviterId) return { credited: false, extendedDays: 0, reason: "self" };

    // 一連の書き込みを1トランザクションに包む。途中で例外・DBエラー・プロセス停止が
    // 起きても、invites 行だけ残って期限延長が飛ぶ（次回は already になり、二度と
    // 延長されない）という部分反映を防ぐため。
    //
    // 「一度きり」の判定は事前 SELECT ではなく UNIQUE 制約 + INSERT の結果に持たせる。
    // 先に INSERT し、changes が 0 なら既に記帳済みとして何もしない。
    const credit = this.db.transaction((): { credited: boolean; extendedDays: number } => {
      const ts = now();
      const inserted = this.db
        .prepare(
          "INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?) ON CONFLICT(invitee_id) DO NOTHING",
        )
        .run(inviterId, inviteeId, ts);
      if (inserted.changes === 0) return { credited: false, extendedDays: 0 };

      this.db
        .prepare("UPDATE souls SET inviter_user_id = ?, inviter_source = ?, updated_at = ? WHERE user_id = ?")
        .run(inviterId, source, ts, inviteeId);
      const extendedDays = this.extendInviterDeadline(inviterId, inviteeGender);
      this.events.log("invite_credited", {
        actor: inviterId,
        target: inviteeId,
        payload: { extendedDays, source },
      });
      return { credited: true, extendedDays };
    })();

    return credit.credited ? credit : { credited: false, extendedDays: 0, reason: "already" };
  }

  /**
   * 門番による招待経路の補足登録（`/審判 招待`）。
   *
   * 相手の状態で挙動が変わる:
   *  - まだ亡霊化していない → **検出・補足を保存するだけ**。実績・期限延長・称号は動かない。
   *    確定は本人が説明会に来て亡霊化した時（ghostify がこの hint を読んで確定する）
   *  - 既に亡霊化済み（ghost_at あり）→ 後追い登録として **その場で確定**。予約行は作らない
   *  - 既に確定済み（invites 行あり）→ **何も書き換えず** 既存の招待者を返す
   *
   * 確定の判定に status ではなく ghost_at を使うのは、亡霊化した後に退城・降格した人でも
   * 「一度は説明会に来た」事実で正しく判断するため。
   */
  recordInviterByStaff(
    inviteeId: string,
    inviter: { userId?: string; source: InviterSource },
    actor: string,
    inviteeGender: "male" | "female" | null = null,
  ): {
    saved: boolean;
    credited: boolean;
    extendedDays: number;
    pending: boolean;
    reason?: "self" | "already";
    existingInviterId?: string;
  } {
    if (inviter.userId && inviter.userId === inviteeId) {
      return { saved: false, credited: false, extendedDays: 0, pending: false, reason: "self" };
    }
    const confirmed = this.getConfirmedInvite(inviteeId);
    if (confirmed) {
      // 確定済みは触らない。付け替えは取り消し設計とセットの別操作にする（設計案 12節）
      return {
        saved: false,
        credited: false,
        extendedDays: 0,
        pending: false,
        reason: "already",
        existingInviterId: confirmed.inviterId,
      };
    }

    const hintResult = this.recordInviterHint(inviteeId, inviter, "staff", actor);
    if (!hintResult.saved) {
      return { saved: false, credited: false, extendedDays: 0, pending: false, reason: hintResult.reason };
    }

    const soul = this.getSoul(inviteeId);
    if (!this.hasEnteredCastle(soul)) {
      // まだ入城していない。亡霊化の時に確定させる
      return { saved: true, credited: false, extendedDays: 0, pending: true };
    }
    if (!inviter.userId) {
      // ディスボード等は記帳対象の招待者がいない（経路の記録だけ）
      return { saved: true, credited: false, extendedDays: 0, pending: false };
    }
    const credit = this.creditInvite(inviteeId, inviter.userId, inviter.source, inviteeGender);
    return {
      saved: true,
      credited: credit.credited,
      extendedDays: credit.extendedDays,
      pending: false,
      reason: credit.reason,
    };
  }

  /**
   * 性別ロールが後付けされた被招待者について、招待者の期限延長を後追い適用する。
   * 既に適用済みなら 0 を返す（冪等・二重延長なし）。
   */
  applyInviteeGenderExtension(inviteeUserId: string, gender: "male" | "female"): number {
    const soul = this.getSoul(inviteeUserId);
    if (!soul || !soul.inviter_user_id) return 0;
    const flagKey = `invite_ext_applied:${inviteeUserId}`;
    if (this.settings.getString(flagKey)) return 0;
    const extended = this.extendInviterDeadline(soul.inviter_user_id, gender);
    if (extended > 0) {
      this.settings.set(flagKey, "1", "system:invite-ext");
      this.events.log("invite_ext_deferred", {
        actor: soul.inviter_user_id,
        target: inviteeUserId,
        payload: { gender, extendedDays: extended },
      });
    }
    return extended;
  }

  /** 招待者の評価期限延長（男+1日/女+2日、累計上限あり。評価期間中の招待者のみ） */
  private extendInviterDeadline(inviterId: string, inviteeGender: "male" | "female" | null): number {
    if (!inviteeGender) return 0;
    const soul = this.getSoul(inviterId);
    const ts = now();
    if (!soul || soul.status !== "ghost" || !soul.eval_deadline_at || soul.eval_deadline_at < ts) return 0;

    const perDays = this.settings.getNumber(
      inviteeGender === "male" ? "invite_extend_days_male" : "invite_extend_days_female",
    );
    const cap = this.settings.getNumber("invite_extend_cap_days");
    const add = Math.max(0, Math.min(perDays, cap - soul.eval_extension_days));
    if (add === 0) return 0;

    this.db
      .prepare(
        `UPDATE souls SET eval_deadline_at = eval_deadline_at + ?, eval_extension_days = eval_extension_days + ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(add * DAY, add, ts, inviterId);
    return add;
  }

  /**
   * 見送り: 出席していたが今回は通さない判断。予約を dropped にしてキューから外す。
   * 亡霊化はしない（初期発行も無し）。再挑戦は本人が再予約すれば可能。
   */
  skipBooking(userId: string, actor: string): boolean {
    const changed = this.db
      .prepare("UPDATE entry_bookings SET status = 'dropped', updated_at = ? WHERE user_id = ? AND status IN ('booked','attended')")
      .run(now(), userId);
    if (changed.changes > 0) this.events.log("entry_skipped", { actor, target: userId });
    return changed.changes > 0;
  }

  /**
   * 移行時の階級バックフィル。現在のロールから判定した階級を魂台帳へ写す。
   * 冪等: 既存の ghost_at / 評価期限は維持する（再実行しても期限リセットしない）。
   * 亡霊は期限が無ければ移行日から periodDays を付与、魔人/魔族は期限なし(NULL)。
   */
  backfillStatuses(
    entries: Array<{ userId: string; status: SoulRow["status"] }>,
    periodDays: number,
  ): { applied: Record<string, number>; ghostDeadlinesSet: number } {
    const ts = now();
    const applied: Record<string, number> = {};
    let ghostDeadlinesSet = 0;
    const promotionRequired = positiveInt(this.settings.getNumber("promotion_marks_required"), SETTING_DEFAULTS.promotion_marks_required);
    const demotionThreshold = positiveInt(this.settings.getNumber("demotion_marks_threshold"), SETTING_DEFAULTS.demotion_marks_threshold);
    const inviteMarkPerPerson = nonNegativeNumber(this.settings.getNumber("invite_mark_per_person"), SETTING_DEFAULTS.invite_mark_per_person);
    const inviteMarkCap = nonNegativeNumber(this.settings.getNumber("invite_mark_cap"), SETTING_DEFAULTS.invite_mark_cap);
    const policyVersion =
      this.settings.getString("eval_policy_version") ??
      `backfill:${promotionRequired}:${demotionThreshold}:${inviteMarkPerPerson}:${inviteMarkCap}:${ts}`;
    const upsert = this.db.prepare(
      `INSERT INTO souls (
         user_id, status, joined_at, ghost_at, eval_deadline_at,
         eval_started_at, eval_policy_version, eval_promotion_required, eval_demotion_threshold,
         eval_invite_mark_per_person, eval_invite_mark_cap, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status, ghost_at = excluded.ghost_at,
         eval_deadline_at = excluded.eval_deadline_at,
         eval_started_at = COALESCE(souls.eval_started_at, excluded.eval_started_at),
         eval_policy_version = COALESCE(souls.eval_policy_version, excluded.eval_policy_version),
         eval_promotion_required = COALESCE(souls.eval_promotion_required, excluded.eval_promotion_required),
         eval_demotion_threshold = COALESCE(souls.eval_demotion_threshold, excluded.eval_demotion_threshold),
         eval_invite_mark_per_person = COALESCE(souls.eval_invite_mark_per_person, excluded.eval_invite_mark_per_person),
         eval_invite_mark_cap = COALESCE(souls.eval_invite_mark_cap, excluded.eval_invite_mark_cap),
         updated_at = excluded.updated_at`,
    );
    const run = this.db.transaction(() => {
      for (const e of entries) {
        applied[e.status] = (applied[e.status] ?? 0) + 1;
        const existing = this.getSoul(e.userId);
        let ghostAt = existing?.ghost_at ?? null;
        let deadline = existing?.eval_deadline_at ?? null;
        if (e.status === "ghost") {
          ghostAt = ghostAt ?? ts;
          if (deadline === null) {
            deadline = ts + periodDays * DAY;
            ghostDeadlinesSet++;
          }
        } else if (e.status === "majin" || e.status === "kenma" || e.status === "mazoku") {
          ghostAt = ghostAt ?? ts;
          deadline = null;
        }
        upsert.run(
          e.userId,
          e.status,
          existing?.joined_at ?? ts,
          ghostAt,
          deadline,
          e.status === "ghost" ? (ghostAt ?? ts) : null,
          e.status === "ghost" ? policyVersion : null,
          e.status === "ghost" ? promotionRequired : null,
          e.status === "ghost" ? demotionThreshold : null,
          e.status === "ghost" ? inviteMarkPerPerson : null,
          e.status === "ghost" ? inviteMarkCap : null,
          ts,
        );
      }
    });
    run();
    this.events.log("backfill_status", { payload: { count: entries.length, applied } });
    return { applied, ghostDeadlinesSet };
  }

  /**
   * @deprecated 予約制の名残。予約枠が無くなったので欠席という状態が発生しない。
   * 呼び出し元なし（設計案 11節(3)）。
   */
  recordNoShow(userId: string): { count: number; dropped: boolean } {
    const ts = now();
    const booking = this.getBooking(userId);
    if (!booking) return { count: 0, dropped: false };
    const count = booking.no_show_count + 1;
    const dropped = count >= 3;
    this.db
      .prepare("UPDATE entry_bookings SET no_show_count = ?, status = ?, updated_at = ? WHERE user_id = ?")
      .run(count, dropped ? "dropped" : "booked", ts, userId);
    this.events.log("entry_no_show", { target: userId, payload: { count, dropped } });
    return { count, dropped };
  }
}
