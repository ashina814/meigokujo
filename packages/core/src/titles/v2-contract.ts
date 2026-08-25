/**
 * 称号v2の設計契約。
 *
 * このファイルはカタログを持たない。先に「何を材料にしてよいか」「どう公開するか」を
 * 型とレジストリで固定し、個々の称号は後続PRでこの契約へ乗せる。
 *
 * v3改修（PR A）: 100件規模の称号を安全に乗せるための契約整理。
 * - TitleDefinitionを behavior（source評価を通す）/ meta（他titleのaward状態や
 *   collection/full-clear manifestを横断して判定する）へ discriminated union で分離。
 * - countsForCompletion を廃止。Collection Credit / Full-clear Required は
 *   collection manifest（v2-collection.ts）側の責務にする。
 * - trigger を単数から triggers（複数）へ変更。TC+VCの両方で完成し得る称号、
 *   複数featureに跨る称号を表現できるようにする。
 * - lifecycle から seasonal を削除（scopeと役割が重複するため）。
 * - scope をcaller任意生成からdefinition宣言 + 中央resolver方式へ移行
 *   （実際のresolverはv2-scope.ts）。
 */

export const TITLE_TIME_ZONE = "Asia/Tokyo" as const;

/**
 * lifecycleの意味は永続契約の一部（released titleの意味は不変）。
 *
 * - active: 新規評価・新規award可
 * - retired: 新規award不可。既存awardは保持する
 * - disabled: 緊急停止用。evaluatorはsourceを読まずskipする。
 *   後続UIでは公開・装備も停止できる意味を想定（本PRではUIまで実装しない）
 *
 * seasonalは削除した——期間限定の意味はscope policy（month/event）が既に持っており、
 * lifecycleとscopeの両方に「期間」の概念を持たせると意味が重複し、
 * どちらが優先されるか曖昧になるため。
 */
export type TitleLifecycle = "active" | "retired" | "disabled";

/**
 * 称号を評価すべき行動の種類。TC+VCの両方で完成し得る称号、複数featureに跨る称号を
 * 表現できるよう、TitleDefinition側は複数triggerを持てる（`triggers`、下記参照）。
 *
 * 旧trigger値からの対応（今回のcontract整理で名前空間を広げた）:
 * vc_leave → vc_activity / game_end → game_completed / room_closed → room_activity /
 * transfer・market_created → economy_activity（Land・casino・shop・recruit等の経済行動を
 * まとめて表現する）。まだDiscord eventへの本番fast-path wiringは無い
 * （production wiringは範囲外）ため、この変更で実際の配線が壊れることはない。
 */
export type TitleTrigger =
  | "text_activity"
  | "vc_activity"
  | "bump_success"
  | "game_completed"
  | "room_activity"
  | "economy_activity"
  | "invite_confirmed"
  | "event_completed"
  | "role_changed"
  | "daily";

const VALID_TRIGGERS: ReadonlySet<TitleTrigger> = new Set([
  "text_activity",
  "vc_activity",
  "bump_success",
  "game_completed",
  "room_activity",
  "economy_activity",
  "invite_confirmed",
  "event_completed",
  "role_changed",
  "daily",
]);

/**
 * definitionが宣言する「どうscopeを区切るか」の方針。実際のwindow解決は
 * v2-scope.ts の resolveTitleScope() が担う（callerは任意のscope/scopeKeyを作れない）。
 *
 * - catalog: start = CATALOG_EPOCH、open-ended
 * - global: start = SYSTEM_EPOCH、open-ended
 * - month: Asia/Tokyo暦月。start = max(月初, CATALOG_EPOCH)、end = 翌月初
 * - event: event固有window。start = max(canonical event開始, CATALOG_EPOCH)、
 *   end = canonical completedAt。eventKeyはpolicy自体に固定し、callerが
 *   好きなeventKeyを差し込めないようにする
 *
 * scope policyはreleased title semanticの一部——一度公開したtitleのscope policyを
 * 意味が変わる形で書き換えない（key規約§12と同じ扱い）。
 */
export type TitleScopePolicy =
  | { readonly type: "catalog" }
  | { readonly type: "global" }
  | { readonly type: "month" }
  | { readonly type: "event"; readonly eventKey: string };

export type TitleSourceKind = "history" | "counter";
export type TitleSourcePrivacy = "safe" | "restricted" | "forbidden";

export type TitleEpochPolicy =
  | { type: "point"; at: string }
  | { type: "interval"; start: string; end: string; clip: true }
  | { type: "baseline"; metrics: readonly string[] };

export interface TitleSourceCodeRef {
  /** repo rootからの相対パス。 */
  file: string;
  /** そのファイルに必ず存在する、契約を示す最小文字列。 */
  needle: string;
}

/**
 * `restrictedUse`が取り得る値。特定の内部専用resolverの入力としてのみ許可された
 * sourceを型として固定する（PR C2で`relationship_private_evidence`、PR E2で
 * `economy_safe_classification`、PR E4/F2bでcasino classification、PR F2dで
 * `public_event_safe_completion_classification`を追加）。値を追加するときは対応する内部resolver
 * （`v2-relationship-evidence.ts`/`v2-economy.ts`/`v2-casino.ts`等）を必ず作ること。
 *
 * 型unionとruntime allowlist（`assertRestrictedUseContract()`が使う）を別々に
 * 保守すると更新忘れが起きる——`TITLE_RESTRICTED_USES`を正本にして型を導出する
 * （PR #161レビュー）。
 */
const TITLE_RESTRICTED_USES = [
  "relationship_private_evidence",
  "economy_safe_classification",
  "casino_safe_participation_classification",
  "casino_safe_completion_classification",
  "public_event_safe_completion_classification",
  "public_event_safe_involvement_classification",
  "public_room_safe_activity_classification",
  "tc_safe_social_classification",
  "public_social_presence_classification",
  "invite_rooted_safe_classification",
  "casino_table_safe_classification",
  "casino_market_safe_classification",
  "social_context_safe_classification",
  "role_domain_temporal_classification",
] as const;
export type TitleRestrictedUse = (typeof TITLE_RESTRICTED_USES)[number];
const VALID_TITLE_RESTRICTED_USES: ReadonlySet<string> = new Set(TITLE_RESTRICTED_USES);

