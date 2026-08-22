import type Database from "better-sqlite3";
import {
  computeEmptyStartThenJoined,
  computeGroupSizeSeconds,
  computeLastOccupant,
  computeSafeSocialAggregates,
  type OccupancyBucket,
} from "../vc/derived.js";
import { TITLE_SOURCES, type TitleSourceDefinition, type TitleUsableSourceKey } from "./v2-contract.js";
import { assertResolvedTitleScope, resolvedScopeEffectiveEnd, type ResolvedTitleScope } from "./v2-scope.js";

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

export interface VcSocialSafeSourcePayload {
  readonly distinctCoPresentUsers: number;
  readonly maxRepeatedDaysWithOneCounterpart: number;
  readonly trustedOverlapSeconds: number;
}

/** sourceKeyごとのsanitized payload型。相手のuserId・raw message ID等は一切含めない。 */
export interface TitleSourcePayloads {
  bump_events: BumpEventsSourcePayload;
  vc_empty_start_then_joined: VcEmptyStartThenJoinedSourcePayload;
  vc_last_occupant: VcLastOccupantSourcePayload;
  vc_group_size_seconds: VcGroupSizeSecondsSourcePayload;
  vc_social_safe: VcSocialSafeSourcePayload;
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

/** internal——`v2.ts`からはexportしない。plannerの`bulkReadCalls`統計計算にだけ使う。 */
export function bulkReadCallsFor(userCount: number): number {
  return userCount === 0 ? 0 : Math.ceil(userCount / BULK_USER_CHUNK_SIZE);
}

function chunkUserIds(userIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += BULK_USER_CHUNK_SIZE) {
    chunks.push(userIds.slice(i, i + BULK_USER_CHUNK_SIZE));
  }
  return chunks;
}

type BulkSourceReader<K extends TitleUsableSourceKey> = (
  db: Database.Database,
  userIds: readonly string[],
  scope: ResolvedTitleScope,
) => ReadonlyMap<string, TitleSourcePayloads[K]>;

