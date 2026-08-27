import { TITLE_V2_CATALOG_CANDIDATES } from "./v2-catalog-candidates.js";
import { TITLE_V2_CATALOG_READINESS, type CandidateReadinessAudit } from "./v2-catalog-readiness.js";
import {
  describeF5cCalibrationProbeContracts,
  F5C_CALIBRATION_PROBES,
  type CalibrationProbeKey,
  type PlanningCalibrationJointEvidence,
} from "./v2-calibration.js";

/** Planning-only contract. Never import from evaluator, pipeline, Bot, or the public v2 barrel. */
export const F5C_SWEEP_CONTRACT_VERSION = 1 as const;

export type F5cEvaluationShape =
  | "STRUCTURAL_PRESENCE"
  | "MANIFEST_CONFORMANCE"
  | "DISTRIBUTION_THRESHOLD"
  | "MULTI_METRIC_CONJUNCTION"
  | "JOINT_CORRELATION"
  | "STRUCTURAL_PLUS_DISTRIBUTION";

export type F5cSweepOperator = "AT_LEAST" | "AT_MOST";

export type F5cSweepAxis =
  | {
      readonly axisKey: string;
      readonly source: "METRIC";
      readonly metricKey: string;
      readonly operator: F5cSweepOperator;
      readonly boundaryMethod: "OBSERVED_NEAREST_RANK";
    }
  | {
      readonly axisKey: string;
      readonly source: "JOINT_EVIDENCE";
      readonly selector: string;
      readonly operator: F5cSweepOperator;
      readonly boundaryMethod: "OBSERVED_NEAREST_RANK";
    };

export interface F5cRequiredJointEvidence {
  readonly kind: PlanningCalibrationJointEvidence["kind"];
  readonly selectors: readonly string[];
}

export interface F5cCandidateSweepPlan {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly probeKey: CalibrationProbeKey;
  readonly thresholdCategory: CandidateReadinessAudit["thresholdCategory"];
  readonly optimizationRisk: CandidateReadinessAudit["optimizationRisk"];
  readonly measurementStatus: "MEASURED" | "MEASUREMENT_GAP";
  readonly evaluationShape: F5cEvaluationShape;
  readonly requiredMetrics: readonly string[];
  readonly requiredJointEvidence: F5cRequiredJointEvidence;
  readonly axes: readonly F5cSweepAxis[];
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
  readonly structuralRequirements?: readonly string[];
  readonly coverageNotes?: readonly string[];
  readonly releaseGateNotes?: readonly string[];
  readonly measurementStatus?: F5cCandidateSweepPlan["measurementStatus"];
}

const NONE = Object.freeze({ kind: "none", selectors: Object.freeze([]) }) satisfies F5cRequiredJointEvidence;
const COVERAGE_NOTE = "Unknown or pre-rollout source coverage must remain distinct from observed zero activity.";

function metricAxis(axisKey: string, metricKey: string, operator: F5cSweepOperator = "AT_LEAST"): F5cSweepAxis {
  return { axisKey, source: "METRIC", metricKey, operator, boundaryMethod: "OBSERVED_NEAREST_RANK" };
}

function jointAxis(axisKey: string, selector: string, operator: F5cSweepOperator = "AT_LEAST"): F5cSweepAxis {
  return { axisKey, source: "JOINT_EVIDENCE", selector, operator, boundaryMethod: "OBSERVED_NEAREST_RANK" };
}

function joint(kind: Exclude<PlanningCalibrationJointEvidence["kind"], "none">, ...selectors: string[]): F5cRequiredJointEvidence {
  return { kind, selectors };
}