/** 全sourceに共通するメタデータ。persisted/derivedのどちらでも同じ意味で使う。 */
interface TitleSourceCommon {
  kind: TitleSourceKind;
  privacy: TitleSourcePrivacy;
  /**
   * source全体について達成時刻を正確に復元できるか。
   * raw sourceに推定時刻が混ざり得るならfalse。必要なら後続のderived sourceでtrueを取り戻す。
   */
  orderable: boolean;
  /** 個々の称号が直接sourceとして宣言してよいか。監査・baseline専用sourceはfalse。 */
  titleUsable: boolean;
  /** カタログ施行時刻をまたぐ履歴をどう切るか。 */
  epochPolicy: TitleEpochPolicy;
  /** SQLの1行（またはderived factの1件）が利用者行動の何を意味するか。誤用を防ぐ。 */
  rawUnit: string;
  /**
   * このsourceが、generic title conditionではなく特定の内部private-evidence resolverの
   * 専用入力であることを明示する（PR C2）。値を持つsourceは`privacy==="restricted"`かつ
   * `titleUsable===false`でなければならない——`assertRestrictedUseContract()`が
   * runtimeで検証する。safe/forbidden sourceへ`restrictedUse`を付けることも禁止する
   * （restrictedの意味を「titleUsable:falseだが実は内部specialized resolverが読める」
   * へ拡張するのではなく、その用途自体を型として固定するためのラベル）。
   */
  restrictedUse?: TitleRestrictedUse;
}

/** DBへ直接書き込まれる正本source。 */
export interface PersistedTitleSourceDefinition extends TitleSourceCommon {
  origin: "persisted";
  /** 人が追えてテストでも検証できる書き込み正本。 */
  writtenBy: TitleSourceCodeRef;
  /** writerを直接呼ぶ本番処理。 */
  calledFrom: TitleSourceCodeRef;
  /** Discord event等からcalledFromまでの最上流配線。死んだcallerを検知する。 */
  wiredFrom: TitleSourceCodeRef;
}

/**
 * 他のsourceから読み出し専用で導出するsource。
 *
 * 「writerが存在するsource」と偽装しない——derivedはDBへ何も書かないので
 * writtenBy/calledFrom/wiredFromを持たせず、代わりに実装ファイルと依存元を持つ。
 */
export interface DerivedTitleSourceDefinition extends TitleSourceCommon {
  origin: "derived";
  /** 導出ロジックを実装しているファイルと、その存在を示す最小文字列。 */
  derivedBy: TitleSourceCodeRef;
  /**
   * 依存する登録済みsource（persisted/derived問わず）。
   * dependency chainは最終的にlive persisted sourceへ到達しなければならない（v2-store.tsで検証）。
   */
  derivedFrom: readonly string[];
}

export type TitleSourceDefinition = PersistedTitleSourceDefinition | DerivedTitleSourceDefinition;

/**
 * 最初のsource registry。
 *
 * 全データ源を一気に登録しない。実際の writer / caller / event wiring / 境界契約を監査できたものだけを
 * PRごとに追加する。未登録sourceは称号定義から参照できない。
 */
