/**
 * PR F1 — Title v2 99 Catalog Convergence / Readiness Registry.
 *
 * `./v2-catalog-candidates.ts`（xlsx原文の機械転記）とは別layer。ここは
 * **現repo（PR #149〜#163後）を実際に読んで判定した「今のsourceで意味を
 * 落とさず表現できるか」の監査結果**——xlsxのSource_Mapをそのままコピーしない
 * （xlsx作成時点よりE2economy/E3 event/E4 casinoの実装が進んでいるため、
 * ここで再判定する。詳細はdocs/titles-v2-catalog-readiness.mdの
 * "editorial intent → runtime resolution"表を参照）。
 *
 * この module も **planning専用**。production runtime pathへは一切接続しない
 * （`./v2-catalog-candidates.ts`と同じ制約——barrel export禁止・evaluator
 * 参照禁止・Bot import禁止・award path接続禁止）。
 *
 * 判定ルール（§7）:
 * - READY: 現在`titleUsable:true`で登録済みのsource／specialized resolverだけで、
 *   意味を縮小・拡大せずにその候補のsemanticSpecを表現できる。
 *   「似たsourceがある」だけではREADYにしない。thresholdの実数値が未定
 *   （分布TBD等）でもREADYにしてよい——sourceReadinessとthreshold決定は別軸（§10）。
 * - PARTIAL: 近い意味のsource／aggregateは存在するが、意味を落とす／広げる
 *   （例: 特定counterpart限定の話に汎用co-presence集計を使う）か、既知バグが
 *   安全な有効化を妨げている。
 * - BLOCKED: 意味的に近いものが repo に一切存在しない（新規persisted source・
 *   role-at-time・event protocol拡張・manifestが必要）。
 * - META: kind:"meta"の候補。sourceReadinessの3値ではなく別bucket
 *   （meta pipeline自体はv2-meta.ts/v2-pipeline.tsに実装済みだが、production
 *   titleとして何も登録されていない——PR F1でもwireしない、§15）。
 *
 * thresholdCategory は candidate.thresholdIntent（xlsx原文）から機械的に導出する
 * ——手で決め直さない（§10「絶対に仮値をproduction thresholdにしない」）。
 */

import type { TitleUsableSourceKey } from "./v2-contract.js";
import { TITLE_V2_CATALOG_CANDIDATES, type TitleV2CatalogCandidate } from "./v2-catalog-candidates.js";

export type CandidateReadinessStatus = "READY" | "PARTIAL" | "BLOCKED" | "META";

export type CandidateBlockerKind =
  | "missing_persisted_source"
  | "missing_derived_source"
  | "missing_role_history"
  | "missing_event_protocol"
  | "missing_manifest"
  | "missing_threshold"
  | "source_semantic_mismatch"
  | "known_bug"
  | "none";

/**
 * xlsx thresholdIntent原文から機械導出するカテゴリ（§10）。実数値はこのPRで
 * 一切決めない——「STRUCTURAL_FIXED」であっても、意味仕様そのものから閾値が
 * 一意に確定するもの（例: 初回=1）だけを指す。数値そのものはここへ書かない。
 */
export type ThresholdCategory =
  | "STRUCTURAL_FIXED"
  | "THRESHOLD_PENDING"
  | "STRUCTURAL_PLUS_DISTRIBUTION"
  | "MANIFEST_DEPENDENT"
  | "FULL_CLEAR_100_PERCENT"
  | "META_NOT_APPLICABLE";

export type OptimizationRisk = "LOW" | "MANAGED" | "HIGH";

export interface CandidateReadinessAudit {
  readonly no: number;
  readonly provisionalKey: string;
  readonly status: CandidateReadinessStatus;
  readonly usableSources: readonly TitleUsableSourceKey[];
  readonly specializedResolvers: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly evidence: readonly { readonly file: string; readonly symbol: string }[];
  readonly notes: string;
  readonly blockerKinds: readonly CandidateBlockerKind[];
  readonly thresholdCategory: ThresholdCategory;
  readonly optimizationRisk: OptimizationRisk;
}

function deriveThresholdCategory(candidate: TitleV2CatalogCandidate): ThresholdCategory {
  if (candidate.kind === "meta") return "META_NOT_APPLICABLE";
  const t = candidate.thresholdIntent;
  if (t === "構造固定") return "STRUCTURAL_FIXED";
  if (t === "分布TBD") return "THRESHOLD_PENDING";
  if (t === "構造+分布") return "STRUCTURAL_PLUS_DISTRIBUTION";
  if (t === "manifest依存" || t === "manifest固定") return "MANIFEST_DEPENDENT";
  if (t === "full-clear 100%") return "FULL_CLEAR_100_PERCENT";
  throw new Error(`unrecognized thresholdIntent for candidate #${candidate.no}: ${JSON.stringify(t)}`);
}

/**
 * `no` → 手動監査した部分的readiness情報。thresholdCategory はここへ含めず
 * `deriveThresholdCategory()` が候補本体から機械導出する（原文と監査を
 * 二重管理しない）。
 */
