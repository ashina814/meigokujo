import { defineMetaTitle, type MetaTitleDefinition } from "./v2-contract.js";
import { assertValidAwardFacts, assertValidFactsVersion, type TitleAwardFacts } from "./v2-award-facts.js";
import { resolveTitleScope, toRuleScope, type TitleRuleScope } from "./v2-scope.js";
import type { TitleAwardOutcome } from "./v2-evaluator.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * Meta title評価契約（PR C1）。
 *
 * behavior TitleRuleとは完全に別の契約にする——behavior ruleがsource payloadを読むのに
 * 対し、meta ruleはbehavior award・Series Mastery・Collection Editionといった、他の
 * 永続状態から導出したsanitized snapshotだけを読む。`defineMetaTitle()` を必ず通す
 * ため、behavior definitionをmeta ruleへ、meta definitionをbehavior TitleRuleへ渡す
 * ことは（型でもruntimeでも）できない。
 */

/**
 * meta ruleへ渡すcontext。`userId` を持たない（§7）——ruleが特定userを名指しした
 * special caseを書けないようにするため。userIdはevaluator（`v2-pipeline.ts`）内部だけが
 * 知り、award時にだけ使う。`Database` / `TitleV2Store` も渡さない（§6）——meta rule作者が
 * 独自SQLを書ける経路を作らない。
 */
export interface MetaTitleRuleContext {
  readonly scope: TitleRuleScope;
  readonly snapshot: TitleMetaSnapshot;
}

/**
 * meta titleについて、earnedAtをruleに決めさせない（§4）。meta titleは複数の永続状態
 * （title ownership・Series Mastery・Collection Edition progress・historical repair）
 * から導出され、その一部はnon-orderableであり得るため、「meta条件を歴史上初めて満たした
 * exact時刻」を一般には証明できない。したがってmatched:trueでも `earnedAt` を持たない
 * ——`evaluateMetaTitle()` がaward時に常に `earnedAt: null` を固定する。
 */
export type MetaTitleRuleResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly awardFacts: TitleAwardFacts };

/** カタログ作者が実装するmeta title 1つぶんの判定ロジック。raw DBへは触れない。 */
export interface MetaTitleRule {
  readonly definition: MetaTitleDefinition;
  /** awardFacts JSONのschema version。behavior TitleRuleと同じ意味（v2-evaluator.ts参照）。 */
  readonly awardFactsVersion: number;
  evaluate(context: MetaTitleRuleContext): MetaTitleRuleResult;
}

/** defineMetaTitleRule()の第2引数。 */
export interface MetaTitleRuleImplementation {
  readonly awardFactsVersion: number;
  evaluate(context: MetaTitleRuleContext): MetaTitleRuleResult;
}

/**
 * `defineMetaTitle()` の検証（v2名前空間・global scope限定・lifecycle妥当性）を通した
 * MetaTitleRuleを組み立てる。definitionはMetaTitleDefinitionしか受け付けない——behavior
 * titleをmeta rule contextへ渡せないようにするため、MetaTitleRule自体の型がbehavior
 * titleを表現できない設計にしてある。
 */
export function defineMetaTitleRule(definition: MetaTitleDefinition, impl: MetaTitleRuleImplementation): MetaTitleRule {
  const validated = defineMetaTitle(definition);
  assertValidFactsVersion(impl.awardFactsVersion, `meta title ${definition.key}: awardFactsVersion`);
  return {
    definition: validated,
    awardFactsVersion: impl.awardFactsVersion,
    evaluate: impl.evaluate,
  };
}

/**
 * Collection Editionの、meta ruleへ渡してよい部分だけの集約（§8, §9, §13）。
 *
 * `activatedBy` / `closedBy` / `activationNote` / `closeNote` / manifest member keys
 * は含まない——meta ruleに運用metadataやhidden titleの構造は不要。
 * `progress` は必ず `TitleV2Store.collectionEditionProgress()` の値をそのまま使う
 * （§11）——closed editionのhistorical repair proof契約（B2 §16）を、meta snapshot側で
 * 独自に再計算して迂回しない。
 */