export const TITLE_SOURCES = {
  vc_segments: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/vc/service.ts",
      needle: "INSERT INTO vc_segments",
    },
    calledFrom: {
      file: "apps/bot/src/vc-tracking.ts",
      needle: "services.vc.open(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "trackVoiceState(oldState, newState, services);",
    },
    kind: "history",
    privacy: "safe",
    // closeAllDangling() はクラッシュ復旧時に ended_at を推定値で補う。
    // raw vc_segments 全体としては達成時刻を完全には証明できない。
    orderable: false,
    // 個々の称号からは直接使わせない。安全な derived source（vc_visits 以下）を使うこと。
    // raw segment を将来の称号作者が直接 COUNT してしまう経路をここで閉じる。
    titleUsable: false,
    epochPolicy: {
      type: "interval",
      start: "started_at",
      end: "ended_at",
      clip: true,
    },
    // VcTracker.open() は入室だけでなく mute/deafen・ch移動でも前segmentを閉じる。
    // COUNT(*) を「VC入室回数」と読んではいけない。
    rawUnit: "voice_state_segment",
  },
  bump_events: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/rank/bump.ts",
      needle: "INSERT OR IGNORE INTO bump_events",
    },
    calledFrom: {
      file: "apps/bot/src/bump.ts",
      needle: "services.bumps.addOnce(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleBumpMessage(message, services)",
    },
    kind: "history",
    privacy: "safe",
    // addOnce() が成功BUMPごとに created_at を保存するため、N件目の達成時刻を復元できる。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "created_at" },
    rawUnit: "successful_bump_event",
  },
  bump_counts: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/rank/bump.ts",
      needle: "INSERT INTO bump_counts",
    },
    calledFrom: {
      file: "apps/bot/src/bump.ts",
      needle: "services.bumps.addOnce(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleBumpMessage(message, services)",
    },
    kind: "counter",
    privacy: "safe",
    orderable: false,
    // ランキング・counter baseline機構の監査には使うが、BUMP称号は時刻付きbump_eventsを使う。
    titleUsable: false,
    // baselineで保存してよいmetric名もsource contract側で固定する。
    epochPolicy: { type: "baseline", metrics: ["count"] },
    rawUnit: "cumulative_counter",
  },

  // ── VC derived source層（PR2）────────────────────────────────────
  //
  // raw vc_segments は state segment（mute/deafen変化でも切れる）で titleUsable:false。
  // 個々の称号は必ずここから下のderived sourceを使う。
  vc_visits: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeLogicalVisits(",
    },
    derivedFrom: ["vc_segments"],
    kind: "history",
    privacy: "safe",
    // VoiceStateUpdateには強い正本時刻が無く、秒精度のtieも起こりうる。
    // 「N人目」等を主張できるsourceへ安易に昇格させない（正本 §8）。
    orderable: false,
    // visit.startedAtは「入室した瞬間」とは限らない（LogicalVisit.startKind参照）。
    // 孤立したstate_change（クラッシュ補正等で前segmentへcoalesceできなかったmute/deafen
    // 変化）から始まった訪問はpartial_observationで、本人は既にそこにいただけ。
    // これをそのまま称号からCOUNTすると「入室回数」を過大に主張してしまうため、
    // vc_visits自体は中間source扱いとし、直接は使わせない。個々の称号は、
    // startKindを踏まえて安全に畳み込まれた下流derived source（vc_social_safe等）を使うこと。
    titleUsable: false,
    epochPolicy: { type: "interval", start: "startedAt", end: "endedAt", clip: true },
    // raw segment の隣接行を1回の訪問へ合成した単位。
    rawUnit: "logical_vc_visit",
  },
  vc_empty_start_then_joined: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeEmptyStartThenJoined(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "joinedAt" },
    // 「誰もいないVCから始まり、後から誰かが入った」という事実のみ。相手のidentityは含まない。
    rawUnit: "empty_start_then_joined_fact",
  },
  vc_last_occupant: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeLastOccupant(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "becameLastAt" },
    // 「他者が退出し、subjectだけが残った」瞬間。相手のidentityは含まない。
    rawUnit: "last_occupant_fact",
  },
  vc_group_size_seconds: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeGroupSizeSeconds(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    // 呼び出し側が渡すwindow境界そのものが切り口。行ごとのSQL列ではない。
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "group_size_seconds_measurement",
  },
  vc_group_size_daily_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeGroupSizeDailySeconds(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "unique_jst_group_size_trusted_seconds_measurement",
  },
  vc_co_presence: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeCoPresenceOverlaps(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "restricted",
    orderable: false,
    // 生pairwiseは相手のuserIdを含むため称号から直接は使わせない。vc_social_safe を使うこと。
    titleUsable: false,
    // PR C2: relationship titleのprivate witness resolution専用（v2-relationship-evidence.ts
    // の内部resolverだけが読む）。generic title ruleへ渡すsource境界（v2-sources.ts）は
    // 一切拡張しない——titleUsableは引き続きfalseのまま。
    restrictedUse: "relationship_private_evidence",
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "pairwise_overlap",
  },
  vc_social_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeSafeSocialAggregates(",
    },
    derivedFrom: ["vc_co_presence"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    // pair identityを畳み込んだ、本人単位の集計だけ。
    rawUnit: "safe_social_aggregate",
  },
  vc_temporal_co_presence_slices: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/vc/derived.ts",
      needle: "export function computeTrustedCoPresenceSlices(",
    },
    derivedFrom: ["vc_visits"],
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "social_context_safe_classification",
    epochPolicy: { type: "interval", start: "startedAt", end: "endedAt", clip: true },
    rawUnit: "trusted_pairwise_temporal_co_presence_slice",
  },
  soul_status_history: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/db/bootstrap.ts",
      needle: "CREATE TRIGGER IF NOT EXISTS trg_soul_status_history_transition",
    },
    calledFrom: {
      file: "packages/core/src/evaluation/service.ts",
      needle: "UPDATE souls SET status",
    },
    wiredFrom: {
      file: "apps/bot/src/rank-sync.ts",
      needle: "services.evaluation.syncStatusFromRoles(",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "social_context_safe_classification",
    epochPolicy: { type: "point", at: "observed_at" },
    rawUnit: "append_only_canonical_soul_status_observation",
  },
  role_family_manifest_history: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/role-family/temporal.ts",
      needle: "INSERT INTO role_family_manifest_revisions",
    },
    calledFrom: {
      file: "apps/bot/src/role-family-tracking.ts",
      needle: "services.roleFamilyTemporal.startObservationSession(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "initializeRoleFamilyTracking(ready, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "social_context_safe_classification",
    epochPolicy: { type: "point", at: "activated_at" },
    rawUnit: "immutable_explicit_role_family_manifest_revision",
  },
  role_observation_sessions: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/role-family/temporal.ts",
      needle: "INSERT INTO role_observation_sessions",
    },
    calledFrom: {
      file: "apps/bot/src/role-family-tracking.ts",
      needle: "services.roleFamilyTemporal.startObservationSession(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "initializeRoleFamilyTracking(ready, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "social_context_safe_classification",
    epochPolicy: { type: "interval", start: "started_at", end: "last_checkpoint_at", clip: true },
    rawUnit: "trusted_gateway_role_observation_coverage",
  },
  role_family_member_presence: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/role-family/temporal.ts",
      needle: "INSERT INTO role_family_member_presence",
    },
    calledFrom: {
      file: "apps/bot/src/role-family-tracking.ts",
      needle: "services.roleFamilyTemporal.observeMemberSnapshot(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "trackRoleFamilyMemberUpdate(oldMember, newMember, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "social_context_safe_classification",
    epochPolicy: { type: "interval", start: "started_at", end: "ended_at", clip: true },
    rawUnit: "trusted_member_semantic_role_family_presence",
  },
  role_family_domain_intervals: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/role-family/domain-temporal.ts",
      needle: "export function loadTrustedRoleFamilyIntervals(",
    },
    derivedFrom: [
      "role_family_manifest_history",
      "role_observation_sessions",
      "role_family_member_presence",
    ],
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "role_domain_temporal_classification",
    epochPolicy: { type: "interval", start: "knownStart", end: "knownEnd", clip: true },
    rawUnit: "trusted_domain_family_presence_interval_with_transition_second_fence",
  },
  social_class_context_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-social-context.ts",
      needle: "export function computeSocialClassContextSafe(",
    },
    derivedFrom: ["vc_temporal_co_presence_slices", "soul_status_history"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "anonymous_counterpart_by_local_public_class_touch_distribution",
  },
  social_department_family_context_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-social-context.ts",
      needle: "export function computeSocialDepartmentFamilyContextSafe(",
    },
    derivedFrom: [
      "vc_temporal_co_presence_slices",
      "role_family_manifest_history",
      "role_observation_sessions",
      "role_family_member_presence",
    ],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "anonymous_counterpart_by_local_public_department_family_touch_distribution",
  },

  // ── Safe Activity Sources（PR E1）────────────────────────────────────
  //
  tc_message_observations: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/tc-social/service.ts",
      needle: "INSERT INTO tc_message_observations",
    },
    calledFrom: {
      file: "apps/bot/src/tc-social-tracking.ts",
      needle: "services.tcSocial.recordMessage({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "trackTitleTcMessage(message, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: true,
    titleUsable: false,
    restrictedUse: "tc_safe_social_classification",
    epochPolicy: { type: "point", at: "created_at_ms" },
    rawUnit: "public_tc_message_observation",
  },
  tc_reaction_observations: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/tc-social/service.ts",
      needle: "INSERT INTO tc_reaction_observations",
    },
    calledFrom: {
      file: "apps/bot/src/tc-social-tracking.ts",
      needle: "services.tcSocial.recordReaction(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "trackTitleTcReaction(reaction, user, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "tc_safe_social_classification",
    epochPolicy: { type: "point", at: "observed_at_ms" },
    rawUnit: "public_tc_reaction_observation",
  },
  tc_conversation_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/tc-social/derived.ts",
      needle: "export function computeTcConversationSafe(",
    },
    derivedFrom: ["tc_message_observations"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "safe_tc_conversation_structure",
  },
  tc_reaction_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/tc-social/derived.ts",
      needle: "export function computeTcReactionSafe(",
    },
    derivedFrom: ["tc_message_observations", "tc_reaction_observations"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "safe_tc_reaction_distribution",
  },
  vc_public_social_presence: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/vc/public-social-presence.ts",
      needle: "INSERT INTO vc_public_social_presence",
    },
    calledFrom: {
      file: "apps/bot/src/vc-public-social-tracking.ts",
      needle: "services.vcPublicSocial.reconcileChannel({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "trackVcPublicSocialPresence(oldState, newState, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "public_social_presence_classification",
    epochPolicy: { type: "interval", start: "started_at", end: "ended_at", clip: true },
    rawUnit: "public_human_social_presence_interval_with_internal_surface_identity",
  },
  social_activity_time_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/social-activity-time/derived.ts",
      needle: "export function computeSocialActivityTimeSafe(",
    },
    derivedFrom: ["tc_message_observations", "vc_public_social_presence"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "safe_public_social_activity_hour_distribution",
  },
  // rank_text XPを称号sourceとして流用しない（位名と印を再び混ぜない）。raw message数も
  // 保存しない。「そのJST日に少なくとも1回、称号対象として安全なTC活動が観測された」
  // という事実だけを、1 user × 1 JST day最大1行で保存する。
  text_active_days: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/text-activity/service.ts",
      needle: "INSERT INTO text_active_days",
    },
    calledFrom: {
      file: "apps/bot/src/rank-tracker.ts",
      needle: "services.textActivity.recordActiveDay(",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleMessageXp(message, services)",
    },
    kind: "history",
    privacy: "safe",
    // 1 user × 1 JST dayにつき最大1行、observed_atはその日最初に永続化された
    // qualifying event time——N active days目をobserved_at ASCで順序付けられる。
    // ただしこれはN messages/N sessionsを意味しない（rawUnit参照）。
    //
    // 「qualifying」の意味（PR #160レビュー §7）: DM・thread（forum post含む）・
    // private/role-gated channel（@everyoneがViewChannelできないchannel）は対象外
    // ——`isSafeTitleTextActivityMessage()`（apps/bot/src/rank-tracker.ts）が
    // fail-closedで判定する。この判定はtext_active_days記録の可否だけに使い、
    // 既存Rank XP eligibility（xp_excluded_channels等）は変更しない。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "observed_at" },
    // 「ある1つのJST日に、public/non-thread guild channelでのTC活動が観測された」
    // という事実1件。message数・session数ではなく、private/thread conversationも含まない。
    rawUnit: "unique_jst_public_text_active_day",
  },

  // ── Confirmed Invites（PR E1）────────────────────────────────────
  //
  // 正本はinvitesテーブルだけ——souls.inviter_hint_*やentry_bookings.inviter_*
  // （検出・hintの段階）はconfirmedではない。Entry.creditInvite()が実際にINSERTした
  // 行だけを数える。invitee identityはpayloadへ一切出さない。
  confirmed_invites: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/entry/service.ts",
      needle:
        "INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?) ON CONFLICT(invitee_id) DO NOTHING",
    },
    calledFrom: {
      file: "apps/bot/src/commands/entry.ts",
      needle: "services.entry.ghostify(userId, actor, { inviteeGender: gender })",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleMemberRoleUpdate(oldMember, newMember, services)",
    },
    kind: "history",
    privacy: "safe",
    // invites.credited_atは実際に確定した瞬間の時刻——N件目の確定招待をcredited_at ASCで
    // 順序付けられる。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "credited_at" },
    rawUnit: "confirmed_invite_credit",
  },

  // 同じconfirmed invites正本のinternal relation view。No.74/75用safe payloadとは分け、
  // inviter↔invitee identityをinvite-rooted classifierのJOIN外へ出さない。
  confirmed_invite_relations: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/entry/service.ts",
      needle:
        "INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?) ON CONFLICT(invitee_id) DO NOTHING",
    },
    calledFrom: {
      file: "apps/bot/src/commands/entry.ts",
      needle: "services.entry.ghostify(userId, actor, { inviteeGender: gender })",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "handleMemberRoleUpdate(oldMember, newMember, services)",
    },
    kind: "history",
    privacy: "restricted",
    orderable: true,
    titleUsable: false,
    restrictedUse: "invite_rooted_safe_classification",
    epochPolicy: { type: "point", at: "credited_at" },
    rawUnit: "confirmed_invite_relation_with_internal_inviter_invitee_identity",
  },

  // Entry.ghostify()がappend-only EventLogへ残したimmutable entry anchor。
  // generic events rowはactor/target/payloadを含むため、safe ruleへ直接渡さない。
  entry_ghosted_events: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/events/service.ts",
      needle: "INSERT INTO events (type, actor_id, target_id, payload_json, created_at)",
    },
    calledFrom: {
      file: "packages/core/src/entry/service.ts",
      needle: 'this.events.log("ghosted", {',
    },
    wiredFrom: {
      file: "apps/bot/src/commands/entry.ts",
      needle: "services.entry.ghostify(userId, actor, { inviteeGender: gender })",
    },
    kind: "history",
    privacy: "restricted",
    orderable: true,
    titleUsable: false,
    restrictedUse: "invite_rooted_safe_classification",
    epochPolicy: { type: "point", at: "created_at" },
    rawUnit: "append_only_ghosted_entry_event_with_internal_target_identity",
  },

  invite_rooted_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-invite-rooted.ts",
      needle: "export function computeInviteRootedSafe(",
    },
    derivedFrom: [
      "confirmed_invite_relations",
      "entry_ghosted_events",
      "tc_message_observations",
      "vc_public_social_presence",
    ],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "anonymous_confirmed_direct_invite_rooted_network_reunion_distribution",
  },

  // ── Public Room Safe Activity Source（PR F2g）──────────────────────────────
  //
  // roomsにはowner/channel/private room kind/lifecycle情報が含まれるためgeneric ruleへ
  // 直接渡さない。normal/gameだけをVC logical visitと交差させる専用classifierが読む。
  rooms: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/rooms/service.ts",
      needle: "INSERT INTO rooms (kind, channel_id, owner_id, capacity, expires_at, status, created_at, updated_at)",
    },
    calledFrom: {
      file: "apps/bot/src/commands/rooms.ts",
      needle: "services.rooms.register({ kind, channelId: channel.id, ownerId: owner.id, hours: opts.hours })",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handleRoomButton(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "public_room_safe_activity_classification",
    epochPolicy: { type: "interval", start: "created_at", end: "closed_at", clip: true },
    rawUnit: "room_lifecycle_session_record",
  },
  public_room_activity_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/rooms/derived.ts",
      needle: "export function computePublicRoomActivitySafe(",
    },
    derivedFrom: ["rooms", "vc_visits"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "public_room_safe_activity_aggregate",
  },

  // ── Economy Safe Classification（PR E2）────────────────────────────────────
  //
  // raw transactionsにはsalary/fine/tax/bet/prize/casino chip/departmentが同居し、
  // amount・counterparty・reason・ref・approved_by等の機微データも含む。個々の称号へ
  // 直接使わせず、restrictedUse:"economy_safe_classification"経由でのみ、
  // v2-economy.tsの内部classifierだけが読む。
  ledger_transactions: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/ledger/service.ts",
      needle: "INSERT INTO transactions",
    },
    calledFrom: {
      file: "apps/bot/src/commands/transfer.ts",
      needle: "services.ledger.transfer({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handleTransfer(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    // created_atはLedger.transfer()が単一transaction内で確定させる観測時刻。
    orderable: true,
    // 個々の称号からは直接使わせない。安全なderived source（economy_safe_peer_actions）
    // を使うこと——raw amount/counterparty/reason/ref/approved_by等を称号ruleへ晒さない。
    titleUsable: false,
    restrictedUse: "economy_safe_classification",
    epochPolicy: { type: "point", at: "created_at" },
    rawUnit: "land_ledger_transaction",
  },
  economy_safe_peer_actions: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-economy.ts",
      needle: "export function computeSafeEconomyPeerActions(",
    },
    derivedFrom: ["ledger_transactions"],
    kind: "history",
    privacy: "safe",
    // 同一(user, JST date, kind)内では常に最初にcommitされたqualifying transactionの
    // created_atをoccurredAtにする——first qualifying observation immutable。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "occurredAt" },
    // 「ある1つのJST日に、本人が実行したtransfer/tip系の対人経済行動が観測された」
    // という事実1件（kindごと）。amount・件数・counterpartyは一切含まない。
    rawUnit: "unique_jst_safe_peer_economy_action_kind",
  },
  shop_purchase_title_records: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/shop/service.ts",
      needle: "recordTitlePurchaseProvenance",
    },
    calledFrom: {
      file: "apps/bot/src/commands/shop-panel.ts",
      needle: "services.shop.purchase({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handleShopButton(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    orderable: true,
    titleUsable: false,
    restrictedUse: "economy_safe_classification",
    epochPolicy: { type: "point", at: "purchased_at" },
    rawUnit: "immutable_shop_purchase_title_provenance_and_status_history",
  },
  shop_purchase_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-shop-purchases.ts",
      needle: "export function computeShopPurchaseSafe(",
    },
    derivedFrom: ["shop_purchase_title_records"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "eligible_shop_product_breadth_by_jst_day",
  },
  shop_role_purchase_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-domain-role.ts",
      needle: "export function computeShopRolePurchaseSafe(",
    },
    derivedFrom: ["shop_purchase_title_records", "role_family_domain_intervals"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "eligible_shop_purchase_count_by_jst_day_while_trusted_shop_role_present",
  },
  economy_semantic_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-economy.ts",
      needle: "export function computeEconomySemanticSafe(",
    },
    derivedFrom: ["ledger_transactions", "shop_purchase_title_records"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "natural_economy_family_direction_counterpart_day_aggregate",
  },

  // ── Public Event Participation Source（PR E3）──────────────────────────────
  //
  // 正本は`packages/core/src/public-events/service.ts`のPublicEvents——generic
  // EventLog（events）は一切参照しない。運営が確定した公開イベントrosterだけを
  // safe sourceとして公開する。recorded_atは「rosterがBotへ確定保存された時刻」
  // であって参加の実時刻ではないため、orderable:falseにする（§11-12）。
  public_event_records: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/public-events/service.ts",
      needle: "INSERT INTO public_events",
    },
    calledFrom: {
      file: "apps/bot/src/commands/public-event-record.ts",
      needle: "services.publicEvents.recordFinalizedEvent({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handlePublicEventRecordButton(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "public_event_safe_involvement_classification",
    epochPolicy: { type: "point", at: "recorded_at" },
    rawUnit: "immutable_public_event_editorial_record",
  },
  public_event_participations: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/public-events/service.ts",
      needle: "INSERT INTO public_event_participations",
    },
    calledFrom: {
      file: "apps/bot/src/commands/public-event-record.ts",
      needle: "services.publicEvents.recordFinalizedEvent({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handlePublicEventRecordButton(interaction, services);",
    },
    kind: "history",
    privacy: "safe",
    // recorded_atはstaffがrosterを確定保存した時刻であり、参加者が入室した瞬間や
    // イベント開始時刻ではない——「N件目の参加を達成したexact time」として使わせない。
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "recorded_at" },
    rawUnit: "staff_confirmed_public_event_participation",
  },
  public_event_completions: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/public-events/service.ts",
      needle: "INSERT INTO public_event_completions",
    },
    calledFrom: {
      file: "apps/bot/src/commands/public-event-complete.ts",
      needle: "services.publicEvents.recordCompletedEvent({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handlePublicEventCompleteButton(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "public_event_safe_completion_classification",
    epochPolicy: { type: "point", at: "completed_at" },
    rawUnit: "staff_attested_public_event_completion",
  },
  public_event_involvement_revisions: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/public-events/service.ts",
      needle: "INSERT INTO public_event_involvement_revisions",
    },
    calledFrom: {
      file: "apps/bot/src/commands/public-event-record.ts",
      needle: "services.publicEvents.recordFinalizedEvent({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handlePublicEventRecordButton(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "public_event_safe_involvement_classification",
    epochPolicy: { type: "point", at: "roster_recorded_at" },
    rawUnit: "public_event_involvement_protocol_revision",
  },
  public_event_involvements: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/public-events/service.ts",
      needle: "INSERT INTO public_event_involvements",
    },
    calledFrom: {
      file: "apps/bot/src/commands/public-event-record.ts",
      needle: "services.publicEvents.recordFinalizedEvent({",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handlePublicEventRecordButton(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    orderable: false,
    titleUsable: false,
    restrictedUse: "public_event_safe_involvement_classification",
    epochPolicy: { type: "point", at: "roster_recorded_at" },
    rawUnit: "public_event_subject_involvement_role",
  },
  public_event_completed_participations: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-public-events.ts",
      needle: "export function computeCompletedPublicEventParticipations(",
    },
    derivedFrom: ["public_event_participations", "public_event_completions"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "completedAt" },
    rawUnit: "staff_attested_completed_public_event_participation",
  },
  public_event_calendar_involvement_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-public-events.ts",
      needle: "export function computePublicEventCalendarInvolvementSafe(",
    },
    derivedFrom: [
      "public_event_records",
      "public_event_participations",
      "public_event_completions",
      "public_event_involvement_revisions",
      "public_event_involvements",
    ],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "point", at: "completedAt" },
    rawUnit: "anonymous_completed_public_event_calendar_involvement_profile",
  },

  // ── Casino Safe Participation Source（PR E4）────────────────────────────────
  //
  // 正本は`packages/core/src/casino/participation-history.ts`のCasinoParticipationHistory
  // ——`CasinoMetrics`（wager/payout/net/resultを持つanalytics正本）は一切参照しない。
  // raw casino_participationsは1 play=1 rowのまま（Goodhart対策のday collapseを
  // 持たない）ので、個々の称号へ直接使わせず、
  // restrictedUse:"casino_safe_participation_classification"経由でのみ、
  // v2-casino.tsの内部classifierだけが読む。
  casino_participations: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/casino/participation-history.ts",
      needle: "INSERT INTO casino_participations",
    },
    calledFrom: {
      file: "apps/bot/src/casino/blackjack.ts",
      needle: "recordCasinoParticipationBestEffort(services, {",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handleAsobuCommand(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    // occurred_atはsuccessful funded participation commit時にservice clockが直接
    // 観測した時刻——raw単体としては順序付け可能だが、個々の称号からは直接使わせない。
    orderable: true,
    titleUsable: false,
    restrictedUse: "casino_safe_participation_classification",
    epochPolicy: { type: "point", at: "occurred_at" },
    rawUnit: "casino_committed_participation",
  },
  casino_activity_days: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-casino.ts",
      needle: "export function computeCasinoActivityDays(",
    },
    derivedFrom: ["casino_participations"],
    kind: "history",
    privacy: "safe",
    // raw participationは1 play=1 rowだが、称号sourceとしては
    // user×activityKey×JST dayで最大1 factへcollapseする——同日100回遊んでも1件。
    // occurredAtはそのscope内で最初に観測したsuccessful participationのtimestamp
    // （staffの後入力ではなく、commit時に直接観測した値）なので、orderable:trueにできる。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "occurredAt" },
    rawUnit: "unique_jst_casino_activity_day",
  },

  // ── Casino Safe Completion Source（PR F2b）──────────────────────────────────
  //
  // casino_participationsが証明する「successful funded participation
  // commitment」とは別の、immutableな正本。「そのparticipationについて、
  // ゲーム固有のcanonical financial resolution primitive（settlement、または
  // ゲームルール上の正常なdraw/push等の解決）が成功したことを直接観測した」
  // という事実だけを保存する——PVP経路はgame runner実行前にwriterが発火する
  // ためcommitmentとcompletionを区別できない、というPR #164レビューで確定した
  // semantic mismatchを解消する。casino_activity_daysの意味は一切変更しない。
  casino_participation_completions: {
    origin: "persisted",
    writtenBy: {
      file: "packages/core/src/casino/participation-history.ts",
      needle: "INSERT INTO casino_participation_completions",
    },
    calledFrom: {
      file: "apps/bot/src/casino/blackjack.ts",
      needle: "recordCasinoCompletionBestEffort(services, {",
    },
    wiredFrom: {
      file: "apps/bot/src/index.ts",
      needle: "await handleAsobuCommand(interaction, services);",
    },
    kind: "history",
    privacy: "restricted",
    // completed_atはcanonical settlement成功をservice clockが直接観測した時刻
    // ——raw単体としては順序付け可能だが、個々の称号からは直接使わせない。
    orderable: true,
    titleUsable: false,
    restrictedUse: "casino_safe_completion_classification",
    epochPolicy: { type: "point", at: "completed_at" },
    rawUnit: "casino_settlement_completion",
  },
  casino_completed_activity_days: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-casino.ts",
      needle: "export function computeCasinoCompletedActivityDays(",
    },
    // completion tableはactivity_keyを複製しない——JOINでcasino_participationsの
    // activity_keyを読むため、両方のsourceがdependencyになる。
    derivedFrom: ["casino_participation_completions", "casino_participations"],
    kind: "history",
    privacy: "safe",
    // rawは1 completion=1 rowだが、称号sourceとしてはuser×activityKey×JST dayで
    // 最大1 factへcollapseする——同日100回完了しても1件。completedAtはそのscope内で
    // 最初に観測したsettlement成功のtimestamp（commit時に直接観測した値）なので、
    // orderable:trueにできる。
    orderable: true,
    titleUsable: true,
    epochPolicy: { type: "point", at: "completedAt" },
    rawUnit: "unique_jst_casino_completed_activity_day",
  },
  casino_edition_i_completion_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-casino-edition-table-market.ts",
      needle: "export function computeCasinoEditionICompletionSafe(",
    },
    derivedFrom: ["casino_completed_activity_days"],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "versioned_edition_i_completed_family_aggregate",
  },
  casino_table_instances: {
    origin: "persisted",
    writtenBy: { file: "packages/core/src/casino/takutate.ts", needle: "INSERT INTO casino_table_instances" },
    calledFrom: { file: "apps/bot/src/commands/takutate-panel.ts", needle: "services.takutate.track(" },
    wiredFrom: { file: "apps/bot/src/index.ts", needle: "await handleTakuButton(interaction, services);" },
    kind: "history", privacy: "restricted", orderable: true, titleUsable: false,
    restrictedUse: "casino_table_safe_classification",
    epochPolicy: { type: "point", at: "created_at" }, rawUnit: "official_casino_table_instance",
  },
  casino_table_guest_presence: {
    origin: "persisted",
    writtenBy: { file: "packages/core/src/casino/takutate.ts", needle: "INSERT OR IGNORE INTO casino_table_guest_presence" },
    calledFrom: { file: "apps/bot/src/commands/takutate-panel.ts", needle: "services.takutate.observeGuestTransition(" },
    wiredFrom: { file: "apps/bot/src/index.ts", needle: "trackTakuGuestPresence(oldState, newState, services);" },
    kind: "history", privacy: "restricted", orderable: true, titleUsable: false,
    restrictedUse: "casino_table_safe_classification",
    epochPolicy: { type: "interval", start: "started_at", end: "ended_at", clip: true },
    rawUnit: "known_human_casino_table_guest_presence",
  },
  casino_table_activity_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-casino-edition-table-market.ts",
      needle: "export function computeCasinoTableActivitySafe(",
    },
    derivedFrom: ["casino_table_instances", "casino_table_guest_presence"],
    kind: "history", privacy: "safe", orderable: false, titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "anonymous_table_guest_jst_day_trusted_seconds",
  },
  casino_market_participation_records: {
    origin: "persisted",
    writtenBy: { file: "packages/core/src/casino/market.ts", needle: "INSERT INTO casino_market_participation_history" },
    calledFrom: { file: "apps/bot/src/commands/ita.ts", needle: "services.markets.bet(" },
    wiredFrom: { file: "apps/bot/src/index.ts", needle: "await handleItaButton(interaction, services);" },
    kind: "history", privacy: "restricted", orderable: true, titleUsable: false,
    restrictedUse: "casino_market_safe_classification",
    epochPolicy: { type: "point", at: "occurred_at" }, rawUnit: "successful_funded_market_commitment",
  },
  casino_market_activity_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-casino-edition-table-market.ts",
      needle: "export function computeCasinoMarketActivitySafe(",
    },
    derivedFrom: ["casino_market_participation_records"],
    kind: "history", privacy: "safe", orderable: false, titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "unique_other_standard_market_jst_day_commitment",
  },
  castle_experience_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-castle-experience.ts",
      needle: "export function computeCastleExperienceSafe(",
    },
    derivedFrom: [
      "vc_public_social_presence",
      "tc_message_observations",
      "rooms",
      "vc_visits",
      "economy_safe_peer_actions",
      "shop_purchase_safe",
      "casino_edition_i_completion_safe",
      "casino_table_instances",
      "casino_table_guest_presence",
      "casino_market_activity_safe",
      "public_event_calendar_involvement_safe",
    ],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "versioned_castle_experience_family_jst_day_profile",
  },
  castle_role_context_safe: {
    origin: "derived",
    derivedBy: {
      file: "packages/core/src/titles/v2-castle-role-context.ts",
      needle: "export function computeCastleRoleContextSafe(",
    },
    derivedFrom: [
      "role_family_manifest_history",
      "role_observation_sessions",
      "role_family_member_presence",
      "vc_public_social_presence",
      "tc_message_observations",
      "rooms",
      "vc_visits",
      "economy_safe_peer_actions",
      "shop_purchase_safe",
      "casino_edition_i_completion_safe",
      "casino_table_instances",
      "casino_table_guest_presence",
      "casino_market_participation_records",
    ],
    kind: "history",
    privacy: "safe",
    orderable: false,
    titleUsable: true,
    epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
    rawUnit: "versioned_role_held_castle_normal_family_inside_outside_jst_profile",
  },
} as const satisfies Record<string, TitleSourceDefinition>;