interface ManualReadinessEntry {
  readonly no: number;
  readonly status: CandidateReadinessStatus;
  readonly usableSources: readonly TitleUsableSourceKey[];
  readonly specializedResolvers: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly evidence: readonly { readonly file: string; readonly symbol: string }[];
  readonly notes: string;
  readonly blockerKinds: readonly CandidateBlockerKind[];
  readonly optimizationRisk: OptimizationRisk;
}

const VC_SOURCES_FILE = "packages/core/src/titles/v2-sources.ts";
const VC_DERIVED_FILE = "packages/core/src/vc/derived.ts";
const ECON_FILE = "packages/core/src/titles/v2-economy.ts";
const CASINO_FILE = "packages/core/src/titles/v2-casino.ts";
const EVENT_SERVICE_FILE = "packages/core/src/public-events/service.ts";
const ROOMS_DERIVED_FILE = "packages/core/src/rooms/derived.ts";
const SOCIAL_ACTIVITY_TIME_FILE = "packages/core/src/social-activity-time/derived.ts";
const INVITE_ROOTED_FILE = "packages/core/src/titles/v2-invite-rooted.ts";

// ─────────────────────────────────────────────────────────────
// Theme 1: 場を起こす (vc_ignite, No.1-5) — source: vc_empty_start_then_joined
// ─────────────────────────────────────────────────────────────
const THEME_01: ManualReadinessEntry[] = [
  {
    no: 1,
    status: "PARTIAL",
    usableSources: ["vc_empty_start_then_joined"],
    specializedResolvers: ["computeEmptyStartThenJoined"],
    missingCapabilities: ["main guildかつpublic VCだったことを証明するprovenance"],
    evidence: [
      { file: VC_SOURCES_FILE, symbol: "vc_empty_start_then_joined" },
      { file: VC_DERIVED_FILE, symbol: "computeEmptyStartThenJoined" },
    ],
    notes:
      "初回成立構造は表現できるが、vc_empty_start_then_joinedは公開分類のないvc_visits由来。private/role-gated/other-guild VCを候補原文の「静かな公開VC」から除外できないためpublic-classified sourceへの移行が必要。",
    blockerKinds: ["source_semantic_mismatch"],
    optimizationRisk: "LOW",
  },
  {
    no: 2,
    status: "READY",
    usableSources: ["vc_empty_start_then_joined"],
    specializedResolvers: ["computeEmptyStartThenJoined"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcEmptyStartThenJoinedSourcePayload.facts" }],
    notes: "facts[].joinedAtにtimestampがあるためruleがJST day単位でgroup化できる——新規source不要。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
  {
    no: 3,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["ignite eventの相手user distinct-count safe aggregate"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcEmptyStartThenJoinedSourcePayload" }],
    notes: "factsにはchannelIdのみ——相手identityが一切ない。vc_social_safeは汎用co-presenceで範囲が違う（意味を広げてしまう）ため代用不可。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 4,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["VC channelのarea/categoryタクソノミー"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcEmptyStartThenJoinedSourcePayload.facts.channelId" }],
    notes: "channelIdはあるがcategory/area分類が一切titlesへ露出していない。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 5,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["vc_ignite比率・最小試行数・複数期間の統計的aggregate"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcEmptyStartThenJoinedSourcePayload" }],
    notes: "「安定して現れる傾向」はraw factsの単純group化では出せない——新derivedが必要（xlsx Blocker欄と一致）。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 2: 場を締める (vc_closer, No.6-9) — source: vc_last_occupant
// ─────────────────────────────────────────────────────────────
const THEME_02: ManualReadinessEntry[] = [
  {
    no: 6,
    status: "PARTIAL",
    usableSources: ["vc_last_occupant"],
    specializedResolvers: ["computeLastOccupant"],
    missingCapabilities: ["main guildかつpublic VCだったことを証明するprovenance"],
    evidence: [{ file: VC_DERIVED_FILE, symbol: "computeLastOccupant" }],
    notes:
      "PR F2aでsame-second/0-second tie bugは解消済み。ただしvc_last_occupantは公開分類のないvc_visits由来で、private/role-gated/other-guild VCを候補原文の「複数人の公開VC」から除外できない。public provenanceを持つsourceへの移行が必要。",
    blockerKinds: ["source_semantic_mismatch"],
    optimizationRisk: "LOW",
  },
  {
    no: 7,
    status: "READY",
    usableSources: ["vc_last_occupant"],
    specializedResolvers: ["computeLastOccupant"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcLastOccupantSourcePayload.facts" }],
    notes: "facts[].becameLastAtでday-group可能。PR F2aでtie bugを解消したため残課題なし。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
  {
    no: 8,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["VC channelのarea/categoryタクソノミー"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcLastOccupantSourcePayload.facts.channelId" }],
    notes:
      "No.4と同じarea taxonomy欠如が残る。PR F2aでtie bug自体は解消したが、No.8はそもそもarea taxonomy不足が主因であり、tie bug解消だけではREADYにならない——今回のfixとは別のBLOCKERとして維持する。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 9,
    status: "READY",
    usableSources: ["vc_last_occupant"],
    specializedResolvers: ["computeLastOccupant"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcLastOccupantSourcePayload.facts" }],
    notes: "distinct channelId数・複数期間はfacts[]のtimestamp/channelIdからruleが導出可能。PR F2aでtie bugを解消したため残課題なし。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 3-6: VCスタイル系 (一対一/少人数/大人数/万能, No.10-21)
// source: vc_group_size_daily_safe（日別4bucket trusted seconds）
// ─────────────────────────────────────────────────────────────
const VC_STYLE_NOTE =
  "PR F2eのvc_group_size_daily_safeはJST dateごとにsolo/oneToOne/smallGroup/largeGroupのtrusted secondsを欠落なく返す。ruleはthresholdやshare denominatorをsourceへ固定せず、qualifying days・trusted sample総量・bucket share・per-day share・first/last date・span・streak・bucket coverage・social三帯の網羅・skewをcatalog semanticsに沿って後から評価できる。";
const THEME_03_06: ManualReadinessEntry[] = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map((no) => ({
  no,
  status: "READY" as const,
  usableSources: ["vc_group_size_daily_safe"] as const,
  specializedResolvers: ["computeGroupSizeDailySeconds"],
  missingCapabilities: [],
  evidence: [
    { file: VC_SOURCES_FILE, symbol: "VcGroupSizeDailySafeSourcePayload" },
    { file: VC_DERIVED_FILE, symbol: "computeGroupSizeDailySeconds" },
  ],
  notes: VC_STYLE_NOTE,
  blockerKinds: ["none"] as const,
  optimizationRisk: "LOW" as const,
}));

// ─────────────────────────────────────────────────────────────
// Theme 7: 広い交友 (social_breadth, No.22-27)
// ─────────────────────────────────────────────────────────────
const THEME_07: ManualReadinessEntry[] = [
  {
    no: 22,
    status: "PARTIAL",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: ["main guildかつpublic VCのcounterpart breadth provenance"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.distinctCoPresentUsers" }],
    notes:
      "distinctCoPresentUsersは時間的広がりを要求しないbreadth自体は表現するが、vc_social_safe→vc_co_presence→vc_visitsはpublic/private provenanceを持たない。private/role-gated/other-guild共在を候補原文の「公開の有効共在」から除外できない。",
    blockerKinds: ["source_semantic_mismatch"],
    optimizationRisk: "LOW",
  },
  {
    no: 23,
    status: "READY",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.dailyBreadth" }],
    notes:
      "PR F2f: scope全体のdistinctCoPresentUsersに加え、dailyBreadthがJST日ごとのdistinct counterpart数を返す。日数・各日のbreadth・first→last spanを後段で組み合わせれば「より広い異なる相手との交流が、複数日に広がる」を意味を落とさず表現できる。threshold値は別途分布から決める。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
  {
    no: 24,
    status: "READY",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.dailyBreadth" }],
    notes:
      "PR F2f: dailyBreadthのJST日別distinct counterpart分布と日付span、scope全体のdistinctCoPresentUsersを後段で組み合わせ、「十分な期間にわたり、多くの異なる相手との交流が続く」を表現できる。day1だけ極端に広いcounterexampleも日別分布で識別できる。threshold値は別途分布から決める。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
  {
    no: 25,
    status: "READY",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.dailyBreadth" }],
    notes:
      "PR F2f: dailyBreadthから多数日にわたる各日のbreadthとfirst→last spanを、distinctCoPresentUsersからscope全体の広がりを評価できるため、「長期・多数日にわたり非常に広い対人接点を持つ」を表現可能。threshold値は別途分布から決める。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
  {
    no: 26,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["公開階級カテゴリ×interaction時点のsafe cross-reference"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload" }],
    notes: "class-at-interaction履歴が一切存在しない（xlsx「class履歴/source不足」は現repoでも未解消）。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 27,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["role-family-at-interaction履歴"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload" }],
    notes: "role-at-time（§9調査）が repo全体で未実装のため成立不可。",
    blockerKinds: ["missing_role_history"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 8: 深い交友 (relationship_depth, No.28-31)
// vc_social_safe.maxRepeatedDaysWithOneCounterpart が一部を直接カバーする
// ─────────────────────────────────────────────────────────────
const THEME_08: ManualReadinessEntry[] = [
  {
    no: 28,
    status: "READY",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.maxRepeatedDaysWithOneCounterpart" }],
    notes: "maxRepeatedDaysWithOneCounterpart ≥ 2がそのまま「同じ一人と異なる複数日」を表す。xlsx「vc_relationship_safe (proposed)」より弱い前提で十分表現できることを確認。",
    blockerKinds: ["none"],
    optimizationRisk: "LOW",
  },
  {
    no: 29,
    status: "PARTIAL",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: ["特定counterpart（day-repeat最大の相手）に紐づくtrusted overlap秒数"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.trustedOverlapSeconds" }],
    notes: "trustedOverlapSecondsは全counterpart合算——「同じ一人との十分なoverlap」をmaxRepeatedDaysの相手に限定して検証できない。",
    blockerKinds: ["source_semantic_mismatch"],
    optimizationRisk: "LOW",
  },
  {
    no: 30,
    status: "PARTIAL",
    usableSources: ["vc_social_safe"],
    specializedResolvers: ["computeSafeSocialAggregates"],
    missingCapabilities: ["特定counterpartの生timestamp配列（離れた期間かどうかの判定）"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload.maxRepeatedDaysWithOneCounterpart" }],
    notes: "1つのaggregate数値だけでは、その日々が連続塊か離れた複数期間かを区別できない。",
    blockerKinds: ["source_semantic_mismatch"],
    optimizationRisk: "LOW",
  },
  {
    no: 31,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["特定counterpartのfirst→last span・複数期間・多数日の複合derived"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "VcSocialSafeSourcePayload" }],
    notes: "xlsx想定の`vc_relationship_safe (proposed)`（per-counterpart identity-freeイベント列）が必要——現sourceは単一集約値のみ。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 9: 時間帯・生活痕 (activity_time, No.32-37)
// ─────────────────────────────────────────────────────────────
const THEME_09: ManualReadinessEntry[] = [32, 33, 34, 35, 36, 37].map((no) => ({
  no,
  status: "READY" as const,
  usableSources: ["social_activity_time_safe"] as const,
  specializedResolvers: ["computeSocialActivityTimeSafe"],
  missingCapabilities: [],
  evidence: [
    { file: VC_SOURCES_FILE, symbol: "SocialActivityTimeSafeSourcePayload" },
    { file: SOCIAL_ACTIVITY_TIME_FILE, symbol: "computeSocialActivityTimeSafe" },
  ],
  notes:
    "PR F2i: canonical same-surface TC exchange候補と、main guild/public GuildVoice/human occupancyをliveに証明するvc_public_social_presenceのtrusted wall-clock unionをJST date×24hour sparse分布へ統合した。hourはprivacy-safe measurement resolutionであり、daypart境界・TC gap・VC meaningful seconds・share/concentration・必要日数はproduction calibrationへ残す。日付構造により一晩だけの多hourと多数日への分散を区別できる。全件NONCOUNTで、streakや夜更かし量rewardは作らない。",
  blockerKinds: ["none"] as const,
  optimizationRisk: "HIGH" as const,
}));

// ─────────────────────────────────────────────────────────────
// Theme 10: BUMP / 鐘 (bump_contribution, No.38-41) — source: bump_events
// ─────────────────────────────────────────────────────────────
const THEME_10: ManualReadinessEntry[] = [38, 39, 40, 41].map((no, i) => ({
  no,
  status: "READY" as const,
  usableSources: ["bump_events"] as const,
  specializedResolvers: [],
  missingCapabilities: [],
  evidence: [{ file: VC_SOURCES_FILE, symbol: "BumpEventsSourcePayload.events" }],
  notes:
    i === 0
      ? "events配列の初回出現＝初回成立。"
      : "events[]の生timestampからruleがJST day/週/月/期間をgroup化できる——追加source不要。",
  blockerKinds: ["none"] as const,
  optimizationRisk: "MANAGED" as const,
}));

// ─────────────────────────────────────────────────────────────
// Theme 11: TC交流 (No.42-49)
// ─────────────────────────────────────────────────────────────
const TC_CONVERSATION_EVIDENCE = [
  { file: "packages/core/src/tc-social/derived.ts", symbol: "computeTcConversationSafe" },
  { file: VC_SOURCES_FILE, symbol: "TcConversationSafeSourcePayload" },
];
const TC_REACTION_EVIDENCE = [
  { file: "packages/core/src/tc-social/derived.ts", symbol: "computeTcReactionSafe" },
  { file: VC_SOURCES_FILE, symbol: "TcReactionSafeSourcePayload" },
];
const THEME_11: ManualReadinessEntry[] = [
  ...[42, 43, 44, 45, 47].map((no) => ({
    no,
    status: "READY" as const,
    usableSources: ["tc_conversation_safe"] as const,
    specializedResolvers: ["computeTcConversationSafe"],
    missingCapabilities: [],
    evidence: TC_CONVERSATION_EVIDENCE,
    notes:
      "PR F2h: content非保存のcanonical public TC metadataから、quiet/continuation/dormant/area/prior distinct other/next-other gapとexplicit reply/thread conversation groupをidentityなしで導出する。具体thresholdは未決定。",
    blockerKinds: ["none"] as const,
    optimizationRisk: "MANAGED" as const,
  })),
  {
    no: 46,
    status: "READY",
    usableSources: ["tc_reaction_safe"],
    specializedResolvers: ["computeTcReactionSafe"],
    missingCapabilities: [],
    evidence: TC_REACTION_EVIDENCE,
    notes:
      "PR F2h: 1 post×1 human reactorのfirst observationをemoji非保存でdedupeし、anonymous post/JST observation day/global distinct reactor分布を公開する。reaction occurrence timeは主張しない。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 48,
    status: "PARTIAL",
    usableSources: ["tc_conversation_safe"],
    specializedResolvers: ["computeTcConversationSafe"],
    missingCapabilities: ["normal free-flow会話の同一topic long-life correlation（reply/thread非依存）"],
    evidence: TC_CONVERSATION_EVIDENCE,
    notes:
      "PR F2h: public thread owner / persisted reply rootならstarter・distinct participants・active dates・span・max gapをexactに証明できる。一方、replyを使わない通常TCで同じ話題かをmetadataだけからcanonicalに確定できず、reply/thread利用者だけへsemanticを狭めないためREADYにはしない。",
    blockerKinds: ["source_semantic_mismatch"],
    optimizationRisk: "HIGH",
  },
  {
    no: 49,
    status: "READY",
    usableSources: ["tc_conversation_safe", "vc_social_safe"],
    specializedResolvers: ["computeTcConversationSafe", "computeSafeSocialAggregates"],
    missingCapabilities: [],
    evidence: [...TC_CONVERSATION_EVIDENCE, { file: "packages/core/src/vc/derived.ts", symbol: "computeSafeSocialAggregates.dailyBreadth" }],
    notes:
      "PR F2h: TCは別humanとの最小exchange gapを持つsocialDays、VCはF2fのdailyBreadthを持つため、双方の複数JST日social activityをthreshold-neutralに後段評価できる。旧noteの『VC day source無し』は解消済み。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 12: 公開部屋 (No.50-57)
// ─────────────────────────────────────────────────────────────
const PUBLIC_ROOM_SOURCE_EVIDENCE = [
  { file: ROOMS_DERIVED_FILE, symbol: "computePublicRoomActivitySafe" },
  { file: VC_SOURCES_FILE, symbol: "PublicRoomActivitySafeSourcePayload" },
];
const THEME_12: ManualReadinessEntry[] = [
  ...[50, 51, 52, 53, 54, 55, 56].map((no) => ({
    no,
    status: "READY" as const,
    usableSources: ["public_room_activity_safe"] as const,
    specializedResolvers: ["computePublicRoomActivitySafe"],
    missingCapabilities: [],
    evidence: PUBLIC_ROOM_SOURCE_EVIDENCE,
    notes:
      "PR F2g: normal/game部屋のlifecycle intervalとtrusted positive logical VC visitを交差し、hosted/guest/ownUseをJST日別・session別にidentityなしで集計する。owner不在でもguest実利用を数え、activated_atやroom作成だけは数えない。",
    blockerKinds: ["none"] as const,
    optimizationRisk: "LOW" as const,
  })),
  {
    no: 57,
    status: "BLOCKED",
    usableSources: ["public_room_activity_safe"],
    specializedResolvers: ["computePublicRoomActivitySafe"],
    missingCapabilities: ["宿屋系role-at-timeとguest visit時点のtemporal cross-reference"],
    evidence: PUBLIC_ROOM_SOURCE_EVIDENCE,
    notes:
      "PR F2gで普通のguestとしての有効来訪は証明可能になったが、visit当時に宿屋系roleを保持していたかを照合するrole historyがrepo全体で未実装。現在roleの参照では代用しない。",
    blockerKinds: ["missing_role_history"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 13: Land・経済 (No.58-65)
// ─────────────────────────────────────────────────────────────
const THEME_13: ManualReadinessEntry[] = [
  {
    no: 58,
    status: "READY",
    usableSources: ["economy_safe_peer_actions"],
    specializedResolvers: ["computeSafeEconomyPeerActions"],
    missingCapabilities: [],
    evidence: [
      { file: ECON_FILE, symbol: "computeSafeEconomyPeerActions" },
      { file: ECON_FILE, symbol: "t.reversal_of IS NULL + snapshot-bounded NOT EXISTS reversal filter" },
    ],
    notes:
      "PR F2c: reversed originalをevaluation snapshot時点で除外するようになった。reversal transaction自身も従来どおり除外し、snapshot内で最初のvalid qualifying tipを表現可能。SOURCE READINESSはREADYだが、post-award reversal semanticsはproduction release gateとして未決定（docs/titles-v2-catalog-readiness.md §15）。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 59,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["tip受取人のdistinct-count safe aggregate"],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "EconomySafePeerActionsSourcePayload.facts" }],
    notes: "payloadはkind/date/occurredAtのみ——counterpartyが一切無いためdistinct受取人数を算出不能。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 60,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["pair単位のsafe aggregate（「以前くれた相手」判定）"],
    evidence: [{ file: ECON_FILE, symbol: "computeSafeEconomyPeerActions" }],
    notes: "現sourceにcounterparty情報が一切無く、pair特定が不可能。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 61,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["economy機能familyのsemantic classifier（transfer/tip以外を含む）"],
    evidence: [{ file: ECON_FILE, symbol: "SAFE_PEER_ECONOMY_TYPES" }],
    notes: "SAFE_PEER_ECONOMY_TYPESはtransfer/tipのみ——shop購入等を含む経済function全体のclassifierが無い。",
    blockerKinds: ["missing_derived_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 62,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["shop purchaseのsafe title source"],
    evidence: [{ file: ECON_FILE, symbol: "SAFE_PEER_ECONOMY_TYPES (does not cover shop)" }],
    notes: "購入台帳（transactions/shop purchases）は正本として存在するが、titles層のsafe sourceへ一切昇格されていない。",
    blockerKinds: ["missing_persisted_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 63,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["economy機能familyのsemantic classifier", "family一覧のmanifest"],
    evidence: [{ file: ECON_FILE, symbol: "SAFE_PEER_ECONOMY_TYPES" }],
    notes: "No.61と同じclassifier欠如に加え、「意味family数」を数えるための一覧定義（manifest）も無い。",
    blockerKinds: ["missing_derived_source", "missing_manifest"],
    optimizationRisk: "LOW",
  },
  {
    no: 64,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["role-at-time"],
    evidence: [{ file: ECON_FILE, symbol: "computeSafeEconomyPeerActions" }],
    notes: "role-at-timeがrepo全体で未実装。",
    blockerKinds: ["missing_role_history"],
    optimizationRisk: "LOW",
  },
  {
    no: 65,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["role-at-time", "shop purchaseのsafe title source"],
    evidence: [{ file: ECON_FILE, symbol: "SAFE_PEER_ECONOMY_TYPES (does not cover shop)" }],
    notes: "role-at-time欠如とshop purchase source欠如の複合BLOCK。",
    blockerKinds: ["missing_role_history", "missing_persisted_source"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 14: 賭場 (No.66-73) — source: casino_activity_days
// ─────────────────────────────────────────────────────────────
const THEME_14: ManualReadinessEntry[] = [
  {
    no: 66,
    status: "READY",
    usableSources: ["casino_completed_activity_days"],
    specializedResolvers: ["computeCasinoCompletedActivityDays"],
    missingCapabilities: [],
    evidence: [
      { file: CASINO_FILE, symbol: "computeCasinoCompletedActivityDays" },
      { file: "apps/bot/src/casino/blackjack.ts", symbol: "recordCasinoCompletionBestEffort(services, {" },
      { file: "apps/bot/src/casino/pvp-common.ts", symbol: "settlePvp / settleProportional / refundAll（正常branch）+ runFundedSession markResolved契約" },
    ],
    notes:
      "PR F2bで解消: casino_completed_activity_daysはcanonical financial resolution primitive（settlePvp/settleProportional/正常branchのrefundAll、またはsolo settleSolo/spinPaid/settleChinchiroRound）成功後にのみ書かれるcompletion正本——commitmentとcompletionを明確に分離した。全11 activityKeyのproduction callsiteを監査し、abnormal void（voidPvpTable/voidRouletteTable/voidKeibaRace、DM失敗abort）ではcompletionを書かないことをsource-order testで固定済み。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 67,
    status: "READY",
    usableSources: ["casino_completed_activity_days"],
    specializedResolvers: ["computeCasinoCompletedActivityDays"],
    missingCapabilities: [],
    evidence: [
      { file: VC_SOURCES_FILE, symbol: "CasinoCompletedActivityDaysSourcePayload.activityDays" },
      { file: "apps/bot/src/casino/blackjack.ts", symbol: "recordCasinoCompletionBestEffort(services, {" },
    ],
    notes: "No.66と同じ理由——distinct game family数はactivityDays[].activityKeyから数えられ、各活動の「正常完了」はcasino_completed_activity_days自体が保証する（PR F2b）。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 68,
    status: "READY",
    usableSources: ["casino_activity_days"],
    specializedResolvers: ["computeCasinoActivityDays"],
    missingCapabilities: [],
    evidence: [{ file: VC_SOURCES_FILE, symbol: "CasinoActivityDaysSourcePayload.activityDays" }],
    notes:
      "No.66/67と一括変更しない（PR F2bでもcasino_completed_activity_daysへ切り替えない）。semanticSpecは「幅広いgame familyを複数日に利用する」——「正常完了する」ではなく「利用する」であり、completion保証を要求しない。successful funded participation commitment（casino_activity_daysが実際に証明する範囲）だけで意味を満たせる。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 69,
    status: "BLOCKED",
    usableSources: ["casino_completed_activity_days"],
    specializedResolvers: ["computeCasinoCompletedActivityDays"],
    missingCapabilities: ["第I期core game family一覧のmanifest"],
    evidence: [
      { file: "packages/core/src/casino/participation-history.ts", symbol: "CASINO_ACTIVITY_KEYS" },
      { file: CASINO_FILE, symbol: "computeCasinoCompletedActivityDays" },
    ],
    notes:
      "PR F2bでcompletion blockerは解消した——casino_completed_activity_daysは「全familyを正常完了」の completion半分を正しく証明できる。残る唯一の欠如は「core」に含めるfamily一覧そのものが未定義であること（本PRでmanifestを作らない、§17）。",
    blockerKinds: ["missing_manifest"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 70,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["casino_table_activity_safe（卓host/guest区別のsafe source）"],
    evidence: [{ file: "packages/core/src/casino/participation-history.ts", symbol: "RecordCommittedParticipationInput (no host/guest distinction)" }],
    notes: "casino_participationsは全参加者を対称に記録——host/guestという概念自体が現データモデルに存在しない。",
    blockerKinds: ["missing_persisted_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 71,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["casino_table_activity_safe"],
    evidence: [{ file: "packages/core/src/casino/participation-history.ts", symbol: "RecordCommittedParticipationInput" }],
    notes: "No.70と同じ欠如。",
    blockerKinds: ["missing_persisted_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 72,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["market/betting boardのsafe title source"],
    evidence: [{ file: "packages/core/src/casino/participation-history.ts", symbol: "CASINO_ACTIVITY_KEYS (market/stocks not included)" }],
    notes: "market/stocks系は casino_activity_days の対象外——完全に別subsystemで一切追跡されていない。",
    blockerKinds: ["missing_persisted_source"],
    optimizationRisk: "LOW",
  },
  {
    no: 73,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["role-at-time"],
    evidence: [{ file: CASINO_FILE, symbol: "computeCasinoActivityDays" }],
    notes: "role-at-time欠如。",
    blockerKinds: ["missing_role_history"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 15: 招待 (No.74-79) — source: confirmed_invites
// ─────────────────────────────────────────────────────────────
const THEME_15: ManualReadinessEntry[] = [
  {
    no: 74,
    status: "READY",
    usableSources: ["confirmed_invites"],
    specializedResolvers: [],
    missingCapabilities: [],
    evidence: [{ file: "packages/core/src/entry/service.ts", symbol: "invites (invitee_id UNIQUE, ON CONFLICT DO NOTHING)" }],
    notes: "creditedAt配列の初回出現＝初回成立。",
    blockerKinds: ["none"],
    optimizationRisk: "HIGH",
  },
  {
    no: 75,
    status: "READY",
    usableSources: ["confirmed_invites"],
    specializedResolvers: [],
    missingCapabilities: [],
    evidence: [{ file: "packages/core/src/entry/service.ts", symbol: "invites.invitee_id UNIQUE constraint" }],
    notes: "invitee_idがUNIQUEのため、creditedAtの各要素は既にdistinct invitee 1件ずつ——配列長がそのままdistinct数になる。",
    blockerKinds: ["none"],
    optimizationRisk: "HIGH",
  },
  {
    no: 76,
    status: "READY",
    usableSources: ["invite_rooted_safe"],
    specializedResolvers: ["computeInviteRootedSafe"],
    missingCapabilities: [],
    evidence: [{ file: INVITE_ROOTED_FILE, symbol: "InviteRootedSafeProfile.activityDays" }],
    notes: "confirmed direct inviteeをimmutable ghosted entry eventへanchorし、entry翌日以降のsame-surface TC exchange候補 / trusted public-social VC秒をanonymous branch別JST day offset分布へ畳む。membership retentionではなくNONCOUNT、qualifying day数/gap/secondsはproduction calibration待ち。",
    blockerKinds: ["none"],
    optimizationRisk: "HIGH",
  },
  {
    no: 77,
    status: "READY",
    usableSources: ["invite_rooted_safe"],
    specializedResolvers: ["computeInviteRootedSafe"],
    missingCapabilities: [],
    evidence: [{ file: INVITE_ROOTED_FILE, symbol: "InviteRootedSafeProfile.nextGenerationConfirmedCount" }],
    notes: "同一anonymous direct branchのrooted activity分布と、そのbranchをinviterとするdistinct confirmed next-generation数を同じprofileへ保持。rooted thresholdは未固定。",
    blockerKinds: ["none"],
    optimizationRisk: "HIGH",
  },
  {
    no: 78,
    status: "READY",
    usableSources: ["invite_rooted_safe"],
    specializedResolvers: ["computeInviteRootedSafe"],
    missingCapabilities: [],
    evidence: [{ file: INVITE_ROOTED_FILE, symbol: "anonymous direct-branch profiles" }],
    notes: "profile 1件=distinct direct branch 1本。A→X,Y,Zは1 profile、A→X / B→Yは2 profilesなので、child総数とindependent rooted branch数を混同しない。cycle/selfは除外。",
    blockerKinds: ["none"],
    optimizationRisk: "HIGH",
  },
  {
    no: 79,
    status: "READY",
    usableSources: ["invite_rooted_safe"],
    specializedResolvers: ["computeInviteRootedSafe"],
    missingCapabilities: [],
    evidence: [{ file: INVITE_ROOTED_FILE, symbol: "InviteRootedSafeProfile.reunionDays" }],
    notes: "inviter↔confirmed direct inviteeだけをinternal pair JOINし、entry dayを除くsame-surface TC gap / same-public-VC trusted pair秒をday offsetへsanitize。他者・cross-surface・private/unclassifiedは不使用。",
    blockerKinds: ["none"],
    optimizationRisk: "HIGH",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 16: イベント (No.80-84)
// ─────────────────────────────────────────────────────────────
const THEME_16: ManualReadinessEntry[] = [
  {
    no: 80,
    status: "READY",
    usableSources: ["public_event_completed_participations"],
    specializedResolvers: ["computeCompletedPublicEventParticipations"],
    missingCapabilities: [],
    evidence: [
      { file: VC_SOURCES_FILE, symbol: "PublicEventCompletedParticipationsSourcePayload.participations" },
      { file: "packages/core/src/titles/v2-public-events.ts", symbol: "computeCompletedPublicEventParticipations" },
      { file: EVENT_SERVICE_FILE, symbol: "PublicEvents.recordCompletedEvent" },
    ],
    notes: "明示的なstaff completion正本と同一roster revisionへJOINされた参加factがあるかを機械判定できる。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 81,
    status: "READY",
    usableSources: ["public_event_completed_participations"],
    specializedResolvers: ["computeCompletedPublicEventParticipations"],
    missingCapabilities: [],
    evidence: [
      { file: VC_SOURCES_FILE, symbol: "PublicEventCompletedParticipationsSourcePayload.participations" },
      { file: "packages/core/src/titles/v2-public-events.ts", symbol: "computeCompletedPublicEventParticipations" },
    ],
    notes: "completed参加factのeventKeyがimmutableな開催instance identityなのでdistinct event数を機械判定できる。",
    blockerKinds: ["none"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 82,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["実event_dateのsafe title exposure / span source"],
    evidence: [{ file: EVENT_SERVICE_FILE, symbol: "public_events.event_date (excluded from safe payload)" }],
    notes: "completion保証は解消したが、completedAtはstaff attestation時刻で実event日ではない。「長期/離れた暦期間」にはevent_dateのsafe span sourceが必要。",
    blockerKinds: ["missing_persisted_source"],
    optimizationRisk: "MANAGED",
  },
  {
    no: 83,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["event participant roleの区別（organizer/staff vs participant）"],
    evidence: [{ file: EVENT_SERVICE_FILE, symbol: "RecordFinalizedEventInput.participantUserIds (flat, no role field)" }],
    notes: "データモデルの時点でorganizer/staff区別が一切存在しない（title sourceの手前、public-events/service.ts自体の制約）。",
    blockerKinds: ["missing_event_protocol"],
    optimizationRisk: "LOW",
  },
  {
    no: 84,
    status: "BLOCKED",
    usableSources: [],
    specializedResolvers: [],
    missingCapabilities: ["primary organizer登録の概念"],
    evidence: [{ file: EVENT_SERVICE_FILE, symbol: "public_events (recorded_by is staff-who-finalized, not organizer)" }],
    notes: "No.83と同じデータモデル欠如。recorded_byは運営audit用でorganizer登録ではない。",
    blockerKinds: ["missing_event_protocol"],
    optimizationRisk: "LOW",
  },
];

// ─────────────────────────────────────────────────────────────
// Theme 17: 城横断 (No.85-91)
// ─────────────────────────────────────────────────────────────
const THEME_17: ManualReadinessEntry[] = [85, 86, 87, 88, 89, 90, 91].map((no) => ({
  no,
  status: "BLOCKED" as const,
  usableSources: [],
  specializedResolvers: [],
  missingCapabilities: [
    "castle_experience_safe（各domain safe sourceを束ねるderived）",
    "第I期城横断manifest（対象family一覧）",
  ],
  evidence: [{ file: VC_SOURCES_FILE, symbol: "TITLE_SOURCES (no castle_experience_* key registered)" }],
  notes:
    no >= 90
      ? "castle_experience_safe欠如に加えrole-at-time欠如も重なる。"
      : "castle_experienceという横断集約自体がrepoに存在しない（grep 0件）。第I期はevent familyを含むためevent infra未完成の影響も受ける（Summary判断#7,#8）。",
  blockerKinds: no >= 90 ? (["missing_manifest", "missing_role_history"] as const) : (["missing_manifest"] as const),
  optimizationRisk: "LOW" as const,
}));

// ─────────────────────────────────────────────────────────────
// Theme 18: 収集・極め (meta, No.92-99)
// ─────────────────────────────────────────────────────────────
const THEME_18_META: ManualReadinessEntry[] = [92, 93, 94, 95, 96, 97, 98, 99].map((no) => ({
  no,
  status: "META" as const,
  usableSources: [],
  specializedResolvers: ["defineMetaTitleRule", "buildMetaSnapshot", "evaluateMetaTitle"],
  missingCapabilities: ["production meta title定義（catalogへの登録が0件）"],
  evidence: [
    { file: "packages/core/src/titles/v2-meta.ts", symbol: "evaluateMetaTitle" },
    { file: "packages/core/src/titles/v2-pipeline.ts", symbol: "(meta evaluation pipeline, test-only call sites)" },
  ],
  notes:
    "meta評価kernel自体はtestで検証済みの本番品質実装として既に存在する——ただし`defineMetaTitle()`のproduction呼び出しがrepo全体で0件（test以外に無い）。PR F1でもwireしない（§15）。",
  blockerKinds: ["none"] as const,
  optimizationRisk: "LOW" as const,
}));

const MANUAL_READINESS: readonly ManualReadinessEntry[] = [
  ...THEME_01,
  ...THEME_02,
  ...THEME_03_06,
  ...THEME_07,
  ...THEME_08,
  ...THEME_09,
  ...THEME_10,
  ...THEME_11,
  ...THEME_12,
  ...THEME_13,
  ...THEME_14,
  ...THEME_15,
  ...THEME_16,
  ...THEME_17,
  ...THEME_18_META,
];

function buildReadiness(): readonly CandidateReadinessAudit[] {
  const byNo = new Map(MANUAL_READINESS.map((e) => [e.no, e]));
  return TITLE_V2_CATALOG_CANDIDATES.map((candidate) => {
    const manual = byNo.get(candidate.no);
    if (!manual) throw new Error(`missing manual readiness audit for candidate #${candidate.no}`);
    return {
      no: candidate.no,
      provisionalKey: candidate.provisionalKey,
      status: manual.status,
      usableSources: manual.usableSources,
      specializedResolvers: manual.specializedResolvers,
      missingCapabilities: manual.missingCapabilities,
      evidence: manual.evidence,
      notes: manual.notes,
      blockerKinds: manual.blockerKinds,
      thresholdCategory: deriveThresholdCategory(candidate),
      optimizationRisk: manual.optimizationRisk,
    };
  });
}

export const TITLE_V2_CATALOG_READINESS: readonly CandidateReadinessAudit[] = buildReadiness();
