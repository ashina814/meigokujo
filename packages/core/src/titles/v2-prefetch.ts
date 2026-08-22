import type Database from "better-sqlite3";
import type { TitleTrigger } from "./v2-contract.js";
import { requirePlanProvenance, type TitleEvaluationPlan } from "./v2-pipeline.js";
import { resolveTitleScope, type TitleScopeResolutionOptions, type ResolvedTitleScope } from "./v2-scope.js";
import { bulkReadCallsFor, sourceScopeGroupKeyFor, TitleSourceCache } from "./v2-sources.js";
import type { TitleUsableSourceKey } from "./v2-contract.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * Bulk Source Prefetch Planner（PR D1）。
 *
 * `TitleSourceCache` はuserごとのcacheなので、N人 × M ruleが同じ(source, semantic
 * scope)を共有していても、そのままではN回derived計算が走る。VC derived関数
 * （`computeEmptyStartThenJoined`等）は元々`userIds?: readonly string[]`でbulk計算
 * できる——このplannerは、compiled planを読んで「どのuserが、どの(source, scope)
 * groupを必要とするか」をまとめ、`TitleSourceCache.prefetch()`（bulk reader）で
 * まとめて先読みする、**読み取り専用の最適化**。
 *
 * `evaluateBatchPipeline()`のデフォルト挙動は変えない（§2）——このAPIはopt-inで、
 * callerが戻り値の`cache`を`evaluateBatchPipeline(..., { ...options, cache: prepared.cache })`
 * へ明示的に渡した場合にだけ効果を持つ。
 */

export interface TitlePrefetchOptions extends TitleScopeResolutionOptions {
  /** 既存cacheへ追加で先読みしたい場合に渡す。省略時は新規`TitleSourceCache`を作る。 */
  readonly cache?: TitleSourceCache;
}

/**
 * identity-freeな要約統計（§29）。userId・titleKey・counterpart・raw payload・
 * source別内訳は一切含まない——これは実行infrastructureの統計であり、catalog
 * introspection APIではない。
 */
export interface TitlePrefetchSummary {
  /** 識別された(source, semantic scope)groupの総数。cache hit率に関わらず数える。 */
  readonly plannedGroups: number;
  /** 実際に1人以上の新規bulk読み込みが発生したgroup数。 */
  readonly executedGroups: number;
  /** 重複除去後の、要求されたuser数。 */
  readonly requestedUniqueUsers: number;
  /** 新規にcacheへ書き込まれたentry数の合計。 */
  readonly cacheEntriesLoaded: number;
  /** 内部chunking込みで実際に発行されたbulk読み込み回数の合計。 */
  readonly bulkReadCalls: number;
}

export interface TitlePrefetchResult {
  readonly cache: TitleSourceCache;
  readonly summary: TitlePrefetchSummary;
}

interface SourceScopeGroup {
  readonly sourceKey: TitleUsableSourceKey;
  readonly scope: ResolvedTitleScope;
}

/**
 * 複数user・複数ruleぶんのgeneric behavior sourceを、`TitleSourceCache`へ一括で
 * 先読みする。
 *
 * - **compiled planのbehaviorRulesだけ**を対象にする（§3-4, §31）。relationship
 *   rule（`compiled.relationshipRules`）は`definition.sources`が`["vc_social_safe"]`
 *   であっても対象にしない——relationship evaluatorはこの汎用source cacheを一切
 *   読まず、`v2-relationship-evidence.ts`の private restricted resolverだけを使う
 *   ため、ここで束ねても実際には使われない上、restricted source境界の趣旨に反する。
 *   meta rule（`compiled.metaRules`）はsourceを持たないため、そもそも対象外。
 * - lifecycle:"disabled" のruleはscope解決も含めて完全にskipする（§5、
 *   `evaluateTitle()`と同じ契約）。lifecycle:"active"/"retired"は両方とも対象
 *   （retired titleも新規awardしないだけで、source読み込み自体は行う既存契約に合わせる）。
 * - `trigger`でfilterする——`daily`等を「全rule評価」の魔法triggerにしない（§5）。
 * - scopeはrule単位で1回だけ解決する（user単位でもsource単位でもない、§8）。
 * - groupのidentityは`(sourceKey, scope.scopeKey, scope.start, scope.endExclusive,
 *   scope.observedAt)`——`titleKey`は含めない（§9、`sourceScopeGroupKeyFor()`は
 *   `TitleSourceCache`のcache key生成と同じ内部helperを共有する）。
 * - `plan`は`requirePlanProvenance()`でruntime検証する——手書きplan・shallow copy・
 *   plan構築後のrule定義の書き換えは、canonical compiled planを経由しないため
 *   一切反映されない。
 * - `userIds`はplanner内部でdedupeする（先出順を保持、§25）。これは純粋に読み込み
 *   最適化であり、`evaluateBatchPipeline()`自身の重複user処理semanticsは変えない。
 * - 実際の読み込み・first-read-wins・forged scope拒否・chunkingは
 *   `TitleSourceCache.prefetch()`（v2-sources.ts）が行う——plannerはgroup化と
 *   呼び出しの整理だけを担当する。
 */
export function prefetchBatchPipelineSources(
  db: Database.Database,
  store: TitleV2Store,
  plan: TitleEvaluationPlan,
  userIds: readonly string[],
  observedAt: number,
  trigger: TitleTrigger,
  options: TitlePrefetchOptions = {},
): TitlePrefetchResult {
  const compiled = requirePlanProvenance(plan);
  const cache = options.cache ?? new TitleSourceCache();

  const uniqueUserIds: string[] = [];
  const seenUsers = new Set<string>();
  for (const userId of userIds) {
    if (seenUsers.has(userId)) continue;
    seenUsers.add(userId);
    uniqueUserIds.push(userId);
  }

  const groups = new Map<string, SourceScopeGroup>();
  for (const rule of compiled.behaviorRules) {
    const definition = rule.definition;
    if (definition.lifecycle === "disabled") continue;
    if (!definition.triggers.includes(trigger)) continue;

    // scopeはrule単位で1回だけ解決する——100人のuserに対して100回resolveしない。
    const scope = resolveTitleScope(store, definition, observedAt, {
      eventProvider: options.eventProvider,
      monthSelector: options.monthSelector,
    });

    for (const sourceKey of definition.sources) {
      const groupKey = sourceScopeGroupKeyFor(sourceKey, scope);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { sourceKey, scope });
      }
    }
  }

  let executedGroups = 0;
  let cacheEntriesLoaded = 0;
  let bulkReadCalls = 0;

  for (const group of groups.values()) {
    const { loaded } = cache.prefetch(db, group.sourceKey, uniqueUserIds, group.scope);
    if (loaded > 0) {
      executedGroups += 1;
      cacheEntriesLoaded += loaded;
      bulkReadCalls += bulkReadCallsFor(loaded);
    }
  }

  return {
    cache,
    summary: {
      plannedGroups: groups.size,
      executedGroups,
      requestedUniqueUsers: uniqueUserIds.length,
      cacheEntriesLoaded,
      bulkReadCalls,
    },
  };
}