export type TitleSourceKey = keyof typeof TITLE_SOURCES;
export type TitleUsableSourceKey = {
  [K in TitleSourceKey]: (typeof TITLE_SOURCES)[K]["titleUsable"] extends true ? K : never;
}[TitleSourceKey];

/**
 * derived sourceのdependency chainが、最終的にlive persisted sourceへ到達することを検証する。
 *
 * 未登録keyへの参照・循環参照・persistedで終わらないchainを全部拒否する。
 * パスと関数名の文字列が存在するだけでは「本番で実際に通る」ことの証明として弱い
 * （evaluationsの変形版が再発しうる）ので、依存関係そのものの整合性もここで機械検証する。
 */
export function assertDerivedSourceDependenciesResolve(
  sources: Record<string, TitleSourceDefinition> = TITLE_SOURCES,
): void {
  const resolving = new Set<string>();
  const resolved = new Set<string>();

  const resolve = (key: string, path: readonly string[]): void => {
    if (resolved.has(key)) return;
    const def = sources[key];
    if (!def) {
      throw new Error(`title source dependency references unknown source: ${[...path, key].join(" -> ")}`);
    }
    if (def.origin === "persisted") {
      resolved.add(key);
      return;
    }
    if (resolving.has(key)) {
      throw new Error(`title source dependency cycle detected: ${[...path, key].join(" -> ")}`);
    }
    if (def.derivedFrom.length === 0) {
      throw new Error(`derived title source must declare at least one dependency: ${key}`);
    }
    resolving.add(key);
    for (const dep of def.derivedFrom) resolve(dep, [...path, key]);
    resolving.delete(key);
    resolved.add(key);
  };

  for (const key of Object.keys(sources)) resolve(key, []);
}

