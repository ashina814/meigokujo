import type Database from "better-sqlite3";
import type { VcTracker } from "../vc/service.js";

/**
 * 称号判定のためのスナップショット。
 *
 * 称号は3桁になるため「1ルール = 1クエリ」では線形に重くなる。ここで1人分の集計を
 * 固定本数のクエリでまとめて取り、ルール側はメモリ上のこの構造だけを読む。
 * 称号が9個でも300個でも、DBに当たる回数は変わらない。
 */

const DAY = 86_400;
const JST_OFFSET = 9 * 3600;
const now = () => Math.floor(Date.now() / 1000);

/** JSTでの日付キー（YYYY-MM-DD）。既存の VcTracker.presence と同じ換算に揃える */
function jstDate(unixSec: number): string {
  return new Date((unixSec + JST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** JSTでの時刻（0-23） */
function jstHour(unixSec: number): number {
  return Math.floor(((unixSec + JST_OFFSET) % DAY) / 3600);
}

export interface TxAgg {
  count: number;
  sum: number;
}

export interface VcDerived {
  totalSeconds: number;
  daysSeen: number;
  /** 一度の滞在の最長秒数 */
  longestSessionSeconds: number;
  /** JSTの深夜帯(2:00-4:59)に跨って浮上していた日数 */
  deepNightDays: number;
  /** JSTの朝(5:00-6:59)まで残っていた回数 */
  dawnSessions: number;
  /** 日付をまたいで浮上し続けた回数 */
  crossMidnightSessions: number;
  /** 連続して浮上した最大日数 */
  maxStreakDays: number;
  /** 浮上したことのあるVCの種類数 */
  distinctChannels: number;
  /** スピーカーミュート(deafen)状態で過ごした秒数 */
  deafenedSeconds: number;
  /** 初回浮上時刻（無ければ null） */
  firstSeenAt: number | null;
}

export interface TitleSnapshot {
  userId: string;
  /** events に actor として記録された回数（type別） */
  evActor: Map<string, number>;
  /** events に target として記録された回数（type別） */
  evTarget: Map<string, number>;
  /** transactions に actor として記録された回数と総額（type別） */
  txActor: Map<string, TxAgg>;
  /** 自分の口座が受け取った回数と総額（type別） */
  txIn: Map<string, TxAgg>;
  casino: Record<string, number>;
  soulStatus: string | null;
  ghostAt: number | null;
  vc: VcDerived;
  companions: { uniqueCount: number; totalSeconds: number; bestSeconds: number };
  /** 賭場で実際に遊んだゲームの種類数 */
  distinctCasinoGames: number;
  /** 開いた部屋の数（kind別） */
  roomsByKind: Map<string, number>;
  invites: { direct: number; grand: number };
  marks: { promotion: number; demotion: number };
  /** 自分が評価した回数（conclusion別） */
  evalsGiven: Map<string, number>;
  bumps: number;
  /** 投げ銭を贈った相手のユニーク人数 */
  distinctTipTargets: number;
  shopPurchases: number;
  /** 競馬に賭けた回数 */
  raceBets: number;
  /**
   * 既に獲得している称号の数。「称号を N 個集めた」系の判定に使う。
   * 同一 evaluate 内での増加は反映されない（次回の評価で追いつく）。
   */
  ownedTitles: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
      | { ok: number }
      | undefined
  ) !== undefined;
}

/** 賭場テーブルは Casino サービスが遅延生成する。未生成でも判定全体を落とさない */
function safeGet<T>(db: Database.Database, table: string, sql: string, params: unknown[]): T | undefined {
  if (!tableExists(db, table)) return undefined;
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch {
    return undefined;
  }
}

function safeAll<T>(db: Database.Database, table: string, sql: string, params: unknown[]): T[] {
  if (!tableExists(db, table)) return [];
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function countMap(rows: Array<{ k: string | null; c: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.k !== null) m.set(r.k, r.c);
  return m;
}

function txMap(rows: Array<{ k: string; c: number; s: number }>): Map<string, TxAgg> {
  const m = new Map<string, TxAgg>();
  for (const r of rows) m.set(r.k, { count: r.c, sum: r.s ?? 0 });
  return m;
}

/** vc_segments 1人分から、時間帯・連続性・最長滞在といった「量ではない」指標を導く */
function deriveVc(
  segments: Array<{ channel_id: string; started_at: number; ended_at: number; self_deafened: number }>,
): VcDerived {
  const days = new Set<string>();
  const deepNight = new Set<string>();
  const channels = new Set<string>();
  let totalSeconds = 0;
  let longest = 0;
  let dawnSessions = 0;
  let crossMidnight = 0;
  let deafenedSeconds = 0;
  let firstSeenAt: number | null = null;

  for (const s of segments) {
    const seconds = Math.max(0, s.ended_at - s.started_at);
    totalSeconds += seconds;
    if (seconds > longest) longest = seconds;
    if (s.self_deafened) deafenedSeconds += seconds;
    channels.add(s.channel_id);
    if (firstSeenAt === null || s.started_at < firstSeenAt) firstSeenAt = s.started_at;

    const startDay = jstDate(s.started_at);
    const endDay = jstDate(s.ended_at);
    days.add(startDay);
    if (startDay !== endDay) {
      days.add(endDay);
      crossMidnight += 1;
    }

    const endHour = jstHour(s.ended_at);
    if (endHour >= 5 && endHour < 7) dawnSessions += 1;

    // 深夜帯(2:00-4:59)に1秒でも掛かっていればその日を深夜浮上とみなす。
    // 区間が長いと複数日にまたがるため、日ごとの深夜窓と突き合わせる。
    for (let t = s.started_at; t <= s.ended_at; t += DAY) {
      const day = jstDate(t);
      const dayStart = Math.floor((t + JST_OFFSET) / DAY) * DAY - JST_OFFSET;
      const windowStart = dayStart + 2 * 3600;
      const windowEnd = dayStart + 5 * 3600;
      if (Math.min(s.ended_at, windowEnd) > Math.max(s.started_at, windowStart)) deepNight.add(day);
    }
  }

  // 連続浮上日数（JST基準の最長ラン）
  const sorted = [...days].sort();
  let maxStreak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    const t = Date.parse(`${d}T00:00:00Z`) / 1000;
    run = prev !== null && t - prev === DAY ? run + 1 : 1;
    if (run > maxStreak) maxStreak = run;
    prev = t;
  }

  return {
    totalSeconds,
    daysSeen: days.size,
    longestSessionSeconds: longest,
    deepNightDays: deepNight.size,
    dawnSessions,
    crossMidnightSessions: crossMidnight,
    maxStreakDays: maxStreak,
    distinctChannels: channels.size,
    deafenedSeconds,
    firstSeenAt,
  };
}

/** 1人分のスナップショットを構築する。DBに当たるのはこの関数の中だけ */
export function buildSnapshot(db: Database.Database, vc: VcTracker, userId: string): TitleSnapshot {
  const ts = now();

  const evActor = countMap(
    db
      .prepare("SELECT type AS k, COUNT(*) AS c FROM events WHERE actor_id = ? GROUP BY type")
      .all(userId) as Array<{ k: string; c: number }>,
  );
  const evTarget = countMap(
    db
      .prepare("SELECT type AS k, COUNT(*) AS c FROM events WHERE target_id = ? GROUP BY type")
      .all(userId) as Array<{ k: string; c: number }>,
  );
  const txActor = txMap(
    db
      .prepare("SELECT type AS k, COUNT(*) AS c, SUM(amount) AS s FROM transactions WHERE actor_id = ? GROUP BY type")
      .all(userId) as Array<{ k: string; c: number; s: number }>,
  );
  const txIn = txMap(
    db
      .prepare("SELECT type AS k, COUNT(*) AS c, SUM(amount) AS s FROM transactions WHERE to_account = ? GROUP BY type")
      .all(`user:${userId}`) as Array<{ k: string; c: number; s: number }>,
  );

  const casinoRow = safeGet<Record<string, number>>(
    db,
    "casino_stats",
    "SELECT * FROM casino_stats WHERE user_id = ?",
    [userId],
  );

  const soul = db.prepare("SELECT status, ghost_at FROM souls WHERE user_id = ?").get(userId) as
    | { status: string; ghost_at: number | null }
    | undefined;

  const segments = db
    .prepare(
      `SELECT channel_id, started_at, COALESCE(ended_at, ?) AS ended_at, self_deafened
       FROM vc_segments WHERE user_id = ?`,
    )
    .all(ts, userId) as Array<{
    channel_id: string;
    started_at: number;
    ended_at: number;
    self_deafened: number;
  }>;

  const distinctGamesRow = safeGet<{ n: number }>(
    db,
    "events",
    `SELECT COUNT(DISTINCT json_extract(payload_json, '$.game')) AS n
     FROM events WHERE type = 'casino_game' AND actor_id = ?`,
    [userId],
  );

  const roomsByKind = countMap(
    safeAll<{ k: string; c: number }>(
      db,
      "rooms",
      "SELECT kind AS k, COUNT(*) AS c FROM rooms WHERE owner_id = ? GROUP BY kind",
      [userId],
    ),
  );

  const inviteRow = safeGet<{ direct: number; grand: number }>(
    db,
    "invites",
    `SELECT
       (SELECT COUNT(*) FROM invites WHERE inviter_id = ?) AS direct,
       (SELECT COUNT(*) FROM invites WHERE inviter_id IN (SELECT invitee_id FROM invites WHERE inviter_id = ?)) AS grand`,
    [userId, userId],
  );

  const markRows = countMap(
    safeAll<{ k: string; c: number }>(
      db,
      "marks",
      "SELECT kind AS k, COUNT(*) AS c FROM marks WHERE target_id = ? AND revoked_at IS NULL GROUP BY kind",
      [userId],
    ),
  );

  const evalsGiven = countMap(
    safeAll<{ k: string; c: number }>(
      db,
      "evaluations",
      "SELECT conclusion AS k, COUNT(*) AS c FROM evaluations WHERE evaluator_id = ? GROUP BY conclusion",
      [userId],
    ),
  );

  const bumpRow = safeGet<{ count: number }>(db, "bump_counts", "SELECT count FROM bump_counts WHERE user_id = ?", [
    userId,
  ]);

  const tipTargetRow = safeGet<{ n: number }>(
    db,
    "transactions",
    "SELECT COUNT(DISTINCT to_account) AS n FROM transactions WHERE type = 'tip' AND actor_id = ?",
    [userId],
  );

  const shopRow = safeGet<{ n: number }>(
    db,
    "shop_purchases",
    "SELECT COUNT(*) AS n FROM shop_purchases WHERE user_id = ?",
    [userId],
  );

  const raceRow = safeGet<{ n: number }>(
    db,
    "race_bets",
    "SELECT COUNT(*) AS n FROM race_bets WHERE user_id = ?",
    [userId],
  );

  const ownedRow = db.prepare("SELECT COUNT(*) AS n FROM titles WHERE user_id = ?").get(userId) as { n: number };

  return {
    userId,
    evActor,
    evTarget,
    txActor,
    txIn,
    casino: casinoRow ?? {},
    soulStatus: soul?.status ?? null,
    ghostAt: soul?.ghost_at ?? null,
    vc: deriveVc(segments),
    companions: vc.companionSummary(userId),
    distinctCasinoGames: distinctGamesRow?.n ?? 0,
    roomsByKind,
    invites: { direct: inviteRow?.direct ?? 0, grand: inviteRow?.grand ?? 0 },
    marks: { promotion: markRows.get("promotion") ?? 0, demotion: markRows.get("demotion") ?? 0 },
    evalsGiven,
    bumps: bumpRow?.count ?? 0,
    distinctTipTargets: tipTargetRow?.n ?? 0,
    shopPurchases: shopRow?.n ?? 0,
    raceBets: raceRow?.n ?? 0,
    ownedTitles: ownedRow.n,
  };
}
