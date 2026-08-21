import type Database from "better-sqlite3";
import {
  TITLE_SOURCES,
  defineBehaviorTitle,
  type BehaviorTitleDefinition,
  type TitleSourceDefinition,
  type TitleUsableSourceKey,
} from "./v2-contract.js";
import { TitleSourceCache, type TitleSourcePayloads } from "./v2-sources.js";
import {
  resolveTitleScope,
  toRuleScope,
  type TitleEventScopeProvider,
  type TitleMonthSelector,
  type TitleRuleScope,
} from "./v2-scope.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * ruleへ渡すcontext。sourcesは `definition.sources` で宣言したsourceのpayloadだけを持つ
 * ——宣言していないsourceはこのオブジェクトに存在しない（型の上でも実体の上でも）。
 * scopeはresolveTitleScope()が作った値からbrandを除いたcopy——ruleがどういじっても
 * evaluator内部のscopeには影響しない（v2-scope.ts参照）。
 */
export interface TitleRuleContext<S extends readonly TitleUsableSourceKey[]> {
  readonly userId: string;
  readonly scope: TitleRuleScope;
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
   * award時にpersistする予定の、安全な事実だけ。counterpartのuserId・raw Discord
   * message ID・channel ID・restricted sourceのidentity・内部SQL rowを入れてはいけない。
   * sourceのpayload自体は既にsanitize済みだが、payloadを丸ごとcopyしない
   * ——channelId等、条件判定には要るが公開説明には要らないフィールドをそのまま流さない。
   * ruleが本当に必要な値だけを組み立てて返すこと。DB永続化は後続PR。
   */
  readonly awardFacts?: Readonly<Record<string, unknown>>;
}

/** カタログ作者が実装する称号1つぶんの判定ロジック。raw DBへは触れない。 */
export interface TitleRule<S extends readonly TitleUsableSourceKey[] = readonly TitleUsableSourceKey[]> {
  readonly definition: BehaviorTitleDefinition & { readonly sources: S };
  evaluate(context: TitleRuleContext<S>): TitleRuleResult;
}

/**
 * `defineBehaviorTitle()` の検証（v2名前空間・登録source・titleUsable・sources/triggers
 * 最低1件・trigger重複禁止）を通したTitleRuleを組み立てる。
 *
 * definitionはBehaviorTitleDefinitionしか受け付けない——meta titleをevaluateTitle()へ
 * 渡せないようにするため、TitleRule自体の型がmeta titleを表現できない設計にしてある。
 */
export function defineTitleRule<S extends readonly TitleUsableSourceKey[]>(
  definition: BehaviorTitleDefinition & { readonly sources: S },
  evaluate: (context: TitleRuleContext<S>) => TitleRuleResult,
): TitleRule<S> {
  const validated = defineBehaviorTitle(definition);
  return { definition: validated as BehaviorTitleDefinition & { readonly sources: S }, evaluate };
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
  /** disabled titleはscopeを解決しないためnull。それ以外は必ずresolveTitleScope()由来。 */
  readonly scopeKey: string | null;
  readonly outcome: TitleAwardOutcome;
  readonly matched: boolean;
  readonly earnedAt: number | null;
  readonly awardFacts?: Readonly<Record<string, unknown>>;
}

export interface TitleEvaluationOptions {
  readonly cache?: TitleSourceCache;
  /** event scope policyを使うruleを評価する場合に必須。無ければfail-closedする。 */
  readonly eventProvider?: TitleEventScopeProvider;
  /** month scope policyの対象月。省略時は`{type:"current"}`（observedAtが属する月）。 */
  readonly monthSelector?: TitleMonthSelector;
}