/**
 * `restrictedUse`契約をfail-closedで検証する（PR C2、PR #161レビューで未知値
 * validationを追加）。`restrictedUse`を持つsourceは:
 * - 既知の`TitleRestrictedUse`値でなければならない——TypeScriptを迂回して
 *   （`as any`等で）未登録の文字列を渡された場合でもruntimeで拒否する。
 * - 必ず`privacy==="restricted"`かつ`titleUsable===false`でなければならない——
 *   safe/forbidden sourceへ`restrictedUse`を付けたり、generic title ruleから
 *   読めてしまう`titleUsable:true`のsourceを「実は内部専用」と偽装したりする
 *   ことを防ぐ。
 */
export function assertRestrictedUseContract(
  sources: Record<string, TitleSourceDefinition> = TITLE_SOURCES,
): void {
  for (const [key, source] of Object.entries(sources)) {
    const restrictedUse = (source as { restrictedUse?: unknown }).restrictedUse;
    if (restrictedUse === undefined) continue;
    if (typeof restrictedUse !== "string" || !VALID_TITLE_RESTRICTED_USES.has(restrictedUse)) {
      throw new Error(`title source ${key}: unknown restrictedUse`);
    }
    if (source.privacy !== "restricted") {
      throw new Error(`title source ${key}: restrictedUse requires privacy==="restricted" (got ${source.privacy})`);
    }
    if (source.titleUsable !== false) {
      throw new Error(`title source ${key}: restrictedUse requires titleUsable===false`);
    }
  }
}

