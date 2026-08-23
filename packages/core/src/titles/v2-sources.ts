import type Database from "better-sqlite3";
import {
  computeEmptyStartThenJoined,
  computeGroupSizeDailySeconds,
  computeGroupSizeSeconds,
  computeLastOccupant,
  computeSafeSocialAggregates,
  type OccupancyBucket,
} from "../vc/derived.js";
import { TITLE_SOURCES, type TitleSourceDefinition, type TitleUsableSourceKey } from "./v2-contract.js";
import { assertResolvedTitleScope, resolvedScopeEffectiveEnd, type ResolvedTitleScope } from "./v2-scope.js";
import { computeSafeEconomyPeerActions, type SafePeerEconomyActionKind } from "./v2-economy.js";
import { computeCasinoActivityDays, computeCasinoCompletedActivityDays } from "./v2-casino.js";
import type { CasinoActivityKey } from "../casino/participation-history.js";
import { computeCompletedPublicEventParticipations } from "./v2-public-events.js";
import { computePublicRoomActivitySafe } from "../rooms/derived.js";
import {
  computeTcConversationSafe,
  computeTcReactionSafe,
  type TcConversationSafePayload,
  type TcReactionSafePayload,
} from "../tc-social/derived.js";

/**
 * 称号ruleがraw DBを直接触らないようにするための、source読み込み境界。
 *
 * ruleへ渡してよいのは `TITLE_SOURCES` に `titleUsable: true` で登録されたsourceの、
 * sanitizeされたpayloadだけ。Database.Database そのものや vc_segments 等の
 * titleUsable:false sourceはruleへ一切渡さない——渡してしまうと、ruleが独自SQLを書ける
 * 設計になり、PR1/PR2で作ったprivacy/provenance/trusted-untrustedの契約を
 * 全部迂回できてしまう。
 *
 * scopeはcallerが自由に作れる `TitleEvaluationScope` ではなく、v2-scope.tsの
 * resolveTitleScope() だけが作れる `ResolvedTitleScope`（branded）を受け取る。
 *
 * PR D1: bulk prefetch planner向けに `BULK_SOURCE_READERS`（複数user分を1回のDB読み込みで
 * まとめて取得するreader）を追加した。**bulk readerが正本**——単一user向けの
 * `SOURCE_READERS`（下記）はbulk readerへ`[userId]`で委譲する薄いwrapperにすることで、
 * single/bulkのsemanticsを別々に実装して片方だけ将来修正される事故を防ぐ（§19）。
 */

export interface BumpEventsSourcePayload {
  /** [start, end) 内の成功BUMPの created_at（unix秒）。created_at ASC。message_idは含まない。 */
  readonly events: readonly number[];
}

export interface VcEmptyStartThenJoinedSourcePayload {
  readonly facts: ReadonlyArray<{
    readonly visitStartedAt: number;
    readonly joinedAt: number;
    readonly channelId: string;
  }>;
}

export interface VcLastOccupantSourcePayload {
  readonly facts: ReadonlyArray<{ readonly becameLastAt: number; readonly channelId: string }>;
}

export interface VcGroupSizeSecondsSourcePayload {
  readonly trustedSecondsByBucket: Readonly<Record<OccupancyBucket, number>>;
  readonly untrustedSeconds: number;
}

export interface VcGroupSizeDailySafeSourcePayload {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly trustedSecondsByBucket: Readonly<Record<OccupancyBucket, number>>;
  }>;
}

export interface VcSocialSafeSourcePayload {
  readonly distinctCoPresentUsers: number;
  readonly maxRepeatedDaysWithOneCounterpart: number;
  readonly trustedOverlapSeconds: number;
  readonly dailyBreadth: ReadonlyArray<{
    readonly date: string;
    readonly distinctCoPresentUsers: number;
  }>;
}

/**
 * PR E1: raw message数・message内容・channel・message idは一切含めない。JST dateだけは
 * safeなので含めてよい（将来、連続日/週末/特定イベント日を安全に評価できるようにする）。
 */
export interface TextActiveDaysSourcePayload {
  readonly days: ReadonlyArray<{ readonly date: string; readonly observedAt: number }>;
}

/** PR E1: invitee identity・inviter identity（自分自身のuserIdはcaller側で既知）は含めない。 */
export interface ConfirmedInvitesSourcePayload {
  readonly creditedAt: readonly number[];
}

/**
 * PR E2: amount・counterparty（from/to account）・reason・ref・approved_by・
 * idempotency_key・transaction idは一切含めない。kind（"transfer"|"tip"）とJST date・
 * occurredAtだけ。
 */
export interface EconomySafePeerActionsSourcePayload {
  readonly facts: ReadonlyArray<{
    readonly kind: SafePeerEconomyActionKind;
    readonly date: string;
    readonly occurredAt: number;
  }>;
}

/**
 * PR E3: eventKeyだけを公開する（公開イベントの機械identity）。event name・event date・
 * recordedBy・他参加者identityは一切含めない。
 */
export interface PublicEventParticipationsSourcePayload {
  readonly participations: ReadonlyArray<{
    readonly eventKey: string;
    readonly recordedAt: number;
  }>;
}

export interface PublicEventCompletedParticipationsSourcePayload {
  readonly participations: ReadonlyArray<{
    readonly eventKey: string;
    readonly completedAt: number;
  }>;
}