function plan(
  no: number,
  evaluationShape: F5cEvaluationShape,
  requiredMetrics: readonly string[],
  options: Omit<PlanInput, "no" | "evaluationShape" | "requiredMetrics"> = {},
): PlanInput {
  return { no, evaluationShape, requiredMetrics, ...options };
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

const PLAN_INPUTS: readonly PlanInput[] = [
  plan(2, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "occurrenceSpanDays"], {
    axes: [metricAxis("welcoming-days", "distinctOccurrenceDays"), metricAxis("welcoming-span", "occurrenceSpanDays")],
  }),
  plan(7, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "occurrenceSpanDays"], {
    axes: [metricAxis("closer-days", "distinctOccurrenceDays"), metricAxis("closer-occurrences", "occurrenceCount")],
  }),
  plan(9, "MULTI_METRIC_CONJUNCTION", ["occurrenceCount", "distinctOccurrenceDays", "distinctChannels", "occurrenceSpanDays"], {
    axes: [
      metricAxis("lockup-days", "distinctOccurrenceDays"),
      metricAxis("lockup-span", "occurrenceSpanDays"),
      metricAxis("lockup-place-breadth", "distinctChannels"),
    ],
  }),

  plan(10, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("oneToOne"), { axes: vcPresenceAxes("oneToOne") }),
  plan(11, "MULTI_METRIC_CONJUNCTION", vcBucketStability("oneToOne"), { axes: vcStabilityAxes("oneToOne") }),
  plan(12, "MULTI_METRIC_CONJUNCTION", vcBucketStability("oneToOne"), {
    axes: [...vcStabilityAxes("oneToOne"), metricAxis("duo-long-active-days", "activeDays"), metricAxis("duo-long-span", "positiveSpanDays")],
  }),
  plan(13, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("smallGroup"), { axes: vcPresenceAxes("smallGroup") }),
  plan(14, "MULTI_METRIC_CONJUNCTION", vcBucketStability("smallGroup"), { axes: vcStabilityAxes("smallGroup") }),
  plan(15, "MULTI_METRIC_CONJUNCTION", vcBucketStability("smallGroup"), {
    axes: [...vcStabilityAxes("smallGroup"), metricAxis("small-long-active-days", "activeDays"), metricAxis("small-long-span", "positiveSpanDays")],
  }),
  plan(16, "MULTI_METRIC_CONJUNCTION", vcBucketPresence("largeGroup"), { axes: vcPresenceAxes("largeGroup") }),
  plan(17, "MULTI_METRIC_CONJUNCTION", vcBucketStability("largeGroup"), { axes: vcStabilityAxes("largeGroup") }),
  plan(18, "MULTI_METRIC_CONJUNCTION", vcBucketStability("largeGroup"), {
    axes: [...vcStabilityAxes("largeGroup"), metricAxis("large-long-active-days", "activeDays"), metricAxis("large-long-span", "positiveSpanDays")],
  }),
  plan(19, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketPresence("oneToOne"), ...vcBucketPresence("largeGroup"),
  ], {
    axes: [...vcPresenceAxes("oneToOne"), ...vcPresenceAxes("largeGroup")],
  }),
  plan(20, "MULTI_METRIC_CONJUNCTION", [
    ...vcBucketPresence("oneToOne"), ...vcBucketPresence("smallGroup"), ...vcBucketPresence("largeGroup"), "positiveSocialBucketCount",
  ], {
    axes: [
      ...vcPresenceAxes("oneToOne"), ...vcPresenceAxes("smallGroup"), ...vcPresenceAxes("largeGroup"),
      metricAxis("social-bucket-breadth", "positiveSocialBucketCount"),
    ],
  }),
  plan(21, "MULTI_METRIC_CONJUNCTION", [
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

  plan(23, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthMedian", "dailyBreadthP90"], {
    axes: [metricAxis("circle-breadth", "distinctCoPresentUsers"), metricAxis("circle-days", "breadthPositiveDays"), metricAxis("circle-daily-breadth", "dailyBreadthMedian")],
  }),
  plan(24, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthP25", "dailyBreadthMedian"], {
    axes: [metricAxis("known-face-breadth", "distinctCoPresentUsers"), metricAxis("known-face-days", "breadthPositiveDays"), metricAxis("known-face-span", "breadthSpanDays"), metricAxis("known-face-daily-floor", "dailyBreadthP25")],
  }),
  plan(25, "MULTI_METRIC_CONJUNCTION", ["distinctCoPresentUsers", "trustedOverlapSeconds", "breadthPositiveDays", "breadthSpanDays", "dailyBreadthP75", "dailyBreadthP90"], {
    axes: [metricAxis("very-wide-breadth", "distinctCoPresentUsers"), metricAxis("very-wide-days", "breadthPositiveDays"), metricAxis("very-wide-span", "breadthSpanDays"), metricAxis("very-wide-daily-breadth", "dailyBreadthP75")],
  }),
  plan(26, "JOINT_CORRELATION", ["counterpartProfileCount", "distinctClassIndexCount", "touchEdgeCount", "totalTrustedSeconds", "unionTouchDays", "structuralMaxPersonClassMatching"], {
    requiredJointEvidence: joint("social-context-graph-v1", "counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"),
    axes: [jointAxis("class-edge-trusted-seconds", "counterparts.semantic-touch-days-seconds"), jointAxis("class-person-matching", "counterparts.maximum-matching")],
  }),
  plan(27, "JOINT_CORRELATION", ["counterpartProfileCount", "distinctFamilyIndexCount", "touchEdgeCount", "totalTrustedSeconds", "unionTouchDays", "structuralMaxPersonFamilyMatching"], {
    requiredJointEvidence: joint("social-context-graph-v1", "counterparts.semantic-touch-days-seconds", "counterparts.maximum-matching"),
    axes: [jointAxis("department-edge-trusted-seconds", "counterparts.semantic-touch-days-seconds"), jointAxis("department-person-matching", "counterparts.maximum-matching")],
  }),
  plan(28, "DISTRIBUTION_THRESHOLD", ["maxRepeatedDaysWithOneCounterpart", "distinctCoPresentUsers", "trustedOverlapSeconds"], {
    axes: [metricAxis("same-person-repeat-days", "maxRepeatedDaysWithOneCounterpart"), metricAxis("relationship-sample-seconds", "trustedOverlapSeconds")],
  }),

  ...([32, 33, 34, 35] as const).map((no) => plan(no, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: activityJoint,
    axes: [
      jointAxis(`candidate-${no}-daypart-boundary`, "rows.daypart-boundary"),
      jointAxis(`candidate-${no}-qualifying-days`, "rows.day-hour-social-evidence"),
      jointAxis(`candidate-${no}-tc-gap-ceiling`, "rows.tc-gap", "AT_MOST"),
      jointAxis(`candidate-${no}-vc-seconds`, "rows.vc-seconds"),
      jointAxis(`candidate-${no}-activity-share`, "rows.daypart-share"),
    ],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no daypart boundary."],
  })),
  plan(36, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: joint("activity-time-day-hour-v1", "rows.activity-start-hour", "rows.day-hour-social-evidence", "rows.tc-gap", "rows.vc-seconds"),
    axes: [
      jointAxis("usual-time-start-hour-stability", "rows.activity-start-hour"),
      jointAxis("usual-time-qualifying-days", "rows.day-hour-social-evidence"),
      metricAxis("usual-time-concentration", "vcTop3HoursShare"),
      metricAxis("usual-time-sample-seconds", "vcTotalTrustedSeconds"),
    ],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no stability band or daypart boundary."],
  }),
  plan(37, "JOINT_CORRELATION", activityMetrics, {
    requiredJointEvidence: activityJoint,
    axes: [
      jointAxis("multi-daypart-boundaries", "rows.daypart-boundary"),
      jointAxis("multi-daypart-distributed-days", "rows.day-hour-social-evidence"),
      jointAxis("multi-daypart-tc-gap-ceiling", "rows.tc-gap", "AT_MOST"),
      jointAxis("multi-daypart-vc-seconds", "rows.vc-seconds"),
    ],
    coverageNotes: ["JST hour bins are measurement resolution; F5c1 fixes no daypart boundary and does not reward a single all-night session."],
  }),

  plan(38, "STRUCTURAL_PRESENCE", ["eventCount"], { structuralRequirements: ["At least one canonical eligible BUMP success after the catalog boundary."] }),
  plan(39, "MULTI_METRIC_CONJUNCTION", ["eventCount", "distinctActiveDays", "activeSpanDays"], {
    axes: [metricAxis("bump-days", "distinctActiveDays"), metricAxis("bump-events", "eventCount")],
  }),
  plan(40, "JOINT_CORRELATION", ["eventCount", "distinctActiveDays", "activeSpanDays", "sameDayExcessCount", "maxEventsPerDay"], {
    requiredJointEvidence: joint("day-occurrences-v1", "dayOffsets.calendar-periods"),
    axes: [jointAxis("bump-calendar-period-breadth", "dayOffsets.calendar-periods"), metricAxis("bump-period-span", "activeSpanDays")],
  }),
  plan(41, "JOINT_CORRELATION", ["eventCount", "distinctActiveDays", "activeSpanDays", "sameDayExcessCount", "maxEventsPerDay"], {
    requiredJointEvidence: joint("day-occurrences-v1", "dayOffsets.calendar-periods"),
    axes: [jointAxis("stable-bump-periods", "dayOffsets.calendar-periods"), metricAxis("stable-bump-days", "distinctActiveDays"), metricAxis("stable-bump-span", "activeSpanDays")],
  }),

  plan(42, "JOINT_CORRELATION", ["startCount", "startDistinctDays", "quietBeforeMsMedian", "nextOtherGapMsMedian", "nextOtherGapMissingCount"], {
    requiredJointEvidence: joint("tc-conversation-v1", "starts.quiet-before", "starts.next-other-gap", "starts.explicit-continuation", "starts.day-offset"),
    axes: [jointAxis("start-quiet-before", "starts.quiet-before"), jointAxis("start-continuation-gap", "starts.next-other-gap", "AT_MOST"), jointAxis("start-days", "starts.day-offset")],
  }),
  plan(43, "JOINT_CORRELATION", ["revivalConversationCount", "revivalOccurrenceCount", "revivalDistinctDays", "dormantBeforeMsMedian", "continuationGapMsMedian"], {
    requiredJointEvidence: joint("tc-conversation-v1", "revivals.conversation-group", "revivals.dormant-before", "revivals.continuation-gap"),
    axes: [jointAxis("revival-dormancy", "revivals.dormant-before"), jointAxis("revival-continuation-gap", "revivals.continuation-gap", "AT_MOST")],
  }),
  plan(44, "JOINT_CORRELATION", ["revivalConversationCount", "revivalOccurrenceCount", "revivalDistinctDays", "maxRevivalsPerConversation"], {
    requiredJointEvidence: joint("tc-conversation-v1", "revivals.conversation-group", "revivals.day-offset"),
    axes: [jointAxis("revival-conversation-breadth", "revivals.conversation-group"), jointAxis("revival-day-breadth", "revivals.day-offset")],
  }),
  plan(45, "JOINT_CORRELATION", ["socialAreaCount", "socialAreaUnionDays", "maxSocialDaysPerArea", "socialAreaSpanDays"], {
    requiredJointEvidence: joint("tc-conversation-v1", "areas.surface-local-social-days", "areas.best-other-gap"),
    axes: [jointAxis("tc-area-breadth", "areas.surface-local-social-days"), jointAxis("tc-area-gap-ceiling", "areas.best-other-gap", "AT_MOST")],
  }),
  plan(46, "JOINT_CORRELATION", ["distinctReactors", "postCount", "reactionPositiveDays", "totalPostDayTouches", "perPostDistinctReactorsMedian", "perPostReactionDayCountMedian"], {
    requiredJointEvidence: joint("tc-reaction-posts-v1", "posts.post-breadth", "posts.day-breadth", "posts.reactor-breadth"),
    axes: [jointAxis("reaction-post-breadth", "posts.post-breadth"), jointAxis("reaction-day-breadth", "posts.day-breadth"), jointAxis("reaction-person-breadth", "posts.reactor-breadth")],
  }),
  plan(47, "JOINT_CORRELATION", ["thirdPartyJoinCount", "thirdPartyJoinDistinctDays", "priorDistinctOtherCountMedian", "thirdPartyNextOtherGapMsMedian", "priorSelfGapMsMedian"], {
    requiredJointEvidence: joint("tc-conversation-v1", "third-party.prior-distinct-others", "third-party.next-other-gap", "third-party.prior-self-gap", "third-party.day-offset"),
    axes: [jointAxis("prior-other-breadth", "third-party.prior-distinct-others"), jointAxis("join-continuation-gap", "third-party.next-other-gap", "AT_MOST"), jointAxis("join-day-breadth", "third-party.day-offset")],
  }),
  plan(49, "JOINT_CORRELATION", ["tcCandidateSocialDays", "vcSocialDays", "unionModalityDays", "overlappingCalendarDays", "tcSpanDays", "vcSpanDays"], {
    requiredJointEvidence: joint("cross-modal-days-v1", "tc-days.gap", "vc-days.breadth", "modality-day-sets"),
    axes: [jointAxis("tc-meaningful-gap", "tc-days.gap", "AT_MOST"), jointAxis("vc-breadth", "vc-days.breadth"), jointAxis("modality-day-breadth", "modality-day-sets")],
  }),

  plan(50, "STRUCTURAL_PRESENCE", ["hostedSessionCount", "hostedDistinctGuests"], { structuralRequirements: ["A canonical eligible hosted-room session contains at least one valid guest visit."] }),
  plan(51, "DISTRIBUTION_THRESHOLD", ["hostedMaxConcurrentGuests", "hostedDistinctGuests", "hostedSessionCount"], { axes: [metricAxis("room-concurrent-guests", "hostedMaxConcurrentGuests"), metricAxis("room-hosted-sessions", "hostedSessionCount")] }),
  plan(52, "MULTI_METRIC_CONJUNCTION", ["hostedSessionCount", "hostedDistinctGuests", "hostedActiveDays", "hostedActiveSpanDays", "hostedDailyDistinctGuestsMedian", "hostedDailySessionsMedian"], {
    axes: [metricAxis("popular-room-days", "hostedActiveDays"), metricAxis("popular-room-sessions", "hostedSessionCount"), metricAxis("popular-room-guests", "hostedDistinctGuests")],
  }),
  plan(53, "DISTRIBUTION_THRESHOLD", ["hostedMaxRepeatGuestDepth", "hostedSessionCount", "hostedActiveDays"], { axes: [metricAxis("repeat-guest-depth", "hostedMaxRepeatGuestDepth")] }),
  plan(54, "MULTI_METRIC_CONJUNCTION", ["guestDistinctOwners", "guestSessionCount", "guestActiveDays", "guestActiveSpanDays", "guestDailyDistinctOwnersMedian"], {
    axes: [metricAxis("guest-owner-breadth", "guestDistinctOwners"), metricAxis("guest-days", "guestActiveDays"), metricAxis("guest-sessions", "guestSessionCount")],
  }),
  plan(55, "MULTI_METRIC_CONJUNCTION", ["hostedSessionCount", "hostedActiveDays", "guestSessionCount", "guestActiveDays", "activeSpanDays"], {
    axes: [metricAxis("host-side-sessions", "hostedSessionCount"), metricAxis("guest-side-sessions", "guestSessionCount"), metricAxis("room-two-sided-span", "activeSpanDays")],
  }),
  plan(56, "JOINT_CORRELATION", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "domainActiveSpanDays", "socialActiveDays", "socialTcGapSampleCount", "socialVcTrustedSeconds"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.public-room-own-use", "domainDays.day-offset"),
    axes: [jointAxis("own-room-use-days", "domainDays.public-room-own-use"), jointAxis("own-room-use-span", "domainDays.day-offset")],
  }),

  plan(58, "STRUCTURAL_PRESENCE", ["tipCount", "tipActiveDays"], {
    structuralRequirements: ["The first snapshot-valid normal tip to another user exists."],
    releaseGateNotes: ["Post-award reversal handling remains unresolved; SOURCE READY does not make this releasable."],
  }),
  plan(59, "MULTI_METRIC_CONJUNCTION", ["outgoingTipDistinctRecipients", "outgoingTipActiveDays", "outgoingTipActiveSpanDays", "dailyOutgoingTipDistinctRecipientsMedian"], {
    axes: [metricAxis("tip-recipient-breadth", "outgoingTipDistinctRecipients"), metricAxis("tip-day-breadth", "outgoingTipActiveDays")],
  }),
  plan(61, "MULTI_METRIC_CONJUNCTION", ["distinctFamilies", "distinctHumanCounterparts", "hasNaturalInflow", "hasNaturalOutflow", "economyActiveDays", "economyActiveSpanDays", "dailyDistinctHumanCounterpartsMedian"], {
    axes: [metricAxis("economy-family-breadth", "distinctFamilies"), metricAxis("economy-counterpart-breadth", "distinctHumanCounterparts"), metricAxis("economy-day-breadth", "economyActiveDays")],
    structuralRequirements: ["Natural inflow and natural outflow are both present; excluded reward/admin/casino/reversal flows remain absent."],
  }),
  plan(62, "MULTI_METRIC_CONJUNCTION", ["distinctEligibleProducts", "purchaseActiveDays", "purchaseActiveSpanDays", "dailyDistinctEligibleProductsMedian"], {
    axes: [metricAxis("eligible-product-breadth", "distinctEligibleProducts"), metricAxis("purchase-day-breadth", "purchaseActiveDays")],
  }),
  plan(63, "MANIFEST_CONFORMANCE", ["distinctSubjectUsedFamilies", "familySubjectUsed.peer_transfer", "familySubjectUsed.tip", "familySubjectUsed.shop"], {
    structuralRequirements: ["Breadth is evaluated only against the current explicit economy semantic-family manifest and subject-initiated outflow use."],
  }),
  plan(65, "STRUCTURAL_PRESENCE", ["shopRoleEligiblePurchaseCount", "shopRolePurchaseActiveDays"], { structuralRequirements: ["An eligible storefront purchase occurs inside a trusted canonical shop-role interval."] }),

  plan(66, "STRUCTURAL_PRESENCE", ["completedActivityCount", "completedActivityDistinctFamilies", "completedActivityDays"], { structuralRequirements: ["At least one Edition-I target game reaches canonical successful financial completion."] }),
  plan(67, "DISTRIBUTION_THRESHOLD", ["completedActivityCount", "completedActivityDistinctFamilies", "completedActivityDays", "completedActivitySpanDays"], { axes: [metricAxis("completed-game-family-breadth", "completedActivityDistinctFamilies"), metricAxis("completed-game-count", "completedActivityCount")] }),
  plan(68, "MULTI_METRIC_CONJUNCTION", ["activityCount", "activityDistinctFamilies", "activityDays", "activitySpanDays"], { axes: [metricAxis("casino-use-family-breadth", "activityDistinctFamilies"), metricAxis("casino-use-days", "activityDays")] }),
  plan(69, "MANIFEST_CONFORMANCE", ["distinctCompletedFamilies", "allFamiliesCompleted", "totalFamilyCompletionDays"], { structuralRequirements: ["Every family in the current Casino Edition-I manifest has canonical completion evidence."] }),
  plan(70, "STRUCTURAL_PRESENCE", ["tableCount", "guestProfileCount", "guestStayRowCount", "guestActiveDays", "totalTrustedGuestSeconds"], { structuralRequirements: ["A subject-hosted official table has at least one valid non-owner human guest interval."] }),
  plan(71, "MULTI_METRIC_CONJUNCTION", ["guestProfileCount", "stayRowCount", "distinctHostedTableProfilesWithGuests", "hostedGuestTrustedSeconds", "busyTableActiveDays", "busyTableActiveSpanDays", "dailyHostedGuestTrustedSecondsMedian", "trustedSecondsPerGuestProfileMedian"], {
    axes: [metricAxis("busy-hosted-table-breadth", "distinctHostedTableProfilesWithGuests"), metricAxis("busy-table-day-breadth", "busyTableActiveDays"), metricAxis("busy-table-guest-breadth", "guestProfileCount"), metricAxis("busy-table-trusted-seconds", "hostedGuestTrustedSeconds")],
  }),
  plan(72, "MULTI_METRIC_CONJUNCTION", ["distinctOtherStandardBoards", "sumDailyDistinctOtherStandardBoards", "marketActiveDays", "marketActiveSpanDays", "dailyDistinctOtherStandardBoardsMedian"], {
    axes: [metricAxis("other-standard-board-breadth", "distinctOtherStandardBoards"), metricAxis("market-participation-days", "marketActiveDays"), metricAxis("market-participation-count", "sumDailyDistinctOtherStandardBoards")],
  }),

  plan(74, "STRUCTURAL_PRESENCE", ["confirmedInviteCount", "confirmationActiveDays"], { structuralRequirements: ["The first canonical confirmed direct-invite relation reaches immutable entry."] }),
  plan(75, "DISTRIBUTION_THRESHOLD", ["confirmedInviteCount", "confirmationActiveDays", "confirmationActiveSpanDays"], { axes: [metricAxis("confirmed-direct-invite-count", "confirmedInviteCount")] }),
  plan(76, "JOINT_CORRELATION", ["directBranchProfileCount", "branchActivityDayCount", "branchActivityVcTrustedSocialSeconds", "branchActivityTcGapSampleCount", "activityDaysPerBranchMedian", "unknownEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.branch-activity-days", "profiles.branch-social-evidence"),
    axes: [jointAxis("rooted-branch-activity-days", "profiles.branch-activity-days"), jointAxis("rooted-branch-social-evidence", "profiles.branch-social-evidence")],
  }),
  plan(77, "STRUCTURAL_PLUS_DISTRIBUTION", ["directBranchProfileCount", "branchActivityDayCount", "nextGenerationOccurrenceCount", "nextGenerationSameDayVcTrustedSocialSeconds", "nextGenerationSameDayTcGapSampleCount", "unknownNextGenerationEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.root-before-child", "profiles.same-day-before-entry", "profiles.next-generation-occurrence"),
    axes: [jointAxis("branch-rooted-before-child", "profiles.root-before-child"), jointAxis("same-day-entry-prefix-evidence", "profiles.same-day-before-entry")],
    structuralRequirements: ["A canonical next-generation occurrence belongs to the same direct branch and is anchored to immutable child entry chronology."],
  }),
  plan(78, "JOINT_CORRELATION", ["directBranchProfileCount", "nextGenerationOccurrenceCount", "nextGenerationOccurrencesPerBranchMedian", "unknownNextGenerationEntryAnchorCount"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.independent-rooted-branches", "profiles.root-before-child", "profiles.same-day-before-entry"),
    axes: [jointAxis("independent-rooted-branch-count", "profiles.independent-rooted-branches"), jointAxis("forest-root-before-child", "profiles.root-before-child")],
  }),
  plan(79, "JOINT_CORRELATION", ["directBranchProfileCount", "reunionDayCount", "reunionVcTrustedPairSeconds", "reunionTcGapSampleCount", "reunionDaysPerBranchMedian"], {
    requiredJointEvidence: joint("invite-rooted-v1", "profiles.reunion-days", "profiles.reunion-pair-social-evidence"),
    axes: [jointAxis("reunion-day-breadth", "profiles.reunion-days"), jointAxis("reunion-social-evidence", "profiles.reunion-pair-social-evidence")],
  }),

  plan(80, "STRUCTURAL_PRESENCE", ["completedParticipationCount", "completionActiveDays"], { structuralRequirements: ["A canonical completed event contains the subject as a confirmed general participant."] }),
  plan(81, "DISTRIBUTION_THRESHOLD", ["completedParticipationCount", "completionActiveDays", "completionActiveSpanDays"], { axes: [metricAxis("completed-event-participation-count", "completedParticipationCount")] }),
  plan(82, "MULTI_METRIC_CONJUNCTION", ["totalEventInvolvementCount", "eventDays", "eventSpanDays"], { axes: [metricAxis("event-calendar-days", "eventDays"), metricAxis("event-calendar-span", "eventSpanDays")] }),
  plan(83, "STRUCTURAL_PRESENCE", ["generalParticipantCount", "staffCount", "organizerCount", "participantOnlyCount", "totalEventInvolvementCount"], { structuralRequirements: ["A participant-only completed event and a distinct staff-or-organizer completed event both exist."] }),
  plan(84, "STRUCTURAL_PRESENCE", ["primaryOrganizerCount", "totalEventInvolvementCount"], { structuralRequirements: ["A canonical completed event names the subject as its exactly-one primary organizer."] }),

  plan(85, "STRUCTURAL_PRESENCE", ["activeFamilyCount", "castleActiveDays"], { structuralRequirements: ["Meaningful use exists in two distinct families of the current Castle Edition-I manifest."] }),
  plan(86, "MANIFEST_CONFORMANCE", ["activeFamilyCount", "sumFamilyActiveDays", "castleActiveDays", "familiesPerActiveDayMedian"], { structuralRequirements: ["Breadth is interpreted only against the current Castle Edition-I family manifest."] }),
  plan(87, "MANIFEST_CONFORMANCE", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "socialActiveDays", "socialTcGapSampleCount", "socialVcTrustedSeconds"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.castle-family-superdomain", "socialHours.day-hour-evidence"),
    structuralRequirements: ["The current Castle Edition-I family-to-super-domain manifest supplies social, economy/play, and castle-wide domain coverage."],
  }),
  plan(88, "MANIFEST_CONFORMANCE", ["domainSemanticBreadth", "domainDayTouches", "domainActiveDays", "domainActiveSpanDays"], {
    requiredJointEvidence: joint("domain-social-time-v1", "domainDays.castle-family-breadth"),
    structuralRequirements: ["Almost-all breadth is interpreted only against the current Castle Edition-I family manifest."],
  }),
  plan(89, "MANIFEST_CONFORMANCE", ["activeFamilyCount", "sumFamilyActiveDays", "castleActiveDays"], { structuralRequirements: ["Every family in the current Castle Edition-I manifest has meaningful-use evidence."] }),
  plan(90, "JOINT_CORRELATION", ["roleHeldFamilyCount", "insideActiveFamilyCount", "outsideActiveFamilyCount", "insideDayUnion", "outsideDayUnion", "insideOccurrenceCount", "outsideOccurrenceCount", "insideTrustedSeconds", "outsideTrustedSeconds"], {
    requiredJointEvidence: joint("castle-role-context-v1", "families.role-held-days", "families.inside-days", "families.outside-days"),
    axes: [jointAxis("role-held-family-breadth", "families.role-held-days"), jointAxis("inside-domain-breadth", "families.inside-days"), jointAxis("outside-domain-breadth", "families.outside-days")],
  }),
  plan(91, "JOINT_CORRELATION", ["roleHeldFamilyCount", "outsideActiveFamilyCount", "outsideDayUnion", "outsideDaysCount", "outsideOccurrenceCount", "outsideTrustedSeconds"], {
    requiredJointEvidence: joint("castle-role-context-v1", "families.role-held-days", "families.outside-days", "families.outside-repeat-days"),
    axes: [jointAxis("outside-repeat-days", "families.outside-repeat-days"), jointAxis("outside-activity-evidence", "families.outside-days")],
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
  return {
    candidateNo: input.no,
    provisionalKey: candidate.provisionalKey,
    probeKey,
    thresholdCategory: readiness.thresholdCategory,
    optimizationRisk: readiness.optimizationRisk,
    measurementStatus: input.measurementStatus ?? "MEASURED",
    evaluationShape: input.evaluationShape,
    requiredMetrics: [...new Set(input.requiredMetrics)].sort(),
    requiredJointEvidence: input.requiredJointEvidence ?? NONE,
    axes: [...(input.axes ?? [])].sort((a, b) => a.axisKey.localeCompare(b.axisKey)),
    structuralRequirements: [...(input.structuralRequirements ?? [])].sort(),
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
  readonly measurementGapCount: number;
  readonly duplicateCount: number;
  readonly nonReadyCandidateCount: number;
  readonly missingReadyCandidateNos: readonly number[];
  readonly unexpectedPlanCandidateNos: readonly number[];
  readonly candidateProbeOwnershipMismatches: readonly number[];
  readonly thresholdCategoryMismatches: readonly number[];
  readonly optimizationRiskMismatches: readonly number[];
  readonly unknownMetricSelectors: readonly string[];
  readonly unknownJointEvidenceSelectors: readonly string[];
  readonly numericThresholdValueCount: number;
  readonly exactReadySet: boolean;
}

function countNumbers(value: unknown): number {
  if (typeof value === "number") return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNumbers(item), 0);
  if (value !== null && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + countNumbers(item), 0);
  return 0;
}

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
    measurementGapCount: F5C_CANDIDATE_SWEEP_PLANS.filter(({ measurementStatus }) => measurementStatus === "MEASUREMENT_GAP").length,
    duplicateCount,
    nonReadyCandidateCount: unexpectedPlanCandidateNos.length,
    missingReadyCandidateNos,
    unexpectedPlanCandidateNos,
    candidateProbeOwnershipMismatches,
    thresholdCategoryMismatches,
    optimizationRiskMismatches,
    unknownMetricSelectors: [...new Set(unknownMetricSelectors)].sort(),
    unknownJointEvidenceSelectors: [...new Set(unknownJointEvidenceSelectors)].sort(),
    numericThresholdValueCount,
    exactReadySet: missingReadyCandidateNos.length === 0 && unexpectedPlanCandidateNos.length === 0,
  });
}
