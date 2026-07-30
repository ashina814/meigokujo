import type Database from "better-sqlite3";
import type { VcTracker } from "../vc/service.js";
import {
  coveredDays,
  crossMidnightCount,
  daysOverlappingWindow,
  longestIntervalSeconds,
  longestStreak,
  mergeIntervals,
  totalSeconds,
  type Interval,
} from "../vc/time.js";
import { PUBLIC_ROOM_KINDS } from "./privacy.js";

/**
 * 称号判定のためのスナップショット。
 *
 * 称号は3桁になるため「1ルール = 1クエリ」では線形に重くなる。ここで1人分の集計を
 * 固定本数のクエリでまとめて取り、ルール側はメモリ上のこの構造だけを読む。
 * 称号が9個でも300個でも、DBに当たる回数は変わらない。
 *
 * ■ 台帳の集計は actor_id ではなく from_account / to_account を使う
 *   transactions.actor_id は自由書式で、ユーザー操作は `user:<id>`、システム処理は
 *   `system:*` や承認者IDが入る（tip.ts / transfer.ts / exchange.ts / bank-panel.ts）。
 *   一方 from_account / to_account は accounts への参照で、住人口座は必ず `user:<id>`。
 *   台帳は追記専用（UPDATE/DELETE 禁止）なので過去行の actor_id を揃える選択は取れない。
 *   よって「口座の出入り」で数える。形式差の影響を受けず、過去データもそのまま読める。
 */

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** 深夜帯（2時〜4時台） */
const NIGHT_WINDOW: readonly [number, number] = [2, 5];
/** 朝帯（5時〜6時台） */
const DAWN_WINDOW: readonly [number, number] = [5, 7];

export interface TxAgg {
  count: number;
  sum: number;
}

export interface VcDerived {
  /** 結合済み区間の合計。重なりがあっても実時間を超えない */
  totalSeconds: number;
  /** 浮上した日数（中間日も落とさない） */
  daysSeen: number;
  /** 一度の滞在の最長秒数（状態変化による分割は結合して数える） */
  longestSessionSeconds: number;
  /** 深夜2時〜4時台に浮上していた日数 */
  deepNightDays: number;
  /** 朝5時〜6時台に浮上していた日数 */
  dawnDays: number;
  /** 日付を跨いだ滞在の回数（結合後の区間で数える） */
  crossMidnightSessions: number;
  /** 連続して浮上した最大日数 */
  maxStreakDays: number;
  /** 浮上したことのあるVCの種類数（動的生成の部屋を除く） */
  distinctChannels: number;
  /** スピーカーを切った状態で過ごした秒数 */
  deafenedSeconds: number;
}

export interface TitleSnapshot {
  userId: string;
  /** events に actor として記録された回数（type別）。events の actor は裸のユーザーID */
  evActor: Map<string, number>;
  /** events に target として記録された回数（type別） */
  evTarget: Map<string, number>;
  /** 自分の口座から出た取引の回数と総額（type別） */
  txOut: Map<string, TxAgg>;
  /** 自分の口座が受け取った取引の回数と総額（type別） */
  txIn: Map<string, TxAgg>;
  casino: Record<string, number>;
  soulStatus: string | null;
  ghostAt: number | null;
  vc: VcDerived;
  companions: { uniqueCount: number; totalSeconds: number; bestSeconds: number };
  /** 賭場で実際に遊んだゲームの種類数 */
  distinctCasinoGames: number;
  /** 開いた部屋の数（公開してよい種別のみ） */
  roomsByKind: Map<string, number>;
  invites: { direct: number; grand: number };
  marks: { promotion: number; demotion: number };
  evalsGiven: Map<string, number>;
  bumps: number;
  /** 投げ銭を贈った相手のユニーク人数 */
  distinctTipTargets: number;
  shopPurchases: number;
  raceBets: number;
  /** 既に獲得している称号の数（同一 evaluate 内の増分は次回に持ち越す） */
  ownedTitles: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
      | { ok: number }
      | undefined) !== undefined
  );
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

function txMap(rows: Array<{ k: string; c: number; s: number | null }>): Map<string, TxAgg> {
  const m = new Map<string, TxAgg>();
  for (const r of rows) m.set(r.k, { count: r.c, sum: r.s ?? 0 });
  return m;
}

/**
 * vc_segments 1人分から「量ではない」指標を導く。
 *
 * セグメントはミュート/デフン切替・チャンネル移動のたびに分割される
 * （apps/bot/src/vc-tracking.ts）。そのままでは「一度の滞在」も「日跨ぎ回数」も
 * 実態とずれるため、まず連続した滞在に結合してから各指標を求める。
 */
