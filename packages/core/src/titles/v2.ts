export {
  TITLE_SOURCES,
  TITLE_TIME_ZONE,
  assertDerivedSourceDependenciesResolve,
  assertRestrictedUseContract,
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
  type TitleRestrictedUse,
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

// computeCoPresenceOverlaps() / CoPresenceOverlap はここからexportしない（PR C2 round 3
// レビュー）。computeCoPresenceOverlaps()はuserA/userBを含む生pairwise relationship data
// を返す——vc_co_presence（TITLE_SOURCESでprivacy:"restricted", titleUsable:false,
// restrictedUse:"relationship_private_evidence"）と同じ制約対象であり、relationship
// raw resolver API（v2-relationship-evidence.tsのresolveRelationshipCandidates()等）を
// 非公開にしても、この経由で`@meigokujo/core/titles/v2`からcounterpart identityへ
// 到達できてしまっては「generic TitleRuleからcounterpart identityへ到達させない」
// 「public raw counterpart APIを作らない」というC2の契約と矛盾する。v2-relationship-
// evidence.tsは`../vc/derived.js`への相対importでこの関数を直接使い続ける——ここでの
// 非公開化はrelationship evaluator自体には影響しない。`computeSafeSocialAggregates()`
// はcounterpart identityを含まないsafe aggregateなので引き続き公開する。
export {
  computeEmptyStartThenJoined,
  computeGroupSizeSeconds,
  computeLastOccupant,
  computeLogicalVisits,
  computeSafeSocialAggregates,
  isTrustedVisitEnd,
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
  type ConfirmedInvitesSourcePayload,
  type EconomySafePeerActionsSourcePayload,
  type PublicEventParticipationsSourcePayload,
  type TextActiveDaysSourcePayload,
  type TitleSourcePayloads,
  type VcEmptyStartThenJoinedSourcePayload,
  type VcGroupSizeSecondsSourcePayload,
  type VcLastOccupantSourcePayload,
  type VcSocialSafeSourcePayload,
} from "./v2-sources.js";

// v2-economy.ts の computeSafeEconomyPeerActions()（PR E2の内部classifier正本）は
// ここではexportしない——callerがraw transactions由来のfactを直接組み立てて
// ruleへ注入できる経路を作らない。SAFE_PEER_ECONOMY_TYPES allowlistもinternalのまま。
// 公開してよいのはpayload型と、その`kind`フィールドの型だけ。
export { type SafePeerEconomyActionKind } from "./v2-economy.js";

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

// PR D1: Bulk Source Prefetch Planner。`BULK_SOURCE_READERS`・生のbulk reader関数・
// cacheの内側の`Map`・group-key構築関数・payload-seeding手段はここではexportしない
// （§52）——公開してよいのは、read-onlyな最適化APIである`prefetchBatchPipelineSources()`
// と、identity-freeな要約統計型・既存の`TitleSourceCache`だけ。
export {
  prefetchBatchPipelineSources,
  type TitlePrefetchOptions,
  type TitlePrefetchResult,
  type TitlePrefetchSummary,
} from "./v2-prefetch.js";

// v2-relationship-evidence.ts の何もここではexportしない（PR C2 §16, §30, §62, §63）。
// `resolveRelationshipCandidates()` / `resolveRelationshipPrivateEvidence()` /
// `requireRelationshipEvidenceProvenance()` はcounterpart identityへ到達できるraw経路
// であり、公開APIにしない——relationship private evidenceの構築はevaluation pipeline
// （`v2-relationship.ts` の `evaluateRelationshipTitle()`、internal）の内部だけで行う。
// `ResolvedRelationshipPrivateEvidence`（raw provenance type）もexportしない。
//
// `evaluateRelationshipTitle()`（`v2-relationship.ts`）自体もexportしない
// ——meta evaluatorのevaluateMetaTitle()と同じ理由（PR C1 §16）。counterpart解決を
// 伴う評価はpipeline（`evaluateUserPipeline()`/`evaluateBatchPipeline()`）経由だけに限定する。
//
// 公開してよいのは、counterpart identityを一切含まないcontract type・
// `defineRelationshipTitleRule()`だけ（§62, §63）。
export {
  defineRelationshipTitleRule,
  type RelationshipCandidateSnapshot,
  type RelationshipTitleEvaluationOptions,
  type RelationshipTitleEvaluationResult,
  type RelationshipTitleRule,
  type RelationshipTitleRuleContext,
  type RelationshipTitleRuleImplementation,
  type RelationshipTitleRuleResult,
} from "./v2-relationship.js";
