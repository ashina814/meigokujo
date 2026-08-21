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
  type AwardFactsInput,
  type AwardResult,
  type AwardResultStatus,
  type AwardTitleInput,
  type TitleAwardFactsRow,
  type TitleAwardRow,
  type TitleBaselineRow,
  type TitleBaselineRunRow,
  type TitleCatalogEpochRow,
  type TitleEquipRow,
  type TitleOwnershipRow,
  type TitleSystemStateRow,
} from "./v2-store.js";

export {
  assertValidAwardFacts,
  assertValidFactsVersion,
  MAX_AWARD_FACTS_BYTES,
  MAX_AWARD_FACTS_DEPTH,
  MAX_AWARD_FACTS_NODES,
  type JsonValue,
  type TitleAwardFacts,
} from "./v2-award-facts.js";

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
  type TitleMonthSelector,
  type TitleRuleScope,
  type TitleScopeResolutionOptions,
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
  type TitleRuleImplementation,
  type TitleRuleResult,
} from "./v2-evaluator.js";

export {
  assertValidSeriesManifest,
  assertNoOverlappingSeriesMembership,
  computeSeriesManifestHash,
  type SeriesManifestHashInput,
  type TitleSeriesManifest,
} from "./v2-series.js";

export {
  assertCollectionEditionActivatable,
  assertValidCollectionEdition,
  computeCollectionEditionHash,
  type TitleCollectionEdition,
  type TitleCollectionMember,
  type TitleCollectionMilestonePolicy,
} from "./v2-collection.js";

// v2-series-store.ts / v2-collection-store.ts の関数（registerSeriesManifests /
// reconcileSeriesMasteriesForUser / activateCollectionEdition / closeCollectionEdition
// 等）はDatabase + clockを直接受け取るraw persistence APIであり、ここではexportしない。
// これらを公開すると、callerが `TitleV2Store` の内部clockを経由せず任意のclockを注入
// でき、「registered_at/recorded_at/activated_at/closed_atはStore clock」という契約
// （callerが任意timestampを注入できない）を迂回できてしまう。persistenceのpublic
// mutation boundaryは `TitleV2Store` のmethodsだけに限定する——これらのraw関数は
// `v2-store.ts` が内部でimportして`TitleV2Store`のmethodsとして再公開するのに使う
// （現状のまま）。integrity helper（assertSeriesPersistenceIntegrity等）も、
// `TitleV2Store` construction時に内部で呼ぶだけで、それ単体を公開API化する必要は無い。
export {
  type NewlyMasteredSeries,
  type ReconcileSeriesMasteriesResult,
  type RegisterSeriesManifestsResult,
  type TitleSeriesManifestSummary,
  type TitleSeriesMasteryRow,
} from "./v2-series-store.js";

export {
  type ActivateCollectionEditionResult,
  type ActivateCollectionEditionStatus,
  type CloseCollectionEditionResult,
  type CloseCollectionEditionStatus,
  type CollectionEditionProgress,
  type TitleCollectionEditionRow,
} from "./v2-collection-store.js";

export {
  type TitleAcquisitionRaritySnapshot,
  type TitleCurrentRaritySnapshot,
} from "./v2-rarity.js";

// v2-identity-store.ts の関数（recordRankTitleTransition / reconcileRankTitleUnlocks /
// equipIdentity / unequipIdentity 等）も、v2-series-store.ts / v2-collection-store.ts
// と同じ理由（PR B2 §28）でここからはexportしない——callerがStore内部clockを迂回して
// 任意timestampを注入できる余地を無くす。public mutation boundaryは`TitleV2Store`の
// methodsだけに限定する。contract type（`ProfileIdentity`等）はexportして構わない。
export {
  type NewlyUnlockedRankTitle,
  type ProfileIdentity,
  type ProfileIdentityEquip,
  type RankTitleUnlockResult,
  type RankTitleUnlockRow,
} from "./v2-identity-store.js";

export {
  rankTierByKey,
  rankTiersForTrack,
  type RankTitleKey,
  type RankTrack,
} from "../rank/tiers.js";

// v2-meta.ts の buildMetaSnapshot() / evaluateMetaTitle() はここではexportしない（PR C1
// §16）。もし公開すると、callerがforgeしたsnapshot（例: behaviorOwnershipCount: 999）を
// 直接meta ruleへ渡してaward()まで到達できてしまう——meta snapshotの構築はevaluation
// pipeline（`v2-pipeline.ts` の `evaluateUserPipeline()`/`evaluateBatchPipeline()`）内部
// だけで行う。contract type（`MetaTitleRule`等）・`defineMetaTitleRule()`はmutationを
// 伴わないためexportして構わない。
export {
  defineMetaTitleRule,
  type MetaCollectionEditionSnapshot,
  type MetaTitleEvaluationResult,
  type MetaTitleRule,
  type MetaTitleRuleContext,
  type MetaTitleRuleImplementation,
  type MetaTitleRuleResult,
  type TitleMetaSnapshot,
} from "./v2-meta.js";

export {
  defineTitleEvaluationPlan,
  evaluateBatchPipeline,
  evaluateUserPipeline,
  type TitleEvaluationPlan,
  type TitlePipelineOptions,
  type TitleUserPipelineResult,
} from "./v2-pipeline.js";
