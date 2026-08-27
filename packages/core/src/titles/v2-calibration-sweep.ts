import { CASINO_EDITION_I_MANIFEST } from "../casino/edition-i-manifest.js";
import { TITLE_V2_CATALOG_CANDIDATES } from "./v2-catalog-candidates.js";
import { TITLE_V2_CATALOG_READINESS, type CandidateReadinessAudit } from "./v2-catalog-readiness.js";
import { CASTLE_EXPERIENCE_EDITION_I_MANIFEST } from "./v2-castle-experience-manifest.js";
import { ECONOMY_FEATURE_FAMILY_MANIFEST_VERSION } from "./v2-economy.js";
import {
  describeF5cCalibrationProbeContracts,
  F5C_CALIBRATION_PROBES,
  type CalibrationProbeKey,
  type PlanningCalibrationJointEvidence,
} from "./v2-calibration.js";

/** Planning-only contract. Never import from evaluator, pipeline, Bot, or the public v2 barrel. */
export const F5C_SWEEP_CONTRACT_VERSION = 2 as const;

export type F5cEvaluationShape =
  | "STRUCTURAL_PRESENCE"
  | "MANIFEST_CONFORMANCE"
  | "DISTRIBUTION_THRESHOLD"
  | "MULTI_METRIC_CONJUNCTION"
  | "JOINT_CORRELATION"
  | "STRUCTURAL_PLUS_DISTRIBUTION";

export type F5cSweepOperator = "AT_LEAST" | "AT_MOST";

/**
 * PR #190レビュー§6: JOINT_EVIDENCE axisはselector/operator/boundaryMethodだけでは
 * 「F5c2がそのselectorをどう subject-level scalar/qualification へ還元するか」を
 * 表現できない——selectorは複数timestamp/gap/grouped profile/graph edge/circular
 * hour/branch structureのいずれにもなり得る。有限のreducerKindだけで実際の
 * READY-76 candidateが必要とするpatternを列挙する（汎用DSLは作らない）。
 *
 * - SCALAR_METRIC: METRIC axis専用。probeが既に計算したsubject-level scalar。
 * - SCALAR_SAMPLE: joint evidence row 1件が持つ生の数値サンプル（gap ms、seconds、
 *   breadth等）をそのままrow-level filterのboundaryとしてsweepする。
 * - FILTER_THEN_COUNT: 同じrow group内で他のSCALAR_SAMPLE filterを満たした
 *   row数を数える。
 * - FILTER_THEN_DISTINCT_DAYS: 同じrow group内でfilterを満たしたrowのdistinct
 *   day数を数える。
 * - FILTER_THEN_SHARE: 同じrow group内でfilterを満たした量/件数の、groupの
 *   総量に対するshare（比率）。
 * - GROUP_FILTER_THEN_MAX: 同じrow groupをsub-groupへ分け、filter後のsub-group内
 *   最大値を取る（例: 同一counterpartとの最大反復日数）。
 * - MATCHING_AFTER_EDGE_FILTER: edgeをSCALAR_SAMPLE filterで絞った後、
 *   maximum bipartite matchingを絞り込み後のedge集合から再計算する
 *   （filter前のstructuralMaxを流用しない）。
 * - CIRCULAR_HOUR_WINDOW: 24 JST hour binは循環しており、単一のAT_LEAST/AT_MOST
 *   hour boundaryでは表現できない。F5c2が後で24 binの中からbounded windowを
 *   列挙する——F5c1はどのwindowも選ばない。
 * - SET_BREADTH: 同じrow groupから導出したdistinct member集合（branch、family、
 *   reactor等）の breadth（要素数）。
 * - REPEAT_PERIOD: 同一counterpart/branch/familyに対する反復qualifying period
 *   （day等）の数。
 */
export type F5cAxisReducerKind =
  | "SCALAR_METRIC"
  | "SCALAR_SAMPLE"
  | "FILTER_THEN_COUNT"
  | "FILTER_THEN_DISTINCT_DAYS"
  | "FILTER_THEN_SHARE"
  | "GROUP_FILTER_THEN_MAX"
  | "MATCHING_AFTER_EDGE_FILTER"
  | "CIRCULAR_HOUR_WINDOW"
  | "SET_BREADTH"
  | "REPEAT_PERIOD";

interface F5cMetricAxis {
  readonly axisKey: string;
  readonly source: "METRIC";
  readonly metricKey: string;
  readonly operator: F5cSweepOperator;
  readonly boundaryMethod: "OBSERVED_NEAREST_RANK";
  readonly reducerKind: "SCALAR_METRIC";
}

/** genuinely sweepable numeric per-row/per-subject sample; nearest-rank boundary selection applies. */
type F5cJointSweepableReducerKind = Exclude<F5cAxisReducerKind, "SCALAR_METRIC" | "MATCHING_AFTER_EDGE_FILTER" | "CIRCULAR_HOUR_WINDOW">;

interface F5cJointThresholdAxis {
  readonly axisKey: string;
  readonly source: "JOINT_EVIDENCE";
  readonly selector: string;
  /** axes（同一planの他axis含む）で同じ生row集合から導出される場合、同じ文字列を共有する。 */
  readonly rowGroupKey: string;
  readonly operator: F5cSweepOperator;
  readonly boundaryMethod: "OBSERVED_NEAREST_RANK";
  readonly reducerKind: F5cJointSweepableReducerKind;
}

/**
 * PR #190レビュー§8/§11: graph matchingの結果はedge filter適用後に再計算される
 * 派生値であり、それ自体を独立にnearest-rank sweepしない——operator/boundaryMethod
 * ともに持たない専用variant。
 */
interface F5cJointMatchingAxis {
  readonly axisKey: string;
  readonly source: "JOINT_EVIDENCE";
  readonly selector: string;
  readonly rowGroupKey: string;
  readonly reducerKind: "MATCHING_AFTER_EDGE_FILTER";
  readonly boundaryMethod: "RECOMPUTED_AFTER_EDGE_FILTER";
}

/**
 * PR #190レビュー§9/§11: 24 JST hourは循環しており、単一のAT_LEAST/AT_MOSTでは
 * 境界を表現できない——operatorを持たない専用variant。F5c1はどのwindowも選ばない。
 */
interface F5cJointCircularHourAxis {
  readonly axisKey: string;
  readonly source: "JOINT_EVIDENCE";
  readonly selector: string;
  readonly rowGroupKey: string;
  readonly reducerKind: "CIRCULAR_HOUR_WINDOW";
  readonly boundaryMethod: "CIRCULAR_CANDIDATE_ENUMERATION";
}

export type F5cSweepAxis = F5cMetricAxis | F5cJointThresholdAxis | F5cJointMatchingAxis | F5cJointCircularHourAxis;

export interface F5cRequiredJointEvidence {
  readonly kind: PlanningCalibrationJointEvidence["kind"];
  readonly selectors: readonly string[];
}

/**
 * PR #190レビュー§2: structuralRequirementsのprose文だけでは、F5c2がre-interpretation
 * 無しに実行できない。全fixedCriteriaはANDされる——分布境界を選ばない、catalog意味論
 * そのものが固定するsemantic constantだけを表現する（§3: THRESHOLD_PENDINGの
 * distribution boundaryではない）。ANY_METRIC_POSITIVEだけが明示的なORケース
 * （例: event staff-or-organizer）。汎用expression言語は作らない。
 */
export type F5cFixedCriterion =
  | { readonly kind: "METRIC_COMPARE"; readonly metricKey: string; readonly operator: "GT" | "GTE" | "EQ"; readonly fixedValue: number }
  | { readonly kind: "METRIC_BOOLEAN_TRUE"; readonly metricKey: string }
  | { readonly kind: "ANY_METRIC_POSITIVE"; readonly metricKeys: readonly string[] }
  | { readonly kind: "JOINT_STRUCTURAL_FACT"; readonly selector: string };

/**
 * PR #190レビュー§5: MANIFEST_DEPENDENT planは「現行Castle Edition-Iマニフェスト」の
 * ようなprose参照だけに頼っていた。実際のcanonical versioned manifest定数を直接
 * 参照する（値を複製しない）——後でmanifestが改訂されても、古いF5c sweep contractを
 * 気づかず変えないようにするため。
 */
