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
export const F5C2_SHADOW_CONTRACT_VERSION = 2 as const;

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
 * PR #191レビュー第3ラウンド§1: `evidenceIsKnown()`（pack存在+kind一致）は「完全な
 * 観測coverage」を意味しない——このcodebaseの全probeが`coverageLimitations`で明記する
 * 通り、safe sourceはunknown/untrusted intervalを省略するため、絶対的なゼロ（該当
 * 証拠が1件も無いという観測）はcoverageの欠落と観測された不在を区別できない。
 * 一方、正の証拠（何か見つかった）はsafe sourceの性質上ねつ造されない——coverage gap
 * はfalse negativeしか生まず、false positiveは生まない。よって:
 * - MATCHED（正の証拠が見つかった）は`coverageWindowValidated`に関わらず常に信頼できる
 *   ——ここでは絶対に変更しない。
 * - 絶対ゼロ（`isAbsoluteZero`）によるNOT_MATCHEDだけは、呼び出し側が
 *   `coverageWindowValidated=true`で「このcalibration windowは関与する全sourceの
 *   rolloutより後で、safe sourceが通常運用中に省略しうるuntracked gapについても
 *   許容できる」と明示的にattestしない限りUNKNOWNへ倒す
 *   （`executeF5cShadowCalibration`/`runF5cShadowCalibration`の必須引数）。
 * - 相対的な境界比較（値>0だが母集団のrepresentative境界未満）はabsence-of-evidenceの
 *   主張ではないため対象外——このflagの影響を受けない。
 */
function zeroSensitiveOutcome(outcome: F5cShadowOutcome, isAbsoluteZero: boolean, coverageWindowValidated: boolean): F5cShadowOutcome {
  if (outcome === "NOT_MATCHED" && isAbsoluteZero && !coverageWindowValidated) return "UNKNOWN";
  return outcome;
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
 * PR #191レビュー§5: CIRCULAR_HOUR_WINDOWは24 JST hour binの循環軸で、単一の
 * AT_LEAST/AT_MOST境界では表現できない——F5c2は`CIRCULAR_WINDOW_LENGTH_HOURS`幅の
 * candidate windowを開始hour 0-23で有限に列挙し、各windowについて母集団の
 * qualifying件数を報告する。どのwindowも「本番の選択」ではない——単に観測分布が
 * どこに集中しているかを示す診断点であり、実際にshadow評価のMATCHED/NOT_MATCHED
 * 合成にも寄与する（`evaluateCircularHourAxis`のrepresentative window選択を参照）。
 */
export interface F5cCircularWindowPoint {
  readonly windowStartHour: number;
  readonly windowLengthHours: number;
  readonly knownCount: number;
  readonly qualifyingCount: number;
  /** Marginal, not candidate-level sensitivity — see `F5cBoundarySweepPoint.marginalPassRate`. */
  readonly marginalQualifyingRate: number | null;
}

export interface F5cAxisSweepResult {
  readonly axisKey: string;
  readonly reducerKind: F5cSweepAxis["reducerKind"];
  /** Underlying observed sample count the percentile grid was derived from (rows or subjects). */
  readonly observedSampleCount: number;
  readonly boundaryPoints: readonly F5cBoundarySweepPoint[];
  /** Only for CIRCULAR_HOUR_WINDOW axes: qualifying-row count per JST hour bin (0-23), no window chosen. */
  readonly hourHistogram: readonly number[] | null;
  /** Only for CIRCULAR_HOUR_WINDOW axes: the bounded window-start enumeration (see doc above). */
  readonly circularWindowPoints: readonly F5cCircularWindowPoint[] | null;
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
 * PR #191レビュー第3ラウンド§4: `axisSweeps[].boundaryPoints`/`circularWindowPoints`は
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
   * The caller's explicit attestation, threaded straight through — PR #191レビュー第3
   * ラウンド§1: this is the report's coverage provenance. `false` means every absolute-zero
   * NOT_MATCHED outcome in `results` was downgraded to UNKNOWN (see `zeroSensitiveOutcome`);
   * `true` means the caller attested the window is safe and real observed zeros stand.
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
    const outcome =
      criterion.operator === "GTE" ? (value >= criterion.fixedValue ? "MATCHED" : "NOT_MATCHED") :
      criterion.operator === "GT" ? (value > criterion.fixedValue ? "MATCHED" : "NOT_MATCHED") :
      value === criterion.fixedValue ? "MATCHED" : "NOT_MATCHED";
    return zeroSensitiveOutcome(outcome, value === 0, coverageWindowValidated);
  }
  if (criterion.kind === "METRIC_BOOLEAN_TRUE") {
    const value = metricForProbe(subject, probeKey, criterion.metricKey);
    if (value === undefined || value === null) return "UNKNOWN";
    return zeroSensitiveOutcome(value !== 0 ? "MATCHED" : "NOT_MATCHED", value === 0, coverageWindowValidated);
  }
  if (criterion.kind === "ANY_METRIC_POSITIVE") {
    // PR #191レビュー§1: 真の3値OR——1つでもpositiveならMATCHED、positiveが無くても
    // 1つでもUNKNOWNならUNKNOWN（全部null/undefinedの場合だけでなく）、それ以外はNOT_MATCHED。
    const perMetric: F5cShadowOutcome[] = criterion.metricKeys.map((key) => {
      const value = metricForProbe(subject, probeKey, key);
      if (value === undefined || value === null) return "UNKNOWN";
      return value > 0 ? "MATCHED" : "NOT_MATCHED";
    });
    // NOT_MATCHED from combineOutcomesOr only happens when every defined metric was <=0 (an
    // absolute zero across the board) — no MATCHED and no UNKNOWN present.
    return zeroSensitiveOutcome(combineOutcomesOr(perMetric), true, coverageWindowValidated);
  }
  // JOINT_STRUCTURAL_FACT: presence of at least one row for this selector IS the fact — but only
  // once evidence is confirmed known; an unmeasured subject is UNKNOWN, never a false NOT_MATCHED
  // (PR #191レビュー§1).
  if (!evidenceIsKnown(subject, probeKey, requiredJointEvidenceKind)) return "UNKNOWN";
  const evidence = packForProbe(subject, probeKey)!;
  const rows = resolveJointRows(evidence, criterion.selector);
  return zeroSensitiveOutcome(rows.length > 0 ? "MATCHED" : "NOT_MATCHED", rows.length === 0, coverageWindowValidated);
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
  if (criterion.kind === "AT_LEAST_FIXED_DISTINCT_MEMBERS") {
    return zeroSensitiveOutcome(value >= criterion.fixedValue ? "MATCHED" : "NOT_MATCHED", value === 0, coverageWindowValidated);
  }
  if (criterion.kind === "MANIFEST_CARDINALITY_SWEEP") {
    // PR #191レビュー§6: 本番の数値は選ばれていないが、それは「常にMATCHED」を意味しない
    // ——観測母集団のrepresentative(p50)cardinality boundaryに対して実際に判定する。No.87/88
    // のprevalenceはこの次元を無視してはならない。boundaryが定義できない(母集団0件)場合のみ
    // UNKNOWNへ倒す。
    if (cardinalitySweepBoundary === null) return "UNKNOWN";
    return zeroSensitiveOutcome(value >= cardinalitySweepBoundary ? "MATCHED" : "NOT_MATCHED", value === 0, coverageWindowValidated);
  }
  // ALL_MANIFEST_MEMBERS / ALL_REQUIRED_SUPERDOMAINS: value must equal the pinned cardinality.
  if (pinnedTotal === null) return "UNKNOWN";
  return zeroSensitiveOutcome(value >= pinnedTotal ? "MATCHED" : "NOT_MATCHED", value === 0, coverageWindowValidated);
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
    outcomeBySubject.set(subjectId, zeroSensitiveOutcome(outcome, value === 0, ctx.coverageWindowValidated));
  }
  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: samples.length, boundaryPoints, hourHistogram: null, circularWindowPoints: null },
    outcomeBySubject,
  };
}

