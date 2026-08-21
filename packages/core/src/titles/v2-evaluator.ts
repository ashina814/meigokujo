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
import { assertValidAwardFacts, assertValidFactsVersion, type TitleAwardFacts } from "./v2-award-facts.js";
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

/**
 * PR B1: matched:falseとmatched:trueをdiscriminated unionへ分離した。
 *
 * - matched:false: earnedAtは常にnull。awardFactsは持たない（＝そもそも「award rowは
 *   あるがfacts rowが無い」という状態を型の上で作れない）。
 * - matched:true: earnedAtはorderable契約に従う（§11、evaluateTitle()参照）。
 *   awardFactsは**必須**——取得理由が特に無い称号でも `awardFacts: {}` を明示的に
 *   返すこと。counterpartのuserId・raw Discord message ID・channel ID・restricted
 *   sourceのidentity・内部SQL row・sourceのpayload丸ごとを入れてはいけない
 *   （v2-award-facts.tsのban listとdoc comment参照）。
 */
export type TitleRuleResult =
  | { readonly matched: false; readonly earnedAt: null }
  | { readonly matched: true; readonly earnedAt: number | null; readonly awardFacts: TitleAwardFacts };

/** カタログ作者が実装する称号1つぶんの判定ロジック。raw DBへは触れない。 */
export interface TitleRule<S extends readonly TitleUsableSourceKey[] = readonly TitleUsableSourceKey[]> {
  readonly definition: BehaviorTitleDefinition & { readonly sources: S };
  /**
   * awardFacts JSONのschema version。title condition/source/threshold/scopeの変更は
   * 新title keyで表現するのに対し、awardFacts JSONの**形式だけ**変更したい場合は
   * このversionを上げる——rule実装側に固定することで、rule.evaluate()の戻り値ごとに
   * versionを付け忘れる事故を防ぐ。
   */
  readonly awardFactsVersion: number;
  evaluate(context: TitleRuleContext<S>): TitleRuleResult;
}

/** defineTitleRule()の第2引数。 */
export interface TitleRuleImplementation<S extends readonly TitleUsableSourceKey[]> {
  readonly awardFactsVersion: number;
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
  impl: TitleRuleImplementation<S>,
): TitleRule<S> {
  const validated = defineBehaviorTitle(definition);
  assertValidFactsVersion(impl.awardFactsVersion, `title ${definition.key}: awardFactsVersion`);
  return {
    definition: validated as BehaviorTitleDefinition & { readonly sources: S },
    awardFactsVersion: impl.awardFactsVersion,
    evaluate: impl.evaluate,
  };
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
  /** matchedのときだけ存在する（TitleRuleResultのdiscriminated unionと同じ形）。 */
  readonly awardFacts?: TitleAwardFacts;
  /** outcome==="awarded"のときだけ意味を持つ。そのawardでtitleKeyのownershipが初めて作られたか。 */
  readonly ownershipCreated?: boolean;
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
 * - matchedのawardFactsは、実際にstoreへ書き込むかどうかに関わらずここで検証する
 *   （retired titleのようにDBへ書かないpathでも、rule実装の不備をfail-closedで検出する）。
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
  assertValidFactsVersion(rule.awardFactsVersion, `title ${definition.key}: awardFactsVersion`);

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

  // TypeScriptを迂回したruleが`matched: "false"`や`matched: 0`のような非boolean値を
  // 返すと、直後の`if (!result.matched)`がJSの truthy/falsy 変換に頼ることになり、
  // discriminated unionのnarrowingが実際のfield構成と食い違ったまま先へ進んでしまう
  // （例: `matched: "false"`は文字列として truthy なので matched:true 分岐へ入るが、
  // 型上は`{matched:true; awardFacts: TitleAwardFacts}`のはずのresultに実際は
  // awardFactsが無い、といった矛盾）。ここで明示的にboolean型であることを強制する。
  if (result.matched !== true && result.matched !== false) {
    throw new Error(
      `title rule ${definition.key} returned a non-boolean matched value (contract violation): ${JSON.stringify((result as { matched: unknown }).matched)}`,
    );
  }

  if (result.earnedAt !== null && !allSourcesOrderable(definition.sources)) {
    throw new Error(
      `title rule ${definition.key} returned a non-null earnedAt but depends on a non-orderable source; ` +
        `only rules whose every declared source has orderable:true may claim an exact earnedAt`,
    );
  }

  if (!result.matched) {
    // TitleRuleは公開structural interfaceで、TitleRuleResultのdiscriminated union も
    // TypeScriptの型検査を迂回されればruntimeでは強制されない。matched:falseなのに
    // earnedAtが非nullなruleは契約違反としてfail-closedする——「マッチしていないのに
    // 達成時刻がある」という矛盾を通さない。awardFactsが（本来型上は存在しないはずの）
    // 値を持っている場合も同様に拒否する——黙って無視すると、ruleのロジックバグ
    // （本来matched:trueで返すべきだった等）を見逃す。
    if ((result as { earnedAt: unknown }).earnedAt !== null) {
      throw new Error(`title rule ${definition.key} returned matched:false with a non-null earnedAt (contract violation)`);
    }
    if ((result as { awardFacts?: unknown }).awardFacts !== undefined) {
      throw new Error(`title rule ${definition.key} returned matched:false with awardFacts set (contract violation)`);
    }
    return { titleKey: definition.key, scopeKey: resolvedScope.scopeKey, outcome: "not_matched", matched: false, earnedAt: null };
  }

  // 「award rowはあるがfacts rowが無い」という状態を作らないため、DBへ書くかどうかに
  // 関わらずここで必ず検証する（retired titleのpathでもrule実装の不備を検出する）。
  assertValidAwardFacts(result.awardFacts, `title ${definition.key} awardFacts`);

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

  const awardResult = store.award({
    userId,
    titleKey: definition.key,
    scope: resolvedScope,
    earnedAt: result.earnedAt,
    awardFacts: { version: rule.awardFactsVersion, data: result.awardFacts },
  });
  return {
    titleKey: definition.key,
    scopeKey: resolvedScope.scopeKey,
    outcome: awardResult.status,
    matched: true,
    earnedAt: result.earnedAt,
    awardFacts: result.awardFacts,
    ownershipCreated: awardResult.ownershipCreated,
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