export type F5cManifestRef =
  | { readonly kind: "ECONOMY_SEMANTIC_FAMILIES"; readonly version: typeof ECONOMY_FEATURE_FAMILY_MANIFEST_VERSION }
  | {
      readonly kind: "CASINO_EDITION";
      readonly editionKey: typeof CASINO_EDITION_I_MANIFEST.editionKey;
      readonly version: typeof CASINO_EDITION_I_MANIFEST.version;
    }
  | {
      readonly kind: "CASTLE_EDITION";
      readonly editionKey: typeof CASTLE_EXPERIENCE_EDITION_I_MANIFEST.editionKey;
      readonly version: typeof CASTLE_EXPERIENCE_EDITION_I_MANIFEST.version;
    };

function economyManifestRef(): F5cManifestRef {
  return { kind: "ECONOMY_SEMANTIC_FAMILIES", version: ECONOMY_FEATURE_FAMILY_MANIFEST_VERSION };
}
function casinoEditionManifestRef(): F5cManifestRef {
  return { kind: "CASINO_EDITION", editionKey: CASINO_EDITION_I_MANIFEST.editionKey, version: CASINO_EDITION_I_MANIFEST.version };
}
function castleEditionManifestRef(): F5cManifestRef {
  return {
    kind: "CASTLE_EDITION",
    editionKey: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.editionKey,
    version: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.version,
  };
}

export interface F5cCandidateSweepPlan {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly probeKey: CalibrationProbeKey;
  readonly thresholdCategory: CandidateReadinessAudit["thresholdCategory"];
  readonly optimizationRisk: CandidateReadinessAudit["optimizationRisk"];
  readonly measurementStatus: "MEASURED" | "MEASUREMENT_GAP";
  readonly gapReason: string | null;
  readonly evaluationShape: F5cEvaluationShape;
  readonly requiredMetrics: readonly string[];
  readonly requiredJointEvidence: F5cRequiredJointEvidence;
  readonly axes: readonly F5cSweepAxis[];
  readonly fixedCriteria: readonly F5cFixedCriterion[];
  readonly manifestRef: F5cManifestRef | null;
  readonly structuralRequirements: readonly string[];
  readonly coverageNotes: readonly string[];
  readonly releaseGateNotes: readonly string[];
}

interface PlanInput {
  readonly no: number;
  readonly evaluationShape: F5cEvaluationShape;
  readonly requiredMetrics: readonly string[];
  readonly requiredJointEvidence?: F5cRequiredJointEvidence;
  readonly axes?: readonly F5cSweepAxis[];
  readonly fixedCriteria?: readonly F5cFixedCriterion[];
  readonly manifestRef?: F5cManifestRef;
  readonly structuralRequirements?: readonly string[];
  readonly coverageNotes?: readonly string[];
  readonly releaseGateNotes?: readonly string[];
  /** measuredPlan()/gapPlan()経由でのみ設定する。呼び出し側が直接defaultへ頼ることはできない。 */
  readonly measurementStatus: F5cCandidateSweepPlan["measurementStatus"];
  readonly gapReason?: string;
}

const NONE = Object.freeze({ kind: "none", selectors: Object.freeze([]) }) satisfies F5cRequiredJointEvidence;
const COVERAGE_NOTE = "Unknown or pre-rollout source coverage must remain distinct from observed zero activity.";

function metricAxis(axisKey: string, metricKey: string, operator: F5cSweepOperator = "AT_LEAST"): F5cMetricAxis {
  return { axisKey, source: "METRIC", metricKey, operator, boundaryMethod: "OBSERVED_NEAREST_RANK", reducerKind: "SCALAR_METRIC" };
}

function jointThresholdAxis(
  axisKey: string,
  selector: string,
  reducerKind: F5cJointSweepableReducerKind,
  rowGroupKey: string,
  operator: F5cSweepOperator = "AT_LEAST",
): F5cJointThresholdAxis {
  return { axisKey, source: "JOINT_EVIDENCE", selector, rowGroupKey, operator, boundaryMethod: "OBSERVED_NEAREST_RANK", reducerKind };
}

function jointMatchingAxis(axisKey: string, selector: string, rowGroupKey: string): F5cJointMatchingAxis {
  return { axisKey, source: "JOINT_EVIDENCE", selector, rowGroupKey, reducerKind: "MATCHING_AFTER_EDGE_FILTER", boundaryMethod: "RECOMPUTED_AFTER_EDGE_FILTER" };
}

function circularHourAxis(axisKey: string, selector: string, rowGroupKey: string): F5cJointCircularHourAxis {
  return { axisKey, source: "JOINT_EVIDENCE", selector, rowGroupKey, reducerKind: "CIRCULAR_HOUR_WINDOW", boundaryMethod: "CIRCULAR_CANDIDATE_ENUMERATION" };
}

function metricAtLeast(metricKey: string, fixedValue: number): F5cFixedCriterion {
  return { kind: "METRIC_COMPARE", metricKey, operator: "GTE", fixedValue };
}
function metricBooleanTrue(metricKey: string): F5cFixedCriterion {
  return { kind: "METRIC_BOOLEAN_TRUE", metricKey };
}
function anyMetricPositive(...metricKeys: readonly string[]): F5cFixedCriterion {
  return { kind: "ANY_METRIC_POSITIVE", metricKeys };
}
function jointStructuralFact(selector: string): F5cFixedCriterion {
  return { kind: "JOINT_STRUCTURAL_FACT", selector };
}

function joint(kind: Exclude<PlanningCalibrationJointEvidence["kind"], "none">, ...selectors: string[]): F5cRequiredJointEvidence {
  return { kind, selectors };
}

/** internal shared constructor. Never call directly from PLAN_INPUTS — use measuredPlan()/gapPlan(). */
function plan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  measurementStatus: F5cCandidateSweepPlan["measurementStatus"],
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics" | "measurementStatus"> = {},
): PlanInput {
  return { no, evaluationShape, requiredMetrics, measurementStatus, ...options };
}

/**
 * PR #190レビュー§12: measurementStatusのdefaultは廃止した——`MEASURED`は必ず
 * 明示的にここを経由する。
 */
function measuredPlan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics" | "measurementStatus" | "gapReason"> = {},
): PlanInput {
  return plan(no, evaluationShape, requiredMetrics, "MEASURED", options);
}

/**
 * PR #190レビュー§12: MEASUREMENT_GAPは`gapReason`を必須にし、sweep axisを
 * 一切持てない（実行可能に見せかけることを禁じる）。現行READY-76のどのcandidateも
 * 実際にはgapではないため、今のところ`gapPlan()`はどのPLAN_INPUTSからも呼ばれていない
 * ——mechanism自体をtestで直接演習する（このfile末尾の`__internal`経由）。
 */
function gapPlan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  gapReason: string,
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics" | "measurementStatus" | "gapReason" | "axes"> = {},
): PlanInput {
  if (!gapReason.trim()) throw new Error(`gapPlan #${no}: gapReason must not be empty`);
  return plan(no, evaluationShape, requiredMetrics, "MEASUREMENT_GAP", { ...options, gapReason });
}

const vcBucketPresence = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  `bucketTotalSeconds.${bucket}`,
  `bucketPositiveDays.${bucket}`,
  `overallBucketShare.${bucket}`,
  `socialOnlyShare.${bucket}`,
  "totalTrustedSeconds",
  "totalSocialSeconds",
  "activeDays",
  "socialPositiveDays",
  "positiveSpanDays",
] as const;

const vcBucketStability = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  ...vcBucketPresence(bucket),
  `dailyBucketShareP25.${bucket}`,
  `dailyBucketShareMedian.${bucket}`,
  `dailyBucketShareIqr.${bucket}`,
  `dailySocialOnlyShareP25.${bucket}`,
  `dailySocialOnlyShareMedian.${bucket}`,
  `dailySocialOnlyShareIqr.${bucket}`,
] as const;

const vcPresenceAxes = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  metricAxis(`${bucket}-seconds`, `bucketTotalSeconds.${bucket}`),
  metricAxis(`${bucket}-days`, `bucketPositiveDays.${bucket}`),
] as const;

const vcStabilityAxes = (bucket: "oneToOne" | "smallGroup" | "largeGroup") => [
  metricAxis(`${bucket}-sample-seconds`, "totalTrustedSeconds"),
  metricAxis(`${bucket}-social-sample-seconds`, "totalSocialSeconds"),
  metricAxis(`${bucket}-overall-share`, `overallBucketShare.${bucket}`),
  metricAxis(`${bucket}-social-only-share`, `socialOnlyShare.${bucket}`),
  metricAxis(`${bucket}-daily-share-floor`, `dailyBucketShareP25.${bucket}`),
  metricAxis(`${bucket}-daily-social-share-floor`, `dailySocialOnlyShareP25.${bucket}`),
  metricAxis(`${bucket}-daily-share-variation`, `dailyBucketShareIqr.${bucket}`, "AT_MOST"),
  metricAxis(`${bucket}-daily-social-share-variation`, `dailySocialOnlyShareIqr.${bucket}`, "AT_MOST"),
] as const;