const EMPTY_GROUP_SIZE_PAYLOAD: VcGroupSizeSecondsSourcePayload = {
  trustedSecondsByBucket: { solo: 0, oneToOne: 0, smallGroup: 0, largeGroup: 0 },
  untrustedSeconds: 0,
};
const EMPTY_SOCIAL_SAFE_PAYLOAD: VcSocialSafeSourcePayload = {
  distinctCoPresentUsers: 0,
  maxRepeatedDaysWithOneCounterpart: 0,
  trustedOverlapSeconds: 0,
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
    const result = new Map<string, BumpEventsSourcePayload>();
    for (const userId of userIds) result.set(userId, { events: [] });
    if (userIds.length === 0) return result;

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    for (const chunk of chunkUserIds(userIds)) {
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
      for (const [userId, events] of byUser) result.set(userId, { events });
    }
    return result;
  },

  vc_empty_start_then_joined: (db, userIds, scope) => {
    const result = new Map<string, VcEmptyStartThenJoinedSourcePayload>();
    for (const userId of userIds) result.set(userId, { facts: [] });
    if (userIds.length === 0) return result;

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return result;
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    for (const chunk of chunkUserIds(userIds)) {
      const facts = computeEmptyStartThenJoined(db, window, chunk);
      const byUser = new Map<string, Array<{ visitStartedAt: number; joinedAt: number; channelId: string }>>();
      for (const f of facts) {
        const entry = { visitStartedAt: f.visitStartedAt, joinedAt: f.joinedAt, channelId: f.channelId };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) result.set(userId, { facts: list });
    }
    return result;
  },

  vc_last_occupant: (db, userIds, scope) => {
    const result = new Map<string, VcLastOccupantSourcePayload>();
    for (const userId of userIds) result.set(userId, { facts: [] });
    if (userIds.length === 0) return result;

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return result;
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    for (const chunk of chunkUserIds(userIds)) {
      const facts = computeLastOccupant(db, window, chunk);
      const byUser = new Map<string, Array<{ becameLastAt: number; channelId: string }>>();
      for (const f of facts) {
        const entry = { becameLastAt: f.becameLastAt, channelId: f.channelId };
        const list = byUser.get(f.userId);
        if (list) list.push(entry);
        else byUser.set(f.userId, [entry]);
      }
      for (const [userId, list] of byUser) result.set(userId, { facts: list });
    }
    return result;
  },

  vc_group_size_seconds: (db, userIds, scope) => {
    const result = new Map<string, VcGroupSizeSecondsSourcePayload>();
    for (const userId of userIds) result.set(userId, EMPTY_GROUP_SIZE_PAYLOAD);
    if (userIds.length === 0) return result;

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return result;
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    for (const chunk of chunkUserIds(userIds)) {
      const rows = computeGroupSizeSeconds(db, window, chunk);
      for (const row of rows) {
        result.set(row.userId, { trustedSecondsByBucket: row.trustedSecondsByBucket, untrustedSeconds: row.untrustedSeconds });
      }
    }
    return result;
  },

  vc_social_safe: (db, userIds, scope) => {
    const result = new Map<string, VcSocialSafeSourcePayload>();
    for (const userId of userIds) result.set(userId, EMPTY_SOCIAL_SAFE_PAYLOAD);
    if (userIds.length === 0) return result;

    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    if (effectiveEnd <= scope.start) return result;
    const window = { start: scope.start, end: effectiveEnd, observedAt: scope.observedAt };

    for (const chunk of chunkUserIds(userIds)) {
      const rows = computeSafeSocialAggregates(db, window, chunk);
      for (const row of rows) {
        result.set(row.userId, {
          distinctCoPresentUsers: row.distinctCoPresentUsers,
          maxRepeatedDaysWithOneCounterpart: row.maxRepeatedDaysWithOneCounterpart,
          trustedOverlapSeconds: row.trustedOverlapSeconds,
        });
      }
    }
    return result;
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
 * （上記doc comment参照）なので、`.get(userId)!`は安全。
 */
const SOURCE_READERS: { [K in TitleUsableSourceKey]: SourceReader<K> } = {
  bump_events: (db, userId, scope) => BULK_SOURCE_READERS.bump_events(db, [userId], scope).get(userId)!,
  vc_empty_start_then_joined: (db, userId, scope) =>
    BULK_SOURCE_READERS.vc_empty_start_then_joined(db, [userId], scope).get(userId)!,
  vc_last_occupant: (db, userId, scope) => BULK_SOURCE_READERS.vc_last_occupant(db, [userId], scope).get(userId)!,
  vc_group_size_seconds: (db, userId, scope) => BULK_SOURCE_READERS.vc_group_size_seconds(db, [userId], scope).get(userId)!,
  vc_social_safe: (db, userId, scope) => BULK_SOURCE_READERS.vc_social_safe(db, [userId], scope).get(userId)!,
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

/**
 * 同一 (userId, sourceKey, scope) の重複読み込みを1 evaluation batch内で共有する。
 *
 * 複数のtitle ruleが同じsourceを使っても、derived計算（PR2の一部はO(訪問数²)）を
 * ruleの数だけ繰り返さない。永続cacheではなく、1回の評価呼び出し内だけのmemory cache。
 *
 * PR D1: `prefetch()`を追加した——複数userをまとめてbulk readerで読み、結果だけを
 * cacheへ入れる（§12）。callerが任意payloadをcacheへ注入できるAPI（`set`/`seed`等）は
 * 意図的に存在しない（§13, §51）——cache mutationは`get()`（trusted single reader）と
 * `prefetch()`（trusted bulk reader）の結果だけを経由する。
 */
export class TitleSourceCache {
  private readonly cache = new Map<string, unknown>();

  get<K extends TitleUsableSourceKey>(
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
    const key = cacheKeyFor(userId, sourceKey, scope);
    if (this.cache.has(key)) return this.cache.get(key) as TitleSourcePayloads[K];
    const value = readTitleSource(db, sourceKey, userId, scope);
    this.cache.set(key, value);
    return value;
  }

  /**
   * 複数userぶんのsource payloadを、1回（またはchunk分割された数回）のbulk readerで
   * まとめて読み、結果だけをcacheへ入れる（PR D1）。
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
   * 戻り値の`loaded`は、実際に新規cacheされたuser数（既にcache済みだったuserを含まない）。
   */
  prefetch<K extends TitleUsableSourceKey>(
    db: Database.Database,
    sourceKey: K,
    userIds: readonly string[],
    scope: ResolvedTitleScope,
  ): { readonly loaded: number } {
    assertResolvedTitleScope(scope);
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
      if (!this.cache.has(cacheKeyFor(userId, sourceKey, scope))) missing.push(userId);
    }
    if (missing.length === 0) return { loaded: 0 };

    const results = reader(db, missing, scope);
    for (const userId of missing) {
      const payload = results.get(userId);
      if (payload === undefined) {
        throw new Error(`bulk source reader for ${String(sourceKey)} did not return a payload for requested user`);
      }
      this.cache.set(cacheKeyFor(userId, sourceKey, scope), deepFreeze(payload));
    }
    return { loaded: missing.length };
  }
}