/**
 * lowercase英数字・"-"・"_"だけのslug。scopeKeyの構成要素（catalogKey・eventKey）や
 * themeKey/groupKey/seriesKey等、後から文字列結合でキーを合成する識別子に使う。
 * ":" や空白を許可すると、`month:${catalogKey}:${label}` のようなscopeKey生成が
 * 曖昧になる（catalogKeyの中に":"が混ざると別のscopeを指してしまう等）。
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function assertSlug(value: string, label: string): void {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new Error(`${label} must be a slug (lowercase alnum, "-", "_", no spaces/colons): ${JSON.stringify(value)}`);
  }
}

export interface TitleProgression {
  /** 同じladderに属するmemberが共有する識別子。TitleSeriesManifest.seriesKeyと一致させる。 */
  readonly seriesKey: string;
  /** 1始まりの連番。TitleSeriesManifestの検証で重複・欠番を拒否する。 */
  readonly stage: number;
}

interface TitleDefinitionCommon {
  readonly key: `v2.${string}`;
  readonly name: string;
  readonly emoji: string;
  readonly description: string;
  readonly lifecycle: TitleLifecycle;
  /** 条件そのものを取得前に公開するのではなく、必要ならこのヒントだけを見せる。 */
  readonly hint?: string;
  /** 条件・名前とも伏せる番外枠。 */
  readonly hidden: boolean;
  /** 高レアだから自動告知、にはしない。 */
  readonly publicAnnounce: boolean;
  /**
   * 「何の分野か」の編集上・閲覧上のカテゴリ（editorial/browsing/display category）。
   * 表示の整理にのみ使う——theme breadth集計・collection/series判定等のlogicには
   * 一切使わない。将来titleを別themeへ移動してよい（released後もimmutableではない）。
   * theme breadth集計が必要な場合は `collectionDomainKey`（BehaviorTitleDefinition）を使うこと。
   */
  readonly themeKey: string;
  /** 関連称号のまとまり。side titleも同じgroupに入れる。themeとは別概念。 */
  readonly groupKey: string;
  readonly scope: TitleScopePolicy;
}