const activityHourMetrics = Object.freeze(Array.from({ length: 24 }, (_, hour) => [
  `hourlyVcTrustedSeconds.${hour}`,
  `hourlyVcPositiveDays.${hour}`,
  `hourlyTcGapSampleCount.${hour}`,
]).flat());

const activityMetrics = Object.freeze([
  "vcTotalTrustedSeconds",
  "vcPositiveDays",
  "vcDominantHourSeconds",
  "vcTop2HoursSeconds",
  "vcTop3HoursSeconds",
  "vcDominantHourShare",
  "vcTop2HoursShare",
  "vcTop3HoursShare",
  "tcGapSampleCount",
  ...activityHourMetrics,
]);

const activityJoint = joint(
  "activity-time-day-hour-v1",
  "rows.daypart-boundary",
  "rows.day-hour-social-evidence",
  "rows.daypart-share",
  "rows.tc-gap",
  "rows.vc-seconds",
);

/** No.32-37共通: activity-time-day-hour-v1の生rowはすべて同じ row group から導出する。 */
function activityDayHourAxes(no: number, rowGroupKey: string) {
  return [
    circularHourAxis(`candidate-${no}-daypart-boundary`, "rows.daypart-boundary", rowGroupKey),
    jointThresholdAxis(`candidate-${no}-qualifying-days`, "rows.day-hour-social-evidence", "FILTER_THEN_DISTINCT_DAYS", rowGroupKey),
    jointThresholdAxis(`candidate-${no}-tc-gap-ceiling`, "rows.tc-gap", "SCALAR_SAMPLE", rowGroupKey, "AT_MOST"),
    jointThresholdAxis(`candidate-${no}-vc-seconds`, "rows.vc-seconds", "SCALAR_SAMPLE", rowGroupKey),
    jointThresholdAxis(`candidate-${no}-activity-share`, "rows.daypart-share", "FILTER_THEN_SHARE", rowGroupKey),
  ];
}