export function deriveVc(
  segments: Array<{ channel_id: string; started_at: number; ended_at: number; self_deafened: number }>,
  opts: { ephemeralChannels?: ReadonlySet<string> } = {},
): VcDerived {
  const intervals: Interval[] = segments.map((s) => ({ start: s.started_at, end: s.ended_at }));
  const merged = mergeIntervals(intervals);
  const days = coveredDays(merged);

  // デフン秒数は「状態」なので結合前の生セグメントから積む
  let deafenedSeconds = 0;
  const channels = new Set<string>();
  for (const s of segments) {
    const seconds = Math.max(0, s.ended_at - s.started_at);
    if (s.self_deafened) deafenedSeconds += seconds;
    // 宿・卓・巣穴のような動的生成VCは「城を歩いた」に数えない。
    // 部屋を10個開けば探索称号が取れてしまうのを防ぐ。
    if (!opts.ephemeralChannels?.has(s.channel_id)) channels.add(s.channel_id);
  }

  return {
    totalSeconds: totalSeconds(merged),
    daysSeen: days.size,
    longestSessionSeconds: longestIntervalSeconds(merged),
    deepNightDays: daysOverlappingWindow(merged, ...NIGHT_WINDOW).size,
    dawnDays: daysOverlappingWindow(merged, ...DAWN_WINDOW).size,
    crossMidnightSessions: crossMidnightCount(merged),
    maxStreakDays: longestStreak(days),
    distinctChannels: channels.size,
    deafenedSeconds,
  };
}

/** 1人分のスナップショットを構築する。DBに当たるのはこの関数の中だけ */
export function buildSnapshot(db: Database.Database, vc: VcTracker, userId: string): TitleSnapshot {
  const ts = now();
  const account = `user:${userId}`;

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

  // 口座の出入りで数える（actor_id の書式差に依存しない）
  const txOut = txMap(
    db
      .prepare(
        "SELECT type AS k, COUNT(*) AS c, SUM(amount) AS s FROM transactions WHERE from_account = ? GROUP BY type",
      )
      .all(account) as Array<{ k: string; c: number; s: number | null }>,
  );
  const txIn = txMap(
    db
      .prepare(
        "SELECT type AS k, COUNT(*) AS c, SUM(amount) AS s FROM transactions WHERE to_account = ? GROUP BY type",
      )
      .all(account) as Array<{ k: string; c: number; s: number | null }>,
  );

  const casinoRow = safeGet<Record<string, number>>(db, "casino_stats", "SELECT * FROM casino_stats WHERE user_id = ?", [
    userId,
  ]);

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

  // 蜜月・朧月は秘匿対象なので集計自体に含めない（titles/privacy.ts）
  const roomsByKind = countMap(
    safeAll<{ k: string; c: number }>(
      db,
      "rooms",
      `SELECT kind AS k, COUNT(*) AS c FROM rooms
       WHERE owner_id = ? AND kind IN (${PUBLIC_ROOM_KINDS.map(() => "?").join(",")})
       GROUP BY kind`,
      [userId, ...PUBLIC_ROOM_KINDS],
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
    "SELECT COUNT(DISTINCT to_account) AS n FROM transactions WHERE type = 'tip' AND from_account = ?",
    [account],
  );

  const shopRow = safeGet<{ n: number }>(db, "shop_purchases", "SELECT COUNT(*) AS n FROM shop_purchases WHERE user_id = ?", [
    userId,
  ]);

  const raceRow = safeGet<{ n: number }>(db, "race_bets", "SELECT COUNT(*) AS n FROM race_bets WHERE user_id = ?", [
    userId,
  ]);

  const ownedRow = db.prepare("SELECT COUNT(*) AS n FROM titles WHERE user_id = ?").get(userId) as { n: number };

  // 動的生成VC（宿・特殊部屋・賭場の卓・巣穴）の channel_id 集合。
  // 常設VCの探索と区別するために使う。テーブルが無い環境では空集合。
  //
  // rooms と den_vcs は行が残るが、casino_temp_vcs は untrack で消えるため
  // 過去の卓を取りこぼす。卓は takutate_create の事件録に channelId が残るので
  // そちらも併せて読む（事件録は追記専用なので取りこぼしがない）。
  const ephemeralChannels = new Set<string>();
  for (const table of ["rooms", "casino_temp_vcs", "den_vcs"]) {
    for (const r of safeAll<{ channel_id: string }>(db, table, `SELECT channel_id FROM ${table}`, [])) {
      if (r.channel_id) ephemeralChannels.add(r.channel_id);
    }
  }
  for (const r of safeAll<{ channel_id: string | null }>(
    db,
    "events",
    "SELECT json_extract(payload_json, '$.channelId') AS channel_id FROM events WHERE type = 'takutate_create'",
    [],
  )) {
    if (r.channel_id) ephemeralChannels.add(r.channel_id);
  }

  return {
    userId,
    evActor,
    evTarget,
    txOut,
    txIn,
    casino: casinoRow ?? {},
    soulStatus: soul?.status ?? null,
    ghostAt: soul?.ghost_at ?? null,
    vc: deriveVc(segments, { ephemeralChannels }),
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

export { DAY };
