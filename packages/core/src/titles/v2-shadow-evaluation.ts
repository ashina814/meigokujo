import type Database from "better-sqlite3";
import {
  F5C1_MANIFEST_PINS,
  F5C_CANDIDATE_SWEEP_PLANS,
  F5C_SWEEP_CONTRACT_VERSION,
  type F5cCandidateSweepPlan,
  type F5cCircularQuadrant,
  type F5cEvaluationShape,
  type F5cFixedCriterion,
  type F5cManifestCriterion,
  type F5cManifestRef,
  type F5cRowGroupCompositionMode,
  type F5cSweepAxis,
} from "./v2-calibration-sweep.js";
import {
  collectF5cCalibrationMeasurements,
  nearestRankPercentile,
  type F5aCalibrationInput,
  type PlanningCalibrationJointEvidence,
  type PlanningCalibrationMeasurementCollection,
  type PlanningCalibrationSubjectMeasurement,
} from "./v2-calibration.js";
import type { CandidateReadinessAudit } from "./v2-catalog-readiness.js";

/**
 * F5c2: shadow-calibration executor. Planning/operator-internal only — never import from
 * evaluator, pipeline, Bot, or the public v2 barrel. Consumes the merged F5c1 sweep contract
 * (`F5C_CANDIDATE_SWEEP_PLANS`) and the deterministic F5c measurement collection
 * (`collectF5cCalibrationMeasurements`) without re-encoding candidate semantics — every typed
 * F5c1 construct (fixedCriteria/manifestCriteria/axes/rowGroupCompositions/reducerKind) is
 * executed as-authored. If a case genuinely cannot be executed from the current contract, the
 * candidate is reported as `UNSUPPORTED_GAP` with a precise reason — it is never silently
 * skipped and never given an invented/easier semantic.
 *
 * No production threshold is selected here. Boundary exploration uses a fixed, finite,
 * reproducible nearest-rank percentile grid (`F5C2_BOUNDARY_PERCENTILES`) over the *observed*
 * calibration population — the same percentile method F5a-c already use
 * (`CALIBRATION_PERCENTILE_METHOD`). No subject identity or raw restricted evidence is ever
 * included in the returned report — only aggregate counts/rates.
 */
export const F5C2_SHADOW_CONTRACT_VERSION = 3 as const;

/**
 * Finite, bounded, reproducible, auditable — not a production threshold grid. Extended with
 * p95/p99 (PR #191 review §8) so a coarse calibration pass does not discard tail information
 * that a rare/aspirational candidate needs — refining the search further (adaptive sampling
 * near a chosen boundary) is left to a later calibration-refinement phase once product intent
 * narrows which candidates matter.
 */
export const F5C2_BOUNDARY_PERCENTILES = [10, 25, 50, 75, 90, 95, 99] as const;
export type F5cBoundaryPercentile = (typeof F5C2_BOUNDARY_PERCENTILES)[number];
/** The single illustrative combination used for the plan-level MATCHED/NOT_MATCHED call. */
const F5C2_REPRESENTATIVE_PERCENTILE: F5cBoundaryPercentile = 50;

/**
 * UNKNOWN is never collapsed into false/zero. A criterion/axis is UNKNOWN for a subject when
 * the underlying metric is `null` (this codebase's existing convention for "structurally not
 * computable for this subject", e.g. no positive days exist so a day-offset stat is undefined)
 * or when the subject was never measured by the owning probe at all (no pack, or a joint
 * evidence pack whose `kind` does not match what the plan actually requires). An *observed*
 * empty row set — the probe ran, the evidence kind matches, and it legitimately found zero
 * qualifying rows — is knowledge, not UNKNOWN: it reduces to a real zero and is compared
 * against the boundary like any other value (PR #191 review §1: "No.49 TC=0 qualifying days,
 * VC=many is a definite NOT_MATCHED on the TC requirement, not automatically UNKNOWN").
 */
export type F5cShadowOutcome = "MATCHED" | "NOT_MATCHED" | "UNKNOWN";

/**
 * Three-valued AND (Kleene logic): any NOT_MATCHED dominates (the conjunction can never be
 * satisfied regardless of what the unknowns turn out to be); only once no input is definitely
 * false does an UNKNOWN block a definite MATCHED; only when every input is definitely true is
 * the conjunction MATCHED.
 */
function combineOutcomes(outcomes: readonly F5cShadowOutcome[]): F5cShadowOutcome {
  if (outcomes.length === 0) return "UNKNOWN";
  if (outcomes.some((o) => o === "NOT_MATCHED")) return "NOT_MATCHED";
  if (outcomes.some((o) => o === "UNKNOWN")) return "UNKNOWN";
  return "MATCHED";
}

/** Three-valued OR (Kleene logic) — the ANY_METRIC_POSITIVE case: any MATCHED dominates. */
function combineOutcomesOr(outcomes: readonly F5cShadowOutcome[]): F5cShadowOutcome {
  if (outcomes.length === 0) return "UNKNOWN";
  if (outcomes.some((o) => o === "MATCHED")) return "MATCHED";
  if (outcomes.some((o) => o === "UNKNOWN")) return "UNKNOWN";
  return "NOT_MATCHED";
}

/**
 * PR #191レビュー第4ラウンド§1: 絶対ゼロだけを特別扱いした`zeroSensitiveOutcome()`
 * （旧実装）は狭すぎた。safe sourceの欠落は非ゼロ値も低く見せうる——真値10・観測3・
 * AT_LEAST境界5なら、観測はNOT_MATCHEDだが真値はMATCHEDだったかもしれない
 * （false AT_LEAST failure）。逆にAT_MOST境界5なら、観測はMATCHEDだが真値は
 * NOT_MATCHEDだったかもしれない（false AT_MOST match）。一般化した原理:
 *
 * 観測値は常に真値の**下限**である（safe sourceはfalse negativeしか生まず、
 * false positiveを生まない——unknown/untrusted intervalは省略されるだけで、
 * 起きていない活動が捏造されることは無い）。よって、observed <= true が
 * 常に成り立つmonotonic lower-bound reducer（行/日数/breadth/matching sizeの
 * 単純count系。個々のrowの生値比較やopaqueなMETRIC scalar、比率/share/gapの
 * ようなnon-monotonicな導出値は対象外——undercountでどちらの方向にも動きうる）
 * に限って:
 * - AT_LEAST比較: MATCHED（observed>=boundary）は真値でも必ずMATCHED——常に信頼できる。
 *   NOT_MATCHED（observed<boundary）は真値がMATCHEDだった可能性を否定できない。
 * - AT_MOST比較: NOT_MATCHED（observed>ceiling）は真値でも必ずNOT_MATCHED——常に
 *   信頼できる。MATCHED（observed<=ceiling）は真値がNOT_MATCHEDだった可能性を
 *   否定できない。
 * - EQ比較は下限だけからどちらの方向も証明できないため、reliabilityに関わらず
 *   常にuncertain扱いとする。
 *
 * non-monotonicなreducer（FILTER_THEN_SHARE、METRIC axis/METRIC_COMPAREの
 * opaqueなscalar——F5c2はそれが count なのか share/gap/median なのか型からは
 * 判別できない）は、どちらの方向も信頼できないため両方uncertain扱いにする。
 *
 * `coverageWindowValidated=true`はF5c2が自動的に証明した事実ではなく、呼び出し側
 * （operator）の未検証の主張にすぎない——「関与する全sourceのrolloutより後の
 * windowで、safe sourceが通常運用中に省略しうるuntracked gapについても残存
 * リスクとして許容する」という宣言であり、F5c2はこれを検証できない
 * （`executeF5cShadowCalibration`/`runF5cShadowCalibration`のdoc参照）。
 */
export type F5cCoverageDirection = "AT_LEAST" | "AT_MOST" | "EQ";
export type F5cCoverageReliability = "MONOTONIC_LOWER_BOUND" | "NON_MONOTONIC";

/**
 * Exported so the asymmetric AT_LEAST/AT_MOST reliability rule can be unit-tested directly with
 * the review's own numeric examples (PR #191レビュー第4ラウンド§1) — no READY-76 candidate
 * currently puts an AT_MOST operator on a monotonic-lower-bound JOINT_EVIDENCE reduction axis
 * (every AT_MOST-operator reduction in the catalog is a METRIC axis, hence NON_MONOTONIC), so the
 * "false AT_MOST match" case cannot be exercised end-to-end through `executeF5cShadowCalibration`
 * today; testing the shared function directly is the honest way to prove that branch is correct.
 */
export function coverageSensitiveOutcome(
  outcome: F5cShadowOutcome,
  direction: F5cCoverageDirection,
  reliability: F5cCoverageReliability,
  coverageWindowValidated: boolean,
): F5cShadowOutcome {
  if (coverageWindowValidated || outcome === "UNKNOWN") return outcome;
  if (reliability === "NON_MONOTONIC" || direction === "EQ") return "UNKNOWN";
  const reliableOutcome = direction === "AT_LEAST" ? "MATCHED" : "NOT_MATCHED";
  return outcome === reliableOutcome ? outcome : "UNKNOWN";
}

/**
 * Reliability classification for JOINT_EVIDENCE reduction results — see the doc above
 * `coverageSensitiveOutcome`. Only reductions that are provably a monotonic lower bound under
 * row-level undercounting (a literal count of qualifying rows/days/members, never a raw per-row
 * VALUE comparison which could represent a non-monotonic derived quantity like a gap) are treated
 * as reliable in the AT_LEAST/AT_MOST-asymmetric sense.
 */
function reductionReliability(reducerKind: F5cSweepAxis["reducerKind"]): F5cCoverageReliability {
  switch (reducerKind) {
    case "FILTER_THEN_COUNT":
    case "FILTER_THEN_DISTINCT_DAYS":
    case "FILTER_THEN_SPAN_DAYS":
    case "SET_BREADTH":
    case "REPEAT_PERIOD":
    case "GROUP_FILTER_THEN_MAX":
    case "POST_FILTER_MATCHING_SIZE":
      return "MONOTONIC_LOWER_BOUND";
    default:
      // SCALAR_SAMPLE (a raw per-row value — could be a gap/duration, not provably monotonic),
      // FILTER_THEN_SHARE (a ratio, explicitly non-monotonic), SCALAR_METRIC (an opaque
      // probe-computed scalar F5c2 cannot introspect) — all conservative.
      return "NON_MONOTONIC";
  }
}