const PLAN_INPUTS: readonly PlanInput[] = [
  measuredPlan(2, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "occurrenceSpanDays"], {
    axes: [metricAxis("welcoming-days", "distinctOccurrenceDays"), metricAxis("welcoming-span", "occurrenceSpanDays")],
  }),
  measuredPlan(7, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "occurrenceSpanDays"], {
    axes: [metricAxis("closer-days", "distinctOccurrenceDays"), metricAxis("closer-occurrences", "occurrenceCount")],
  }),
  measuredPlan(9, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "distinctChannels", "occurrenceSpanDays"], {
    axes: [
      metricAxis("lockup-days", "distinctOccurrenceDays"),
      metricAxis("lockup-span", "occurrenceSpanDays"),
      metricAxis("lockup-place-breadth", "distinctChannels"),
    ],
  }),

  measuredPlan(10, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("oneToOne"), { axes: vcPresenceAxes("oneToOne") }),
  measuredPlan(11, "MULTI_METRIC_CONJUNCTION", vcBucketStability("oneToOne"), { axes: vcStabilityAxes("oneToOne") }),
  measuredPlan(12, "MULTI_METRIC_CONJUNCTION", vcBucketStability("oneToOne"), {
    axes: [...vcStabilityAxes("oneToOne"), metricAxis("duo-long-active-days", "activeDays"), metricAxis("duo-long-span", "positiveSpanDays")],
  }),
  measuredPlan(13, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("smallGroup"), { axes: vcPresenceAxes("smallGroup") }),
  measuredPlan(14, "MULTI_METRIC_CONJUNCTION", vcBucketStability("smallGroup"), { axes: vcStabilityAxes("smallGroup") }),
  measuredPlan(15, "MULTI_METRIC_CONJUNCTION", vcBucketStability("smallGroup"), {
    axes: [...vcStabilityAxes("smallGroup"), metricAxis("small-long-active-days", "activeDays"), metricAxis("small-long-span", "positiveSpanDays")],
  }),
  measuredPlan(16, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("largeGroup"), { axes: vcPresenceAxes("largeGroup") }),
  measuredPlan(17, "MULTI_METRIC_CONJUNCTION", vcBucketStability("largeGroup"), { axes: vcStabilityAxes("largeGroup") }),
  measuredPlan(18, "MULTI_METRIC_CONJUNCTION", vcBucketStability("largeGroup"), {
    axes: [...vcStabilityAxes("largeGroup"), metricAxis("large-long-active-days", "activeDays"), metricAxis("large-long-span", "positiveSpanDays")],
  }),
  measuredPlan(19, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketPresence("oneToOne"), ...vcBucketPresence("largeGroup"),
  ], {
    axes: [...vcPresenceAxes("oneToOne"), ...vcPresenceAxes("largeGroup")],
  }),
  measuredPlan(20, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketPresence("oneToOne"), ...vcBucketPresence("smallGroup"), ...vcBucketPresence("largeGroup"), "positiveSocialBucketCount",
  ], {
    axes: [
      ...vcPresenceAxes("oneToOne"), ...vcPresenceAxes("smallGroup"), ...vcPresenceAxes("largeGroup"),
      metricAxis("social-bucket-breadth", "positiveSocialBucketCount"),
    ],
  }),
  measuredPlan(21, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketStability("oneToOne"), ...vcBucketStability("smallGroup"), ...vcBucketStability("largeGroup"), "positiveSocialBucketCount",
  ], {
    axes: [
      metricAxis("all-seat-breadth", "positiveSocialBucketCount"),
      metricAxis("all-seat-active-days", "socialPositiveDays"),
      metricAxis("all-seat-span", "positiveSpanDays"),
      metricAxis("duo-share-floor", "socialOnlyShare.oneToOne"),
      metricAxis("small-share-floor", "socialOnlyShare.smallGroup"),
      metricAxis("large-share-floor", "socialOnlyShare.largeGroup"),
      metricAxis("duo-share-ceiling", "socialOnlyShare.oneToOne", "AT_MOST"),
      metricAxis("small-share-ceiling", "socialOnlyShare.smallGroup", "AT_MOST"),
      metricAxis("large-share-ceiling", "socialOnlyShare.largeGroup", "AT_MOST"),
    ],
  }),

  measuredPlan(23, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthMedian", "dailyBreadthP90"], {
    axes: [metricAxis("circle-breadth", "distinctCoPresentUsers"), metricAxis("circle-days", "breadthPositiveDays"), metricAxis("circle-daily-breadth", "dailyBreadthMedian")],
  }),
  measuredPlan(24, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthP25", "dailyBreadthMedian"], {
    axes: [metricAxis("known-face-breadth", "distinctCoPresentUsers"), metricAxis("known-face-days", "breadthPositiveDays"), metricAxis("known-face-span", "breadthSpanDays"), metricAxis("known-face-daily-floor", "dailyBreadthP25")],
  }),
  measuredPlan(25, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthP75", "dailyBreadthP90"], {
    axes: [metricAxis("very-wide-breadth", "distinctCoPresentUsers"), metricAxis("very-wide-days", "breadthPositiveDays"), metricAxis("very-wide-span", "breadthSpanDays"), metricAxis("very-wide-daily-breadth", "dailyBreadthP75")],
  }),
  measuredPlan(26, "JOINT_CORRELATION", ["counterpartProfileCount", "distinctClassIndexCount", "touchEdgeCount", "totalTrustedSeconds", "unionTouchDays", "structuralMaxPersonClassMatching"], {
    requiredJointEvidence: joint("social-context-graph-v1", "counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"),
    axes: [
      jointThresholdAxis("class-edge-trusted-seconds", "counterparts.semantic-touch-days-seconds", "SCALAR_SAMPLE", "class-edges"),
      jointMatchingAxis("class-person-matching", "counterparts.maximum-matching", "class-edges"),
    ],
  }),
  measuredPlan(27, "JOINT_CORRELATION", ["counterpartProfileCount", "distinctFamilyIndexCount", "touchEdgeCount", "totalTrustedSeconds", "unionTouchDays", "structuralMaxPersonFamilyMatching"], {
    requiredJointEvidence: joint("social-context-graph-v1", "counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"),
    axes: [
      jointThresholdAxis("department-edge-trusted-seconds", "counterparts.semantic-touch-days-seconds", "SCALAR_SAMPLE", "family-edges"),
      jointMatchingAxis("department-person-matching", "counterparts.maximum-matching", "family-edges"),
    ],
  }),
  measuredPlan(28, "DISTRIBUTION_THRESHOLD", ["maxRepeatedDaysWithOneCounterpart", "distinctCoPresentUsers", "trustedOverlapSeconds"], {
    axes: [metricAxis("same-person-repeat-days", "maxRepeatedDaysWithOneCounterpart"), metricAxis("relationship-sample-seconds", "trustedOverlapSeconds")],
  }),

  ...([32, 33, 34, 35] as const).map((no) => measuredPlan(no, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: activityJoint,
    axes: activityDayHourAxes(no, `candidate-${no}-activity-day-hour-rows`),
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no daypart boundary."],
  })),
  measuredPlan(36, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: joint("activity-time-day-hour-v1", "rows.activity-start-hour", "rows.day-hour-social-evidence", "rows.tc-gap", "rows.vc-seconds"),
    axes: [
      circularHourAxis("usual-time-start-hour-stability", "rows.activity-start-hour", "usual-time-rows"),
      jointThresholdAxis("usual-time-qualifying-days", "rows.day-hour-social-evidence", "FILTER_THEN_DISTINCT_DAYS", "usual-time-rows"),
      metricAxis("usual-time-concentration", "vcTop3HoursShare"),
      metricAxis("usual-time-sample-seconds", "vcTotalTrustedSeconds"),
    ],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no stability band or daypart boundary."],
  }),
  measuredPlan(37, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: activityJoint,
    axes: [
      circularHourAxis("multi-daypart-boundaries", "rows.daypart-boundary", "multi-daypart-rows"),
      jointThresholdAxis("multi-daypart-distributed-days", "rows.day-hour-social-evidence", "FILTER_THEN_DISTINCT_DAYS", "multi-daypart-rows"),
      jointThresholdAxis("multi-daypart-tc-gap-ceiling", "rows.tc-gap", "SCALAR_SAMPLE", "multi-daypart-rows", "AT_MOST"),
      jointThresholdAxis("multi-daypart-vc-seconds", "rows.vc-seconds", "SCALAR_SAMPLE", "multi-daypart-rows"),
    ],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no daypart boundary and does not reward a single all-night session."],
  }),

  measuredPlan(38, "STRUCTURAL_PRESENCE", ["eventCount"], {
    structuralRequirements: ["At least one canonical eligible BUMP success after the catalog boundary."],
    fixedCriteria: [metricAtLeast("eventCount", 1)],
  }),
  measuredPlan(39, "MULTI_METRIC_CONJUNCTION", ["eventCount", "distinctActiveDays", "activeSpanDays"], {
    axes: [metricAxis("bump-days", "distinctActiveDays"), metricAxis("bump-events", "eventCount")],
  }),
  measuredPlan(40, "JOINT_CORRELATION", ["eventCount", "distinctActiveDays", "activeSpanDays", "sameDayExcessCount", "maxEventsPerDay"], {
    requiredJointEvidence: joint("day-occurrences-v1", "dayOffsets.calendar-periods"),
    axes: [
      jointThresholdAxis("bump-calendar-period-breadth", "dayOffsets.calendar-periods", "SET_BREADTH", "bump-day-rows"),
      metricAxis("bump-period-span", "activeSpanDays"),
    ],
  }),
  measuredPlan(41, "JOINT_CORRELATION", ["eventCount", "distinctActiveDays", "activeSpanDays", "sameDayExcessCount", "maxEventsPerDay"], {
    requiredJointEvidence: joint("day-occurrences-v1", "dayOffsets.calendar-periods"),
    axes: [
      jointThresholdAxis("stable-bump-periods", "dayOffsets.calendar-periods", "SET_BREADTH", "bump-day-rows"),
      metricAxis("stable-bump-days", "distinctActiveDays"),
      metricAxis("stable-bump-span", "activeSpanDays"),
    ],
  }),

  measuredPlan(42, "JOINT_CORRELATION", ["startCount", "startDistinctDays", "quietBeforeMsMedian", "nextOtherGapMsMedian", "nextOtherGapMissingCount"], {
    requiredJointEvidence: joint("tc-conversation-v1", "starts.quiet-before", "starts.next-other-gap", "starts.explicit-continuation", "starts.day-offset"),
    axes: [
      jointThresholdAxis("start-quiet-before", "starts.quiet-before", "SCALAR_SAMPLE", "tc-start-rows"),
      jointThresholdAxis("start-continuation-gap", "starts.next-other-gap", "SCALAR_SAMPLE", "tc-start-rows", "AT_MOST"),
      jointThresholdAxis("start-days", "starts.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-start-rows"),
    ],
  }),
  measuredPlan(43, "JOINT_CORRELATION", ["revivalConversationCount", "revivalOccurrenceCount", "revivalDistinctDays", "dormantBeforeMsMedian", "continuationGapMsMedian"], {
    requiredJointEvidence: joint("tc-conversation-v1", "revivals.conversation-group", "revivals.dormant-before", "revivals.continuation-gap"),
    axes: [
      jointThresholdAxis("revival-dormancy", "revivals.dormant-before", "SCALAR_SAMPLE", "tc-revival-rows"),
      jointThresholdAxis("revival-continuation-gap", "revivals.continuation-gap", "SCALAR_SAMPLE", "tc-revival-rows", "AT_MOST"),
      jointThresholdAxis("revival-qualifying-conversation-breadth", "revivals.conversation-group", "SET_BREADTH", "tc-revival-rows"),
    ],
  }),
  measuredPlan(44, "JOINT_CORRELATION", ["revivalConversationCount", "revivalOccurrenceCount", "revivalDistinctDays", "maxRevivalsPerConversation"], {
    requiredJointEvidence: joint("tc-conversation-v1", "revivals.conversation-group", "revivals.day-offset"),
    axes: [
      jointThresholdAxis("revival-conversation-breadth", "revivals.conversation-group", "SET_BREADTH", "tc-revival-breadth-rows"),
      jointThresholdAxis("revival-day-breadth", "revivals.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-revival-breadth-rows"),
    ],
  }),
  measuredPlan(45, "JOINT_CORRELATION", ["socialAreaCount", "socialAreaUnionDays", "maxSocialDaysPerArea", "socialAreaSpanDays"], {
    requiredJointEvidence: joint("tc-conversation-v1", "areas.surface-local-social-days", "areas.best-other-gap"),
    axes: [
      jointThresholdAxis("tc-area-breadth", "areas.surface-local-social-days", "SET_BREADTH", "tc-area-rows"),
      jointThresholdAxis("tc-area-gap-ceiling", "areas.best-other-gap", "SCALAR_SAMPLE", "tc-area-rows", "AT_MOST"),
    ],
  }),
  measuredPlan(46, "JOINT_CORRELATION", ["distinctReactors", "postCount", "reactionPositiveDays", "totalPostDayTouches", "perPostDistinctReactorsMedian", "perPostReactionDayCountMedian"], {
    requiredJointEvidence: joint("tc-reaction-posts-v1", "posts.post-breadth", "posts.day-breadth", "posts.reactor-breadth"),
    axes: [
      jointThresholdAxis("reaction-post-breadth", "posts.post-breadth", "SET_BREADTH", "reaction-post-rows"),
      jointThresholdAxis("reaction-day-breadth", "posts.day-breadth", "FILTER_THEN_DISTINCT_DAYS", "reaction-post-rows"),
      jointThresholdAxis("reaction-person-breadth", "posts.reactor-breadth", "SET_BREADTH", "reaction-post-rows"),
    ],
  }),
  measuredPlan(47, "JOINT_CORRELATION", ["thirdPartyJoinCount", "thirdPartyJoinDistinctDays", "priorDistinctOtherCountMedian", "thirdPartyNextOtherGapMsMedian", "priorSelfGapMsMedian"], {
    requiredJointEvidence: joint("tc-conversation-v1", "third-party.prior-distinct-others", "third-party.next-other-gap", "third-party.prior-self-gap", "third-party.day-offset"),
    axes: [
      jointThresholdAxis("prior-other-breadth", "third-party.prior-distinct-others", "SCALAR_SAMPLE", "tc-third-party-rows"),
      jointThresholdAxis("join-continuation-gap", "third-party.next-other-gap", "SCALAR_SAMPLE", "tc-third-party-rows", "AT_MOST"),
      jointThresholdAxis("join-day-breadth", "third-party.day-offset", "FILTER_THEN_DISTINCT_DAYS", "tc-third-party-rows"),
    ],
  }),
  measuredPlan(49, "JOINT_CORRELATION", ["tcCandidateSocialDays", "vcSocialDays", "unionModalityDays", "overlappingCalendarDays", "tcSpanDays", "vcSpanDays"], {
    requiredJointEvidence: joint("cross-modal-days-v1", "tc-days.gap", "vc-days.breadth", "modality-day-sets"),
    axes: [
      jointThresholdAxis("tc-meaningful-gap", "tc-days.gap", "SCALAR_SAMPLE", "tc-days-rows", "AT_MOST"),
      jointThresholdAxis("vc-breadth", "vc-days.breadth", "SCALAR_SAMPLE", "vc-days-rows"),
      jointThresholdAxis("modality-day-breadth", "modality-day-sets", "FILTER_THEN_DISTINCT_DAYS", "tc-vc-union-rows"),
    ],
  }),

  measuredPlan(50, "STRUCTURAL_PRESENCE", ["hostedSessionCount", "hostedDistinctGuests"], {
    structuralRequirements: ["A canonical eligible hosted-room session contains at least one valid guest visit."],
    fixedCriteria: [metricAtLeast("hostedDistinctGuests", 1)],
  }),
  measuredPlan(51, "DISTRIBUTION_THRESHOLD", ["hostedMaxConcurrentGuests", "hostedDistinctGuests", "hostedSessionCount"], { axes: [metricAxis("room-concurrent-guests", "hostedMaxConcurrentGuests"), metricAxis("room-hosted-sessions", "hostedSessionCount")] }),
  measuredPlan(52, "MULTI_METRIC_CONJUNCTION", ["hostedSessionCount", "hostedDistinctGuests", "hostedActiveDays", "hostedActiveSpanDays", "hostedDailyDistinctGuestsMedian", "hostedDailySessionsMedian"], {
    axes: [metricAxis("popular-room-days", "hostedActiveDays"), metricAxis("popular-room-sessions", "hostedSessionCount"), metricAxis("popular-room-guests", "hostedDistinctGuests")],
  }),
  measuredPlan(53, "DISTRIBUTION_THRESHOLD", ["hostedMaxRepeatGuestDepth", "hostedSessionCount", "hostedActiveDays"], { axes: [metricAxis("repeat-guest-depth", "hostedMaxRepeatGuestDepth")] }),
  measuredPlan(54, "MULTI_METRIC_CONJUNCTION", ["guestDistinctOwners", "guestSessionCount", "guestActiveDays", "guestActiveSpanDays", "guestDailyDistinctOwnersMedian"], {
    axes: [metricAxis("guest-owner-breadth", "guestDistinctOwners"), metricAxis("guest-days", "guestActiveDays"), metricAxis("guest-sessions", "guestSessionCount")],
  }),
  measuredPlan(55, "MULTI_METRIC_CONJUNCTION", ["hostedSessionCount", "hostedActiveDays", "guestSessionCount", "guestActiveDays", "activeSpanDays"], {
    axes: [metricAxis("host-side-sessions", "hostedSessionCount"), metricAxis("guest-side-sessions", "guestSessionCount"), metricAxis("room-two-sided-span", "activeSpanDays")],
  }),
  measuredPlan(56, "JOINT_CORRELATION", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "domainActiveSpanDays", "socialActiveDays", "socialTcGapSampleCount", "socialVcTrustedSeconds"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.public-room-own-use", "domainDays.day-offset"),
    axes: [
      jointThresholdAxis("own-room-use-days", "domainDays.public-room-own-use", "FILTER_THEN_DISTINCT_DAYS", "domain-day-rows"),
      jointThresholdAxis("own-room-use-span", "domainDays.day-offset", "FILTER_THEN_DISTINCT_DAYS", "domain-day-rows"),
    ],
  }),

  measuredPlan(58, "STRUCTURAL_PRESENCE", ["tipCount", "tipActiveDays"], {
    structuralRequirements: ["The first snapshot-valid normal tip to another user exists."],
    fixedCriteria: [metricAtLeast("tipCount", 1)],
    releaseGateNotes: ["Post-award reversal handling remains unresolved; SOURCE READY does not make this releasable."],
  }),
  measuredPlan(59, "MULTI_METRIC_CONJUNCTION", ["outgoingTipDistinctRecipients", "outgoingTipActiveDays", "outgoingTipActiveSpanDays", "dailyOutgoingTipDistinctRecipientsMedian"], {
    axes: [metricAxis("tip-recipient-breadth", "outgoingTipDistinctRecipients"), metricAxis("tip-day-breadth", "outgoingTipActiveDays")],
  }),
  measuredPlan(61, "MULTI_METRIC_CONJUNCTION", ["distinctFamilies", "distinctHumanCounterparts", "hasNaturalInflow", "hasNaturalOutflow", "economyActiveDays", "economyActiveSpanDays", "dailyDistinctHumanCounterpartsMedian"], {
    axes: [metricAxis("economy-family-breadth", "distinctFamilies"), metricAxis("economy-counterpart-breadth", "distinctHumanCounterparts"), metricAxis("economy-day-breadth", "economyActiveDays")],
    structuralRequirements: ["Natural inflow and natural outflow are both present; excluded reward/admin/casino/reversal flows remain absent."],
    fixedCriteria: [metricBooleanTrue("hasNaturalInflow"), metricBooleanTrue("hasNaturalOutflow")],
  }),
  measuredPlan(62, "MULTI_METRIC_CONJUNCTION", ["distinctEligibleProducts", "purchaseActiveDays", "purchaseActiveSpanDays", "dailyDistinctEligibleProductsMedian"], {
    axes: [metricAxis("eligible-product-breadth", "distinctEligibleProducts"), metricAxis("purchase-day-breadth", "purchaseActiveDays")],
  }),
  measuredPlan(63, "MANIFEST_CONFORMANCE", ["distinctSubjectUsedFamilies", "familySubjectUsed.peer_transfer", "familySubjectUsed.tip", "familySubjectUsed.shop"], {
    structuralRequirements: ["Breadth is evaluated only against the current explicit economy semantic-family manifest and subject-initiated outflow use."],
    manifestRef: economyManifestRef(),
  }),
  measuredPlan(65, "STRUCTURAL_PRESENCE", ["shopRoleEligiblePurchaseCount", "shopRolePurchaseActiveDays"], {
    structuralRequirements: ["An eligible storefront purchase occurs inside a trusted canonical shop-role interval."],
    fixedCriteria: [metricAtLeast("shopRoleEligiblePurchaseCount", 1)],
  }),

  measuredPlan(66, "STRUCTURAL_PRESENCE", ["completedActivityCount", "completedActivityDistinctFamilies", "completedActivityDays"], {
    structuralRequirements: ["At least one Edition-I target game reaches canonical successful financial completion."],
    fixedCriteria: [metricAtLeast("completedActivityCount", 1)],
  }),
  measuredPlan(67, "DISTRIBUTION_THRESHOLD", ["completedActivityCount", "completedActivityDistinctFamilies", "completedActivityDays", "completedActivitySpanDays"], { axes: [metricAxis("completed-game-family-breadth", "completedActivityDistinctFamilies"), metricAxis("completed-game-count", "completedActivityCount")] }),
  measuredPlan(68, "MULTI_METRIC_CONJUNCTION", ["activityCount", "activityDistinctFamilies", "activityDays", "activitySpanDays"], { axes: [metricAxis("casino-use-family-breadth", "activityDistinctFamilies"), metricAxis("casino-use-days", "activityDays")] }),
  measuredPlan(69, "MANIFEST_CONFORMANCE", ["distinctCompletedFamilies", "allFamiliesCompleted", "totalFamilyCompletionDays"], {
    structuralRequirements: ["Every family in the current Casino Edition-I manifest has canonical completion evidence."],
    manifestRef: casinoEditionManifestRef(),
  }),
  measuredPlan(70, "STRUCTURAL_PRESENCE", ["tableCount", "guestProfileCount", "guestStayRowCount", "guestActiveDays", "totalTrustedGuestSeconds"], {
    structuralRequirements: ["A subject-hosted official table has at least one valid non-owner human guest interval."],
    fixedCriteria: [metricAtLeast("guestStayRowCount", 1)],
  }),
  measuredPlan(71, "MULTI_METRIC_CONJUNCTION", ["guestProfileCount", "stayRowCount", "distinctHostedTableProfilesWithGuests", "hostedGuestTrustedSeconds", "busyTableActiveDays", "busyTableActiveSpanDays", "dailyHostedGuestTrustedSecondsMedian", "trustedSecondsPerGuestProfileMedian"], {
    axes: [metricAxis("busy-hosted-table-breadth", "distinctHostedTableProfilesWithGuests"), metricAxis("busy-table-day-breadth", "busyTableActiveDays"), metricAxis("busy-table-guest-breadth", "guestProfileCount"), metricAxis("busy-table-trusted-seconds", "hostedGuestTrustedSeconds")],
  }),
  measuredPlan(72, "MULTI_METRIC_CONJUNCTION", ["distinctOtherStandardBoards", "sumDailyDistinctOtherStandardBoards", "marketActiveDays", "marketActiveSpanDays", "dailyDistinctOtherStandardBoardsMedian"], {
    axes: [metricAxis("other-standard-board-breadth", "distinctOtherStandardBoards"), metricAxis("market-participation-days", "marketActiveDays"), metricAxis("market-participation-count", "sumDailyDistinctOtherStandardBoards")],
  }),

  measuredPlan(74, "STRUCTURAL_PRESENCE", ["confirmedInviteCount", "confirmationActiveDays"], {
    structuralRequirements: ["The first canonical confirmed direct-invite relation reaches immutable entry."],
    fixedCriteria: [metricAtLeast("confirmedInviteCount", 1)],
  }),
  measuredPlan(75, "DISTRIBUTION_THRESHOLD", ["confirmedInviteCount", "confirmationActiveDays", "confirmationActiveSpanDays"], { axes: [metricAxis("confirmed-direct-invite-count", "confirmedInviteCount")] }),
  measuredPlan(76, "JOINT_CORRELATION", ["directBranchProfileCount", "branchActivityDayCount", "branchActivityVcTrustedSocialSeconds", "branchActivityTcGapSampleCount", "activityDaysPerBranchMedian", "unknownEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.branch-activity-days", "profiles.branch-social-evidence"),
    axes: [
      jointThresholdAxis("rooted-branch-activity-days", "profiles.branch-activity-days", "FILTER_THEN_DISTINCT_DAYS", "invite-branch-rows"),
      jointThresholdAxis("rooted-branch-social-evidence", "profiles.branch-social-evidence", "SCALAR_SAMPLE", "invite-branch-rows"),
    ],
  }),
  measuredPlan(77, "STRUCTURAL_PLUS_DISTRIBUTION", ["directBranchProfileCount", "branchActivityDayCount", "nextGenerationOccurrenceCount", "nextGenerationSameDayVcTrustedSocialSeconds", "nextGenerationSameDayTcGapSampleCount", "unknownNextGenerationEntryAnchorCount"], {
    requiredJointEvidence: joint(
      "invite-rooted-v1",
      "profiles.root-before-child",
      "profiles.same-day-before-entry",
      "profiles.next-generation-occurrence",
      "profiles.next-generation-same-day-gap",
      "profiles.next-generation-same-day-seconds",
    ),
    axes: [
      jointThresholdAxis("next-generation-same-day-gap-ceiling", "profiles.next-generation-same-day-gap", "SCALAR_SAMPLE", "next-gen-rows", "AT_MOST"),
      jointThresholdAxis("next-generation-same-day-seconds", "profiles.next-generation-same-day-seconds", "SCALAR_SAMPLE", "next-gen-rows"),
      jointThresholdAxis("next-generation-qualifying-count", "profiles.next-generation-occurrence", "FILTER_THEN_COUNT", "next-gen-rows"),
    ],
    fixedCriteria: [
      jointStructuralFact("profiles.root-before-child"),
      jointStructuralFact("profiles.same-day-before-entry"),
      metricAtLeast("nextGenerationOccurrenceCount", 1),
    ],
    structuralRequirements: ["A canonical next-generation occurrence belongs to the same direct branch and is anchored to immutable child entry chronology."],
  }),
  measuredPlan(78, "JOINT_CORRELATION", ["directBranchProfileCount", "nextGenerationOccurrenceCount", "nextGenerationOccurrencesPerBranchMedian", "unknownNextGenerationEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.independent-rooted-branches", "profiles.root-before-child", "profiles.same-day-before-entry"),
    axes: [jointThresholdAxis("independent-rooted-branch-count", "profiles.independent-rooted-branches", "SET_BREADTH", "invite-forest-rows")],
    fixedCriteria: [jointStructuralFact("profiles.root-before-child"), jointStructuralFact("profiles.same-day-before-entry")],
    structuralRequirements: ["Every counted next-generation occurrence is anchored to the same-branch root-before-child immutable entry chronology."],
  }),
  measuredPlan(79, "JOINT_CORRELATION", ["directBranchProfileCount", "reunionDayCount", "reunionVcTrustedPairSeconds", "reunionTcGapSampleCount", "reunionDaysPerBranchMedian"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.reunion-days", "profiles.reunion-pair-social-evidence"),
    axes: [
      jointThresholdAxis("reunion-day-breadth", "profiles.reunion-days", "FILTER_THEN_DISTINCT_DAYS", "invite-reunion-rows"),
      jointThresholdAxis("reunion-social-evidence", "profiles.reunion-pair-social-evidence", "SCALAR_SAMPLE", "invite-reunion-rows"),
    ],
  }),

  measuredPlan(80, "STRUCTURAL_PRESENCE", ["completedParticipationCount", "completionActiveDays"], {
    structuralRequirements: ["A canonical completed event contains the subject as a confirmed general participant."],
    fixedCriteria: [metricAtLeast("completedParticipationCount", 1)],
  }),
  measuredPlan(81, "DISTRIBUTION_THRESHOLD", ["completedParticipationCount", "completionActiveDays", "completionActiveSpanDays"], { axes: [metricAxis("completed-event-participation-count", "completedParticipationCount")] }),
  measuredPlan(82, "MULTI_METRIC_CONJUNCTION", ["totalEventInvolvementCount", "eventDays", "eventSpanDays"], { axes: [metricAxis("event-calendar-days", "eventDays"), metricAxis("event-calendar-span", "eventSpanDays")] }),
  measuredPlan(83, "STRUCTURAL_PRESENCE", ["generalParticipantCount", "staffCount", "organizerCount", "participantOnlyCount", "totalEventInvolvementCount"], {
    structuralRequirements: ["A participant-only completed event and a distinct staff-or-organizer completed event both exist."],
    fixedCriteria: [metricAtLeast("participantOnlyCount", 1), anyMetricPositive("staffCount", "organizerCount")],
  }),
  measuredPlan(84, "STRUCTURAL_PRESENCE", ["primaryOrganizerCount", "totalEventInvolvementCount"], {
    structuralRequirements: ["A canonical completed event names the subject as its exactly-one primary organizer."],
    fixedCriteria: [metricAtLeast("primaryOrganizerCount", 1)],
  }),

  measuredPlan(85, "STRUCTURAL_PRESENCE", ["activeFamilyCount", "castleActiveDays"], {
    structuralRequirements: ["Meaningful use exists in two distinct families of the current Castle Edition-I manifest."],
    fixedCriteria: [metricAtLeast("activeFamilyCount", 2)],
  }),
  measuredPlan(86, "MANIFEST_CONFORMANCE", ["activeFamilyCount", "sumFamilyActiveDays", "castleActiveDays", "familiesPerActiveDayMedian"], {
    structuralRequirements: ["Breadth is interpreted only against the current Castle Edition-I family manifest."],
    manifestRef: castleEditionManifestRef(),
  }),
  measuredPlan(87, "MANIFEST_CONFORMANCE", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "socialActiveDays", "socialTcGapSampleCount", "socialVcTrustedSeconds"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.castle-family-superdomain", "socialHours.day-hour-evidence"),
    structuralRequirements: ["The current Castle Edition-I family-to-super-domain manifest supplies social, economy/play, and castle-wide domain coverage."],
    manifestRef: castleEditionManifestRef(),
  }),
  measuredPlan(88, "MANIFEST_CONFORMANCE", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "domainActiveSpanDays"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.castle-family-breadth"),
    structuralRequirements: ["Almost-all breadth is interpreted only against the current Castle Edition-I family manifest."],
    manifestRef: castleEditionManifestRef(),
  }),
  measuredPlan(89, "MANIFEST_CONFORMANCE", ["activeFamilyCount", "sumFamilyActiveDays", "castleActiveDays"], {
    structuralRequirements: ["Every family in the current Castle Edition-I manifest has meaningful-use evidence."],
    manifestRef: castleEditionManifestRef(),
  }),
  measuredPlan(90, "JOINT_CORRELATION", ["roleHeldFamilyCount", "insideActiveFamilyCount", "outsideActiveFamilyCount", "insideDayUnion", "outsideDayUnion", "insideOccurrenceCount", "outsideOccurrenceCount", "insideTrustedSeconds", "outsideTrustedSeconds"], {
    requiredJointEvidence: joint("castle-role-context-v1", "families.role-held-days", "families.inside-days", "families.outside-days"),
    axes: [
      jointThresholdAxis("role-held-family-breadth", "families.role-held-days", "SET_BREADTH", "castle-role-family-rows"),
      jointThresholdAxis("inside-domain-breadth", "families.inside-days", "SET_BREADTH", "castle-role-family-rows"),
      jointThresholdAxis("outside-domain-breadth", "families.outside-days", "SET_BREADTH", "castle-role-family-rows"),
    ],
  }),
  measuredPlan(91, "JOINT_CORRELATION", ["roleHeldFamilyCount", "outsideActiveFamilyCount", "outsideDayUnion", "outsideDaysCount", "outsideOccurrenceCount", "outsideTrustedSeconds"], {
    requiredJointEvidence: joint("castle-role-context-v1", "families.role-held-days", "families.outside-days", "families.outside-repeat-days"),
    axes: [
      jointThresholdAxis("outside-repeat-days", "families.outside-repeat-days", "REPEAT_PERIOD", "castle-outside-rows"),
      jointThresholdAxis("outside-activity-evidence", "families.outside-days", "SCALAR_SAMPLE", "castle-outside-rows"),
    ],
  }),
];