/** 通常source evaluatorを通す称号。 */
export interface BehaviorTitleDefinition extends TitleDefinitionCommon {
  readonly kind: "behavior";
  /** 第I期・第II期など計測起点を共有するカタログ。 */
  readonly catalog: string;
  readonly sources: readonly TitleUsableSourceKey[];
  readonly triggers: readonly TitleTrigger[];
  /** 連番ladderの1段であることを示す。無ければ単独称号。 */
  readonly progression?: TitleProgression;
  /**
   * collection breadth判定（千印万来のtheme breadth集計等）用のsemantic identity。
   * `themeKey` とは別概念——`themeKey` はeditorial/display専用でlogicに使わないが、
   * `collectionDomainKey` はcollection edition manifest（`v2-collection.ts` の
   * `TitleCollectionMember.collectionDomainKey`）が横断性判定の基準として直接参照する。
   *
   * **released behavior titleの`collectionDomainKey`はsemantic contractの一部——
   * 後から別domainへ付け替えない。** themeKeyのように自由に編集し直してよいフィールド
   * ではない（released title semanticの他の不変フィールドと同じ扱い）。
   */
  readonly collectionDomainKey: string;
}

/**
 * 他titleのaward状態やcollection/full-clear manifestを横断して判定する称号
 * （千印万来・万印皆伝等）。通常のsource evaluatorは経由しない——そのため
 * `sources` / `triggers` を持たない。型でbehavior evaluatorへ渡せないようにする
 * （TitleRule.definitionはBehaviorTitleDefinitionしか受け付けない）。
 *
 * `catalog` も持たない。meta titleは特定1catalogの監査対象という単位ではなく、
 * 有効な複数catalog/manifestを横断して判定する。scope.typeは実質globalのみ有効
 * （defineMetaTitle()がruntimeで強制する。catalog/month/eventはcatalog参照が
 * 無いと解決できないため）。
 *
 * `progression` は持たせない。meta titleは「ある条件を満たした/満たしていない」の
 * 単発到達点であり、《一門皆伝》のような称号もそれ自体は連番ladderの1段ではなく、
 * series完遂そのものを示すゴール。meta同士のladderが将来本当に必要になったら、
 * その時点で別の型を起こす（先回りして型を膨らませない）。
 */
