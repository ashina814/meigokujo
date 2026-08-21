import type Database from "better-sqlite3";
import {
  defineBehaviorTitle,
  defineMetaTitle,
  type BehaviorTitleDefinition,
  type MetaTitleDefinition,
  type TitleTrigger,
} from "./v2-contract.js";
import { assertValidFactsVersion } from "./v2-award-facts.js";
import {
  evaluateTitle,
  type TitleEvaluationOptions,
  type TitleEvaluationResult,
  type TitleRule,
} from "./v2-evaluator.js";
import { TitleSourceCache } from "./v2-sources.js";
import { buildMetaSnapshot, evaluateMetaTitle, type MetaTitleEvaluationResult, type MetaTitleRule } from "./v2-meta.js";
import {
  evaluateRelationshipTitle,
  type RelationshipTitleEvaluationResult,
  type RelationshipTitleRule,
} from "./v2-relationship.js";
import type { ReconcileSeriesMasteriesResult } from "./v2-series-store.js";
import type { TitleV2Store } from "./v2-store.js";

/**
 * behavior/meta ruleをまとめる評価planと、それを実行するevaluation orchestration
 * kernel（PR C1）。
 *
 * 評価順序は必ず: behavior → ownership（Store側で確定済み） → Series Mastery reconcile →
 * Meta snapshot構築 → Meta評価。この順序を変えると《一門皆伝》《千印万来》のようなmeta
 * titleが、同じpass内で成立したばかりのSeries mastery/behavior awardを見られなくなる
 * ——`evaluateUserPipeline()` がこの順序を固定する唯一のAPI。
 *
 * PR #156レビュー: plan provenance（round 2レビュー対応）。`v2-scope.ts` の
 * `ResolvedTitleScope`/`RESOLVED_SCOPE_PROVENANCE` と同じ思想——TypeScript brandだけでは
 * `defineTitleEvaluationPlan()` を経由しない手書きplanや、正規plan構築後の
 * `(plan as any).behaviorRules = forgedRules` のようなfield差し替え、`{ ...realPlan }`
 * のようなshallow copyをruntimeで検出できない。`PLAN_PROVENANCE: WeakMap<object,
 * CompiledTitleEvaluationPlan>` をexact object identityの正本にし、
 * `evaluateUserPipeline()`/`evaluateBatchPipeline()` は必ずこのWeakMapから引いた
 * canonical compiled planだけを読む——callerへ渡す`TitleEvaluationPlan`（public plan）の
 * fieldsは実行時のtrigger filtering/behaviorOwnershipCount分類には一切使わない。
 *
 * PR C2: `relationshipRules`（`RelationshipTitleRule[]`）を追加。generic behavior
 * ownershipとの区別なく、`behaviorOwnershipCount`（Meta snapshot）へは
 * genericBehavior + relationshipBehaviorの両方を数える——meta ownershipだけを
 * 数えない既存契約（C1）はそのまま維持する。plan provenanceの防御は
 * relationshipRulesにも同じcanonicalize/freezeを適用する（既存防御を弱めない）。
 */

/**
 * behavior rule/meta ruleの束。`released ruleをplanから消さない`契約（§18、docs参照）
 * ——planは「今activeなtitleだけの一覧」ではなく、v2 runtimeが知っているreleased
 * definitions/rulesのregistry。retired/disabledなruleも残す（lifecycleはrule/definition
 * 自身が制御する）。これにより`behaviorOwnershipCount`等が、historical ownershipの
 * kind判定（そのtitleKeyが「behavior title」だったか）を維持できる。
 *
 * この型自体はcallerが手書きできてしまう（`defineTitleEvaluationPlan()`を経由しない
 * plain object literal）——それを実行時に検出するのが`PLAN_PROVENANCE`（下記）。
 */
export interface TitleEvaluationPlan {
  readonly behaviorRules: readonly TitleRule<any>[];
  readonly metaRules: readonly MetaTitleRule[];
  readonly relationshipRules: readonly RelationshipTitleRule[];
}