export interface MetaCollectionEditionSnapshot {
  readonly editionKey: string;
  readonly state: "active" | "closed";
  readonly milestones: {
    readonly startedCollecting: number;
    readonly collectorHabit: number;
    readonly stillCollecting: number;
    readonly thousandMarks: { readonly count: number; readonly domains: number };
    readonly almostComplete: { readonly remaining: number };
  };
  readonly progress: {
    readonly collectionOwnedCount: number;
    readonly collectionTotalCount: number;
    readonly collectionOwnedDomainCount: number;
    readonly collectionTotalDomainCount: number;
    readonly fullClearOwnedCount: number;
    readonly fullClearRequiredCount: number;
    readonly fullClearRemainingCount: number;
    readonly fullClearComplete: boolean;
  };
}

/**
 * meta ruleへ渡す、sanitizeされたpersisted-state snapshot（§8）。
 *
 * 絶対に含めないもの（§9）: userId・counterpart userId・member titleKey一覧・
 * missing titleKey一覧・hidden title名/条件・award scope raw list・raw DB row・
 * channel ID・message ID・relationship pair identity・rank title unlock・
 * profile equips・Database・Store。
 */
export interface TitleMetaSnapshot {
  /**
   * behavior title ownershipの数。meta title自身のownershipは絶対に数えない（§10, §23）
   * ——`buildMetaSnapshot()` は評価planのbehavior rule key集合へ照合してカウントする
   * ため、meta ownershipもrank title unlockも構造的にここへ混ざらない。
   */
  readonly behaviorOwnershipCount: number;
  readonly seriesMasteries: readonly { readonly catalogKey: string; readonly seriesKey: string }[];
  readonly collectionEditions: readonly MetaCollectionEditionSnapshot[];
}

/** 配列・ネストしたobjectも含めて再帰的にfreezeする（§15, §48）。payloadは循環参照を持たない前提。 */
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
 * meta ruleへ渡すsnapshotを中央で1回だけ構築する（internal——`v2.ts`/rootからは
 * exportしない、§16）。
 *
 * `behaviorTitleKeys` は評価planのbehavior rule定義keyの集合——`store.listOwnerships()`
 * の結果をこの集合へ照合してカウントすることで、meta title自身のownershipや
 * rank title unlock（別テーブルなのでそもそも`listOwnerships()`には出てこない）を
 * `behaviorOwnershipCount` へ混入させない（§10, §23）。
 *
 * collection情報は必ず `listCollectionEditions()`（active/closed両方、§12）+
 * `collectionEditionProgress()`（historical repair proofを迂回しない、§11）を使う
 * ——current runtime catalogを再計算したり、独自SQLで所有数を数え直したりしない。
 *
 * 返り値はdeep-freezeする（§15）——同じMeta evaluation pass内でrule Aがsnapshotを
 * 書き換えてrule Bの判定へ影響することを防ぐ。
 */
export function buildMetaSnapshot(store: TitleV2Store, userId: string, behaviorTitleKeys: ReadonlySet<string>): TitleMetaSnapshot {
  const ownerships = store.listOwnerships(userId);
  let behaviorOwnershipCount = 0;
  for (const ownership of ownerships) {
    if (behaviorTitleKeys.has(ownership.title_key)) behaviorOwnershipCount += 1;
  }

  const seriesMasteries = store.listSeriesMasteries(userId).map((m) => ({ catalogKey: m.catalogKey, seriesKey: m.seriesKey }));

  const collectionEditions: MetaCollectionEditionSnapshot[] = store.listCollectionEditions().map((edition) => {
    const progress = store.collectionEditionProgress(userId, edition.editionKey);
    return {
      editionKey: edition.editionKey,
      state: edition.closedAt === null ? "active" : "closed",
      milestones: {
        startedCollecting: edition.milestones.startedCollecting,
        collectorHabit: edition.milestones.collectorHabit,
        stillCollecting: edition.milestones.stillCollecting,
        thousandMarks: {
          count: edition.milestones.thousandMarks.count,
          domains: edition.milestones.thousandMarks.domains,
        },
        almostComplete: { remaining: edition.milestones.almostComplete.remaining },
      },
      progress: {
        collectionOwnedCount: progress.collectionOwnedCount,
        collectionTotalCount: progress.collectionTotalCount,
        collectionOwnedDomainCount: progress.collectionOwnedDomainCount,
        collectionTotalDomainCount: progress.collectionTotalDomainCount,
        fullClearOwnedCount: progress.fullClearOwnedCount,
        fullClearRequiredCount: progress.fullClearRequiredCount,
        fullClearRemainingCount: progress.fullClearRemainingCount,
        fullClearComplete: progress.fullClearComplete,
      },
    };
  });

  return deepFreeze({ behaviorOwnershipCount, seriesMasteries, collectionEditions });
}

