import type Database from "better-sqlite3";
import { defineBehaviorTitle, defineMetaTitle, type TitleTrigger } from "./v2-contract.js";
import { assertValidFactsVersion } from "./v2-award-facts.js";
import {
  evaluateTitle,
  type TitleEvaluationOptions,
  type TitleEvaluationResult,
  type TitleRule,
} from "./v2-evaluator.js";
import { TitleSourceCache } from "./v2-sources.js";
import { buildMetaSnapshot, evaluateMetaTitle, type MetaTitleEvaluationResult, type MetaTitleRule } from "./v2-meta.js";
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
 */

/**
 * behavior rule/meta ruleの束。`released ruleをplanから消さない`契約（§18、docs参照）
 * ——planは「今activeなtitleだけの一覧」ではなく、v2 runtimeが知っているreleased
 * definitions/rulesのregistry。retired/disabledなruleも残す（lifecycleはrule/definition
 * 自身が制御する）。これにより`behaviorOwnershipCount`等が、historical ownershipの
 * kind判定（そのtitleKeyが「behavior title」だったか）を維持できる。
 */
export interface TitleEvaluationPlan {
  readonly behaviorRules: readonly TitleRule<any>[];
  readonly metaRules: readonly MetaTitleRule[];
}

/**
 * planを検証して組み立てる。
 *
 * - behavior rule定義はkind:"behavior"であること（`defineBehaviorTitle()`のruntime
 *   guardを通す——手で組み立てた/kindを書き換えたforged ruleもここで弾く、§46, §47）
 * - meta rule定義はkind:"meta"であること（`defineMetaTitle()`のruntime guardを通す）
 * - awardFactsVersionが妥当であること
 * - behavior rule key同士の重複禁止、meta rule key同士の重複禁止、
 *   behavior/meta横断でのkey重複禁止（同じv2 keyをbehaviorとmeta両方には使えない）
 *
 * 返り値の配列はfreezeする——構築後にcallerが配列へ要素をpush/spliceして
 * planを書き換えられないようにする。
 */
export function defineTitleEvaluationPlan(
  behaviorRules: readonly TitleRule<any>[],
  metaRules: readonly MetaTitleRule[],
): TitleEvaluationPlan {
  const seenKeys = new Set<string>();

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
  }

  for (const rule of metaRules) {
    const definition = defineMetaTitle({ ...rule.definition });
    assertValidFactsVersion(rule.awardFactsVersion, `evaluation plan: meta rule ${definition.key} awardFactsVersion`);
    if (seenKeys.has(definition.key)) {
      throw new Error(
        `evaluation plan: duplicate title key ${definition.key} (meta rule key collides with an existing behavior/meta key)`,
      );
    }
    seenKeys.add(definition.key);
  }

  return {
    behaviorRules: Object.freeze([...behaviorRules]),
    metaRules: Object.freeze([...metaRules]),
  };
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
  readonly series: ReconcileSeriesMasteriesResult;
  readonly meta: readonly MetaTitleEvaluationResult[];
}

/**
 * 1人分の evaluation kernel の中心API（§21）。
 *
 * 順序を必ず固定する:
 *
 * 1. trigger対象のbehavior rules（`rule.definition.triggers.includes(trigger)`）だけを
 *    評価する——`daily` trigger等を「全ruleを無条件評価する」魔法triggerにしない（§19）。
 * 2. `store.reconcileSeriesMasteriesForUser(userId)` をbehavior stage完了後に1回だけ
 *    呼ぶ（§34）——behavior ruleがawardするたびに呼ばない。
 * 3. Meta snapshotを1回だけ構築する（§22, §35）——meta rule数だけDBを読み直さない。
 * 4. 全meta ruleを、その同一frozen snapshotで評価する。
 *
 * 例外はfail-fastで即座に呼び出し元へ伝播する（§33）——途中のruleがthrowしても
 * 残りのruleをcatchして続行しない。個々のStore mutationはそれぞれ独立にatomicだが、
 * pipeline全体を外側transactionで包まない（§31）ため、部分的に完了した状態が残り得る
 * ——次回同じpipelineをretryすれば、既に完了した分は冪等にスキップされ、
 * 失敗した分だけ再試行される（§32, resumable）。
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
  const cache = options.cache ?? new TitleSourceCache();

  const behavior: TitleEvaluationResult[] = [];
  for (const rule of plan.behaviorRules) {
    if (!rule.definition.triggers.includes(trigger)) continue;
    behavior.push(evaluateTitle(db, store, rule, userId, observedAt, { ...options, cache }));
  }

  const series = store.reconcileSeriesMasteriesForUser(userId);

  // behaviorTitleKeysはplan全体（retired/disabled含む、§18）から取る——lifecycleで
  // 絞り込むと、過去に取得したretired behavior titleのownershipがbehaviorOwnershipCount
  // から抜け落ちてしまう。
  const behaviorTitleKeys = new Set(plan.behaviorRules.map((rule) => rule.definition.key));
  const snapshot = buildMetaSnapshot(store, userId, behaviorTitleKeys);

  const meta: MetaTitleEvaluationResult[] = [];
  for (const rule of plan.metaRules) {
    meta.push(evaluateMetaTitle(store, rule, userId, observedAt, snapshot));
  }

  return { userId, trigger, behavior, series, meta };
}

/**
 * 複数user向けのbatch実行（§29）。userごとに behavior→series→meta を完了させてから
 * 次userへ進む——全userのbehaviorを先に全部実行してからseries/metaへ進む二段階方式には
 * しない（1人分のpipeline orderを常に保つ）。
 *
 * `TitleSourceCache` はbatch全体で共有する（§30）——同じuser×同じsourceの重複読み込みを
 * batch内でも防ぐ。callerが`options.cache`を渡した場合はそのcacheを使う。
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
