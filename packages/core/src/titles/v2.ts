export {
  TITLE_SOURCES,
  TITLE_TIME_ZONE,
  assertDerivedSourceDependenciesResolve,
  assertSlug,
  defineBehaviorTitle,
  defineMetaTitle,
  type BehaviorTitleDefinition,
  type DerivedTitleSourceDefinition,
  type MetaTitleDefinition,
  type PersistedTitleSourceDefinition,
  type TitleDefinition,
  type TitleEpochPolicy,
  type TitleLifecycle,
  type TitleProgression,
  type TitleScopePolicy,
  type TitleSourceCodeRef,
  type TitleSourceDefinition,
  type TitleSourceKey,
  type TitleSourceKind,
  type TitleSourcePrivacy,
  type TitleTrigger,
  type TitleUsableSourceKey,
} from "./v2-contract.js";

export {
  TitleV2Store,
  ensureTitleV2Schema,
  type ApplyCatalogInput,
  type AwardTitleInput,
  type TitleAwardRow,
  type TitleBaselineRow,
  type TitleBaselineRunRow,
  type TitleCatalogEpochRow,
  type TitleEquipRow,
  type TitleSystemStateRow,
} from "./v2-store.js";

export {
  computeCoPresenceOverlaps,
  computeEmptyStartThenJoined,
  computeGroupSizeSeconds,
  computeLastOccupant,
  computeLogicalVisits,
  computeSafeSocialAggregates,
  isTrustedVisitEnd,
  type CoPresenceOverlap,
  type EmptyStartThenJoinedFact,
  type GroupSizeSeconds,
  type LastOccupantFact,
  type LogicalVisit,
  type LogicalVisitEndQuality,
  type LogicalVisitStartKind,
  type OccupancyBucket,
  type SafeSocialAggregate,
  type TitleWindow,
} from "../vc/derived.js";

export {
  assertResolvedTitleScope,
  resolveTitleScope,
  resolvedScopeEffectiveEnd,
  toRuleScope,
  type ResolvedTitleScope,
  type TitleEventScopeProvider,
  type TitleRuleScope,
} from "./v2-scope.js";

export {
  assertSourceReaderCoverage,
  readTitleSource,
  TitleSourceCache,
  type BumpEventsSourcePayload,
  type TitleSourcePayloads,
  type VcEmptyStartThenJoinedSourcePayload,
  type VcGroupSizeSecondsSourcePayload,
  type VcLastOccupantSourcePayload,
  type VcSocialSafeSourcePayload,
} from "./v2-sources.js";

export {
  defineTitleRule,
  evaluateBatch,
  evaluateTitle,
  evaluateUser,
  type TitleAwardOutcome,
  type TitleEvaluationOptions,
  type TitleEvaluationResult,
  type TitleRule,
  type TitleRuleContext,
  type TitleRuleResult,
} from "./v2-evaluator.js";

export {
  assertValidSeriesManifest,
  assertNoOverlappingSeriesMembership,
  type TitleSeriesManifest,
} from "./v2-series.js";

export {
  assertValidCollectionEdition,
  type TitleCollectionEdition,
  type TitleCollectionMember,
  type TitleCollectionMilestonePolicy,
} from "./v2-collection.js";

export {
  type TitleAcquisitionRaritySnapshot,
  type TitleCurrentRaritySnapshot,
} from "./v2-rarity.js";