/**
 * PR E4: activityKey・activityDate・occurredAtだけを公開する。participationKey・
 * operationId・session・counterpart/opponent・wager・payout・net・result・betType・
 * horse・roulette選択・raw play countは一切含めない。
 */
export interface CasinoActivityDaysSourcePayload {
  readonly activityDays: ReadonlyArray<{
    readonly activityKey: CasinoActivityKey;
    readonly activityDate: string;
    readonly occurredAt: number;
  }>;
}

/**
 * PR F2b: activityKey・activityDate・completedAtだけを公開する。participationKey・
 * operationId・session・counterpart/opponent・wager・payout・net・result・
 * winner/loser・betType・horse・roulette選択・raw play countは一切含めない。
 * casino_activity_daysとは別sourceであり、意味も別——こちらはcanonical
 * settlement成功（completion）だけを表す。
 */
export interface CasinoCompletedActivityDaysSourcePayload {
  readonly activityDays: ReadonlyArray<{
    readonly activityKey: CasinoActivityKey;
    readonly activityDate: string;
    readonly completedAt: number;
  }>;
}

export type TcConversationSafeSourcePayload = TcConversationSafePayload;
export type TcReactionSafeSourcePayload = TcReactionSafePayload;

export interface PublicRoomActivitySafeSourcePayload {
  readonly hosted: {
    readonly distinctGuests: number;
    readonly sessionCount: number;
    readonly maxConcurrentGuests: number;
    readonly maxRepeatGuestDepth: number;
    readonly days: ReadonlyArray<{ readonly date: string; readonly distinctGuests: number; readonly sessionsWithGuests: number }>;
  };
  readonly guest: {
    readonly distinctOwners: number;
    readonly sessionCount: number;
    readonly days: ReadonlyArray<{ readonly date: string; readonly distinctOwners: number; readonly sessionsVisited: number }>;
  };
  readonly ownUse: {
    readonly sessionCount: number;
    readonly days: ReadonlyArray<{ readonly date: string; readonly sessionsUsed: number }>;
  };
}

/** sourceKeyごとのsanitized payload型。相手のuserId・raw message ID等は一切含めない。 */
export interface TitleSourcePayloads {
  bump_events: BumpEventsSourcePayload;
  vc_empty_start_then_joined: VcEmptyStartThenJoinedSourcePayload;
  vc_last_occupant: VcLastOccupantSourcePayload;
  vc_group_size_seconds: VcGroupSizeSecondsSourcePayload;
  vc_group_size_daily_safe: VcGroupSizeDailySafeSourcePayload;
  vc_social_safe: VcSocialSafeSourcePayload;
  tc_conversation_safe: TcConversationSafeSourcePayload;
  tc_reaction_safe: TcReactionSafeSourcePayload;
  text_active_days: TextActiveDaysSourcePayload;
  confirmed_invites: ConfirmedInvitesSourcePayload;
  economy_safe_peer_actions: EconomySafePeerActionsSourcePayload;
  public_event_participations: PublicEventParticipationsSourcePayload;
  public_event_completed_participations: PublicEventCompletedParticipationsSourcePayload;
  casino_activity_days: CasinoActivityDaysSourcePayload;
  casino_completed_activity_days: CasinoCompletedActivityDaysSourcePayload;
  public_room_activity_safe: PublicRoomActivitySafeSourcePayload;
}

// ─────────────────────────────────────────────────────────────
// cache/group key（single readerとbulk plannerで共有する唯一のidentity生成ロジック、§9）
// ─────────────────────────────────────────────────────────────

/**
 * scopeのsemantic identity。`userId`/`sourceKey`を含まない——`(user, source, scope)`
 * cache keyと `(source, scope)` group keyの両方がこの同じ関数を土台にする。
 */
function scopeIdentityFor(scope: ResolvedTitleScope): string {
  return [scope.scopeKey, scope.start, scope.endExclusive, scope.observedAt].join(" ");
}

/** `TitleSourceCache`が使う `(userId, sourceKey, scope)` cache key。 */
function cacheKeyFor(userId: string, sourceKey: string, scope: ResolvedTitleScope): string {
  return `${userId} ${sourceKey} ${scopeIdentityFor(scope)}`;
}

/**
 * bulk prefetch plannerが使う `(sourceKey, scope)` group key（internal——`v2.ts`からは
 * exportしない、§52）。`titleKey`はgroup identityへ含めない——複数titleが同じ
 * source/semantic scopeを宣言していれば1 groupへmerge する（§11）。同じwindowでも
 * `scopeKey`が違えば別group（§10、既存`TitleSourceCache`semanticと同じ）。
 */
export function sourceScopeGroupKeyFor(sourceKey: string, scope: ResolvedTitleScope): string {
  return `${sourceKey} ${scopeIdentityFor(scope)}`;
}

// ─────────────────────────────────────────────────────────────
// bulk source readers（正本、§18-§21）
// ─────────────────────────────────────────────────────────────

/**
 * SQLite variable limitを考慮したuser id chunk size（§24）。1000+ userIdsのbulk prefetch
 * でも単一の巨大`IN (...)`を作らない——内部定数でよい値として300を選ぶ。
 */
const BULK_USER_CHUNK_SIZE = 300;