export interface MetaTitleEvaluationResult {
  readonly titleKey: string;
  /** disabled titleはscopeを解決しないためnull。それ以外は必ずresolveTitleScope()由来。 */
  readonly scopeKey: string | null;
  readonly outcome: TitleAwardOutcome;
  readonly matched: boolean;
  /** meta titleのearnedAtは常にnull（§4）。 */
  readonly earnedAt: null;
  readonly awardFacts?: TitleAwardFacts;
  readonly ownershipCreated?: boolean;
}

/**
 * 1つのmeta rule × 1人を、既に構築済みのsnapshotで評価する
 * （internal——`v2.ts`/rootからはexportしない、§16）。呼び出し側（`v2-pipeline.ts`）が
 * snapshotをpass開始前に1回だけ構築し、全meta ruleへ同じsnapshotを渡す（§22）——
 * ここではsnapshotを受け取るだけで、自分では構築し直さない。
 *
 * behavior evaluatorの `evaluateTitle()` と同じ堅牢性を持たせる（§5, §47）:
 * - definitionはevaluate()呼び出し前に独立したcopyを作り、以降はそのcopyだけを使う
 *   （rule実装がevaluate()の中で自分のdefinitionを書き換えても、以降の判定へ影響しない）
 * - result.matchedはstrict boolean（truthy/falsyへ頼らない）
 * - matched:falseにawardFactsが存在したらreject
 * - matched:trueならawardFacts必須、かつassertValidAwardFacts()を通す
 * - lifecycle:disabledはscopeを解決せずrule.evaluate()自体を呼ばない
 * - lifecycle:retiredはmatchedでも新規awardしない（既存awardの有無だけ見る）
 *
 * scopeはbehavior title同様、`resolveTitleScope()` だけが作る（§25）——meta title
 * はglobal scope限定なので常に`SYSTEM_EPOCH`起点のcanonical scopeになる。
 * award時は必ず`earnedAt: null`を渡す（§4, §55）。
 */
export function evaluateMetaTitle(
  store: TitleV2Store,
  rule: MetaTitleRule,
  userId: string,
  observedAt: number,
  snapshot: TitleMetaSnapshot,
): MetaTitleEvaluationResult {
  const definition = defineMetaTitle({ ...rule.definition });
  assertValidFactsVersion(rule.awardFactsVersion, `meta title ${definition.key}: awardFactsVersion`);

  if (definition.lifecycle === "disabled") {
    return { titleKey: definition.key, scopeKey: null, outcome: "skipped", matched: false, earnedAt: null };
  }

  const resolvedScope = resolveTitleScope(store, definition, observedAt);
  const result = rule.evaluate({ scope: toRuleScope(resolvedScope), snapshot });

  if (result.matched !== true && result.matched !== false) {
    throw new Error(
      `meta title rule ${definition.key} returned a non-boolean matched value (contract violation): ${JSON.stringify((result as { matched: unknown }).matched)}`,
    );
  }

  if (!result.matched) {
    if ((result as { awardFacts?: unknown }).awardFacts !== undefined) {
      throw new Error(`meta title rule ${definition.key} returned matched:false with awardFacts set (contract violation)`);
    }
    return { titleKey: definition.key, scopeKey: resolvedScope.scopeKey, outcome: "not_matched", matched: false, earnedAt: null };
  }

  assertValidAwardFacts(result.awardFacts, `meta title ${definition.key} awardFacts`);

  if (definition.lifecycle === "retired") {
    const outcome: TitleAwardOutcome = store.hasAward(userId, definition.key, resolvedScope.scopeKey)
      ? "already_awarded"
      : "skipped";
    return {
      titleKey: definition.key,
      scopeKey: resolvedScope.scopeKey,
      outcome,
      matched: true,
      earnedAt: null,
      awardFacts: result.awardFacts,
    };
  }

  const awardResult = store.award({
    userId,
    titleKey: definition.key,
    scope: resolvedScope,
    earnedAt: null,
    awardFacts: { version: rule.awardFactsVersion, data: result.awardFacts },
  });

  return {
    titleKey: definition.key,
    scopeKey: resolvedScope.scopeKey,
    outcome: awardResult.status,
    matched: true,
    earnedAt: null,
    awardFacts: result.awardFacts,
    ownershipCreated: awardResult.ownershipCreated,
  };
}