const JOINT_SELECTOR_ALLOWLIST = Object.freeze({
  "none": [],
  "activity-time-day-hour-v1": ["rows.daypart-boundary", "rows.day-hour-social-evidence", "rows.daypart-share", "rows.tc-gap", "rows.vc-seconds", "rows.activity-start-hour"],
  "day-occurrences-v1": ["dayOffsets.calendar-periods"],
  "social-breadth-days-v1": [],
  "social-context-graph-v1": ["counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"],
  "tc-conversation-v1": [
    "starts.quiet-before", "starts.next-other-gap", "starts.explicit-continuation", "starts.day-offset",
    "revivals.conversation-group", "revivals.dormant-before", "revivals.continuation-gap", "revivals.day-offset",
    "areas.surface-local-social-days", "areas.best-other-gap",
    "third-party.prior-distinct-others", "third-party.next-other-gap", "third-party.prior-self-gap", "third-party.day-offset",
  ],
  "tc-reaction-posts-v1": ["posts.post-breadth", "posts.day-breadth", "posts.reactor-breadth"],
  "cross-modal-days-v1": ["tc-days.gap", "vc-days.breadth", "modality-day-sets"],
  "domain-social-time-v1": [
    "domainDays.public-room-own-use", "domainDays.day-offset", "domainDays.castle-family-superdomain",
    "domainDays.castle-family-breadth", "socialHours.day-hour-evidence",
  ],
  "economy-actions-v1": [],
  "invite-rooted-v1": [
    "profiles.branch-activity-days", "profiles.branch-social-evidence", "profiles.root-before-child",
    "profiles.same-day-before-entry", "profiles.next-generation-occurrence", "profiles.independent-rooted-branches",
    "profiles.reunion-days", "profiles.reunion-pair-social-evidence",
    "profiles.next-generation-same-day-gap", "profiles.next-generation-same-day-seconds",
  ],
  "castle-role-context-v1": ["families.role-held-days", "families.inside-days", "families.outside-days", "families.outside-repeat-days"],
} satisfies Record<PlanningCalibrationJointEvidence["kind"], readonly string[]>);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const ownerByCandidate = new Map<number, CalibrationProbeKey>();
for (const probe of F5C_CALIBRATION_PROBES) {
  for (const no of probe.candidateNos) {
    if (ownerByCandidate.has(no)) throw new Error(`duplicate F5c probe ownership for candidate #${no}`);
    ownerByCandidate.set(no, probe.probeKey);
  }
}

