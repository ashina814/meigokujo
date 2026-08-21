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

type SourceReader<K extends TitleUsableSourceKey> = (
  db: Database.Database,
  userId: string,
  scope: ResolvedTitleScope,
) => TitleSourcePayloads[K];

/**
 * titleUsable:true な全sourceについて、ここへreaderを実装する。
 * `{ [K in TitleUsableSourceKey]: ... }` はTITLE_SOURCESにtitleUsable:trueのsourceを
 * 追加したのにreaderを足し忘れると型検査で落ちる（同時に、runtime側は
 * assertSourceReaderCoverage() / readTitleSource() が独立にfail-closedする）。
 */
const SOURCE_READERS: { [K in TitleUsableSourceKey]: SourceReader<K> } = {
  bump_events: (db, userId, scope) => {
    // 同秒tieはSQLの並びに任せる。「この人が何番目か」というcross-user順序は主張しない
    // ——このreaderが返すのは単一userのcreated_at列挙だけ。
    //
    // scope.observedAtより後のBUMPも読み込んではいけない——VC readerはPR2のwindowへ
    // observedAtをそのまま渡して未来を計上しないのに、BUMP側だけendExclusive(または
    // open-endedならobservedAt)まで無条件に読むと、同一evaluation内でsourceごとに
    // 時間軸がずれてしまう（VCは観測時点まで、BUMPは未来まで、という不整合）。ただし
    // これは完全なDB snapshot再現ではない——BUMPはretryで後からcreated_atが過去の
    // eventを挿入し得るため、「同じobservedAtなら永久にDB内容と一致する」とまでは
    // 言えない。ここではobservedAtを「event occurrenceの上限」として扱う。
    const effectiveEnd = resolvedScopeEffectiveEnd(scope);
    const rows = db
      .prepare(
        `SELECT created_at FROM bump_events WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC`,
      )
      .all(userId, scope.start, effectiveEnd) as Array<{ created_at: number }>;
    return { events: rows.map((r) => r.created_at) };
  },
  vc_empty_start_then_joined: (db, userId, scope) => {
    const window = { start: scope.start, end: resolvedScopeEffectiveEnd(scope), observedAt: scope.observedAt };
    const facts = computeEmptyStartThenJoined(db, window, [userId]);
    return {
      facts: facts.map((f) => ({ visitStartedAt: f.visitStartedAt, joinedAt: f.joinedAt, channelId: f.channelId })),
    };
  },
  vc_last_occupant: (db, userId, scope) => {
    const window = { start: scope.start, end: resolvedScopeEffectiveEnd(scope), observedAt: scope.observedAt };
    const facts = computeLastOccupant(db, window, [userId]);
    return { facts: facts.map((f) => ({ becameLastAt: f.becameLastAt, channelId: f.channelId })) };
  },
  vc_group_size_seconds: (db, userId, scope) => {
    const window = { start: scope.start, end: resolvedScopeEffectiveEnd(scope), observedAt: scope.observedAt };
    const rows = computeGroupSizeSeconds(db, window, [userId]);
    const row = rows.find((r) => r.userId === userId);
    return {
      trustedSecondsByBucket: row?.trustedSecondsByBucket ?? { solo: 0, oneToOne: 0, smallGroup: 0, largeGroup: 0 },
      untrustedSeconds: row?.untrustedSeconds ?? 0,
    };
  },
  vc_social_safe: (db, userId, scope) => {
    const window = { start: scope.start, end: resolvedScopeEffectiveEnd(scope), observedAt: scope.observedAt };
    const rows = computeSafeSocialAggregates(db, window, [userId]);
    const row = rows.find((r) => r.userId === userId);
    return {
      distinctCoPresentUsers: row?.distinctCoPresentUsers ?? 0,
      maxRepeatedDaysWithOneCounterpart: row?.maxRepeatedDaysWithOneCounterpart ?? 0,
      trustedOverlapSeconds: row?.trustedOverlapSeconds ?? 0,
    };
  },
};

/**
 * titleUsable:true な全sourceにreaderが実際に存在することを確認する。
 * 上のオブジェクトリテラルの型検査（コンパイル時）に加えて、`sources` を差し替えた
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
 */
export class TitleSourceCache {
  private readonly cache = new Map<string, unknown>();

  get<K extends TitleUsableSourceKey>(
    db: Database.Database,
    sourceKey: K,
    userId: string,
    scope: ResolvedTitleScope,
  ): TitleSourcePayloads[K] {
    const key = [userId, sourceKey, scope.scopeKey, scope.start, scope.endExclusive, scope.observedAt].join(" ");
    if (this.cache.has(key)) return this.cache.get(key) as TitleSourcePayloads[K];
    const value = readTitleSource(db, sourceKey, userId, scope);
    this.cache.set(key, value);
    return value;
  }
}