/**
 * PR #191レビュー第3ラウンド§4: `marginalPassRate`はこのaxis/filter単体の観測分布に
 * 対するpass率であって、他のaxisをrepresentative境界に固定した状態でcandidate全体を
 * 再判定した「候補レベルのsensitivity」ではない——F5c2は現時点でone-axis-at-a-time
 * candidate-level sensitivity（他境界を固定しつつ候補全体のprevalenceを再計算する
 * こと）を実装していない（`F5C2_SENSITIVITY_MODEL`参照）。フィールド名自体に
 * "marginal"を含めることで、後工程がこれをcandidate sensitivityと取り違えることを防ぐ。
 */
export interface F5cBoundarySweepPoint {
  readonly percentile: F5cBoundaryPercentile;
  readonly boundaryValue: number;
  readonly knownCount: number;
  readonly passingCount: number;
  readonly marginalPassRate: number | null;
}

/**
 * PR #191レビュー第4ラウンド§1: `boundaryValue`/`marginalPassRate`は`coverageWindowValidated`
 * が`false`のとき、真の母集団の値そのものではなく観測できた分だけからの計算になる
 * ——safe sourceの欠落は観測値を実際より低く見せうるため（false negativeのみ、
 * false positiveは無い）、この値は「真の分布のある percentile」の**下限**でしか
 * ない。`"OBSERVED_LOWER_BOUND_ONLY"`はこの事実をreport自体に明示する
 * ——`coverageWindowValidated=true`のときだけ`"OBSERVED_COMPLETE"`になる。
 */
export type F5cBoundaryReliability = "OBSERVED_COMPLETE" | "OBSERVED_LOWER_BOUND_ONLY";

export interface F5cAxisSweepResult {
  readonly axisKey: string;
  readonly reducerKind: F5cSweepAxis["reducerKind"];
  /** Underlying observed sample count the percentile grid was derived from (rows or subjects). */
  readonly observedSampleCount: number;
  readonly boundaryPoints: readonly F5cBoundarySweepPoint[];
  readonly boundaryReliability: F5cBoundaryReliability;
  /** Only for CIRCULAR_HOUR_WINDOW axes: qualifying-row count per JST hour bin (0-23), no window chosen. */
  readonly hourHistogram: readonly number[] | null;
}

export type F5cExecutionStrategy =
  | "FIXED_CRITERIA"
  | "MANIFEST_CRITERIA"
  | "METRIC_AXIS_SWEEP"
  | "JOINT_EVIDENCE_SWEEP"
  | "STRUCTURAL_PLUS_DISTRIBUTION"
  | "UNSUPPORTED_GAP";

export interface F5cCandidateShadowResult {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly evaluationShape: F5cEvaluationShape;
  readonly thresholdCategory: CandidateReadinessAudit["thresholdCategory"];
  readonly executionStrategy: F5cExecutionStrategy;
  readonly populationCount: number;
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly matchedCount: number;
  readonly notMatchedCount: number;
  /** matchedCount / knownCount at the representative (median) boundary combination; null if knownCount===0. */
  readonly prevalence: number | null;
  readonly axisSweeps: readonly F5cAxisSweepResult[];
  readonly unsupportedReason: string | null;
}

/**
 * PR #191レビュー第3ラウンド§4: `axisSweeps[].boundaryPoints`は
 * axis単体のmarginal pass rateであって、他のaxisをrepresentativeへ固定しつつcandidate
 * 全体のprevalenceを一軸ずつ再計算する「候補レベルのsensitivity」ではない——実装複雑度
 * とreviewabilityを考慮し、後者はこのPRでは意図的に見送る（Option B、次段階で明確な
 * 設計を経てから実装する）。このtyped markerを実際のreportへ載せることで、後続の
 * 製品判断がmarginalな数値をcandidate sensitivityと取り違えることを防ぐ。
 */
export const F5C2_SENSITIVITY_MODEL = "MARGINAL_AXIS_ONLY" as const;