/**
 * `defineTitleEvaluationPlan()`が確定した、canonical・immutableなcompiled plan。
 *
 * public `TitleEvaluationPlan` はcallerが元々渡したrule参照をそのまま持つ（後方互換・
 * introspection用）が、pipeline自身の判断（trigger filtering・behaviorOwnershipCount・
 * meta rule iteration・key identity）はこちらだけを見る。`definition`はvalidation時に
 * shallow copy + sources/triggers/scope/progressionをcopyしてfreezeしたcanonical
 * snapshot——callerが元のrule.definitionを後からTypeScriptを迂回して書き換えても、
 * ここへは一切反映されない（A案：define時点でsnapshotを作り切る、round 2レビュー§4）。
 * `evaluate`は元のfunction参照をそのまま保持してよい（function自体の同一性は
 * plan semanticsに影響しない）。
 */
interface CompiledTitleEvaluationPlan {
  readonly behaviorRules: readonly TitleRule<any>[];
  readonly metaRules: readonly MetaTitleRule[];
  readonly relationshipRules: readonly RelationshipTitleRule[];
}

/**
 * runtimeのforgery検知の正本。keyは`TitleEvaluationPlan`のexact object identityそのもの
 * ——`v2-scope.ts`の`RESOLVED_SCOPE_PROVENANCE`と同じ理由で、`{ ...realPlan }`の
 * ようなshallow copyやProxyでのラップはここに載らない。値は`defineTitleEvaluationPlan()`
 * の中でしか`.set()`しない。
 */
const PLAN_PROVENANCE = new WeakMap<object, CompiledTitleEvaluationPlan>();

/** behavior definitionのcanonical snapshotを作る。sources/triggers/scope/progressionまでcopy+freezeする。 */
function canonicalizeBehaviorDefinition(definition: BehaviorTitleDefinition): BehaviorTitleDefinition {
  return Object.freeze({
    ...definition,
    sources: Object.freeze([...definition.sources]),
    triggers: Object.freeze([...definition.triggers]),
    scope: Object.freeze({ ...definition.scope }),
    ...(definition.progression ? { progression: Object.freeze({ ...definition.progression }) } : {}),
  });
}

/** meta definitionのcanonical snapshotを作る。scopeまでcopy+freezeする。 */
function canonicalizeMetaDefinition(definition: MetaTitleDefinition): MetaTitleDefinition {
  return Object.freeze({
    ...definition,
    scope: Object.freeze({ ...definition.scope }),
  });
}

/**
 * relationship definitionのcanonical snapshotを作る（PR C2）。`RelationshipTitleRule.
 * definition`は`BehaviorTitleDefinition`（sources tupleが`["vc_social_safe"]`に narrow
 * されているだけ）なので、`canonicalizeBehaviorDefinition()`をそのまま再利用する。
 */
function canonicalizeRelationshipDefinition(
  definition: BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] },
): BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] } {
  return canonicalizeBehaviorDefinition(definition) as unknown as BehaviorTitleDefinition & {
    readonly sources: readonly ["vc_social_safe"];
  };
}

/**
 * `plan`が本当に`defineTitleEvaluationPlan()`の産物かをruntimeで確認し、
 * canonical compiled planを返す。`v2-scope.ts`の`assertResolvedTitleScope()`と同じ構造
 * ——正本はWeakMap identity。`plan`という**まさにそのobject参照**が登録されていなければ
 * forgeryとして拒否する（手書きplan・shallow copy・Proxy包みのいずれも）。
 */
function requirePlanProvenance(plan: TitleEvaluationPlan): CompiledTitleEvaluationPlan {
  if (plan === null || typeof plan !== "object") {
    throw new Error("evaluation plan was not produced by defineTitleEvaluationPlan() (forged or hand-built TitleEvaluationPlan)");
  }
  const compiled = PLAN_PROVENANCE.get(plan as unknown as object);
  if (!compiled) {
    throw new Error(
      "evaluation plan was not produced by defineTitleEvaluationPlan() (forged, hand-built, cloned, or proxied TitleEvaluationPlan)",
    );
  }
  return compiled;
}