export interface MetaTitleDefinition extends TitleDefinitionCommon {
  readonly kind: "meta";
}

export type TitleDefinition = BehaviorTitleDefinition | MetaTitleDefinition;

const VALID_LIFECYCLES: ReadonlySet<TitleLifecycle> = new Set(["active", "retired", "disabled"]);
const VALID_SCOPE_TYPES: ReadonlySet<TitleScopePolicy["type"]> = new Set(["catalog", "global", "month", "event"]);

function assertCommonTitleDefinition(definition: TitleDefinitionCommon & { key: string }): void {
  if (!definition.key.startsWith("v2.") || definition.key.length <= 3) {
    throw new Error(`title key must use v2.* namespace: ${definition.key}`);
  }
  // TypeScriptのunion型を迂回した動的入力（旧seasonal等）でもruntimeで拒否する。
  if (!VALID_LIFECYCLES.has(definition.lifecycle)) {
    throw new Error(`title ${definition.key}: invalid lifecycle ${String(definition.lifecycle)}`);
  }
  assertSlug(definition.themeKey, `title ${definition.key}: themeKey`);
  assertSlug(definition.groupKey, `title ${definition.key}: groupKey`);
  if (!VALID_SCOPE_TYPES.has(definition.scope?.type)) {
    throw new Error(`title ${definition.key}: invalid scope.type ${String(definition.scope?.type)}`);
  }
  if (definition.scope.type === "event") {
    assertSlug(definition.scope.eventKey, `title ${definition.key}: scope.eventKey`);
  }
}

/**
 * behavior titleのruntime guard。TypeScriptを迂回した動的入力でも、旧key・未登録
 * source・監査専用source・sources/triggers空・重複triggerを通さない。
 */
export function defineBehaviorTitle<T extends BehaviorTitleDefinition>(definition: T): T {
  if (definition.kind !== "behavior") {
    throw new Error(`title ${definition.key}: defineBehaviorTitle() requires kind:"behavior"`);
  }
  assertCommonTitleDefinition(definition);
  assertSlug(definition.catalog, `title ${definition.key}: catalog`);
  assertSlug(definition.collectionDomainKey, `title ${definition.key}: collectionDomainKey`);

  if (definition.sources.length === 0) throw new Error(`title ${definition.key}: at least one source is required`);
  for (const source of definition.sources as readonly TitleSourceKey[]) {
    if (!(source in TITLE_SOURCES)) {
      throw new Error(`title ${definition.key}: unregistered source ${String(source)}`);
    }
    const sourceDefinition: TitleSourceDefinition = TITLE_SOURCES[source];
    if (!sourceDefinition.titleUsable) {
      throw new Error(`title ${definition.key}: source is not usable by titles: ${source}`);
    }
    if (sourceDefinition.privacy === "forbidden") {
      throw new Error(`title ${definition.key}: forbidden source ${source}`);
    }
  }

  if (definition.triggers.length === 0) throw new Error(`title ${definition.key}: at least one trigger is required`);
  const seenTriggers = new Set<TitleTrigger>();
  for (const trigger of definition.triggers) {
    // TypeScriptを迂回した動的入力（as any等）で未知のtrigger文字列が来てもruntimeで拒否する。
    if (!VALID_TRIGGERS.has(trigger)) {
      throw new Error(`title ${definition.key}: invalid trigger ${String(trigger)}`);
    }
    if (seenTriggers.has(trigger)) throw new Error(`title ${definition.key}: duplicate trigger ${trigger}`);
    seenTriggers.add(trigger);
  }

  if (definition.progression) {
    assertSlug(definition.progression.seriesKey, `title ${definition.key}: progression.seriesKey`);
    if (!Number.isInteger(definition.progression.stage) || definition.progression.stage < 1) {
      throw new Error(`title ${definition.key}: progression.stage must be a positive integer`);
    }
  }

  return definition;
}

/**
 * meta titleのruntime guard。scope.typeはglobalのみ許可する
 * （meta titleはcatalog参照を持たないため、catalog/month/eventのCATALOG_EPOCH解決ができない）。
 */
export function defineMetaTitle<T extends MetaTitleDefinition>(definition: T): T {
  if (definition.kind !== "meta") {
    throw new Error(`title ${definition.key}: defineMetaTitle() requires kind:"meta"`);
  }
  assertCommonTitleDefinition(definition);
  if (definition.scope.type !== "global") {
    throw new Error(
      `title ${definition.key}: meta titles only support scope.type="global" (no catalog reference on meta titles)`,
    );
  }
  return definition;
}