export interface F5cShadowCalibrationReport {
  readonly contractVersion: typeof F5C2_SHADOW_CONTRACT_VERSION;
  readonly sweepContractVersion: number;
  readonly sensitivityModel: typeof F5C2_SENSITIVITY_MODEL;
  /**
   * The caller's unverified attestation, threaded straight through as the report's coverage
   * provenance (PR #191レビュー第3/第4ラウンド§1) — F5c2 never proves this itself. `false` means
   * every coverage-sensitive comparison in `results` was made conservative and every axis's
   * boundary values are `"OBSERVED_LOWER_BOUND_ONLY"` (see `coverageSensitiveOutcome` /
   * `F5cBoundaryReliability`); `true` means the caller claimed the window is safe and observed
   * values were trusted as complete — a claim, not a fact this report independently establishes.
   */
  readonly coverageWindowValidated: boolean;
  readonly cohort: { readonly key: string; readonly subjectCount: number };
  readonly window: PlanningCalibrationMeasurementCollection["window"];
  readonly readyCandidateCount: number;
  readonly executedCandidateCount: number;
  readonly unsupportedCandidateCount: number;
  readonly results: readonly F5cCandidateShadowResult[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function boundaryValuesFor(samples: readonly number[]): ReadonlyMap<F5cBoundaryPercentile, number> {
  const result = new Map<F5cBoundaryPercentile, number>();
  for (const percentile of F5C2_BOUNDARY_PERCENTILES) {
    const value = nearestRankPercentile(samples, percentile);
    if (value !== null) result.set(percentile, value);
  }
  return result;
}

function passes(operator: "AT_LEAST" | "AT_MOST", value: number, boundary: number): boolean {
  return operator === "AT_LEAST" ? value >= boundary : value <= boundary;
}

function boundaryReliabilityFor(ctx: AxisEvalContext): F5cBoundaryReliability {
  return ctx.coverageWindowValidated ? "OBSERVED_COMPLETE" : "OBSERVED_LOWER_BOUND_ONLY";
}

// ─────────────────────────────────────────────────────────────
// raw row model for JOINT_EVIDENCE resolution
// ─────────────────────────────────────────────────────────────

interface RawRow {
  readonly dayOffset: number | null;
  /** numeric sample for SCALAR_SAMPLE filters / FILTER_THEN_SHARE magnitude. */
  readonly sampleValue: number | null;
  /** distinct-member identity for SET_BREADTH (e.g. "profile:3", "area:2"). */
  readonly memberKey: string | null;
  /** sub-group identity for REPEAT_PERIOD/GROUP_FILTER_THEN_MAX (e.g. "family:2"). */
  readonly groupKey: string | null;
  /** left/right identity for POST_FILTER_MATCHING_SIZE bipartite edges. */
  readonly edgeLeftKey: string | null;
  readonly edgeRightKey: string | null;
  /**
   * Position within THIS selector's own extraction, stamped by `rowGroupRawRowsFor()`. Every
   * selector within one row group maps 1:1, same order, over the same underlying joint-evidence
   * array (see `resolveJointRows()`), so `rowIndex` is the correct cross-selector correspondence
   * key for row-group composition — NOT object identity (each selector produces fresh objects)
   * and NOT dayOffset (which can repeat across distinct rows, e.g. two conversation starts on
   * the same day).
   */
  readonly rowIndex: number;
}

function row(partial: Partial<RawRow>): RawRow {
  return {
    dayOffset: partial.dayOffset ?? null,
    sampleValue: partial.sampleValue ?? null,
    memberKey: partial.memberKey ?? null,
    groupKey: partial.groupKey ?? null,
    edgeLeftKey: partial.edgeLeftKey ?? null,
    edgeRightKey: partial.edgeRightKey ?? null,
    rowIndex: -1, // stamped by rowGroupRawRowsFor(); see RawRow.rowIndex doc.
  };
}

/** Thrown by `resolveJointRows()` for a (kind, selector) pair outside `JOINT_ROW_RESOLVERS`. */
class UnsupportedSelectorError extends Error {
  constructor(kind: string, selector: string) {
    super(`unsupported joint selector for F5c2 execution: ${kind}::${selector}`);
    this.name = "UnsupportedSelectorError";
  }
}

type JointEvidenceOfKind<K extends PlanningCalibrationJointEvidence["kind"]> = Extract<PlanningCalibrationJointEvidence, { kind: K }>;
type AnyJointRowResolver = (evidence: PlanningCalibrationJointEvidence) => readonly RawRow[];

/**
 * PR #191レビュー第3ラウンド§5: selector支持の判定(`isSupportedJointSelector`)と実際の
 * 解決(`resolveJointRows`)が別々に手で同期される2つのSSOTだと、resolver caseを削除/変更
 * してもregistry側が古いまま残り、audit だけが「支持している」と誤答できてしまう。
 * ここでは1つの実行可能なmapだけを正本にする——kindごとのselector文字列は、実際の
 * resolver関数と同じobjectのkeyとしてしか存在しない。`isSupportedJointSelector`と
 * `resolveJointRows`はどちらもこの同じmapを読むだけで、2つ目の並行リストを持たない。
 */
function jointResolverGroup<K extends PlanningCalibrationJointEvidence["kind"]>(
  kind: K,
  map: Record<string, (evidence: JointEvidenceOfKind<K>) => readonly RawRow[]>,
): readonly [K, Record<string, AnyJointRowResolver>] {
  return [kind, map as Record<string, AnyJointRowResolver>];
}

const JOINT_ROW_RESOLVERS: ReadonlyMap<string, Record<string, AnyJointRowResolver>> = new Map([
  jointResolverGroup("activity-time-day-hour-v1", {
    "rows.tc-gap": (e) => e.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.tcBestOtherGapMs })),
    "rows.vc-seconds": (e) => e.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.vcTrustedSocialSeconds })),
    "rows.day-hour-social-evidence": (e) => e.rows.map((r) => row({ dayOffset: r.dayOffset })),
    // share denominator/numerator both use vcTrustedSocialSeconds magnitude.
    "rows.daypart-share": (e) => e.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.vcTrustedSocialSeconds })),
    "rows.daypart-boundary": (e) => e.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.hour })),
    // PR #191レビュー第3ラウンド§3: "start hour"は「その日に記録された最初のhour」であって
    // 「記録された全hour」ではない——旧実装はdaypart-boundaryと同じ全hour rowを返しており、
    // selector名（activity-start-hour）と実際の意味が食い違っていた。既存evidenceから導出
    // できる最小の修正として、日ごとの最小hourを1件だけ返す（No.36専用selector）。
    "rows.activity-start-hour": (e) => {
      const minHourByDay = new Map<number, number>();
      for (const r of e.rows) {
        const current = minHourByDay.get(r.dayOffset);
        if (current === undefined || r.hour < current) minHourByDay.set(r.dayOffset, r.hour);
      }
      return [...minHourByDay.entries()].map(([dayOffset, hour]) => row({ dayOffset, sampleValue: hour }));
    },
  }),
  jointResolverGroup("day-occurrences-v1", {
    // Bounded, deterministic period grouping: 7-day buckets relative to window start.
    "dayOffsets.calendar-periods": (e) => e.dayOffsets.map((offset) => row({ dayOffset: offset, memberKey: `period:${Math.floor(offset / 7)}` })),
  }),
  jointResolverGroup("social-context-graph-v1", (() => {
    const edgesOf = (e: JointEvidenceOfKind<"social-context-graph-v1">) => e.counterparts.flatMap((counterpart) =>
      counterpart.touches.map((touch) => ({
        left: `counterpart:${counterpart.counterpartOrdinal}`,
        right: `semantic:${touch.semanticIndex}`,
        seconds: touch.days.reduce((sum, day) => sum + day.trustedSeconds, 0),
        dayOffset: touch.days.length > 0 ? touch.days[0]!.dayOffset : null,
      })),
    );
    const edgeRows = (e: JointEvidenceOfKind<"social-context-graph-v1">) => edgesOf(e).map((edge) => row({
      dayOffset: edge.dayOffset, sampleValue: edge.seconds, edgeLeftKey: edge.left, edgeRightKey: edge.right,
    }));
    return {
      "counterparts.semantic-touch-days-seconds": edgeRows,
      "counterparts.maximum-matching": edgeRows,
    };
  })()),
  jointResolverGroup("tc-conversation-v1", {
    "starts.quiet-before": (e) => e.starts.map((s) => row({ dayOffset: s.dayOffset, sampleValue: s.quietBeforeMs })),
    "starts.next-other-gap": (e) => e.starts.map((s) => row({ dayOffset: s.dayOffset, sampleValue: s.nextOtherGapMs })),
    "starts.day-offset": (e) => e.starts.map((s) => row({ dayOffset: s.dayOffset })),
    "revivals.dormant-before": (e) => e.revivalConversations.flatMap((c) => c.revivals.map((r) => row({
      dayOffset: r.dayOffset, sampleValue: r.dormantBeforeMs, memberKey: `conversation:${c.conversationOrdinal}`,
    }))),
    "revivals.continuation-gap": (e) => e.revivalConversations.flatMap((c) => c.revivals.map((r) => row({
      dayOffset: r.dayOffset, sampleValue: r.continuationGapMs, memberKey: `conversation:${c.conversationOrdinal}`,
    }))),
    "revivals.conversation-group": (e) => e.revivalConversations.flatMap((c) => c.revivals.map((r) => row({
      dayOffset: r.dayOffset, memberKey: `conversation:${c.conversationOrdinal}`,
    }))),
    "revivals.day-offset": (e) => e.revivalConversations.flatMap((c) => c.revivals.map((r) => row({ dayOffset: r.dayOffset }))),
    "areas.surface-local-social-days": (e) => e.areas.flatMap((a) => a.socialDays.map((d) => row({
      dayOffset: d.dayOffset, memberKey: `area:${a.areaOrdinal}`,
    }))),
    "areas.best-other-gap": (e) => e.areas.flatMap((a) => a.socialDays.map((d) => row({
      dayOffset: d.dayOffset, sampleValue: d.bestOtherGapMs, memberKey: `area:${a.areaOrdinal}`,
    }))),
    "third-party.prior-distinct-others": (e) => e.thirdPartyJoins.map((j) => row({ dayOffset: j.dayOffset, sampleValue: j.priorDistinctOtherGapMs.length })),
    "third-party.next-other-gap": (e) => e.thirdPartyJoins.map((j) => row({ dayOffset: j.dayOffset, sampleValue: j.nextOtherGapMs })),
    "third-party.day-offset": (e) => e.thirdPartyJoins.map((j) => row({ dayOffset: j.dayOffset })),
  }),
  jointResolverGroup("tc-reaction-posts-v1", {
    "posts.post-breadth": (e) => e.posts.map((p) => row({ memberKey: `post:${p.postOrdinal}` })),
    "posts.day-breadth": (e) => e.posts.flatMap((p) => p.reactionDayOffsets.map((offset) => row({ dayOffset: offset, memberKey: `post:${p.postOrdinal}` }))),
  }),
  jointResolverGroup("cross-modal-days-v1", {
    "tc-days.gap": (e) => e.tcDays.map((d) => row({ dayOffset: d.dayOffset, sampleValue: d.bestOtherGapMs })),
    "tc-days.day-offset": (e) => e.tcDays.map((d) => row({ dayOffset: d.dayOffset })),
    "vc-days.breadth": (e) => e.vcDays.map((d) => row({ dayOffset: d.dayOffset, sampleValue: d.distinctCoPresentUsers })),
    "vc-days.day-offset": (e) => e.vcDays.map((d) => row({ dayOffset: d.dayOffset })),
  }),
  jointResolverGroup("domain-social-time-v1", {
    // semanticIndex 2 = ownUse for the public-room-social-time-v1 probe (see v2-calibration.ts).
    "domainDays.public-room-own-use": (e) => e.domainDays.filter((d) => d.semanticIndex === 2).map((d) => row({ dayOffset: d.dayOffset, sampleValue: d.magnitude })),
  }),
  jointResolverGroup("invite-rooted-v1", {
    "profiles.branch-activity-days": (e) => e.profiles.flatMap((p) => p.activityDays.map((d) => row({
      dayOffset: d.dayOffset, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.branch-social-evidence": (e) => e.profiles.flatMap((p) => p.activityDays.map((d) => row({
      dayOffset: d.dayOffset, sampleValue: d.vcTrustedSocialSeconds, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.next-generation-same-day-gap": (e) => e.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
      dayOffset: o.entryDayOffset, sampleValue: o.tcBestOtherGapMs, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.next-generation-same-day-seconds": (e) => e.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
      dayOffset: o.entryDayOffset, sampleValue: o.vcTrustedSocialSeconds, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    // Each entry in nextGenerationOccurrences[] is only ever populated by the probe for
    // occurrences that already satisfy root-before-child + same-day-before-entry chronology —
    // presence of a row IS the structural fact, by construction.
    "profiles.next-generation-occurrence": (e) => e.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
      dayOffset: o.entryDayOffset, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.root-before-child": (e) => e.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
      dayOffset: o.entryDayOffset, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.same-day-before-entry": (e) => e.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
      dayOffset: o.entryDayOffset, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.independent-rooted-branches": (e) => e.profiles.map((p) => row({ memberKey: `profile:${p.profileOrdinal}` })),
    "profiles.reunion-days": (e) => e.profiles.flatMap((p) => p.reunionDays.map((d) => row({
      dayOffset: d.dayOffset, memberKey: `profile:${p.profileOrdinal}`,
    }))),
    "profiles.reunion-pair-social-evidence": (e) => e.profiles.flatMap((p) => p.reunionDays.map((d) => row({
      dayOffset: d.dayOffset, sampleValue: d.vcTrustedPairSeconds, memberKey: `profile:${p.profileOrdinal}`,
    }))),
  }),
  jointResolverGroup("castle-role-context-v1", {
    "families.role-held-days": (e) => e.families.filter((f) => f.roleHeldDays.length > 0).map((f) => row({ memberKey: `family:${f.semanticIndex}` })),
    "families.inside-days": (e) => e.families.filter((f) => f.insideDays.length > 0).map((f) => row({ memberKey: `family:${f.semanticIndex}` })),
    "families.outside-days": (e) => e.families.flatMap((f) => f.outsideDays.map((d) => row({
      dayOffset: d.dayOffset, sampleValue: d.trustedSeconds, groupKey: `family:${f.semanticIndex}`,
    }))),
    "families.outside-repeat-days": (e) => e.families.flatMap((f) => f.outsideDays.map((d) => row({
      dayOffset: d.dayOffset, groupKey: `family:${f.semanticIndex}`,
    }))),
  }),
]);

function isSupportedJointSelector(kind: string, selector: string): boolean {
  return Boolean(JOINT_ROW_RESOLVERS.get(kind)?.[selector]);
}

/**
 * Maps (jointEvidenceKind, selector) to the subject's raw row set for that selector, entirely
 * unfiltered — the single executable SSOT for what an F5c1 selector string means structurally
 * (see `JOINT_ROW_RESOLVERS` / PR #191レビュー第3ラウンド§5). An unrecognized selector throws
 * `UnsupportedSelectorError` rather than silently returning `[]` — a recognized selector
 * legitimately observing zero rows is a completely different state.
 */
function resolveJointRows(evidence: PlanningCalibrationJointEvidence, selector: string): readonly RawRow[] {
  const resolver = JOINT_ROW_RESOLVERS.get(evidence.kind)?.[selector];
  if (!resolver) throw new UnsupportedSelectorError(evidence.kind, selector);
  return resolver(evidence);
}

function packForProbe(subject: PlanningCalibrationSubjectMeasurement, probeKey: string): PlanningCalibrationJointEvidence | null {
  const pack = subject.packs.find((p) => p.probeKey === probeKey);
  return pack?.jointEvidence ?? null;
}

function metricForProbe(subject: PlanningCalibrationSubjectMeasurement, probeKey: string, metricKey: string): number | null | undefined {
  const pack = subject.packs.find((p) => p.probeKey === probeKey);
  if (!pack) return undefined;
  return pack.metrics[metricKey];
}

/**
 * PR #191レビュー§1: 「evidenceが既知」と「行が0件」は別の状態——subjectのpackが
 * 存在し、そのjointEvidence.kindがplanの要求するkindと一致していれば、そのsubject
 * は実際に観測されている。行が0件でもそれは観測されたゼロであり、UNKNOWNではない。
 * `requiredKind === "none"`（joint evidenceを要求しないplan）はここでは常にfalse
 * ——呼び出し側はJOINT_STRUCTURAL_FACT/JOINT_EVIDENCE軸を持つplanでのみ呼ぶ。
 */
function evidenceIsKnown(subject: PlanningCalibrationSubjectMeasurement, probeKey: string, requiredKind: PlanningCalibrationJointEvidence["kind"]): boolean {
  if (requiredKind === "none") return false;
  const evidence = packForProbe(subject, probeKey);
  return evidence !== null && evidence.kind === requiredKind;
}

// ─────────────────────────────────────────────────────────────
// fixed / manifest criteria evaluation (deterministic, no boundary grid)
// ─────────────────────────────────────────────────────────────

function evaluateFixedCriterion(
  criterion: F5cFixedCriterion,
  subject: PlanningCalibrationSubjectMeasurement,
  probeKey: string,
  requiredJointEvidenceKind: PlanningCalibrationJointEvidence["kind"],
  coverageWindowValidated: boolean,
): F5cShadowOutcome {
  if (criterion.kind === "METRIC_COMPARE") {
    const value = metricForProbe(subject, probeKey, criterion.metricKey);
    if (value === undefined) return "UNKNOWN";
    if (value === null) return "UNKNOWN";
    // GT/GTE share the same "MATCHED is reliable" direction (both are ascending comparisons); EQ
    // cannot be proven reliable in either direction from a lower bound alone. metricKey is an
    // opaque probe-computed scalar F5c2 cannot introspect (could be a count or a ratio) — NON_MONOTONIC.
    const direction: F5cCoverageDirection = criterion.operator === "EQ" ? "EQ" : "AT_LEAST";
    const outcome =
      criterion.operator === "GTE" ? (value >= criterion.fixedValue ? "MATCHED" : "NOT_MATCHED") :
      criterion.operator === "GT" ? (value > criterion.fixedValue ? "MATCHED" : "NOT_MATCHED") :
      value === criterion.fixedValue ? "MATCHED" : "NOT_MATCHED";
    return coverageSensitiveOutcome(outcome, direction, "NON_MONOTONIC", coverageWindowValidated);
  }
  if (criterion.kind === "METRIC_BOOLEAN_TRUE") {
    const value = metricForProbe(subject, probeKey, criterion.metricKey);
    if (value === undefined || value === null) return "UNKNOWN";
    // a pure presence check (!==0) is reliable regardless of what the metric represents — a safe
    // source cannot fabricate a nonzero reading from true zero, only suppress a true positive
    // toward zero (unlike METRIC_COMPARE's arbitrary fixedValue, which could cross a ratio).
    const outcome = value !== 0 ? "MATCHED" : "NOT_MATCHED";
    return coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", coverageWindowValidated);
  }
  if (criterion.kind === "ANY_METRIC_POSITIVE") {
    // PR #191レビュー§1: 真の3値OR——1つでもpositiveならMATCHED、positiveが無くても
    // 1つでもUNKNOWNならUNKNOWN（全部null/undefinedの場合だけでなく）、それ以外はNOT_MATCHED。
    const perMetric: F5cShadowOutcome[] = criterion.metricKeys.map((key) => {
      const value = metricForProbe(subject, probeKey, key);
      if (value === undefined || value === null) return "UNKNOWN";
      return value > 0 ? "MATCHED" : "NOT_MATCHED";
    });
    // Same presence-check reasoning as METRIC_BOOLEAN_TRUE — reliable regardless of metric shape.
    return coverageSensitiveOutcome(combineOutcomesOr(perMetric), "AT_LEAST", "MONOTONIC_LOWER_BOUND", coverageWindowValidated);
  }
  // JOINT_STRUCTURAL_FACT: presence of at least one row for this selector IS the fact — but only
  // once evidence is confirmed known; an unmeasured subject is UNKNOWN, never a false NOT_MATCHED
  // (PR #191レビュー§1).
  if (!evidenceIsKnown(subject, probeKey, requiredJointEvidenceKind)) return "UNKNOWN";
  const evidence = packForProbe(subject, probeKey)!;
  const rows = resolveJointRows(evidence, criterion.selector);
  const outcome = rows.length > 0 ? "MATCHED" : "NOT_MATCHED";
  return coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", coverageWindowValidated);
}

function evaluateManifestCriterion(
  criterion: F5cManifestCriterion,
  subject: PlanningCalibrationSubjectMeasurement,
  probeKey: string,
  pinnedTotal: number | null,
  cardinalitySweepBoundary: number | null,
  coverageWindowValidated: boolean,
): F5cShadowOutcome {
  const value = metricForProbe(subject, probeKey, criterion.countMetricKey);
  if (value === undefined || value === null) return "UNKNOWN";
  // Manifest criteria compare a distinct-member COUNT (the F5c1 construct's own kind names —
  // AT_LEAST_FIXED_DISTINCT_MEMBERS/ALL_MANIFEST_MEMBERS — structurally guarantee this, unlike a
  // generic METRIC_COMPARE's opaque metricKey) against a fixed/pinned/observed total: a monotonic
  // lower bound under coverage gaps.
  if (criterion.kind === "AT_LEAST_FIXED_DISTINCT_MEMBERS") {
    const outcome = value >= criterion.fixedValue ? "MATCHED" : "NOT_MATCHED";
    return coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", coverageWindowValidated);
  }
  if (criterion.kind === "MANIFEST_CARDINALITY_SWEEP") {
    // PR #191レビュー§6: 本番の数値は選ばれていないが、それは「常にMATCHED」を意味しない
    // ——観測母集団のrepresentative(p50)cardinality boundaryに対して実際に判定する。No.87/88
    // のprevalenceはこの次元を無視してはならない。boundaryが定義できない(母集団0件)場合のみ
    // UNKNOWNへ倒す。
    if (cardinalitySweepBoundary === null) return "UNKNOWN";
    const outcome = value >= cardinalitySweepBoundary ? "MATCHED" : "NOT_MATCHED";
    return coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", coverageWindowValidated);
  }
  // ALL_MANIFEST_MEMBERS / ALL_REQUIRED_SUPERDOMAINS: value must equal the pinned cardinality.
  if (pinnedTotal === null) return "UNKNOWN";
  const outcome = value >= pinnedTotal ? "MATCHED" : "NOT_MATCHED";
  return coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", coverageWindowValidated);
}

// ─────────────────────────────────────────────────────────────
// axis evaluation
// ─────────────────────────────────────────────────────────────

function filterRows(rows: readonly RawRow[], operator: "AT_LEAST" | "AT_MOST", boundary: number): readonly RawRow[] {
  return rows.filter((r) => r.sampleValue !== null && passes(operator, r.sampleValue, boundary));
}

/**
 * Computes the qualifying `rowIndex` set from one or more ALREADY-THRESHOLDED filter row sets,
 * combined per the row group's declared composition mode. Returns `null` when there are no
 * filters at all (caller should then treat every row of the target selector as qualifying).
 * Composition is over `rowIndex`, not object identity or dayOffset — see `RawRow.rowIndex`.
 */
function qualifyingIndices(filterSets: readonly (readonly RawRow[])[], mode: F5cRowGroupCompositionMode): ReadonlySet<number> | null {
  if (filterSets.length === 0) return null;
  const indexSets = filterSets.map((set) => new Set(set.map((r) => r.rowIndex)));
  if (mode === "ANY_FILTER") {
    const union = new Set<number>();
    for (const set of indexSets) for (const index of set) union.add(index);
    return union;
  }
  const [first, ...rest] = indexSets;
  return new Set([...first!].filter((index) => rest.every((set) => set.has(index))));
}

/** Applies a qualifying-index set (from `qualifyingIndices()`) to one selector's own raw rows. */
function applyQualifyingIndices(ownRows: readonly RawRow[], indices: ReadonlySet<number> | null): readonly RawRow[] {
  return indices === null ? ownRows : ownRows.filter((r) => indices.has(r.rowIndex));
}

function reduceRows(rows: readonly RawRow[], allRows: readonly RawRow[], reducerKind: F5cSweepAxis["reducerKind"]): number {
  switch (reducerKind) {
    case "FILTER_THEN_COUNT":
      return rows.length;
    case "FILTER_THEN_DISTINCT_DAYS": {
      const days = new Set(rows.map((r) => r.dayOffset).filter((d): d is number => d !== null));
      return days.size;
    }
    case "FILTER_THEN_SPAN_DAYS": {
      const days = [...new Set(rows.map((r) => r.dayOffset).filter((d): d is number => d !== null))];
      return days.length === 0 ? 0 : Math.max(...days) - Math.min(...days) + 1;
    }
    case "FILTER_THEN_SHARE": {
      const numerator = rows.reduce((sum, r) => sum + (r.sampleValue ?? 0), 0);
      const denominator = allRows.reduce((sum, r) => sum + (r.sampleValue ?? 0), 0);
      return denominator === 0 ? 0 : numerator / denominator;
    }
    case "SET_BREADTH": {
      const members = new Set(rows.map((r) => r.memberKey).filter((m): m is string => m !== null));
      return members.size;
    }
    case "REPEAT_PERIOD":
    case "GROUP_FILTER_THEN_MAX": {
      const byGroup = new Map<string, Set<number>>();
      for (const r of rows) {
        if (r.groupKey === null) continue;
        const days = byGroup.get(r.groupKey) ?? new Set<number>();
        if (r.dayOffset !== null) days.add(r.dayOffset);
        byGroup.set(r.groupKey, days);
      }
      let max = 0;
      for (const days of byGroup.values()) max = Math.max(max, days.size);
      return max;
    }
    default:
      return rows.length;
  }
}

function maximumBipartiteMatching(adjacency: ReadonlyMap<string, ReadonlySet<string>>): number {
  const leftByRight = new Map<string, string>();
  const augment = (left: string, seen: Set<string>): boolean => {
    for (const right of adjacency.get(left) ?? []) {
      if (seen.has(right)) continue;
      seen.add(right);
      const previousLeft = leftByRight.get(right);
      if (previousLeft === undefined || augment(previousLeft, seen)) {
        leftByRight.set(right, left);
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (const left of adjacency.keys()) if (augment(left, new Set())) size += 1;
  return size;
}

/** rowGroupKey -> its declared composition mode, defaulting to ALL_FILTERS when only one filter exists (moot). */
function compositionModeFor(plan: F5cCandidateSweepPlan, rowGroupKey: string): F5cRowGroupCompositionMode {
  return plan.rowGroupCompositions.find((c) => c.rowGroupKey === rowGroupKey)?.composition ?? "ALL_FILTERS";
}

interface AxisEvalContext {
  readonly plan: F5cCandidateSweepPlan;
  readonly probeKey: string;
  readonly subjects: readonly PlanningCalibrationSubjectMeasurement[];
  readonly coverageWindowValidated: boolean;
}

function metricSamplesFor(ctx: AxisEvalContext, metricKey: string): { readonly bySubject: ReadonlyMap<string, number | null>; readonly samples: readonly number[] } {
  const bySubject = new Map<string, number | null>();
  const samples: number[] = [];
  for (const subject of ctx.subjects) {
    const value = metricForProbe(subject, ctx.probeKey, metricKey);
    const resolved = value === undefined ? null : value;
    bySubject.set(subject.subjectUserId, resolved);
    if (resolved !== null) samples.push(resolved);
  }
  return { bySubject, samples };
}

/** Per-subject raw (unfiltered) row set for one row group, keyed by the axis's own selector. */
function rowGroupRawRowsFor(ctx: AxisEvalContext, axis: F5cSweepAxis & { source: "JOINT_EVIDENCE" }): ReadonlyMap<string, readonly RawRow[]> {
  const bySubject = new Map<string, readonly RawRow[]>();
  for (const subject of ctx.subjects) {
    const evidence = packForProbe(subject, ctx.probeKey);
    const rows = evidence ? resolveJointRows(evidence, axis.selector) : [];
    // stamp rowIndex: the cross-selector correspondence key for row-group composition (see
    // RawRow.rowIndex doc) — every selector in one row group maps 1:1, same order, over the
    // same underlying joint-evidence array.
    bySubject.set(subject.subjectUserId, rows.map((r, index) => ({ ...r, rowIndex: index })));
  }
  return bySubject;
}

function evaluateMetricAxis(ctx: AxisEvalContext, axis: F5cSweepAxis & { source: "METRIC" }): {
  readonly sweep: F5cAxisSweepResult;
  readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome>;
} {
  const { bySubject, samples } = metricSamplesFor(ctx, axis.metricKey);
  const boundaries = boundaryValuesFor(samples);
  const knownSubjects = [...bySubject.entries()].filter(([, v]) => v !== null);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
    const passingCount = knownSubjects.filter(([, v]) => passes(axis.operator, v!, boundaryValue)).length;
    return {
      percentile, boundaryValue, knownCount: knownSubjects.length, passingCount,
      marginalPassRate: knownSubjects.length === 0 ? null : passingCount / knownSubjects.length,
    };
  });
  const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);
  const outcomeBySubject = new Map<string, F5cShadowOutcome>();
  for (const [subjectId, value] of bySubject) {
    if (value === null || representativeBoundary === undefined) { outcomeBySubject.set(subjectId, "UNKNOWN"); continue; }
    const outcome = passes(axis.operator, value, representativeBoundary) ? "MATCHED" : "NOT_MATCHED";
    // an opaque probe-computed METRIC scalar — F5c2 cannot introspect whether it is a count or a
    // ratio, so it is treated conservatively (NON_MONOTONIC) regardless of the observed value.
    outcomeBySubject.set(subjectId, coverageSensitiveOutcome(outcome, axis.operator, "NON_MONOTONIC", ctx.coverageWindowValidated));
  }
  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: samples.length, boundaryPoints, hourHistogram: null, boundaryReliability: boundaryReliabilityFor(ctx) },
    outcomeBySubject,
  };
}