function materializePlan(input: PlanInput): F5cCandidateSweepPlan {
  const candidate = TITLE_V2_CATALOG_CANDIDATES.find(({ no }) => no === input.no);
  const readiness = TITLE_V2_CATALOG_READINESS.find(({ no }) => no === input.no);
  const probeKey = ownerByCandidate.get(input.no);
  if (!candidate || !readiness || !probeKey) throw new Error(`unknown F5c sweep candidate #${input.no}`);
  const probe = F5C_CALIBRATION_PROBES.find((entry) => entry.probeKey === probeKey)!;
  // PR #190レビュー§12: measurementStatusはPlanInputで既にrequired fieldだが、
  // 実行時にも「未設定のまま素通りしない」ことを二重に保証する（防御的defense-in-depth）。
  if (input.measurementStatus !== "MEASURED" && input.measurementStatus !== "MEASUREMENT_GAP") {
    throw new Error(`#${input.no}: measurementStatus must be explicit (MEASURED or MEASUREMENT_GAP), got ${String(input.measurementStatus)}`);
  }
  if (input.measurementStatus === "MEASUREMENT_GAP") {
    if (!input.gapReason?.trim()) throw new Error(`#${input.no}: MEASUREMENT_GAP requires a non-empty gapReason`);
    if ((input.axes?.length ?? 0) > 0) throw new Error(`#${input.no}: MEASUREMENT_GAP must not declare sweep axes`);
  }
  const structuralRequirements = [...(input.structuralRequirements ?? [])].sort();
  const fixedCriteria = [...(input.fixedCriteria ?? [])];
  const manifestRef = input.manifestRef ?? null;
  if (structuralRequirements.length > 0 && fixedCriteria.length === 0 && manifestRef === null) {
    throw new Error(`#${input.no}: structuralRequirements is prose-only — a typed fixedCriteria or manifestRef is required`);
  }
  return {
    candidateNo: input.no,
    provisionalKey: candidate.provisionalKey,
    probeKey,
    thresholdCategory: readiness.thresholdCategory,
    optimizationRisk: readiness.optimizationRisk,
    measurementStatus: input.measurementStatus,
    gapReason: input.measurementStatus === "MEASUREMENT_GAP" ? input.gapReason!.trim() : null,
    evaluationShape: input.evaluationShape,
    requiredMetrics: [...new Set(input.requiredMetrics)].sort(),
    requiredJointEvidence: input.requiredJointEvidence ?? NONE,
    axes: [...(input.axes ?? [])].sort((a, b) => a.axisKey.localeCompare(b.axisKey)),
    fixedCriteria,
    manifestRef,
    structuralRequirements,
    coverageNotes: [...new Set([...probe.coverageLimitations, COVERAGE_NOTE, ...(input.coverageNotes ?? [])])].sort(),
    releaseGateNotes: [...(input.releaseGateNotes ?? [])].sort(),
  };
}

