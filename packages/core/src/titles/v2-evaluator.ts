import type Database from "better-sqlite3";
import { TITLE_SOURCES, defineTitle, type TitleDefinition, type TitleSourceDefinition, type TitleUsableSourceKey } from "./v2-contract.js";
import { TitleSourceCache, type TitleEvaluationScope, type TitleSourcePayloads } from "./v2-sources.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * ruleへ渡すcontext。sourcesは `definition.sources` で宣言したsourceのpayloadだけを持つ
 * ——宣言していないsourceはこのオブジェクトに存在しない（型の上でも実体の上でも）。
 */
export interface TitleRuleContext<S extends readonly TitleUsableSourceKey[]> {
  readonly userId: string;
  readonly scope: TitleEvaluationScope;
  readonly sources: { readonly [K in S[number]]: TitleSourcePayloads[K] };
}

export interface TitleRuleResult {
  readonly matched: boolean;
  /**
   * 条件を満たした実時刻。証明できないなら null。
   * ruleが宣言する全sourceがorderable:trueでない限り、non-nullを返してもevaluateTitle()
   * がrejectする（§11）。
   */
  readonly earnedAt: number | null;
  /**
   * 通知・本人向け説明のための安全な事実だけ。counterpartのuserId・raw Discord
   * message ID・restricted sourceのidentity・内部SQL rowを入れてはいけない
   * ——sourceのpayload自体が既にsanitize済みなので、それをそのまま返す分には安全。
   */
  readonly publicFacts?: Readonly<Record<string, unknown>>;
}

/** カタログ作者が実装する称号1つぶんの判定ロジック。raw DBへは触れない。 */
export interface TitleRule<S extends readonly TitleUsableSourceKey[] = readonly TitleUsableSourceKey[]> {
  readonly definition: TitleDefinition & { readonly sources: S };
  evaluate(context: TitleRuleContext<S>): TitleRuleResult;
}

/**
 * `defineTitle()` の検証（v2名前空間・登録source・titleUsable・hidden/completion整合）を
 * 通したTitleRuleを組み立てる。
 */
export function defineTitleRule<S extends readonly TitleUsableSourceKey[]>(
  definition: TitleDefinition & { readonly sources: S },
  evaluate: (context: TitleRuleContext<S>) => TitleRuleResult,
): TitleRule<S> {
  const validated = defineTitle(definition);
  return { definition: validated as TitleDefinition & { readonly sources: S }, evaluate };
}

function sourceDefinitionOf(key: TitleUsableSourceKey): TitleSourceDefinition {
  const definition = (TITLE_SOURCES as Record<string, TitleSourceDefinition>)[key as string];
  if (!definition) throw new Error(`unknown title source: ${String(key)}`);
  return definition;
}

/** ruleが宣言した全sourceがorderable:trueのときだけ、正確なearnedAtを主張してよい。 */
function allSourcesOrderable(sources: readonly TitleUsableSourceKey[]): boolean {
  return sources.every((key) => sourceDefinitionOf(key).orderable === true);
}

export type TitleAwardOutcome = "awarded" | "already_awarded" | "not_matched" | "skipped";

export interface TitleEvaluationResult {
  readonly titleKey: string;
  readonly scopeKey: string;
  readonly outcome: TitleAwardOutcome;
  readonly matched: boolean;
  readonly earnedAt: number | null;
  readonly publicFacts?: Readonly<Record<string, unknown>>;
}

/**
 * 1つのrule × 1人 × 1scopeを評価し、matchedならTitleV2Storeへawardする。
 *
 * - lifecycle:'disabled' は新規評価しない（sourceも一切読まずに'skipped'を返す）。
 * - lifecycle:'retired' はmatchedでも新規awardしない。既存awardがあれば
 *   'already_awarded'（保持したまま）、無ければ'skipped'。
 * - source読み込みで例外が起きたら、ここで握り潰さずそのまま呼び出し側へ伝播する
 *   （「条件未達」として誤魔化さない。fail-closed）。
 */
export function evaluateTitle<S extends readonly TitleUsableSourceKey[]>(
  db: Database.Database,
  store: TitleV2Store,
  rule: TitleRule<S>,
  userId: string,
  scope: TitleEvaluationScope,
  cache: TitleSourceCache = new TitleSourceCache(),
): TitleEvaluationResult {
  const { definition } = rule;

  if (definition.lifecycle === "disabled") {
    return { titleKey: definition.key, scopeKey: scope.scopeKey, outcome: "skipped", matched: false, earnedAt: null };
  }

  const sources = {} as { [K in S[number]]: TitleSourcePayloads[K] };
  for (const sourceKey of definition.sources) {
    (sources as Record<string, unknown>)[sourceKey] = cache.get(db, sourceKey, userId, scope);
  }

  const result = rule.evaluate({ userId, scope, sources });

  if (result.earnedAt !== null && !allSourcesOrderable(definition.sources)) {
    throw new Error(
      `title rule ${definition.key} returned a non-null earnedAt but depends on a non-orderable source; ` +
        `only rules whose every declared source has orderable:true may claim an exact earnedAt`,
    );
  }

  if (!result.matched) {
    return {
      titleKey: definition.key,
      scopeKey: scope.scopeKey,
      outcome: "not_matched",
      matched: false,
      earnedAt: null,
      publicFacts: result.publicFacts,
    };
  }

  if (definition.lifecycle === "retired") {
    const outcome: TitleAwardOutcome = store.hasAward(userId, definition.key, scope.scopeKey)
      ? "already_awarded"
      : "skipped";
    return {
      titleKey: definition.key,
      scopeKey: scope.scopeKey,
      outcome,
      matched: true,
      earnedAt: result.earnedAt,
      publicFacts: result.publicFacts,
    };
  }

  const awarded = store.award({ userId, titleKey: definition.key, scopeKey: scope.scopeKey, earnedAt: result.earnedAt });
  return {
    titleKey: definition.key,
    scopeKey: scope.scopeKey,
    outcome: awarded ? "awarded" : "already_awarded",
    matched: true,
    earnedAt: result.earnedAt,
    publicFacts: result.publicFacts,
  };
}

/**
 * 1人について複数ruleを評価する。同じbatch内で複数ruleが同じsourceを宣言していても、
 * source読み込みは1回だけ（TitleSourceCacheを共有するため）。
 */
export function evaluateUser(
  db: Database.Database,
  store: TitleV2Store,
  rules: readonly TitleRule<any>[],
  userId: string,
  scope: TitleEvaluationScope,
): TitleEvaluationResult[] {
  const cache = new TitleSourceCache();
  return rules.map((rule) => evaluateTitle(db, store, rule, userId, scope, cache));
}

/**
 * 複数人 × 複数ruleを評価する（日次reconcile等のbatch経路を想定）。
 * cacheはbatch全体で共有する——同じuser×同じsourceの重複読み込みはuser単位でも防ぐ。
 */
export function evaluateBatch(
  db: Database.Database,
  store: TitleV2Store,
  rules: readonly TitleRule<any>[],
  userIds: readonly string[],
  scope: TitleEvaluationScope,
): TitleEvaluationResult[] {
  const cache = new TitleSourceCache();
  const results: TitleEvaluationResult[] = [];
  for (const userId of userIds) {
    for (const rule of rules) {
      results.push(evaluateTitle(db, store, rule, userId, scope, cache));
    }
  }
  return results;
}