/**
 * PR #191レビュー第2ラウンド§5 / 第3ラウンド§2: F5c1はどのdaypart/window境界も選んで
 * いない——F5c2はuser-facingなlabel（"morning"等）を発明せず、本番のwindowも選ばない。
 * だが、同じCIRCULAR_HOUR_WINDOW axis shapeは3つの構造的に異なる意味論
 * （`F5cCircularIntent`参照）を表しており、全てを「母集団全体でのbest 8-hour
 * window」戦略へ強制すると、No.32-35が同じwindowへ収束しかねない。以下は
 * `axis.circularIntent.kind`で分岐する3つの実行戦略——固定幅（1日の1/3=
 * `CIRCULAR_WINDOW_LENGTH_HOURS`）のwindow長は共通だが、探索領域・reduction・
 * sensitivity表現がそれぞれ異なる。
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
 * No.32-35: search only within the candidate's own quadrant (a fixed, neutral 6-hour arc — not
 * a production daypart cutoff) so the 4 daypart-target candidates cannot collapse onto the same
 * representative window. The full 24-point enumeration is still reported for transparency; only
 * the *representative* pick (the one MATCHED/NOT_MATCHED is computed against) is quadrant-scoped.
 * A subject's own evidence not falling in the representative window is a positional fact, not an
 * absence of evidence — `zeroSensitiveOutcome` does not apply here.
 */
function evaluateDaypartTargetAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" },
  quadrant: F5cCircularQuadrant,
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
  evidenceKnownBySubject: ReadonlyMap<string, boolean>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const { hourCounts, observed, knownSubjectIds } = prepareCircularAxis(ctx, siblingFilteredRows, evidenceKnownBySubject);
  const quadrantIndex = CIRCULAR_QUADRANT_INDEX[quadrant];
  const allowedStarts = new Set(
    Array.from({ length: CIRCULAR_QUADRANT_WIDTH_HOURS }, (_, i) => (quadrantIndex * CIRCULAR_QUADRANT_WIDTH_HOURS + i) % 24),
  );

  const circularWindowPoints: F5cCircularWindowPoint[] = [];
  let representativeStartHour = quadrantIndex * CIRCULAR_QUADRANT_WIDTH_HOURS;
  let bestQualifyingCount = -1;
  for (let windowStartHour = 0; windowStartHour < 24; windowStartHour += 1) {
    let qualifying = 0;
    for (const subjectId of knownSubjectIds) {
      const rows = siblingFilteredRows.get(subjectId) ?? [];
      if (rows.some((r) => r.sampleValue !== null && hourInWindow(r.sampleValue, windowStartHour, CIRCULAR_WINDOW_LENGTH_HOURS))) qualifying += 1;
    }
    circularWindowPoints.push({
      windowStartHour,
      windowLengthHours: CIRCULAR_WINDOW_LENGTH_HOURS,
      knownCount: knownSubjectIds.length,
      qualifyingCount: qualifying,
      marginalQualifyingRate: knownSubjectIds.length === 0 ? null : qualifying / knownSubjectIds.length,
    });
    if (allowedStarts.has(windowStartHour) && qualifying > bestQualifyingCount) { bestQualifyingCount = qualifying; representativeStartHour = windowStartHour; }
  }

  const outcomeBySubject = new Map<string, F5cShadowOutcome>();
  for (const subject of ctx.subjects) {
    if (evidenceKnownBySubject.get(subject.subjectUserId) !== true) { outcomeBySubject.set(subject.subjectUserId, "UNKNOWN"); continue; }
    const rows = siblingFilteredRows.get(subject.subjectUserId) ?? [];
    const inWindow = rows.some((r) => r.sampleValue !== null && hourInWindow(r.sampleValue, representativeStartHour, CIRCULAR_WINDOW_LENGTH_HOURS));
    outcomeBySubject.set(subject.subjectUserId, inWindow ? "MATCHED" : "NOT_MATCHED");
  }

  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints: [], hourHistogram: hourCounts, circularWindowPoints },
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
    outcomeBySubject.set(subject.subjectUserId, zeroSensitiveOutcome(outcome, share === 0, ctx.coverageWindowValidated));
  }

  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: hourCounts, circularWindowPoints: null },
    outcomeBySubject,
  };
}

/**
 * No.37: the opposite of daypart-target — reward spread, not concentration. Reduce each subject
 * to the count of distinct quadrants (out of the same 4 neutral quadrants `DAYPART_TARGET`
 * uses) containing at least one of their own qualifying rows, then sweep that per-subject
 * breadth scalar the same way a reduction axis would. A single concentrated block (e.g. one
 * all-nighter) can touch at most 2 of the 4 quadrants; genuine round-the-clock spread touches
 * 3-4 — structurally distinct from `DAYPART_TARGET`'s single-window concentration measure.
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
    const quadrants = new Set(rows.map((r) => quadrantOfHour(r.sampleValue!)));
    breadthBySubject.set(subjectId, quadrants.size);
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
    outcomeBySubject.set(subject.subjectUserId, zeroSensitiveOutcome(outcome, breadth === 0, ctx.coverageWindowValidated));
  }

  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: hourCounts, circularWindowPoints: null },
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
    outcomeAtRepresentative.set(subject.subjectUserId, zeroSensitiveOutcome(outcome, size === 0, ctx.coverageWindowValidated));
  }
  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: null, circularWindowPoints: null },
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
    sweeps.push({ axisKey: reductionAxis.axisKey, reducerKind: reductionAxis.reducerKind, observedSampleCount: samples.length, boundaryPoints, hourHistogram: null, circularWindowPoints: null });

    const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);
    for (const subject of ctx.subjects) {
      const result = reducedBySubject.get(subject.subjectUserId)!;
      const prior = outcomeBySubject.get(subject.subjectUserId);
      let outcome: F5cShadowOutcome;
      if (!result.hasEvidence || representativeBoundary === undefined) outcome = "UNKNOWN";
      else {
        const raw = passes(reductionAxis.operator, result.value, representativeBoundary) ? "MATCHED" : "NOT_MATCHED";
        outcome = zeroSensitiveOutcome(raw, result.value === 0, ctx.coverageWindowValidated);
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
  return { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: allSamples.length, boundaryPoints, hourHistogram: null, circularWindowPoints: null };
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
        axisSweeps.push({ axisKey: `manifest:${criterion.countMetricKey}`, reducerKind: "SCALAR_METRIC", observedSampleCount: samples.length, boundaryPoints, hourHistogram: null, circularWindowPoints: null });
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
 * `coverageWindowValidated` is required, not defaulted (PR #191レビュー第3ラウンド§1): the
 * caller must explicitly attest that `collection.window` starts after every source used by
 * READY-76's probes was rolled out AND that the operator accepts the residual untracked-gap risk
 * every safe source's `coverageLimitations` documents. Passing `false` is always safe (it only
 * downgrades absolute-zero NOT_MATCHED outcomes to UNKNOWN — see `zeroSensitiveOutcome`); passing
 * `true` is a real claim about the window's provenance, not a default to reach for casually.
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