export const F5C_CANDIDATE_SWEEP_PLANS: readonly F5cCandidateSweepPlan[] = deepFreeze(
  PLAN_INPUTS.map(materializePlan).sort((a, b) => a.candidateNo - b.candidateNo),
);

export interface F5cCandidateSweepPlanAudit {
  readonly contractVersion: typeof F5C_SWEEP_CONTRACT_VERSION;
  readonly probeCount: number;
  readonly measurementCandidateCount: number;
  readonly readyCandidateCount: number;
  readonly plannedCandidateCount: number;
  readonly thresholdCategoryCounts: Readonly<Record<CandidateReadinessAudit["thresholdCategory"], number>>;
  readonly optimizationRiskCounts: Readonly<Record<CandidateReadinessAudit["optimizationRisk"], number>>;
  readonly declaredMeasurementGapCount: number;
  readonly unexecutablePlanCount: number;
  readonly unexecutablePlanCandidateNos: readonly number[];
  readonly duplicateCount: number;
  readonly nonReadyCandidateCount: number;
  readonly missingReadyCandidateNos: readonly number[];
  readonly unexpectedPlanCandidateNos: readonly number[];
  readonly candidateProbeOwnershipMismatches: readonly number[];
  readonly thresholdCategoryMismatches: readonly number[];
  readonly optimizationRiskMismatches: readonly number[];
  readonly unknownMetricSelectors: readonly string[];
  readonly unknownJointEvidenceSelectors: readonly string[];
  readonly manifestRefMismatches: readonly number[];
  readonly numericThresholdValueCount: number;
  readonly exactReadySet: boolean;
}

function countNumbers(value: unknown): number {
  if (typeof value === "number") return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNumbers(item), 0);
  if (value !== null && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + countNumbers(item), 0);
  return 0;
}

const CANONICAL_MANIFEST_REF_BUILDERS: Readonly<Record<F5cManifestRef["kind"], () => F5cManifestRef>> = {
  ECONOMY_SEMANTIC_FAMILIES: economyManifestRef,
  CASINO_EDITION: casinoEditionManifestRef,
  CASTLE_EDITION: castleEditionManifestRef,
};