function chunkUserIds(userIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += BULK_USER_CHUNK_SIZE) {
    chunks.push(userIds.slice(i, i + BULK_USER_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * bulk readerの戻り値。`readCalls`は実際に発行したDB/derived関数呼び出しの回数
 * ——zero-width scopeの早期returnではchunkループ自体を回さないため0のまま。
 * `userIds.length`からの見積もり（`Math.ceil(userIds.length/CHUNK_SIZE)`）ではなく、
 * 各readerが実際に実行した回数をそのまま返す（PR #158レビュー§8）。
 */
interface BulkSourceReaderResult<K extends TitleUsableSourceKey> {
  readonly payloads: ReadonlyMap<string, TitleSourcePayloads[K]>;
  readonly readCalls: number;
}

type BulkSourceReader<K extends TitleUsableSourceKey> = (
  db: Database.Database,
  userIds: readonly string[],
  scope: ResolvedTitleScope,
) => BulkSourceReaderResult<K>;

const EMPTY_GROUP_SIZE_PAYLOAD: VcGroupSizeSecondsSourcePayload = {
  trustedSecondsByBucket: { solo: 0, oneToOne: 0, smallGroup: 0, largeGroup: 0 },
  untrustedSeconds: 0,
};
const EMPTY_GROUP_SIZE_DAILY_PAYLOAD: VcGroupSizeDailySafeSourcePayload = { days: [] };
const EMPTY_SOCIAL_SAFE_PAYLOAD: VcSocialSafeSourcePayload = {
  distinctCoPresentUsers: 0,
  maxRepeatedDaysWithOneCounterpart: 0,
  trustedOverlapSeconds: 0,
  dailyBreadth: [],
};
const EMPTY_TC_CONVERSATION_SAFE_PAYLOAD: TcConversationSafeSourcePayload = {
  starts: [],
  revivalConversations: [],
  areas: [],
  thirdPartyJoins: [],
  startedConversations: [],
  socialDays: [],
};
const EMPTY_TC_REACTION_SAFE_PAYLOAD: TcReactionSafeSourcePayload = { distinctReactors: 0, posts: [], days: [] };
const EMPTY_PUBLIC_ROOM_ACTIVITY_SAFE_PAYLOAD: PublicRoomActivitySafeSourcePayload = {
  hosted: { distinctGuests: 0, sessionCount: 0, maxConcurrentGuests: 0, maxRepeatGuestDepth: 0, days: [] },
  guest: { distinctOwners: 0, sessionCount: 0, days: [] },
  ownUse: { sessionCount: 0, days: [] },
};

/**
 * titleUsable:true な全sourceについて、複数userをまとめて読むbulk readerを実装する。
 * `{ [K in TitleUsableSourceKey]: ... }` はsourceを追加したのにbulk reader追加を
 * 忘れると型検査で落ちる（`assertBulkSourceReaderCoverage()`がruntime側も守る、§18）。
 *
 * 契約（すべてのbulk readerが守る）:
 * - 戻り値は要求した`userIds`**全員分**のentryを持つ（0件userも欠けているデータでは
 *   なく明示的な空payloadとしてMapへ含める、§28——missing entryをそのまま
 *   「未読み込み」と誤読させない）。
 * - `userIds`以外（channel context取得のために内部で読む第三者）をMapへ含めない（§22）。
 * - zero-width window（`effectiveEnd <= scope.start`）は空payloadだけを返し、
 *   VC derivedへ不正なwindowを渡さない（既存single readerと同じ、§26）。
 * - SQLite variable limitを超えないよう`userIds`をchunkして複数回読み込む（§24）。
 */
const BULK_SOURCE_READERS: { [K in TitleUsableSourceKey]: BulkSourceReader<K> } = {
  bump_events: (db, userIds, scope) => {
    const payloads = new Map<string, BumpEventsSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { events: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT user_id, created_at FROM bump_events
            WHERE user_id IN (${placeholders}) AND created_at >= ? AND created_at < ?
            ORDER BY user_id ASC, created_at ASC`,
        )
        .all(...chunk, scope.start, effectiveEnd) as Array<{ user_id: string; created_at: number }>;
      const byUser = new Map<string, number[]>();
      for (const row of rows) {
        const list = byUser.get(row.user_id);
        if (list) list.push(row.created_at);
        else byUser.set(row.user_id, [row.created_at]);
      }
      for (const [userId, events] of byUser) payloads.set(userId, { events });
    }
    return { payloads, readCalls };
  },

  vc_empty_start_then_joined: (db, userIds, scope) => {
    const payloads = new Map<string, VcEmptyStartThenJoinedSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { facts: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const facts = computeEmptyStartThenJoined(db, window, chunk);
      const byUser = new Map<string, Array<{ visitStartedAt: number; joinedAt: number; channelId: string }>>();
      for (const f of facts) {
        const entry = { visitStartedAt: f.visitStartedAt, joinedAt: f.joinedAt, channelId: f.channelId };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) payloads.set(userId, { facts: list });
    }
    return { payloads, readCalls };
  },

  vc_last_occupant: (db, userIds, scope) => {
    const payloads = new Map<string, VcLastOccupantSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { facts: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const facts = computeLastOccupant(db, window, chunk);
      const byUser = new Map<string, Array<{ becameLastAt: number; channelId: string }>>();
      for (const f of facts) {
        const entry = { becameLastAt: f.becameLastAt, channelId: f.channelId };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) payloads.set(userId, { facts: list });
    }
    return { payloads, readCalls };
  },

  vc_group_size_seconds: (db, userIds, scope) => {
    const payloads = new Map<string, VcGroupSizeSecondsSourcePayload>();
    for (const userId of userIds) payloads.set(userId, EMPTY_GROUP_SIZE_PAYLOAD);
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const rows = computeGroupSizeSeconds(db, window, chunk);
      for (const row of rows) {
        payloads.set(row.userId, { trustedSecondsByBucket: row.trustedSecondsByBucket, untrustedSeconds: row.untrustedSeconds });
      }
    }
    return { payloads, readCalls };
  },

  vc_group_size_daily_safe: (db, userIds, scope) => {
    const payloads = new Map<string, VcGroupSizeDailySafeSourcePayload>();
    for (const userId of userIds) payloads.set(userId, EMPTY_GROUP_SIZE_DAILY_PAYLOAD);
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const rows = computeGroupSizeDailySeconds(db, window, chunk);
      for (const row of rows) payloads.set(row.userId, { days: row.days });
    }
    return { payloads, readCalls };
  },

  vc_social_safe: (db, userIds, scope) => {
    const payloads = new Map<string, VcSocialSafeSourcePayload>();
    for (const userId of userIds) payloads.set(userId, EMPTY_SOCIAL_SAFE_PAYLOAD);
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const rows = computeSafeSocialAggregates(db, window, chunk);
      for (const row of rows) {
        payloads.set(row.userId, {
          distinctCoPresentUsers: row.distinctCoPresentUsers,
          maxRepeatedDaysWithOneCounterpart: row.maxRepeatedDaysWithOneCounterpart,
          trustedOverlapSeconds: row.trustedOverlapSeconds,
          dailyBreadth: row.dailyBreadth,
        });
      }
    }
    return { payloads, readCalls };
  },

  public_room_activity_safe: (db, userIds, scope) => {
    const payloads = new Map<string, PublicRoomActivitySafeSourcePayload>();
    for (const userId of userIds) payloads.set(userId, EMPTY_PUBLIC_ROOM_ACTIVITY_SAFE_PAYLOAD);
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      for (const row of computePublicRoomActivitySafe(db, window, chunk)) {
        payloads.set(row.userId, { hosted: row.hosted, guest: row.guest, ownUse: row.ownUse });
      }
    }
    return { payloads, readCalls };
  },

  tc_conversation_safe: (db, userIds, scope) => {
    const payloads = new Map<string, TcConversationSafeSourcePayload>();
    for (const userId of userIds) payloads.set(userId, EMPTY_TC_CONVERSATION_SAFE_PAYLOAD);
    if (userIds.length === 0) return { payloads, readCalls: 0 };
    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      for (const row of computeTcConversationSafe(db, window, chunk)) payloads.set(row.userId, row.payload);
    }
    return { payloads, readCalls };
  },

  tc_reaction_safe: (db, userIds, scope) => {
    const payloads = new Map<string, TcReactionSafeSourcePayload>();
    for (const userId of userIds) payloads.set(userId, EMPTY_TC_REACTION_SAFE_PAYLOAD);
    if (userIds.length === 0) return { payloads, readCalls: 0 };
    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return { payloads, readCalls: 0 };
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      for (const row of computeTcReactionSafe(db, window, chunk)) payloads.set(row.userId, row.payload);
    }
    return { payloads, readCalls };
  },

  text_active_days: (db, userIds, scope) => {
    const payloads = new Map<string, TextActiveDaysSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { days: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT user_id, activity_date, observed_at FROM text_active_days
            WHERE user_id IN (${placeholders}) AND observed_at >= ? AND observed_at < ?
            ORDER BY user_id ASC, observed_at ASC`,
        )
        .all(...chunk, scope.start, effectiveEnd) as Array<{ user_id: string; activity_date: string; observed_at: number }>;
      const byUser = new Map<string, Array<{ date: string; observedAt: number }>>();
      for (const row of rows) {
        const entry = { date: row.activity_date, observedAt: row.observed_at };
        const list = byUser.get(row.user_id);
        if (list) list.push(entry);
        else byUser.set(row.user_id, [entry]);
      }
      for (const [userId, days] of byUser) payloads.set(userId, { days });
    }
    return { payloads, readCalls };
  },

  confirmed_invites: (db, userIds, scope) => {
    const payloads = new Map<string, ConfirmedInvitesSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { creditedAt: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const placeholders = chunk.map(() => "?").join(",");
      // invitee_idはSELECTしない——招待された側のidentityをruleへ一切渡さない（§26, §33）。
      const rows = db
        .prepare(
          `SELECT inviter_id, credited_at FROM invites
            WHERE inviter_id IN (${placeholders}) AND credited_at >= ? AND credited_at < ?
            ORDER BY inviter_id ASC, credited_at ASC`,
        )
        .all(...chunk, scope.start, effectiveEnd) as Array<{ inviter_id: string; credited_at: number }>;
      const byUser = new Map<string, number[]>();
      for (const row of rows) {
        const list = byUser.get(row.inviter_id);
        if (list) list.push(row.credited_at);
        else byUser.set(row.inviter_id, [row.credited_at]);
      }
      for (const [userId, creditedAt] of byUser) payloads.set(userId, { creditedAt });
    }
    return { payloads, readCalls };
  },

  economy_safe_peer_actions: (db, userIds, scope) => {
    const payloads = new Map<string, EconomySafePeerActionsSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { facts: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      // 実際のsafe allowlist・actor binding・reversal除外・JST day×kind dedupeは
      // v2-economy.tsのcomputeSafeEconomyPeerActions()だけが持つ（正本を二重実装しない）。
      const facts = computeSafeEconomyPeerActions(db, { start: scope.start, end: effectiveEnd }, chunk);
      const byUser = new Map<string, Array<{ kind: SafePeerEconomyActionKind; date: string; occurredAt: number }>>();
      for (const f of facts) {
        const entry = { kind: f.kind, date: f.date, occurredAt: f.occurredAt };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) payloads.set(userId, { facts: list });
    }
    return { payloads, readCalls };
  },

  public_event_participations: (db, userIds, scope) => {
    const payloads = new Map<string, PublicEventParticipationsSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { participations: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const placeholders = chunk.map(() => "?").join(",");
      // recorded_by・name・event_dateはSELECTしない——公開してよいのはeventKey/recordedAtだけ。
      const rows = db
        .prepare(
          `SELECT user_id, event_key, recorded_at FROM public_event_participations
            WHERE user_id IN (${placeholders}) AND recorded_at >= ? AND recorded_at < ?
            ORDER BY user_id ASC, recorded_at ASC, event_key ASC`,
        )
        .all(...chunk, scope.start, effectiveEnd) as Array<{ user_id: string; event_key: string; recorded_at: number }>;
      const byUser = new Map<string, Array<{ eventKey: string; recordedAt: number }>>();
      for (const row of rows) {
        const entry = { eventKey: row.event_key, recordedAt: row.recorded_at };
        const list = byUser.get(row.user_id);
        if (list) list.push(entry);
        else byUser.set(row.user_id, [entry]);
      }
      for (const [userId, list] of byUser) payloads.set(userId, { participations: list });
    }
    return { payloads, readCalls };
  },

  public_event_completed_participations: (db, userIds, scope) => {
    const payloads = new Map<string, PublicEventCompletedParticipationsSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { participations: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      const facts = computeCompletedPublicEventParticipations(
        db,
        { start: scope.start, end: effectiveEnd },
        chunk,
      );
      const byUser = new Map<string, Array<{ eventKey: string; completedAt: number }>>();
      for (const fact of facts) {
        const entry = { eventKey: fact.eventKey, completedAt: fact.completedAt };
        const list = byUser.get(fact.userId);
        if (list) list.push(entry);
        else byUser.set(fact.userId, [entry]);
      }
      for (const [userId, participations] of byUser) payloads.set(userId, { participations });
    }
    return { payloads, readCalls };
  },

  casino_activity_days: (db, userIds, scope) => {
    const payloads = new Map<string, CasinoActivityDaysSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { activityDays: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      // 実際のallowlist検証・day collapse dedupeはv2-casino.tsのcomputeCasinoActivityDays()
      // だけが持つ（正本を二重実装しない）。
      const facts = computeCasinoActivityDays(db, { start: scope.start, end: effectiveEnd }, chunk);
      const byUser = new Map<string, Array<{ activityKey: CasinoActivityKey; activityDate: string; occurredAt: number }>>();
      for (const f of facts) {
        const entry = { activityKey: f.activityKey, activityDate: f.activityDate, occurredAt: f.occurredAt };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) payloads.set(userId, { activityDays: list });
    }
    return { payloads, readCalls };
  },

  casino_completed_activity_days: (db, userIds, scope) => {
    const payloads = new Map<string, CasinoCompletedActivityDaysSourcePayload>();
    for (const userId of userIds) payloads.set(userId, { activityDays: [] });
    if (userIds.length === 0) return { payloads, readCalls: 0 };

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    let readCalls = 0;
    for (const chunk of chunkUserIds(userIds)) {
      readCalls += 1;
      // 実際のallowlist検証・day collapse dedupeはv2-casino.tsの
      // computeCasinoCompletedActivityDays()だけが持つ（正本を二重実装しない）。
      const facts = computeCasinoCompletedActivityDays(db, { start: scope.start, end: effectiveEnd }, chunk);
      const byUser = new Map<string, Array<{ activityKey: CasinoActivityKey; activityDate: string; completedAt: number }>>();
      for (const f of facts) {
        const entry = { activityKey: f.activityKey, activityDate: f.activityDate, completedAt: f.completedAt };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) payloads.set(userId, { activityDays: list });
    }
    return { payloads, readCalls };
  },
};

/**
 * titleUsable:true な全sourceにbulk readerが実際に存在することを確認する（§18）。
 * `assertSourceReaderCoverage()`と同じ理由——TypeScriptを迂回した動的登録でも検証する。
 */
export function assertBulkSourceReaderCoverage(
  sources: Record<string, TitleSourceDefinition> = TITLE_SOURCES,
): void {
  for (const [key, definition] of Object.entries(sources)) {
    if (!definition.titleUsable) continue;
    if (!(key in BULK_SOURCE_READERS)) {
      throw new Error(`missing bulk source reader for titleUsable source: ${key}`);
    }
  }
}

type SourceReader<K extends TitleUsableSourceKey> = (
  db: Database.Database,
  userId: string,
  scope: ResolvedTitleScope,
) => TitleSourcePayloads[K];

/**
 * single-user readerはbulk readerへ`[userId]`で委譲する薄いwrapper（§19）——
 * 独立した実装を持たせない。bulk readerが要求した全userIds分のentryを必ず返す契約
 * （上記doc comment参照）なので、`.payloads.get(userId)!`は安全。
 */
const SOURCE_READERS: { [K in TitleUsableSourceKey]: SourceReader<K> } = {
  bump_events: (db, userId, scope) => BULK_SOURCE_READERS.bump_events(db, [userId], scope).payloads.get(userId)!,
  vc_empty_start_then_joined: (db, userId, scope) =>
    BULK_SOURCE_READERS.vc_empty_start_then_joined(db, [userId], scope).payloads.get(userId)!,
  vc_last_occupant: (db, userId, scope) => BULK_SOURCE_READERS.vc_last_occupant(db, [userId], scope).payloads.get(userId)!,
  vc_group_size_seconds: (db, userId, scope) =>
    BULK_SOURCE_READERS.vc_group_size_seconds(db, [userId], scope).payloads.get(userId)!,
  vc_group_size_daily_safe: (db, userId, scope) =>
    BULK_SOURCE_READERS.vc_group_size_daily_safe(db, [userId], scope).payloads.get(userId)!,
  vc_social_safe: (db, userId, scope) => BULK_SOURCE_READERS.vc_social_safe(db, [userId], scope).payloads.get(userId)!,
  public_room_activity_safe: (db, userId, scope) =>
    BULK_SOURCE_READERS.public_room_activity_safe(db, [userId], scope).payloads.get(userId)!,
  tc_conversation_safe: (db, userId, scope) =>
    BULK_SOURCE_READERS.tc_conversation_safe(db, [userId], scope).payloads.get(userId)!,
  tc_reaction_safe: (db, userId, scope) =>
    BULK_SOURCE_READERS.tc_reaction_safe(db, [userId], scope).payloads.get(userId)!,
  text_active_days: (db, userId, scope) => BULK_SOURCE_READERS.text_active_days(db, [userId], scope).payloads.get(userId)!,
  confirmed_invites: (db, userId, scope) => BULK_SOURCE_READERS.confirmed_invites(db, [userId], scope).payloads.get(userId)!,
  economy_safe_peer_actions: (db, userId, scope) =>
    BULK_SOURCE_READERS.economy_safe_peer_actions(db, [userId], scope).payloads.get(userId)!,
  public_event_participations: (db, userId, scope) =>
    BULK_SOURCE_READERS.public_event_participations(db, [userId], scope).payloads.get(userId)!,
  public_event_completed_participations: (db, userId, scope) =>
    BULK_SOURCE_READERS.public_event_completed_participations(db, [userId], scope).payloads.get(userId)!,
  casino_activity_days: (db, userId, scope) =>
    BULK_SOURCE_READERS.casino_activity_days(db, [userId], scope).payloads.get(userId)!,
  casino_completed_activity_days: (db, userId, scope) =>
    BULK_SOURCE_READERS.casino_completed_activity_days(db, [userId], scope).payloads.get(userId)!,
};

/**
 * titleUsable:true な全sourceにreaderが実際に存在することを確認する。
 * 上のオブジェクトリテラルの型検査(コンパイル時)に加えて、`sources` を差し替えた
 * runtime呼び出しでも検証できるようにする（TypeScriptを迂回した動的登録を想定）。
 */
export function assertSourceReaderCoverage(
  sources: Record<string, TitleSourceDefinition> = TITLE_SOURCES,
): void {
  for (const [key, definition] of Object.entries(sources)) {
    if (!definition.titleUsable) continue;
    if (!(key in SOURCE_READERS)) {
      throw new Error(`missing source reader for titleUsable source: ${key}`);
    }
  }
}

/**
 * 称号ruleが呼んでよい唯一の読み込みAPI。
 *
 * `sourceKey` がTypeScriptの型を迂回して（`as any`等で）titleUsable:falseや未登録の
 * 値を渡された場合でも、ここでfail-closedする——ruleがvc_segments等のraw sourceへ
 * 到達する経路をruntimeでも塞ぐ。`scope` もresolveTitleScope()の産物であることを
 * runtimeで検証する——手書きのscopeオブジェクトをここへ通さない。
 */
export function readTitleSource<K extends TitleUsableSourceKey>(
  db: Database.Database,
  sourceKey: K,
  userId: string,
  scope: ResolvedTitleScope,
): TitleSourcePayloads[K] {
  assertResolvedTitleScope(scope);
  const definition = (TITLE_SOURCES as Record<string, TitleSourceDefinition>)[sourceKey as string];
  if (!definition) {
    throw new Error(`unknown title source: ${String(sourceKey)}`);
  }
  if (!definition.titleUsable) {
    throw new Error(`title source is not usable by titles: ${String(sourceKey)}`);
  }
  const reader = (SOURCE_READERS as Record<string, SourceReader<TitleUsableSourceKey> | undefined>)[
    sourceKey as string
  ];
  if (!reader) {
    throw new Error(`missing source reader for titleUsable source: ${String(sourceKey)}`);
  }
  // payloadはTitleSourceCache経由で複数ruleへ同じ参照が配られる。1つのruleが受け取った
  // payloadを書き換えると、後続ruleが汚染された値を見てしまう——deep-freezeして、
  // 書き換えようとしたら（strict modeで）例外にする。読み込みのたびに新しいobjectを
  // 作るreader関数の性質上、freezeしても他の呼び出しへ影響しない。
  return deepFreeze(reader(db, userId, scope)) as TitleSourcePayloads[K];
}

/** 配列・ネストしたobjectも含めて再帰的にfreezeする。payloadは循環参照を持たない前提。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ─────────────────────────────────────────────────────────────
// TitleSourceCache runtime provenance（PR #158レビュー: private fieldはruntimeを守らない）
// ─────────────────────────────────────────────────────────────

/**
 * `TitleSourceCache`のbacking stateの正本。`v2-scope.ts`の`RESOLVED_SCOPE_PROVENANCE`・
 * `v2-pipeline.ts`の`PLAN_PROVENANCE`と同じ思想——TypeScriptの`private`はruntimeでは
 * 単なる`this.cache`という通常のown propertyでしかなく、`(cache as any).cache`で
 * 素通しで読めてしまう。より重大なのは、`{ get() {...}, prefetch() {...} }`という
 * structural fakeを`TitleEvaluationOptions.cache`/`TitlePrefetchOptions.cache`へ渡し、
 * それを呼び出し側が`cache.get(...)`のようにdynamic dispatchで呼ぶと、`readTitleSource()`
 * /`BULK_SOURCE_READERS`/DBを一切経由せず、forgeされたsafe payloadをruleへ渡せてしまう
 * ——source trust boundary全体の迂回になる。
 *
 * 対策は二段構え:
 * 1. backing Mapをinstanceのown propertyに置かず、この`WeakMap<object, Map<...>>`
 *    （exact object identityでしか引けない）へ移す。`{ ...realCache }`のcopy・
 *    `Object.create(TitleSourceCache.prototype)`・`new Proxy(realCache, {})`は
 *    いずれもこのWeakMapに載っていないためfail-closedする。
 * 2. `TitleSourceCache`のconstructorで`Object.freeze(this)`する——instance own
 *    propertyの追加/上書き（例: `instance.get = fakeFn`によるmethod shadowing）を
 *    strict modeで例外にする。
 *
 * さらに、**evaluator/planner側がcaller供給のcacheに対して`cache.get(...)`/
 * `cache.prefetch(...)`というdynamic dispatchを直接呼ばない**——freezeで守れるのは
 * genuine instanceへのshadowingだけで、caller が最初から渡してきた structural fake
 * object自体（`{get(){...}}`）にはfreezeが及ばない。true trust boundaryは
 * `getFromTitleSourceCache()`/`prefetchIntoTitleSourceCache()`という、`cache`を
 * 単にWeakMap lookupのkeyとしてしか使わない自由関数——`cache`のどのメソッドも
 * 一切呼び出さないため、`cache`が何のmethodを持っていようと影響を受けない。
 */
const TITLE_SOURCE_CACHE_STATE = new WeakMap<object, Map<string, unknown>>();

function requireTitleSourceCache(cache: TitleSourceCache): Map<string, unknown> {
  if (cache === null || typeof cache !== "object") {
    throw new Error(
      "cache was not produced by `new TitleSourceCache()` (forged or hand-built TitleSourceCache) — " +
        "evaluation source trust boundary requires a genuine cache instance",
    );
  }
  const state = TITLE_SOURCE_CACHE_STATE.get(cache as unknown as object);
  if (!state) {
    throw new Error(
      "cache was not produced by `new TitleSourceCache()` (forged, hand-built, cloned, or proxied TitleSourceCache) — " +
        "evaluation source trust boundary requires a genuine cache instance",
    );
  }
  return state;
}

/**
 * `options.cache`をevaluator/plannerが受け取った直後に呼ぶ、入口での早期検証
 * （PR #158レビュー§2）。実際の読み込み境界は`getFromTitleSourceCache()`/
 * `prefetchIntoTitleSourceCache()`が呼び出しのたびに再検証するため、これは
 * defense-in-depthで必須ではないが、forgeされたcacheをruleが1件でも評価される前に
 * 早期にfail-closedする。
 */
export function assertGenuineTitleSourceCache(cache: TitleSourceCache): void {
  requireTitleSourceCache(cache);
}

/**
 * `TitleSourceCache`の唯一の信頼された読み込み経路（freestanding function）。
 * `cache`は単にWeakMap lookupのkeyとしてのみ使う——`cache.get(...)`のような
 * dynamic dispatchを一切行わないため、`cache`が偽造されたstructural fake
 * （`{get(){return forged}}`のようなobject）であっても、そのfakeの`get`メソッドが
 * 実行されることはない。evaluator（v2-evaluator.ts）はこの関数だけを使い、
 * `cache.get(...)`という形の呼び出しは一切しない。
 */
export function getFromTitleSourceCache<K extends TitleUsableSourceKey>(
  cache: TitleSourceCache,
  db: Database.Database,
  sourceKey: K,
  userId: string,
  scope: ResolvedTitleScope,
): TitleSourcePayloads[K] {
  // cache hitはreadTitleSource()を経由しない——brand検証をcache miss側だけに任せると、
  // 正規のscopeで一度cacheされたキーと同じ (userId, sourceKey, scopeKey, start,
  // endExclusive, observedAt) を持つ「偽造scope」を渡した2回目の呼び出しが、
  // assertResolvedTitleScope()を一度も通らずcacheの値をそのまま受け取れてしまう。
  // hit/miss どちらの経路でも必ずbrandを検証する。
  assertResolvedTitleScope(scope);
  const state = requireTitleSourceCache(cache);
  const key = cacheKeyFor(userId, sourceKey, scope);
  if (state.has(key)) return state.get(key) as TitleSourcePayloads[K];
  const value = readTitleSource(db, sourceKey, userId, scope);
  state.set(key, value);
  return value;
}

/**
 * `TitleSourceCache`の唯一の信頼されたbulk書き込み経路（freestanding function、PR D1）。
 * `getFromTitleSourceCache()`と同じ理由で、`cache`のmethodを一切呼ばずWeakMap lookupの
 * keyとしてのみ使う。planner（v2-prefetch.ts）はこの関数だけを使う。
 *
 * - scope forgeryはuserIds=[]でも必ずreject（§16, §49）——空usersだから
 *   validationをskipする、にはしない。
 * - **first-read-wins**（§14）: 既にcache済みの`(user, source, scope)`entryは
 *   上書きしない——`userIds`のうち未cacheのuserだけをbulk readerへ渡す（§15）。
 * - `userIds`は内部でdedupeする（§25）——重複があってもbulk readerへは去重後の
 *   listを渡す。
 * - bulk readerの戻り値を先に完全に受け取ってから（＝失敗すれば何もcommitされない）
 *   cacheへ書き込む——複数chunk中に例外が起きても、既存cache entryはもちろん、
 *   今回のprefetch分も一切cacheへ反映されない（§34、JSの呼び出し-返却-mutation
 *   という構造そのものでstaging/commitを実現している）。
 * - cacheした値はsingleと同じくdeep-freezeする（§27）。
 *
 * 戻り値の`loaded`は実際に新規cacheされたuser数、`readCalls`はbulk readerが実際に
 * 発行したDB/derived関数呼び出しの回数（zero-width scopeの早期returnでは0、PR #158
 * レビュー§8）。
 */
export function prefetchIntoTitleSourceCache<K extends TitleUsableSourceKey>(
  cache: TitleSourceCache,
  db: Database.Database,
  sourceKey: K,
  userIds: readonly string[],
  scope: ResolvedTitleScope,
): { readonly loaded: number; readonly readCalls: number } {
  assertResolvedTitleScope(scope);
  const state = requireTitleSourceCache(cache);
  const definition = (TITLE_SOURCES as Record<string, TitleSourceDefinition>)[sourceKey as string];
  if (!definition) {
    throw new Error(`unknown title source: ${String(sourceKey)}`);
  }
  if (!definition.titleUsable) {
    throw new Error(`title source is not usable by titles: ${String(sourceKey)}`);
  }
  const reader = (BULK_SOURCE_READERS as Record<string, BulkSourceReader<TitleUsableSourceKey> | undefined>)[
    sourceKey as string
  ];
  if (!reader) {
    throw new Error(`missing bulk source reader for titleUsable source: ${String(sourceKey)}`);
  }

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    if (!state.has(cacheKeyFor(userId, sourceKey, scope))) missing.push(userId);
  }
  if (missing.length === 0) return { loaded: 0, readCalls: 0 };

  const { payloads, readCalls } = reader(db, missing, scope);
  for (const userId of missing) {
    const payload = payloads.get(userId);
    if (payload === undefined) {
      throw new Error(`bulk source reader for ${String(sourceKey)} did not return a payload for requested user`);
    }
    state.set(cacheKeyFor(userId, sourceKey, scope), deepFreeze(payload));
  }
  return { loaded: missing.length, readCalls };
}

/**
 * 同一 (userId, sourceKey, scope) の重複読み込みを1 evaluation batch内で共有する。
 *
 * 複数のtitle ruleが同じsourceを使っても、derived計算（PR2の一部はO(訪問数²)）を
 * ruleの数だけ繰り返さない。永続cacheではなく、1回の評価呼び出し内だけのmemory cache。
 *
 * backing stateはinstanceのown propertyではなく`TITLE_SOURCE_CACHE_STATE`
 * （module-private WeakMap）にある——`(cache as any).cache`は常に`undefined`。
 * constructorで`Object.freeze(this)`するため、`instance.get = fakeFn`のような
 * method shadowingもstrict modeで例外になる（PR #158レビュー§1）。
 *
 * `get()`/`prefetch()`はこのクラスの外部利用者（テスト・ドキュメント例）向けの
 * 薄いpublic wrapper——実体は`getFromTitleSourceCache()`/`prefetchIntoTitleSourceCache()`
 * （freestanding function）。evaluator/planner自身はこれらのinstance methodではなく
 * freestanding functionを直接呼ぶ（dynamic dispatchを信用しない、PR #158レビュー§3）。
 *
 * callerが任意payloadをcacheへ注入できるAPI（`set`/`seed`等）は意図的に存在しない
 * （§13, §51）——cache mutationは`get()`（trusted single reader）と`prefetch()`
 * （trusted bulk reader）の結果だけを経由する。
 */
export class TitleSourceCache {
  constructor() {
    TITLE_SOURCE_CACHE_STATE.set(this, new Map());
    Object.freeze(this);
  }

  get<K extends TitleUsableSourceKey>(
    db: Database.Database,
    sourceKey: K,
    userId: string,
    scope: ResolvedTitleScope,
  ): TitleSourcePayloads[K] {
    return getFromTitleSourceCache(this, db, sourceKey, userId, scope);
  }

  prefetch<K extends TitleUsableSourceKey>(
    db: Database.Database,
    sourceKey: K,
    userIds: readonly string[],
    scope: ResolvedTitleScope,
  ): { readonly loaded: number; readonly readCalls: number } {
    return prefetchIntoTitleSourceCache(this, db, sourceKey, userIds, scope);
  }
}