/**
 * planを検証して組み立てる。
 *
 * - behavior rule定義はkind:"behavior"であること（`defineBehaviorTitle()`のruntime
 *   guardを通す——手で組み立てた/kindを書き換えたforged ruleもここで弾く、§46, §47）
 * - meta rule定義はkind:"meta"であること（`defineMetaTitle()`のruntime guardを通す）
 * - relationship rule定義はkind:"behavior"かつsourcesがexactly["vc_social_safe"]で
 *   あること（PR C2 §43）
 * - awardFactsVersionが妥当であること
 * - behavior rule key・meta rule key・relationship rule key、全横断での重複禁止
 *   （generic behavior + relationship behavior + meta、どの組でも同じv2 keyは使えない）
 *
 * 検証と同時にcanonical compiled planを構築し、`PLAN_PROVENANCE`へexact object identity
 * で登録する（round 2レビュー対応）。返す`TitleEvaluationPlan`はcallerが渡したrule
 * 参照をそのまま持つが、`Object.freeze()`する——構築後にcallerが配列へ要素をpush/splice
 * したり、`behaviorRules`/`metaRules`/`relationshipRules`自体を差し替えたりできないように
 * する（defense-in-depth。真の防御はWeakMap identityの方——下記`requirePlanProvenance()`参照）。
 *
 * `relationshipRules`は省略可（デフォルト`[]`）——既存の2引数呼び出しはそのまま動く（§42）。
 */
export function defineTitleEvaluationPlan(
  behaviorRules: readonly TitleRule<any>[],
  metaRules: readonly MetaTitleRule[],
  relationshipRules: readonly RelationshipTitleRule[] = [],
): TitleEvaluationPlan {
  const seenKeys = new Set<string>();
  const compiledBehaviorRules: TitleRule<any>[] = [];

  for (const rule of behaviorRules) {
    // kindをまず確認する——meta definitionが紛れ込んでいた場合、sources/triggers
    // フィールド自体が存在しないため、先に`[...rule.definition.sources]`を試みると
    // 「not iterable」という不親切なTypeErrorになってしまう。defineBehaviorTitle()自身も
    // kindを最初に検証するが、その手前でこの配列展開が失敗するため、ここで明示的に
    // 確認してから展開する。
    if ((rule.definition as { kind?: string }).kind !== "behavior") {
      throw new Error(
        `evaluation plan: defineBehaviorTitle() requires kind:"behavior" (got ${String((rule.definition as { kind?: string }).kind)})`,
      );
    }
    // evaluateTitle()と同じ理由（v2-evaluator.tsのdoc comment参照）——
    // definitionをcopyせず再検証すると、rule.definitionが後から書き換えられた場合に
    // ここでの検証をすり抜けられる。sources/triggersを含めて独立したcopyで検証する。
    const definition = defineBehaviorTitle({
      ...rule.definition,
      sources: [...rule.definition.sources],
      triggers: [...rule.definition.triggers],
    });
    assertValidFactsVersion(rule.awardFactsVersion, `evaluation plan: behavior rule ${definition.key} awardFactsVersion`);
    if (seenKeys.has(definition.key)) {
      throw new Error(`evaluation plan: duplicate title key ${definition.key} (behavior rule)`);
    }
    seenKeys.add(definition.key);

    // compiled側のdefinitionはさらにfreezeしたcanonical snapshot——callerが元の
    // rule.definitionを後から書き換えても、pipelineのtrigger filtering/
    // behaviorOwnershipCount分類には一切影響しない（round 2レビュー§3, §4）。
    compiledBehaviorRules.push({
      definition: canonicalizeBehaviorDefinition(definition),
      awardFactsVersion: rule.awardFactsVersion,
      evaluate: rule.evaluate,
    });
  }

  const compiledMetaRules: MetaTitleRule[] = [];
  for (const rule of metaRules) {
    const definition = defineMetaTitle({ ...rule.definition });
    assertValidFactsVersion(rule.awardFactsVersion, `evaluation plan: meta rule ${definition.key} awardFactsVersion`);
    if (seenKeys.has(definition.key)) {
      throw new Error(
        `evaluation plan: duplicate title key ${definition.key} (meta rule key collides with an existing behavior/meta key)`,
      );
    }
    seenKeys.add(definition.key);

    compiledMetaRules.push({
      definition: canonicalizeMetaDefinition(definition),
      awardFactsVersion: rule.awardFactsVersion,
      evaluate: rule.evaluate,
    });
  }

  const compiledRelationshipRules: RelationshipTitleRule[] = [];
  for (const rule of relationshipRules) {
    // 同じ理由（kindが紛れ込んだ場合、sources/triggers展開が不親切なTypeErrorになる前に確認）。
    if ((rule.definition as { kind?: string }).kind !== "behavior") {
      throw new Error(
        `evaluation plan: relationship rule ${String((rule.definition as { key?: string }).key)} must have kind:"behavior" ` +
          `(got ${String((rule.definition as { kind?: string }).kind)})`,
      );
    }
    const definition = defineBehaviorTitle({
      ...rule.definition,
      sources: [...rule.definition.sources],
      triggers: [...rule.definition.triggers],
    }) as unknown as BehaviorTitleDefinition & { readonly sources: readonly ["vc_social_safe"] };
    // defineRelationshipTitleRule()を経由しない手書きruleでも、sources契約
    // （exactly ["vc_social_safe"]、§6）をここで再検証する。
    if (definition.sources.length !== 1 || definition.sources[0] !== "vc_social_safe") {
      throw new Error(`evaluation plan: relationship rule ${definition.key} sources must be exactly ["vc_social_safe"]`);
    }
    assertValidFactsVersion(rule.awardFactsVersion, `evaluation plan: relationship rule ${definition.key} awardFactsVersion`);
    if (seenKeys.has(definition.key)) {
      throw new Error(
        `evaluation plan: duplicate title key ${definition.key} (relationship rule collides with an existing behavior/meta/relationship key)`,
      );
    }
    seenKeys.add(definition.key);

    compiledRelationshipRules.push({
      definition: canonicalizeRelationshipDefinition(definition),
      awardFactsVersion: rule.awardFactsVersion,
      evaluateCandidate: rule.evaluateCandidate,
    });
  }

  const compiled: CompiledTitleEvaluationPlan = Object.freeze({
    behaviorRules: Object.freeze(compiledBehaviorRules),
    metaRules: Object.freeze(compiledMetaRules),
    relationshipRules: Object.freeze(compiledRelationshipRules),
  });

  const publicPlan: TitleEvaluationPlan = Object.freeze({
    behaviorRules: Object.freeze([...behaviorRules]),
    metaRules: Object.freeze([...metaRules]),
    relationshipRules: Object.freeze([...relationshipRules]),
  });

  PLAN_PROVENANCE.set(publicPlan as unknown as object, compiled);
  return publicPlan;
}