/**
 * PR #191レビュー第2ラウンド§5 / 第3ラウンド§2 / 第4ラウンド§3・§4: F5c1はどの
 * daypart/window境界も選んでいない——F5c2はuser-facingなlabel（"morning"等）を
 * 発明せず、本番のwindowも選ばない。だが、同じCIRCULAR_HOUR_WINDOW axis shapeは
 * 3つの構造的に異なる意味論（`F5cCircularIntent`参照）を表す。以下は
 * `axis.circularIntent.kind`で分岐する3つの実行戦略——DAYPART_TARGET/
 * MULTI_DAYPART_BREADTHは共通の中立的4分割quadrant（`CIRCULAR_QUADRANT_*`）を
 * 使い、PERSONAL_STABILITYだけが固定幅（1日の1/3=`CIRCULAR_WINDOW_LENGTH_HOURS`）
 * のsliding windowを各subject自身のrowに対して探索する——母集団共通の
 * window探索はもう存在しない（第4ラウンド§3でDAYPART_TARGETから除去した）。
 */
const CIRCULAR_WINDOW_LENGTH_HOURS = 8;
/** No.32-35 / No.37共通の中立的quadrant分割 — 本番のdaypart境界ではない（型doc参照）。 */
const CIRCULAR_QUADRANT_COUNT = 4;
const CIRCULAR_QUADRANT_WIDTH_HOURS = 24 / CIRCULAR_QUADRANT_COUNT;