/**
 * 1つのrule × 1人を評価し、matchedならTitleV2Storeへawardする。
 *
 * scopeはcallerから受け取らない。callerが渡すのは `observedAt` だけで、
 * `definition.scope` + store（system/catalog epoch）から resolveTitleScope() が
 * scopeを作る——callerが任意のscopeKeyやwindowを注入できる経路を無くすため。
 *
 * - lifecycle:'disabled' は新規評価しない（scope解決もsource読み込みもせずに'skipped'を返す）。
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
  observedAt: number,
  options: TitleEvaluationOptions = {},
): TitleEvaluationResult {
  // TitleRuleは公開structural interfaceなので、defineTitleRule()を経由せず手で組み立てた
  // り、構築後にdefinitionを書き換えたりできてしまう（実際、このファイル自身のテストが
  // defineTitleRuleを迂回したruleを作って検証している）。defineBehaviorTitle()の検証
  // （v2名前空間・source最低1件・登録済みsource・titleUsable・trigger整合）を
  // ここでも必ず通す——さもないと sources:[] のruleが「何も読まずに任意のearnedAtで
  // award」を通せてしまい、「source contractを条件実装から迂回させない」が破れる。
  //
  // ただし defineBehaviorTitle() はdefinitionをcopyせず同じobjectを返すため、それだけ
  // では足りない——rule.evaluate() の実行中に rule.definition（同一参照）を書き換え
  // られると、評価後のorderable判定がその改竄後の値を見てしまう（入口の再検証を
  // すり抜ける）。sources/triggersを含めて独立したcopyを作り、以降はこのcopyだけを使う。
  const definition = defineBehaviorTitle({
    ...rule.definition,
    sources: [...rule.definition.sources],
    triggers: [...rule.definition.triggers],
  });

  if (definition.lifecycle === "disabled") {
    // scopeKeyはscope解決前なので不明。disabledは新規評価しない契約のため、
    // scopeKeyを持たない'skipped'として返す（storeへは一切触れない）。空文字列は
    // 「globalなど何らかのscopeKeyが空である」と誤読され得るため、明示的にnullにする。
    return { titleKey: definition.key, scopeKey: null, outcome: "skipped", matched: false, earnedAt: null };
  }

  const resolvedScope = resolveTitleScope(store, definition, observedAt, {
    eventProvider: options.eventProvider,
    monthSelector: options.monthSelector,
  });
  const cache = options.cache ?? new TitleSourceCache();

  const sources = {} as { [K in S[number]]: TitleSourcePayloads[K] };
  for (const sourceKey of definition.sources) {
    (sources as Record<string, unknown>)[sourceKey] = cache.get(db, sourceKey, userId, resolvedScope);
  }

  const result = rule.evaluate({ userId, scope: toRuleScope(resolvedScope), sources });

  if (result.earnedAt !== null && !allSourcesOrderable(definition.sources)) {
    throw new Error(
      `title rule ${definition.key} returned a non-null earnedAt but depends on a non-orderable source; ` +
        `only rules whose every declared source has orderable:true may claim an exact earnedAt`,
    );
  }

  if (!result.matched) {
    return {
      titleKey: definition.key,
      scopeKey: resolvedScope.scopeKey,
      outcome: "not_matched",
      matched: false,
      earnedAt: null,
      awardFacts: result.awardFacts,
    };
  }

  if (definition.lifecycle === "retired") {
    const outcome: TitleAwardOutcome = store.hasAward(userId, definition.key, resolvedScope.scopeKey)
      ? "already_awarded"
      : "skipped";
    return {
      titleKey: definition.key,
      scopeKey: resolvedScope.scopeKey,
      outcome,
      matched: true,
      earnedAt: result.earnedAt,
      awardFacts: result.awardFacts,
    };
  }

  const awarded = store.award({
    userId,
    titleKey: definition.key,
    scopeKey: resolvedScope.scopeKey,
    earnedAt: result.earnedAt,
  });
  return {
    titleKey: definition.key,
    scopeKey: resolvedScope.scopeKey,
    outcome: awarded ? "awarded" : "already_awarded",
    matched: true,
    earnedAt: result.earnedAt,
    awardFacts: result.awardFacts,
  };
}

/**
 * 1人について複数ruleを評価する。同じbatch内で複数ruleが同じ(source, resolved scope)
 * を宣言していても、source読み込みは1回だけ（TitleSourceCacheを共有するため）。
 * ruleごとにscope policyが異なってもよい——resolveTitleScope()はrule単位で呼ばれる。
 */
export function evaluateUser(
  db: Database.Database,
  store: TitleV2Store,
  rules: readonly TitleRule<any>[],
  userId: string,
  observedAt: number,
  options: TitleEvaluationOptions = {},
): TitleEvaluationResult[] {
  const cache = options.cache ?? new TitleSourceCache();
  return rules.map((rule) => evaluateTitle(db, store, rule, userId, observedAt, { ...options, cache }));
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
  observedAt: number,
  options: TitleEvaluationOptions = {},
): TitleEvaluationResult[] {
  const cache = options.cache ?? new TitleSourceCache();
  const results: TitleEvaluationResult[] = [];
  for (const userId of userIds) {
    for (const rule of rules) {
      results.push(evaluateTitle(db, store, rule, userId, observedAt, { ...options, cache }));
    }
  }
  return results;
}