/** `evaluateUserPipeline()`/`evaluateBatchPipeline()` のoptions。behavior stageへそのまま渡す。 */
export type TitlePipelineOptions = TitleEvaluationOptions;

/**
 * userごとのpipeline実行結果。新規取得だけに絞らず、各stage resultを返す
 * ——後続Bot wiringがaudit/通知判断しやすい形にする（§28）。
 */
export interface TitleUserPipelineResult {
  readonly userId: string;
  readonly trigger: TitleTrigger;
  readonly behavior: readonly TitleEvaluationResult[];
  /** counterpart identityは一切含まない（PR C2 §29, §47, §48）。 */
  readonly relationship: readonly RelationshipTitleEvaluationResult[];
  readonly series: ReconcileSeriesMasteriesResult;
  readonly meta: readonly MetaTitleEvaluationResult[];
}

/**
 * 1人分の evaluation kernel の中心API（§21、PR C2で§45へ拡張）。
 *
 * 順序を必ず固定する:
 *
 * 1. trigger対象のgeneric behavior rules（`rule.definition.triggers.includes(trigger)`）
 *    だけを評価する——`daily` trigger等を「全ruleを無条件評価する」魔法triggerにしない（§19）。
 * 2. trigger対象のrelationship behavior rulesを評価する（PR C2 §45）。restricted
 *    `vc_co_presence`を読むのはこのstageだけ——trigger対象外・disabled・retiredでは
 *    読まない（§40, §68）。
 * 3. `store.reconcileSeriesMasteriesForUser(userId)` をbehavior/relationship stage
 *    完了後に1回だけ呼ぶ（§34）——ruleがawardするたびに呼ばない。
 * 4. Meta snapshotを1回だけ構築する（§22, §35）——meta rule数だけDBを読み直さない。
 *    `behaviorOwnershipCount`にはgeneric behavior + relationship behaviorの両方の
 *    ownershipを数える（PR C2 §46）。
 * 5. 全meta ruleを、その同一frozen snapshotで評価する。
 *
 * 例外はfail-fastで即座に呼び出し元へ伝播する（§33）——途中のruleがthrowしても
 * 残りのruleをcatchして続行しない。個々のStore mutationはそれぞれ独立にatomicだが、
 * pipeline全体を外側transactionで包まない（§31）ため、部分的に完了した状態が残り得る
 * ——次回同じpipelineをretryすれば、既に完了した分は冪等にスキップされ、
 * 失敗した分だけ再試行される（§32, resumable）。
 *
 * `plan`は必ず`requirePlanProvenance()`でruntime検証する——手書きplan・shallow copy・
 * Proxy包みはここでreject。trigger filtering / behaviorOwnershipCount分類 /
 * meta rule iterationは、以降すべて`compiled`（canonical compiled plan）だけを読む。
 * `plan`（public plan）のfieldsはここから先、一切読まない。
 */