function hourInWindow(hour: number, windowStartHour: number, windowLengthHours: number): boolean {
  const offset = (hour - windowStartHour + 24) % 24;
  return offset < windowLengthHours;
}

const CIRCULAR_QUADRANT_INDEX: Readonly<Record<F5cCircularQuadrant, number>> = {
  QUADRANT_0: 0, QUADRANT_1: 1, QUADRANT_2: 2, QUADRANT_3: 3,
};

function quadrantOfHour(hour: number): number {
  return Math.floor(hour / CIRCULAR_QUADRANT_WIDTH_HOURS);
}

interface CircularAxisPrep {
  readonly hourCounts: number[];
  readonly observed: number;
  readonly knownSubjectIds: readonly string[];
}

/** Shared prep every circular-intent strategy needs: the diagnostic histogram + who is known. */
function prepareCircularAxis(
  ctx: AxisEvalContext,
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
  evidenceKnownBySubject: ReadonlyMap<string, boolean>,
): CircularAxisPrep {
  const hourCounts = Array.from({ length: 24 }, () => 0);
  let observed = 0;
  for (const subject of ctx.subjects) {
    for (const r of siblingFilteredRows.get(subject.subjectUserId) ?? []) {
      if (r.sampleValue !== null && r.sampleValue >= 0 && r.sampleValue < 24) {
        hourCounts[Math.floor(r.sampleValue)]! += 1;
        observed += 1;
      }
    }
  }
  const knownSubjectIds = ctx.subjects.filter((s) => evidenceKnownBySubject.get(s.subjectUserId) === true).map((s) => s.subjectUserId);
  return { hourCounts, observed, knownSubjectIds };
}

/**
 * No.32-35: judge each subject by their own qualifying-row count strictly *within* the
 * candidate's assigned quadrant (a fixed, neutral 6-hour arc — not a production daypart cutoff),
 * never a window that can spill past it. PR #191レビュー第4ラウンド§3: the round-3 design
 * enumerated an 8-hour sliding window whose *start* was restricted to the quadrant, but an
 * 8-hour window starting near the end of a 6-hour quadrant still extends up to 2 hours into the
 * next one — a candidate could derive its representative meaning primarily from a neighboring
 * daypart. Reducing to a per-subject in-quadrant row count (exactly the same shape as
 * PERSONAL_STABILITY/MULTI_DAYPART_BREADTH below) removes window search — and the overreach it
 * enabled — entirely.
 */
function evaluateDaypartTargetAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" },
  quadrant: F5cCircularQuadrant,
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
  evidenceKnownBySubject: ReadonlyMap<string, boolean>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const { hourCounts, observed, knownSubjectIds } = prepareCircularAxis(ctx, siblingFilteredRows, evidenceKnownBySubject);
  const targetQuadrantIndex = CIRCULAR_QUADRANT_INDEX[quadrant];

  const countBySubject = new Map<string, number>();
  for (const subjectId of knownSubjectIds) {
    const rows = (siblingFilteredRows.get(subjectId) ?? []).filter((r) => r.sampleValue !== null);
    countBySubject.set(subjectId, rows.filter((r) => quadrantOfHour(r.sampleValue!) === targetQuadrantIndex).length);
  }

  const samples = knownSubjectIds.map((id) => countBySubject.get(id)!);
  const boundaries = boundaryValuesFor(samples);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
    const passingCount = samples.filter((s) => s >= boundaryValue).length;
    return { percentile, boundaryValue, knownCount: samples.length, passingCount, marginalPassRate: samples.length === 0 ? null : passingCount / samples.length };
  });
  const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);

  const outcomeBySubject = new Map<string, F5cShadowOutcome>();
  for (const subject of ctx.subjects) {
    if (evidenceKnownBySubject.get(subject.subjectUserId) !== true || representativeBoundary === undefined) {
      outcomeBySubject.set(subject.subjectUserId, "UNKNOWN");
      continue;
    }
    const count = countBySubject.get(subject.subjectUserId) ?? 0;
    const outcome = count >= representativeBoundary ? "MATCHED" : "NOT_MATCHED";
    // a literal count of qualifying rows is a monotonic lower bound under coverage gaps.
    outcomeBySubject.set(subject.subjectUserId, coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", ctx.coverageWindowValidated));
  }

  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: hourCounts, boundaryReliability: boundaryReliabilityFor(ctx) },
    outcomeBySubject,
  };
}

/**
 * No.36: a population-wide "best window" is the wrong question — "two users with equally stable
 * but different personal usual times must not be judged solely by which time is more popular in
 * the cohort" (PR #191レビュー第3ラウンド§7). Instead, reduce each subject to their OWN best
 * personal 8-hour window's share of their OWN total rows (a stability/concentration ratio, not a
 * shared window), then sweep that per-subject scalar with the standard percentile mechanism —
 * exactly like a reduction axis, reusing `boundaryPoints` rather than a global window enumeration.
 * This share is a ratio, not a literal count — PR #191レビュー第4ラウンド§1: dropping rows
 * outside the subject's best window while keeping rows inside it can only *inflate* the share, so
 * it is not a monotonic lower bound; treated conservatively (both directions coverage-sensitive).
 */
function evaluatePersonalStabilityAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" },
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
  evidenceKnownBySubject: ReadonlyMap<string, boolean>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const { hourCounts, observed, knownSubjectIds } = prepareCircularAxis(ctx, siblingFilteredRows, evidenceKnownBySubject);

  const shareBySubject = new Map<string, number>();
  for (const subjectId of knownSubjectIds) {
    const rows = (siblingFilteredRows.get(subjectId) ?? []).filter((r) => r.sampleValue !== null);
    if (rows.length === 0) { shareBySubject.set(subjectId, 0); continue; }
    let bestOwnCount = 0;
    for (let windowStartHour = 0; windowStartHour < 24; windowStartHour += 1) {
      const count = rows.filter((r) => hourInWindow(r.sampleValue!, windowStartHour, CIRCULAR_WINDOW_LENGTH_HOURS)).length;
      if (count > bestOwnCount) bestOwnCount = count;
    }
    shareBySubject.set(subjectId, bestOwnCount / rows.length);
  }

  const samples = knownSubjectIds.map((id) => shareBySubject.get(id)!);
  const boundaries = boundaryValuesFor(samples);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
    const passingCount = samples.filter((s) => s >= boundaryValue).length;
    return { percentile, boundaryValue, knownCount: samples.length, passingCount, marginalPassRate: samples.length === 0 ? null : passingCount / samples.length };
  });
  const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);

  const outcomeBySubject = new Map<string, F5cShadowOutcome>();
  for (const subject of ctx.subjects) {
    if (evidenceKnownBySubject.get(subject.subjectUserId) !== true || representativeBoundary === undefined) {
      outcomeBySubject.set(subject.subjectUserId, "UNKNOWN");
      continue;
    }
    const share = shareBySubject.get(subject.subjectUserId) ?? 0;
    const outcome = share >= representativeBoundary ? "MATCHED" : "NOT_MATCHED";
    outcomeBySubject.set(subject.subjectUserId, coverageSensitiveOutcome(outcome, "AT_LEAST", "NON_MONOTONIC", ctx.coverageWindowValidated));
  }

  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: hourCounts, boundaryReliability: boundaryReliabilityFor(ctx) },
    outcomeBySubject,
  };
}