export function auditF5cCandidateSweepPlans(): F5cCandidateSweepPlanAudit {
  const ready = TITLE_V2_CATALOG_READINESS.filter(({ status }) => status === "READY").sort((a, b) => a.no - b.no);
  const readySet = new Set(ready.map(({ no }) => no));
  const planNos = F5C_CANDIDATE_SWEEP_PLANS.map(({ candidateNo }) => candidateNo);
  const planSet = new Set(planNos);
  const measurementNos = F5C_CALIBRATION_PROBES.flatMap(({ candidateNos }) => candidateNos);
  const contracts = new Map(describeF5cCalibrationProbeContracts().map((contract) => [contract.probeKey, contract]));
  const unknownMetricSelectors: string[] = [];
  const unknownJointEvidenceSelectors: string[] = [];
  const candidateProbeOwnershipMismatches: number[] = [];
  const thresholdCategoryMismatches: number[] = [];
  const optimizationRiskMismatches: number[] = [];
  const manifestRefMismatches: number[] = [];
  const unexecutablePlanCandidateNos: number[] = [];

  for (const candidatePlan of F5C_CANDIDATE_SWEEP_PLANS) {
    const contract = contracts.get(candidatePlan.probeKey);
    const readiness = TITLE_V2_CATALOG_READINESS.find(({ no }) => no === candidatePlan.candidateNo)!;
    if (!contract?.candidateNos.includes(candidatePlan.candidateNo)) candidateProbeOwnershipMismatches.push(candidatePlan.candidateNo);
    if (candidatePlan.thresholdCategory !== readiness.thresholdCategory) thresholdCategoryMismatches.push(candidatePlan.candidateNo);
    if (candidatePlan.optimizationRisk !== readiness.optimizationRisk) optimizationRiskMismatches.push(candidatePlan.candidateNo);
    const knownMetrics = new Set(contract?.metricKeys ?? []);
    for (const metricKey of candidatePlan.requiredMetrics) {
      if (!knownMetrics.has(metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${metricKey}`);
    }
    for (const axis of candidatePlan.axes) {
      if (axis.source === "METRIC" && !knownMetrics.has(axis.metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${axis.metricKey}`);
    }
    for (const criterion of candidatePlan.fixedCriteria) {
      if (criterion.kind === "METRIC_COMPARE" || criterion.kind === "METRIC_BOOLEAN_TRUE") {
        if (!knownMetrics.has(criterion.metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${criterion.metricKey}`);
      }
      if (criterion.kind === "ANY_METRIC_POSITIVE") {
        for (const metricKey of criterion.metricKeys) {
          if (!knownMetrics.has(metricKey)) unknownMetricSelectors.push(`#${candidatePlan.candidateNo}:${metricKey}`);
        }
      }
    }
    const requiredJoint = candidatePlan.requiredJointEvidence;
    if (requiredJoint.kind !== "none" && contract?.jointEvidenceKind !== requiredJoint.kind) {
      unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:kind:${requiredJoint.kind}`);
    }
    const allowed = new Set(JOINT_SELECTOR_ALLOWLIST[requiredJoint.kind]);
    for (const selector of requiredJoint.selectors) {
      if (!allowed.has(selector)) unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:${selector}`);
    }
    for (const axis of candidatePlan.axes) {
      if (axis.source === "JOINT_EVIDENCE" && !allowed.has(axis.selector)) {
        unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:${axis.selector}`);
      }
    }
    for (const criterion of candidatePlan.fixedCriteria) {
      if (criterion.kind === "JOINT_STRUCTURAL_FACT" && (requiredJoint.kind === "none" || !allowed.has(criterion.selector))) {
        unknownJointEvidenceSelectors.push(`#${candidatePlan.candidateNo}:${requiredJoint.kind}:${criterion.selector}`);
      }
    }

    let unexecutable = false;
    if (candidatePlan.thresholdCategory === "STRUCTURAL_FIXED" && candidatePlan.fixedCriteria.length === 0) unexecutable = true;
    if (candidatePlan.thresholdCategory === "MANIFEST_DEPENDENT" && candidatePlan.manifestRef === null) unexecutable = true;
    if (candidatePlan.thresholdCategory === "STRUCTURAL_PLUS_DISTRIBUTION" && (candidatePlan.fixedCriteria.length === 0 || candidatePlan.axes.length === 0)) unexecutable = true;
    if (candidatePlan.structuralRequirements.length > 0 && candidatePlan.fixedCriteria.length === 0 && candidatePlan.manifestRef === null) unexecutable = true;
    if (candidatePlan.evaluationShape === "JOINT_CORRELATION" && (candidatePlan.requiredJointEvidence.kind === "none" || candidatePlan.axes.length === 0)) unexecutable = true;
    if (candidatePlan.thresholdCategory === "THRESHOLD_PENDING" && candidatePlan.axes.length === 0 && candidatePlan.fixedCriteria.length === 0) unexecutable = true;
    if (candidatePlan.measurementStatus === "MEASUREMENT_GAP" && (candidatePlan.axes.length > 0 || !candidatePlan.gapReason)) unexecutable = true;
    if (candidatePlan.manifestRef) {
      const canonical = CANONICAL_MANIFEST_REF_BUILDERS[candidatePlan.manifestRef.kind]();
      if (JSON.stringify(canonical) !== JSON.stringify(candidatePlan.manifestRef)) {
        manifestRefMismatches.push(candidatePlan.candidateNo);
        unexecutable = true;
      }
    }
    if (unexecutable) unexecutablePlanCandidateNos.push(candidatePlan.candidateNo);
  }

  const thresholdCategoryCounts = Object.fromEntries([
    "STRUCTURAL_FIXED", "THRESHOLD_PENDING", "MANIFEST_DEPENDENT", "STRUCTURAL_PLUS_DISTRIBUTION",
  ].map((category) => [category, F5C_CANDIDATE_SWEEP_PLANS.filter((entry) => entry.thresholdCategory === category).length])) as Record<CandidateReadinessAudit["thresholdCategory"], number>;
  const optimizationRiskCounts = Object.fromEntries(["LOW", "MANAGED", "HIGH"].map((risk) => [
    risk, F5C_CANDIDATE_SWEEP_PLANS.filter((entry) => entry.optimizationRisk === risk).length,
  ])) as Record<CandidateReadinessAudit["optimizationRisk"], number>;
  const missingReadyCandidateNos = ready.filter(({ no }) => !planSet.has(no)).map(({ no }) => no);
  const unexpectedPlanCandidateNos = planNos.filter((no) => !readySet.has(no));
  const duplicateCount = planNos.length - planSet.size + measurementNos.length - new Set(measurementNos).size;
  const numericThresholdValueCount = F5C_CANDIDATE_SWEEP_PLANS.reduce((sum, entry) => sum + countNumbers(entry.axes), 0);
  return deepFreeze({
    contractVersion: F5C_SWEEP_CONTRACT_VERSION,
    probeCount: F5C_CALIBRATION_PROBES.length,
    measurementCandidateCount: new Set(measurementNos).size,
    readyCandidateCount: ready.length,
    plannedCandidateCount: planNos.length,
    thresholdCategoryCounts,
    optimizationRiskCounts,
    declaredMeasurementGapCount: F5C_CANDIDATE_SWEEP_PLANS.filter(({ measurementStatus }) => measurementStatus === "MEASUREMENT_GAP").length,
    unexecutablePlanCount: unexecutablePlanCandidateNos.length,
    unexecutablePlanCandidateNos: [...new Set(unexecutablePlanCandidateNos)].sort((a, b) => a - b),
    duplicateCount,
    nonReadyCandidateCount: unexpectedPlanCandidateNos.length,
    missingReadyCandidateNos,
    unexpectedPlanCandidateNos,
    candidateProbeOwnershipMismatches,
    thresholdCategoryMismatches,
    optimizationRiskMismatches,
    unknownMetricSelectors: [...new Set(unknownMetricSelectors)].sort(),
    unknownJointEvidenceSelectors: [...new Set(unknownJointEvidenceSelectors)].sort(),
    manifestRefMismatches: [...new Set(manifestRefMismatches)].sort((a, b) => a - b),
    numericThresholdValueCount,
    exactReadySet: missingReadyCandidateNos.length === 0 && unexpectedPlanCandidateNos.length === 0,
  });
}

/**
 * テスト専用: measuredPlan()/gapPlan()のno-silent-default機構自体を直接演習するための
 * 内部builder。production plan set（`F5C_CANDIDATE_SWEEP_PLANS`）には一切影響しない。
 */
export const __internal = { plan, measuredPlan, gapPlan, materializePlan };