export function evaluateUserPipeline(
  db: Database.Database,
  store: TitleV2Store,
  plan: TitleEvaluationPlan,
  userId: string,
  observedAt: number,
  trigger: TitleTrigger,
  options: TitlePipelineOptions = {},
): TitleUserPipelineResult {
  const compiled = requirePlanProvenance(plan);
  const cache = options.cache ?? new TitleSourceCache();

  const behavior: TitleEvaluationResult[] = [];
  for (const rule of compiled.behaviorRules) {
    if (!rule.definition.triggers.includes(trigger)) continue;
    behavior.push(evaluateTitle(db, store, rule, userId, observedAt, { ...options, cache }));
  }

  const relationship: RelationshipTitleEvaluationResult[] = [];
  for (const rule of compiled.relationshipRules) {
    if (!rule.definition.triggers.includes(trigger)) continue;
    relationship.push(
      evaluateRelationshipTitle(db, store, rule, userId, observedAt, {
        eventProvider: options.eventProvider,
        monthSelector: options.monthSelector,
      }),
    );
  }

  const series = store.reconcileSeriesMasteriesForUser(userId);

  // behaviorTitleKeysはcompiled plan全体（retired/disabled含む、§18）から取る——
  // lifecycleで絞り込むと、過去に取得したretired behavior titleのownershipが
  // behaviorOwnershipCountから抜け落ちてしまう。generic behavior + relationship
  // behaviorの両方を数える（meta ownershipは数えない、PR C2 §46）。
  const behaviorTitleKeys = new Set([
    ...compiled.behaviorRules.map((rule) => rule.definition.key),
    ...compiled.relationshipRules.map((rule) => rule.definition.key),
  ]);
  const snapshot = buildMetaSnapshot(store, userId, behaviorTitleKeys);

  const meta: MetaTitleEvaluationResult[] = [];
  for (const rule of compiled.metaRules) {
    meta.push(evaluateMetaTitle(store, rule, userId, observedAt, snapshot));
  }

  return { userId, trigger, behavior, relationship, series, meta };
}

/**
 * 複数user向けのbatch実行（§29）。userごとに behavior→series→meta を完了させてから
 * 次userへ進む——全userのbehaviorを先に全部実行してからseries/metaへ進む二段階方式には
 * しない（1人分のpipeline orderを常に保つ）。
 *
 * `TitleSourceCache` はbatch全体で共有する（§30）——同じuser×同じsourceの重複読み込みを
 * batch内でも防ぐ。callerが`options.cache`を渡した場合はそのcacheを使う。
 *
 * `plan`のprovenance検証はuserごとの`evaluateUserPipeline()`呼び出し内で毎回行われる
 * ——batch全体で1回だけに最適化しない（WeakMap lookupはO(1)であり、検証を省略する
 * メリットより「途中でplanが差し替えられていないか」を毎回確認する安全性を優先する）。
 */
export function evaluateBatchPipeline(
  db: Database.Database,
  store: TitleV2Store,
  plan: TitleEvaluationPlan,
  userIds: readonly string[],
  observedAt: number,
  trigger: TitleTrigger,
  options: TitlePipelineOptions = {},
): TitleUserPipelineResult[] {
  const cache = options.cache ?? new TitleSourceCache();
  const results: TitleUserPipelineResult[] = [];
  for (const userId of userIds) {
    results.push(evaluateUserPipeline(db, store, plan, userId, observedAt, trigger, { ...options, cache }));
  }
  return results;
}