/**
 * No.37: the opposite of daypart-target — reward spread, not concentration. PR #191レビュー
 * 第4ラウンド§4: counting merely *any* qualifying row per quadrant is not enough — a single
 * continuous session crossing midnight (e.g. 22:00-04:00) touches 2 quadrants (and up to 3-4 for
 * a sufficiently long one) from ONE occurrence, so "distinct quadrants touched" alone could be
 * satisfied by exactly the one-night session the catalog semantic excludes ("複数のdaypartに
 * 活動痕が多数日に分散し、一晩の徹夜では説明できない"). A quadrant only counts toward breadth
 * when the subject has qualifying rows in it on at least 2 *distinct* JST days — a single
 * overnight block can only ever contribute 1 day to each quadrant it touches, so it can never
 * make a quadrant "recurring" on its own; genuine multi-day activity in that quadrant can.
 */
function evaluateMultiDaypartBreadthAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" },
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
  evidenceKnownBySubject: ReadonlyMap<string, boolean>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const { hourCounts, observed, knownSubjectIds } = prepareCircularAxis(ctx, siblingFilteredRows, evidenceKnownBySubject);

  const breadthBySubject = new Map<string, number>();
  for (const subjectId of knownSubjectIds) {
    const rows = (siblingFilteredRows.get(subjectId) ?? []).filter((r) => r.sampleValue !== null);
    const dayOffsetsByQuadrant = new Map<number, Set<number>>();
    for (const r of rows) {
      const q = quadrantOfHour(r.sampleValue!);
      const days = dayOffsetsByQuadrant.get(q) ?? new Set<number>();
      if (r.dayOffset !== null) days.add(r.dayOffset);
      dayOffsetsByQuadrant.set(q, days);
    }
    let recurringQuadrants = 0;
    for (const days of dayOffsetsByQuadrant.values()) if (days.size >= 2) recurringQuadrants += 1;
    breadthBySubject.set(subjectId, recurringQuadrants);
  }

  const samples = knownSubjectIds.map((id) => breadthBySubject.get(id)!);
  const boundaries = boundaryValuesFor(samples);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
    const passingCount = samples.filter((s) => s >= boundaryValue).length;
    return { percentile, boundaryValue, knownCount: samples.length, passingCount, marginalPassRate: samples.length === 0 ? null : passingCount / samples.length };
  });
  const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);

  const outcomeBySubject = new Map<string, F5cShadowOutcome>();
  for (const subject of ctx.subjects) {
    if (evidenceKnownBySubject.get(subject.subjectUserId) !== true || representativeBoundary === undefined) {
      outcomeBySubject.set(subject.subjectUserId, "UNKNOWN");
      continue;
    }
    const breadth = breadthBySubject.get(subject.subjectUserId) ?? 0;
    const outcome = breadth >= representativeBoundary ? "MATCHED" : "NOT_MATCHED";
    // a count of quadrants meeting a >=2-distinct-day bar is a monotonic lower bound: dropped
    // rows can only reduce a quadrant's own day count, never fabricate a recurrence.
    outcomeBySubject.set(subject.subjectUserId, coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", ctx.coverageWindowValidated));
  }

  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: hourCounts, boundaryReliability: boundaryReliabilityFor(ctx) },
    outcomeBySubject,
  };
}

function evaluateCircularHourAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" },
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
  evidenceKnownBySubject: ReadonlyMap<string, boolean>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const intent = axis.circularIntent;
  if (intent.kind === "DAYPART_TARGET") return evaluateDaypartTargetAxis(ctx, axis, intent.quadrant, siblingFilteredRows, evidenceKnownBySubject);
  if (intent.kind === "PERSONAL_STABILITY") return evaluatePersonalStabilityAxis(ctx, axis, siblingFilteredRows, evidenceKnownBySubject);
  return evaluateMultiDaypartBreadthAxis(ctx, axis, siblingFilteredRows, evidenceKnownBySubject);
}

/**
 * PR #191レビュー§7: matching-size axisのboundaryPointsは「1つの明確な意味」を持たな
 * ければならない。edge-filter境界を毎percentileごとに変えながらmatching-size分布の
 * p50を報告する旧実装は、2つの異なる次元（edge-filter percentile / matching-size
 * percentile）を1つの`percentile`ラベルへ混在させていた。ここではedge-filter境界を
 * それ自身のrepresentative(p50)値に固定し、matching-size分布そのものに対して通常の
 * percentile gridをsweepする——「edge filterをrepresentativeに固定した状態での
 * matching-size境界sensitivity」という単一の意味になる。edge-filter自身の境界
 * sensitivityは、隣接するSCALAR_SAMPLE軸（`evaluateJointFilterAxis`が呼び出し元で
 * 別のaxisKeyとして push する）で独立して報告される——2軸に分かれているので
 * Cartesian積は不要。plan-level representative outcomeもmatching-size分布の
 * 同じp50境界を使う（`size >= 1`のような契約に無い固定値は使わない）。
 */
function evaluatePostFilterMatchingAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "POST_FILTER_MATCHING_SIZE" },
  edgeSampleBoundaries: ReadonlyMap<F5cBoundaryPercentile, number>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeAtRepresentative: ReadonlyMap<string, F5cShadowOutcome> } {
  const rawRowsBySubject = rowGroupRawRowsFor(ctx, axis);
  const representativeEdgeBoundary = edgeSampleBoundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);
  const matchingSizeBySubject = new Map<string, number>();
  const knownSubjectIds: string[] = [];
  for (const subject of ctx.subjects) {
    const rows = rawRowsBySubject.get(subject.subjectUserId) ?? [];
    const qualifying = representativeEdgeBoundary === undefined
      ? []
      : rows.filter((r) => r.sampleValue !== null && r.sampleValue >= representativeEdgeBoundary && r.edgeLeftKey !== null && r.edgeRightKey !== null);
    const adjacency = new Map<string, Set<string>>();
    for (const r of qualifying) {
      const set = adjacency.get(r.edgeLeftKey!) ?? new Set<string>();
      set.add(r.edgeRightKey!);
      adjacency.set(r.edgeLeftKey!, set);
    }
    matchingSizeBySubject.set(subject.subjectUserId, maximumBipartiteMatching(adjacency));
    if (evidenceIsKnown(subject, ctx.probeKey, ctx.plan.requiredJointEvidence.kind)) knownSubjectIds.push(subject.subjectUserId);
  }

  const matchingSizeSamples = knownSubjectIds.map((id) => matchingSizeBySubject.get(id)!);
  const boundaries = boundaryValuesFor(matchingSizeSamples);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
    const passingCount = matchingSizeSamples.filter((s) => s >= boundaryValue).length;
    return {
      percentile, boundaryValue, knownCount: matchingSizeSamples.length, passingCount,
      marginalPassRate: matchingSizeSamples.length === 0 ? null : passingCount / matchingSizeSamples.length,
    };
  });
  const representativeMatchingBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE) ?? 0;

  const observed = [...rawRowsBySubject.values()].reduce((sum, rows) => sum + rows.length, 0);
  const outcomeAtRepresentative = new Map<string, F5cShadowOutcome>();
  for (const subject of ctx.subjects) {
    if (!evidenceIsKnown(subject, ctx.probeKey, ctx.plan.requiredJointEvidence.kind)) { outcomeAtRepresentative.set(subject.subjectUserId, "UNKNOWN"); continue; }
    const size = matchingSizeBySubject.get(subject.subjectUserId) ?? 0;
    const outcome = size >= representativeMatchingBoundary ? "MATCHED" : "NOT_MATCHED";
    // maximum bipartite matching size over a possibly-incomplete edge set is a monotonic lower
    // bound: removing edges can only shrink (never grow) the maximum matching.
    outcomeAtRepresentative.set(subject.subjectUserId, coverageSensitiveOutcome(outcome, "AT_LEAST", "MONOTONIC_LOWER_BOUND", ctx.coverageWindowValidated));
  }
  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: null, boundaryReliability: boundaryReliabilityFor(ctx) },
    outcomeAtRepresentative,
  };
}

interface RowGroupPlan {
  readonly rowGroupKey: string;
  readonly filterAxes: readonly (F5cSweepAxis & { source: "JOINT_EVIDENCE"; reducerKind: "SCALAR_SAMPLE" })[];
  readonly reductionAxes: readonly (F5cSweepAxis & { source: "JOINT_EVIDENCE"; operator: "AT_LEAST" | "AT_MOST" })[];
  readonly circularAxes: readonly (F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" })[];
  readonly matchingAxes: readonly (F5cSweepAxis & { reducerKind: "POST_FILTER_MATCHING_SIZE" })[];
}

function groupAxesByRowGroup(axes: readonly F5cSweepAxis[]): readonly RowGroupPlan[] {
  const groups = new Map<string, F5cSweepAxis[]>();
  for (const axis of axes) {
    if (axis.source !== "JOINT_EVIDENCE") continue;
    const list = groups.get(axis.rowGroupKey) ?? [];
    list.push(axis);
    groups.set(axis.rowGroupKey, list);
  }
  return [...groups.entries()].map(([rowGroupKey, groupAxes]) => ({
    rowGroupKey,
    filterAxes: groupAxes.filter((a): a is F5cSweepAxis & { source: "JOINT_EVIDENCE"; reducerKind: "SCALAR_SAMPLE" } =>
      a.source === "JOINT_EVIDENCE" && a.reducerKind === "SCALAR_SAMPLE"),
    reductionAxes: groupAxes.filter((a): a is F5cSweepAxis & { source: "JOINT_EVIDENCE"; operator: "AT_LEAST" | "AT_MOST" } =>
      a.source === "JOINT_EVIDENCE" && a.reducerKind !== "SCALAR_SAMPLE" && a.reducerKind !== "CIRCULAR_HOUR_WINDOW" && a.reducerKind !== "POST_FILTER_MATCHING_SIZE"),
    circularAxes: groupAxes.filter((a): a is F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" } => a.reducerKind === "CIRCULAR_HOUR_WINDOW"),
    matchingAxes: groupAxes.filter((a): a is F5cSweepAxis & { reducerKind: "POST_FILTER_MATCHING_SIZE" } => a.reducerKind === "POST_FILTER_MATCHING_SIZE"),
  }));
}

function evaluateRowGroup(
  ctx: AxisEvalContext,
  group: RowGroupPlan,
): { readonly sweeps: readonly F5cAxisSweepResult[]; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const composition = compositionModeFor(ctx.plan, group.rowGroupKey);
  const sweeps: F5cAxisSweepResult[] = [];
  const outcomeBySubject = new Map<string, F5cShadowOutcome>();

  // POST_FILTER_MATCHING_SIZE consumes its sibling filter's boundary grid directly; handle first.
  for (const matchingAxis of group.matchingAxes) {
    const filterAxis = group.filterAxes[0];
    const edgeSamples = filterAxis ? rowGroupRawRowsFor(ctx, filterAxis) : new Map<string, readonly RawRow[]>();
    const allEdgeSamples = [...edgeSamples.values()].flat().map((r) => r.sampleValue).filter((v): v is number => v !== null);
    const boundaries = boundaryValuesFor(allEdgeSamples);
    const result = evaluatePostFilterMatchingAxis(ctx, matchingAxis, boundaries);
    sweeps.push(result.sweep);
    for (const [subjectId, outcome] of result.outcomeAtRepresentative) {
      outcomeBySubject.set(subjectId, combineOutcomes([outcomeBySubject.get(subjectId) ?? "MATCHED", outcome]));
    }
    if (filterAxis) {
      const filterSweep = evaluateJointFilterAxis(ctx, filterAxis, edgeSamples);
      sweeps.push(filterSweep);
    }
  }
  if (group.matchingAxes.length > 0) return { sweeps, outcomeBySubject };

  // Raw rows per subject for every axis selector in this group (filters + reductions share one
  // logical row set per selector, but filters and reductions may reference different selectors
  // within the same rowGroupKey — resolve each axis's own selector, then compose the FILTER
  // axes' qualifying-row sets per subject).
  const filterRawBySubject = group.filterAxes.map((axis) => rowGroupRawRowsFor(ctx, axis));
  const filterBoundaries = group.filterAxes.map((axis) => {
    const allSamples = [...(filterRawBySubject[group.filterAxes.indexOf(axis)] ?? new Map()).values()].flat()
      .map((r) => r.sampleValue).filter((v): v is number => v !== null);
    return boundaryValuesFor(allSamples);
  });

  // Circular-hour axes: qualifying rows after sibling filters at the representative boundary,
  // then a bounded 24-window enumeration decides a representative window (PR #191レビュー§5) —
  // its outcome genuinely joins the row group's AND combination, not just a diagnostic histogram.
  if (group.circularAxes.length > 0) {
    const evidenceKnownBySubject = new Map<string, boolean>();
    for (const subject of ctx.subjects) evidenceKnownBySubject.set(subject.subjectUserId, evidenceIsKnown(subject, ctx.probeKey, ctx.plan.requiredJointEvidence.kind));
    for (const circularAxis of group.circularAxes) {
      const rawBySubject = rowGroupRawRowsFor(ctx, circularAxis);
      const qualifyingBySubject = new Map<string, readonly RawRow[]>();
      for (const subject of ctx.subjects) {
        const qualifyingFilterSets = group.filterAxes.map((filterAxis, i) => {
          const boundary = filterBoundaries[i]!.get(F5C2_REPRESENTATIVE_PERCENTILE);
          const raw = filterRawBySubject[i]!.get(subject.subjectUserId) ?? [];
          return boundary === undefined ? raw : filterRows(raw, filterAxis.operator, boundary);
        });
        const own = rawBySubject.get(subject.subjectUserId) ?? [];
        const indices = qualifyingIndices(qualifyingFilterSets, composition);
        qualifyingBySubject.set(subject.subjectUserId, applyQualifyingIndices(own, indices));
      }
      const result = evaluateCircularHourAxis(ctx, circularAxis, qualifyingBySubject, evidenceKnownBySubject);
      sweeps.push(result.sweep);
      for (const [subjectId, outcome] of result.outcomeBySubject) {
        outcomeBySubject.set(subjectId, combineOutcomes([outcomeBySubject.get(subjectId) ?? "MATCHED", outcome]));
      }
    }
  }

  // Filter axes: report each axis's own independent sensitivity (varying just that axis,
  // siblings held at their own representative boundary) and its representative-boundary outcome.
  for (let i = 0; i < group.filterAxes.length; i += 1) {
    const filterAxis = group.filterAxes[i]!;
    sweeps.push(evaluateJointFilterAxis(ctx, filterAxis, filterRawBySubject[i]!));
  }

  // Reduction axes: apply the row-group composition at each subject, at the representative
  // boundary combination, then sweep the reduction's OWN resulting distribution.
  for (const reductionAxis of group.reductionAxes) {
    const rawBySubject = rowGroupRawRowsFor(ctx, reductionAxis);
    const reducedBySubject = new Map<string, { readonly value: number; readonly hasEvidence: boolean }>();
    for (const subject of ctx.subjects) {
      // PR #191レビュー§1: "hasEvidence"はrowが0件かどうかではなく、subjectがこの
      // joint-evidence kindで実際に観測されたかどうか——No.49のTC=0件/VC=多数件のように、
      // 観測された本当のゼロをUNKNOWNへ倒してはならない。
      const hasEvidence = evidenceIsKnown(subject, ctx.probeKey, ctx.plan.requiredJointEvidence.kind);
      const own = rawBySubject.get(subject.subjectUserId) ?? [];
      if (group.filterAxes.length === 0) {
        reducedBySubject.set(subject.subjectUserId, { value: reduceRows(own, own, reductionAxis.reducerKind), hasEvidence });
        continue;
      }
      const qualifyingFilterSets = group.filterAxes.map((filterAxis, i) => {
        const boundary = filterBoundaries[i]!.get(F5C2_REPRESENTATIVE_PERCENTILE);
        const raw = filterRawBySubject[i]!.get(subject.subjectUserId) ?? [];
        return boundary === undefined ? [] : filterRows(raw, filterAxis.operator, boundary);
      });
      const indices = qualifyingIndices(qualifyingFilterSets, composition);
      const qualifying = applyQualifyingIndices(own, indices);
      reducedBySubject.set(subject.subjectUserId, { value: reduceRows(qualifying, own, reductionAxis.reducerKind), hasEvidence });
    }
    const samples = [...reducedBySubject.values()].filter((r) => r.hasEvidence).map((r) => r.value);
    const boundaries = boundaryValuesFor(samples);
    const knownCount = [...reducedBySubject.values()].filter((r) => r.hasEvidence).length;
    const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
      const boundaryValue = boundaries.get(percentile);
      if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
      const passingCount = [...reducedBySubject.values()].filter((r) => r.hasEvidence && passes(reductionAxis.operator, r.value, boundaryValue)).length;
      return { percentile, boundaryValue, knownCount, passingCount, marginalPassRate: knownCount === 0 ? null : passingCount / knownCount };
    });
    sweeps.push({ axisKey: reductionAxis.axisKey, reducerKind: reductionAxis.reducerKind, observedSampleCount: samples.length, boundaryPoints, hourHistogram: null, boundaryReliability: boundaryReliabilityFor(ctx) });

    const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);
    for (const subject of ctx.subjects) {
      const result = reducedBySubject.get(subject.subjectUserId)!;
      const prior = outcomeBySubject.get(subject.subjectUserId);
      let outcome: F5cShadowOutcome;
      if (!result.hasEvidence || representativeBoundary === undefined) outcome = "UNKNOWN";
      else {
        const raw = passes(reductionAxis.operator, result.value, representativeBoundary) ? "MATCHED" : "NOT_MATCHED";
        outcome = coverageSensitiveOutcome(raw, reductionAxis.operator, reductionReliability(reductionAxis.reducerKind), ctx.coverageWindowValidated);
      }
      outcomeBySubject.set(subject.subjectUserId, prior === undefined ? outcome : combineOutcomes([prior, outcome]));
    }
  }

  return { sweeps, outcomeBySubject };
}

function evaluateJointFilterAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { source: "JOINT_EVIDENCE"; reducerKind: "SCALAR_SAMPLE" },
  rawBySubject: ReadonlyMap<string, readonly RawRow[]>,
): F5cAxisSweepResult {
  const allSamples = [...rawBySubject.values()].flat().map((r) => r.sampleValue).filter((v): v is number => v !== null);
  const boundaries = boundaryValuesFor(allSamples);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
    let known = 0;
    let passing = 0;
    for (const subject of ctx.subjects) {
      if (!evidenceIsKnown(subject, ctx.probeKey, ctx.plan.requiredJointEvidence.kind)) continue;
      known += 1;
      const rows = rawBySubject.get(subject.subjectUserId) ?? [];
      if (rows.some((r) => r.sampleValue !== null && passes(axis.operator, r.sampleValue, boundaryValue))) passing += 1;
    }
    return { percentile, boundaryValue, knownCount: known, passingCount: passing, marginalPassRate: known === 0 ? null : passing / known };
  });
  return { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: allSamples.length, boundaryPoints, hourHistogram: null, boundaryReliability: boundaryReliabilityFor(ctx) };
}

// ─────────────────────────────────────────────────────────────
// per-candidate + top-level execution
// ─────────────────────────────────────────────────────────────

/**
 * PR #191レビュー第2ラウンド§3: family/super-domain cardinalityはF5c1の
 * `F5C1_MANIFEST_PINS`から直接読む——F5c2側にeconomy=3/casino=8/castle=7の
 * ようなliteralを複製しない。F5c1のpinが改訂されればF5c2は自動的に追従する。
 */
function pinnedFamilyCount(kind: F5cManifestRef["kind"]): number {
  if (kind === "ECONOMY_SEMANTIC_FAMILIES") return F5C1_MANIFEST_PINS.ECONOMY_SEMANTIC_FAMILIES.familyKeys.length;
  if (kind === "CASINO_EDITION") return F5C1_MANIFEST_PINS.CASINO_EDITION.families.length;
  return F5C1_MANIFEST_PINS.CASTLE_EDITION.families.length;
}
function pinnedSuperDomainCount(): number {
  return new Set(F5C1_MANIFEST_PINS.CASTLE_EDITION.families.map((f) => f.superDomain)).size;
}
function pinnedManifestTotal(plan: F5cCandidateSweepPlan): number | null {
  if (!plan.manifestRef) return null;
  return pinnedFamilyCount(plan.manifestRef.kind);
}

/**
 * PR #191レビュー§4: `unsupportedCandidateCount === 0`は「例外が飛ばなかった」だけの
 * 消極的な主張であってはならない——実際に実行可能であるという積極的な静的claimに
 * ならなければならない。plan単位で、実際に使われるJOINT_EVIDENCE軸/JOINT_STRUCTURAL_FACT
 * selectorが全て`JOINT_ROW_RESOLVERS`に実行可能なmappingとして存在するかを、subjectデータを
 * 評価する前にチェックする。`requiredJointEvidence`が宣言するがどのaxis/criterionからも
 * 実際に参照されないselector（例: No.87/88のmanifest-onlyな宣言）は対象外——実行時に
 * `resolveJointRows`へ絶対に渡らないため、audit対象にする意味が無い。
 */
function auditPlanSelectorSupport(plan: F5cCandidateSweepPlan): string | null {
  const kind = plan.requiredJointEvidence.kind;
  const selectors = new Set<string>();
  for (const axis of plan.axes) if (axis.source === "JOINT_EVIDENCE") selectors.add(axis.selector);
  for (const criterion of plan.fixedCriteria) if (criterion.kind === "JOINT_STRUCTURAL_FACT") selectors.add(criterion.selector);
  if (selectors.size === 0) return null;
  if (kind === "none") return `plan references joint selectors [${[...selectors].join(", ")}] but requiredJointEvidence.kind is "none"`;
  for (const selector of selectors) {
    if (!isSupportedJointSelector(kind, selector)) return `unsupported joint selector for F5c2 execution: ${kind}::${selector}`;
  }
  return null;
}

/**
 * Static, subject-data-independent audit across every plan — every actively-referenced JOINT_EVIDENCE
 * axis / JOINT_STRUCTURAL_FACT selector in `plans` must resolve against `JOINT_ROW_RESOLVERS`.
 * Exported so a dedicated test can assert READY-76 has zero gaps directly, without needing to
 * fabricate subject data to exercise every code path (PR #191レビュー§4).
 */
export function auditF5c2SelectorSupport(
  plans: readonly F5cCandidateSweepPlan[] = F5C_CANDIDATE_SWEEP_PLANS,
): readonly { readonly candidateNo: number; readonly reason: string }[] {
  const gaps: { readonly candidateNo: number; readonly reason: string }[] = [];
  for (const plan of plans) {
    const reason = auditPlanSelectorSupport(plan);
    if (reason !== null) gaps.push({ candidateNo: plan.candidateNo, reason });
  }
  return gaps;
}

function executeCandidate(
  plan: F5cCandidateSweepPlan,
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
  coverageWindowValidated: boolean,
): F5cCandidateShadowResult {
  const ctx: AxisEvalContext = { plan, probeKey: plan.probeKey, subjects, coverageWindowValidated };
  const axisSweeps: F5cAxisSweepResult[] = [];
  const outcomeBySubject = new Map<string, F5cShadowOutcome[]>();
  const pushOutcome = (subjectId: string, outcome: F5cShadowOutcome) => {
    const list = outcomeBySubject.get(subjectId) ?? [];
    list.push(outcome);
    outcomeBySubject.set(subjectId, list);
  };

  const staticAuditReason = auditPlanSelectorSupport(plan);
  let unsupportedReason: string | null = staticAuditReason;

  if (unsupportedReason === null) {
    try {
      for (const subject of subjects) {
        for (const criterion of plan.fixedCriteria) {
          pushOutcome(subject.subjectUserId, evaluateFixedCriterion(criterion, subject, plan.probeKey, plan.requiredJointEvidence.kind, coverageWindowValidated));
        }
      }
    } catch (error) {
      unsupportedReason = `fixed criteria: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (unsupportedReason === null) {
    const pinnedTotal = pinnedManifestTotal(plan);
    for (const criterion of plan.manifestCriteria) {
      const pinnedForCriterion = criterion.kind === "ALL_REQUIRED_SUPERDOMAINS" ? pinnedSuperDomainCount() : pinnedTotal;
      // PR #191レビュー§6: MANIFEST_CARDINALITY_SWEEPは「本番値未選択」であって
      // 「常にMATCHED」ではない——観測母集団のrepresentative(p50)cardinalityを先に
      // 計算し、各subjectをそれに対して実際に判定する。No.87/88のprevalenceはこの
      // 次元を無視してはならない。
      const cardinalitySweepBoundary = criterion.kind === "MANIFEST_CARDINALITY_SWEEP"
        ? boundaryValuesFor(metricSamplesFor(ctx, criterion.countMetricKey).samples).get(F5C2_REPRESENTATIVE_PERCENTILE) ?? null
        : null;
      for (const subject of subjects) {
        pushOutcome(subject.subjectUserId, evaluateManifestCriterion(criterion, subject, plan.probeKey, pinnedForCriterion, cardinalitySweepBoundary, coverageWindowValidated));
      }
      if (criterion.kind === "MANIFEST_CARDINALITY_SWEEP") {
        const { samples } = metricSamplesFor(ctx, criterion.countMetricKey);
        const boundaries = boundaryValuesFor(samples);
        const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
          const boundaryValue = boundaries.get(percentile);
          if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, marginalPassRate: null };
          const known = samples.length;
          const passing = samples.filter((v) => v >= boundaryValue).length;
          return { percentile, boundaryValue, knownCount: known, passingCount: passing, marginalPassRate: known === 0 ? null : passing / known };
        });
        axisSweeps.push({ axisKey: `manifest:${criterion.countMetricKey}`, reducerKind: "SCALAR_METRIC", observedSampleCount: samples.length, boundaryPoints, hourHistogram: null, boundaryReliability: boundaryReliabilityFor(ctx) });
      }
    }
  }

  if (unsupportedReason === null) {
    const metricAxes = plan.axes.filter((a): a is F5cSweepAxis & { source: "METRIC" } => a.source === "METRIC");
    for (const axis of metricAxes) {
      const { sweep, outcomeBySubject: axisOutcomes } = evaluateMetricAxis(ctx, axis);
      axisSweeps.push(sweep);
      for (const [subjectId, outcome] of axisOutcomes) pushOutcome(subjectId, outcome);
    }
  }

  if (unsupportedReason === null) {
    const rowGroups = groupAxesByRowGroup(plan.axes);
    for (const group of rowGroups) {
      try {
        const { sweeps, outcomeBySubject: groupOutcomes } = evaluateRowGroup(ctx, group);
        axisSweeps.push(...sweeps);
        for (const [subjectId, outcome] of groupOutcomes) pushOutcome(subjectId, outcome);
      } catch (error) {
        unsupportedReason = `row group ${group.rowGroupKey}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const hasJointEvidence = plan.axes.some((a) => a.source === "JOINT_EVIDENCE") || plan.fixedCriteria.some((c) => c.kind === "JOINT_STRUCTURAL_FACT");
  const executionStrategy: F5cExecutionStrategy = unsupportedReason !== null
    ? "UNSUPPORTED_GAP"
    : plan.thresholdCategory === "STRUCTURAL_PLUS_DISTRIBUTION"
      ? "STRUCTURAL_PLUS_DISTRIBUTION"
      : plan.manifestCriteria.length > 0
        ? "MANIFEST_CRITERIA"
        : hasJointEvidence
          ? "JOINT_EVIDENCE_SWEEP"
          : plan.axes.length > 0
            ? "METRIC_AXIS_SWEEP"
            : "FIXED_CRITERIA";

  let matchedCount = 0;
  let notMatchedCount = 0;
  let unknownCount = 0;
  for (const subject of subjects) {
    const outcomes = outcomeBySubject.get(subject.subjectUserId) ?? [];
    const combined = combineOutcomes(outcomes);
    if (combined === "MATCHED") matchedCount += 1;
    else if (combined === "NOT_MATCHED") notMatchedCount += 1;
    else unknownCount += 1;
  }
  const knownCount = matchedCount + notMatchedCount;

  return {
    candidateNo: plan.candidateNo,
    provisionalKey: plan.provisionalKey,
    evaluationShape: plan.evaluationShape,
    thresholdCategory: plan.thresholdCategory,
    executionStrategy,
    populationCount: subjects.length,
    knownCount,
    unknownCount,
    matchedCount,
    notMatchedCount,
    prevalence: knownCount === 0 ? null : matchedCount / knownCount,
    axisSweeps,
    unsupportedReason,
  };
}

/**
 * Executes every READY-76 F5c1 plan against a deterministic F5c calibration collection.
 * Restricted subject IDs are used transiently in-memory only — the returned report is
 * aggregate-only (counts/rates/boundary values), never subject identities or raw evidence.
 *
 * `coverageWindowValidated` is required, not defaulted (PR #191レビュー第3/第4ラウンド§1).
 * **This is an unverified operator attestation, not a fact F5c2 proves or can prove** — nothing
 * in the safe-source layer exposes a per-window "coverage was complete" signal for F5c2 to check.
 * Passing `true` is a real claim by the caller that `collection.window` starts after every source
 * used by READY-76's probes was rolled out, *and* that the operator knowingly accepts the residual
 * untracked-gap risk every safe source's `coverageLimitations` documents (bot restarts, migration
 * windows, and other gaps that persist even after rollout) — it is not a default to reach for
 * casually, and F5c2 has no way to reject a `true` that turns out to be wrong. Passing `false` is
 * always safe: it makes every coverage-sensitive comparison conservative (see
 * `coverageSensitiveOutcome`) and marks every axis's `boundaryPoints`/`boundaryValue` as
 * `"OBSERVED_LOWER_BOUND_ONLY"` rather than a trustworthy population statistic.
 */
export function executeF5cShadowCalibration(
  collection: PlanningCalibrationMeasurementCollection,
  coverageWindowValidated: boolean,
): F5cShadowCalibrationReport {
  const results = F5C_CANDIDATE_SWEEP_PLANS.map((plan) => executeCandidate(plan, collection.subjects, coverageWindowValidated));
  const unsupportedCandidateCount = results.filter((r) => r.executionStrategy === "UNSUPPORTED_GAP").length;
  return deepFreeze({
    contractVersion: F5C2_SHADOW_CONTRACT_VERSION,
    sweepContractVersion: F5C_SWEEP_CONTRACT_VERSION,
    sensitivityModel: F5C2_SENSITIVITY_MODEL,
    coverageWindowValidated,
    cohort: collection.cohort,
    window: collection.window,
    readyCandidateCount: F5C_CANDIDATE_SWEEP_PLANS.length,
    executedCandidateCount: results.length - unsupportedCandidateCount,
    unsupportedCandidateCount,
    results: results.sort((a, b) => a.candidateNo - b.candidateNo),
  });
}

/**
 * Convenience wrapper: collect + execute in one call. Never persists/logs subject identity.
 * See `executeF5cShadowCalibration` for what `coverageWindowValidated` actually attests.
 */
export function runF5cShadowCalibration(
  db: Database.Database,
  input: F5aCalibrationInput,
  coverageWindowValidated: boolean,
): F5cShadowCalibrationReport {
  return executeF5cShadowCalibration(collectF5cCalibrationMeasurements(db, input), coverageWindowValidated);
}
