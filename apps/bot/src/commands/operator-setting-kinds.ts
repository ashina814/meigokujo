/** Operator-facing Settings metadata only. Dynamic runtime markers do not belong here. */
export const OPERATOR_SETTING_KINDS = [
  "channel",
  "category",
  "role",
  "number",
  "string",
  "role-list",
  "string-list",
  "json",
] as const;
export type OperatorSettingKind = (typeof OPERATOR_SETTING_KINDS)[number];
export type OperatorNumberValidation = "positive-integer" | "flag" | "non-negative";
export type OperatorSettingSurface = "generic-settings-ui" | "dedicated-ui" | "manual";

export interface OperatorSettingMeta {
  /** Actual key persisted in the generic Settings KVS. */
  key: string;
  /** Value carried by admin UI custom IDs; prefixes are deliberately explicit. */
  uiKey: string;
  kind: OperatorSettingKind;
  label: string;
  /** Omitted on the original generic settings groups for compactness. */
  surface?: OperatorSettingSurface;
  validation?: OperatorNumberValidation;
  consumerMode?: "production" | "display-only";
  /** Small source-liveness proof that this is consumed outside the admin UI. */
  consumer: { file: string; needle: string };
}

const c = (file: string, needle: string) => ({ file, needle });

export const OPERATOR_SETTINGS = [
  { key: "channel:public_log", uiKey: "public_log", kind: "channel", label: "公開取引ログ", consumer: c("apps/bot/src/outbox.ts", 'kind === "public_log"') },
  { key: "channel:kessai", uiKey: "kessai", kind: "channel", label: "#決裁", consumer: c("apps/bot/src/commands/fiscal.ts", 'getString("channel:kessai")') },
  { key: "channel:keikiban", uiKey: "keikiban", kind: "channel", label: "#城の計器盤", consumer: c("apps/bot/src/dashboard.ts", 'getString("channel:keikiban")') },
  { key: "channel:audit_log", uiKey: "audit_log", kind: "channel", label: "監査ログ", consumer: c("apps/bot/src/outbox.ts", '"audit_log"') },
  { key: "channel:entry_guide", uiKey: "entry_guide", kind: "channel", label: "入城案内（パネル・DMの案内先）", consumer: c("apps/bot/src/entry-channels.ts", 'ENTRY_GUIDE_KEY = "channel:entry_guide"') },
  { key: "channel:entry_ops", uiKey: "entry_ops", kind: "channel", label: "入城の運用（説明会お知らせ・時間外希望スレッド／未設定なら入城案内と同じ）", consumer: c("apps/bot/src/entry-channels.ts", 'ENTRY_OPS_KEY = "channel:entry_ops"') },
  { key: "channel:waiters_board", uiKey: "waiters_board", kind: "channel", label: "門番用の待ち人ボード", consumer: c("apps/bot/src/waiters-board.ts", 'WAITERS_BOARD_CHANNEL_KEY = "channel:waiters_board"') },
  { key: "channel:session_vc", uiKey: "session_vc", kind: "channel", label: "説明会場VC", consumer: c("apps/bot/src/commands/entry.ts", 'getString("channel:session_vc")') },
  { key: "channel:session_vc2", uiKey: "session_vc2", kind: "channel", label: "説明会場VC（2つ目）", consumer: c("apps/bot/src/commands/entry.ts", 'getString("channel:session_vc2")') },
  { key: "channel:shokan", uiKey: "shokan", kind: "channel", label: "冥界商館（ショップ配送通知）", consumer: c("apps/bot/src/outbox.ts", 'getString("channel:shokan")') },
  { key: "channel:promotion_call", uiKey: "promotion_call", kind: "channel", label: "昇格面談呼び出し", consumer: c("apps/bot/src/commands/entry.ts", 'getString("channel:promotion_call")') },
  { key: "channel:rank_notify", uiKey: "rank_notify", kind: "channel", label: "称号レベルアップ通知", consumer: c("apps/bot/src/rank-tracker.ts", 'getString("channel:rank_notify")') },
  { key: "channel:eval_forum", uiKey: "eval_forum", kind: "channel", label: "評価フォーラム", consumer: c("apps/bot/src/commands/evaluation.ts", 'getString("channel:eval_forum")') },
  { key: "channel:shurei", uiKey: "shurei", kind: "channel", label: "集令", consumer: c("apps/bot/src/rank-tracker.ts", 'getString("channel:shurei")') },
  { key: "channel:announce", uiKey: "announce", kind: "channel", label: "昇格のお知らせ", consumer: c("apps/bot/src/commands/promote.ts", 'getString("channel:announce")') },
  { key: "channel:recruit", uiKey: "recruit", kind: "channel", label: "蜜月の募集掲示", consumer: c("apps/bot/src/commands/rooms.ts", 'getString("channel:recruit")') },
  { key: "channel:charon_notify", uiKey: "charon_notify", kind: "channel", label: "カロン通知", consumer: c("apps/bot/src/scheduler.ts", 'getString("channel:charon_notify")') },
  { key: "channel:bigwin", uiKey: "bigwin", kind: "channel", label: "大勝ち速報", consumer: c("apps/bot/src/casino/bigwin.ts", 'getString("channel:bigwin")') },
  { key: "channel:member_log", uiKey: "member_log", kind: "channel", label: "入退室ログ", consumer: c("apps/bot/src/member-log.ts", 'getString("channel:member_log")') },
  { key: "channel:confession", uiKey: "confession", kind: "channel", label: "トートの耳（匿名タレコミ）", consumer: c("apps/bot/src/commands/confession-base.ts", 'getString("channel:confession")') },
  { key: "channel:court_forum", uiKey: "court_forum", kind: "channel", label: "冥府裁判所フォーラム（送致先）", consumer: c("apps/bot/src/commands/confession-base.ts", 'getString("channel:court_forum")') },
  { key: "channel:emergency_reports", uiKey: "emergency_reports", kind: "channel", label: "緊急対応の通知先", consumer: c("apps/bot/src/commands/confession-base.ts", 'getString("channel:emergency_reports")') },
  { key: "channel:handoff_notify", uiKey: "handoff_notify", kind: "channel", label: "対応先変更・大司教呼出の通知先（省略時はトートの耳）", consumer: c("apps/bot/src/commands/confession-base.ts", 'getString("channel:handoff_notify")') },

  { key: "category:conversation_court_core_block", uiKey: "conversation_court_core_block", kind: "category", label: "会話廷コアタイムVC制限カテゴリ", consumer: c("apps/bot/src/conversation-court.ts", 'CONVERSATION_COURT_CATEGORY_SETTING_KEY = "category:conversation_court_core_block"') },
  { key: "category:rooms", uiKey: "rooms", kind: "category", label: "宿ぜんぶの既定カテゴリ（種別ごとの指定が無いとき）", consumer: c("apps/bot/src/commands/rooms.ts", 'ROOM_CATEGORY_FALLBACK_KEY = "category:rooms"') },
  { key: "category:room_normal", uiKey: "room_normal", kind: "category", label: "通常宿の生成先", consumer: c("apps/bot/src/commands/rooms.ts", 'normal: "category:room_normal"') },
  { key: "category:room_mitsugetsu", uiKey: "room_mitsugetsu", kind: "category", label: "蜜月の生成先", consumer: c("apps/bot/src/commands/rooms.ts", 'mitsugetsu: "category:room_mitsugetsu"') },
  { key: "category:room_oborozuki", uiKey: "room_oborozuki", kind: "category", label: "朧月（秘密の宿）の生成先", consumer: c("apps/bot/src/commands/rooms.ts", 'oborozuki: "category:room_oborozuki"') },
  { key: "category:room_game", uiKey: "room_game", kind: "category", label: "ゲーム部屋の生成先", consumer: c("apps/bot/src/commands/rooms.ts", 'game: "category:room_game"') },
  { key: "category:eval_den", uiKey: "eval_den", kind: "category", label: "巣穴（評価VC）の生成先", consumer: c("apps/bot/src/dens.ts", 'getString("category:eval_den")') },

  { key: "role:admin", uiKey: "admin", kind: "role", label: "運営（管理ロール）", consumer: c("apps/bot/src/church-roles.ts", 'getString("role:admin")') },
  { key: "role:queue_wait", uiKey: "queue_wait", kind: "role", label: "入城案内待ち", consumer: c("apps/bot/src/commands/entry.ts", 'getString("role:queue_wait")') },
  { key: "role:ghost", uiKey: "ghost", kind: "role", label: "亡霊", consumer: c("packages/core/src/rank/sync.ts", 'ghost: "role:ghost"') },
  { key: "role:meirei", uiKey: "meirei", kind: "role", label: "迷霊", consumer: c("packages/core/src/rank/sync.ts", 'MEIREI_ROLE_SETTING_KEY = "role:meirei"') },
  { key: "role:majin", uiKey: "majin", kind: "role", label: "魔人", consumer: c("packages/core/src/rank/sync.ts", 'majin: "role:majin"') },
  { key: "role:kenma", uiKey: "kenma", kind: "role", label: "眷魔", consumer: c("packages/core/src/rank/sync.ts", 'kenma: "role:kenma"') },
  { key: "role:mazoku", uiKey: "mazoku", kind: "role", label: "魔族", consumer: c("packages/core/src/rank/sync.ts", 'mazoku: "role:mazoku"') },
  { key: "role:judge", uiKey: "judge", kind: "role", label: "門番", consumer: c("apps/bot/src/commands/entry.ts", 'JUDGE_ROLE_KINDS = ["judge", "judge_lead", "judge_extra"]') },
  { key: "role:judge_lead", uiKey: "judge_lead", kind: "role", label: "門番統括", consumer: c("apps/bot/src/commands/entry.ts", 'JUDGE_ROLE_KINDS = ["judge", "judge_lead", "judge_extra"]') },
  { key: "role:judge_extra", uiKey: "judge_extra", kind: "role", label: "門番（予備）", consumer: c("apps/bot/src/commands/entry.ts", 'JUDGE_ROLE_KINDS = ["judge", "judge_lead", "judge_extra"]') },
  { key: "role:shin", uiKey: "shin", kind: "role", label: "審", consumer: c("apps/bot/src/commands/entry.ts", 'getString("role:shin")') },
  { key: "role:mendan", uiKey: "mendan", kind: "role", label: "面談待ち", consumer: c("apps/bot/src/commands/entry.ts", 'getString("role:mendan")') },
  { key: "role:ticket_staff", uiKey: "ticket_staff", kind: "role", label: "チケット対応", consumer: c("apps/bot/src/church-roles.ts", 'getString("role:ticket_staff")') },
  { key: "role:male", uiKey: "male", kind: "role", label: "男性属性", consumer: c("apps/bot/src/commands/entry.ts", 'getString("role:male")') },
  { key: "role:female", uiKey: "female", kind: "role", label: "女性属性", consumer: c("apps/bot/src/commands/entry.ts", 'getString("role:female")') },
  { key: "role:bump_notify", uiKey: "bump_notify", kind: "role", label: "紹介協力者", consumer: c("apps/bot/src/bump.ts", 'getString("role:bump_notify")') },
  { key: "role:casino_vip", uiKey: "casino_vip", kind: "role", label: "賭場VIP", consumer: c("apps/bot/src/commands/vip.ts", 'getString("role:casino_vip")') },
  { key: "role:emergency_staff", uiKey: "emergency_staff", kind: "role", label: "緊急対応担当", consumer: c("apps/bot/src/church-roles.ts", 'getString("role:emergency_staff")') },

  { key: "initial_grant", uiKey: "initial_grant", kind: "number", label: "亡霊化時の初期発行", consumer: c("packages/core/src/entry/service.ts", 'getNumber("initial_grant")') },
  { key: "eval_base_period_days", uiKey: "eval_base_period_days", kind: "number", label: "評価期限（日）", consumer: c("packages/core/src/evaluation/service.ts", 'getNumber("eval_base_period_days")') },
  { key: "invite_extend_days_male", uiKey: "invite_extend_days_male", kind: "number", label: "招待延長：男（日）", consumer: c("packages/core/src/entry/service.ts", '"invite_extend_days_male"') },
  { key: "invite_extend_days_female", uiKey: "invite_extend_days_female", kind: "number", label: "招待延長：女（日）", consumer: c("packages/core/src/entry/service.ts", '"invite_extend_days_female"') },
  { key: "invite_extend_cap_days", uiKey: "invite_extend_cap_days", kind: "number", label: "招待延長 上限（日）", consumer: c("packages/core/src/entry/service.ts", 'getNumber("invite_extend_cap_days")') },
  { key: "invite_mark_per_person", uiKey: "invite_mark_per_person", kind: "number", label: "招待→昇格印（人あたり）", validation: "non-negative", consumer: c("packages/core/src/entry/service.ts", 'getNumber("invite_mark_per_person")') },
  { key: "invite_mark_cap", uiKey: "invite_mark_cap", kind: "number", label: "招待→昇格印 上限", validation: "non-negative", consumer: c("packages/core/src/entry/service.ts", 'getNumber("invite_mark_cap")') },
  { key: "promotion_marks_required", uiKey: "promotion_marks_required", kind: "number", label: "昇格印 必要数", validation: "positive-integer", consumer: c("packages/core/src/evaluation/service.ts", 'getNumber("promotion_marks_required")') },
  { key: "demotion_marks_threshold", uiKey: "demotion_marks_threshold", kind: "number", label: "低評価印 閾値", validation: "positive-integer", consumer: c("packages/core/src/evaluation/service.ts", 'getNumber("demotion_marks_threshold")') },
  { key: "approval_threshold", uiKey: "approval_threshold", kind: "number", label: "承認閾値（Land）", consumer: c("apps/bot/src/commands/transfer.ts", 'getNumber("approval_threshold")') },
  { key: "room_slot_price", uiKey: "room_slot_price", kind: "number", label: "宿の枠+1価格", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_slot_price")') },
  { key: "room_mitsugetsu_price", uiKey: "room_mitsugetsu_price", kind: "number", label: "蜜月価格", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_mitsugetsu_price")') },
  { key: "room_oborozuki_price", uiKey: "room_oborozuki_price", kind: "number", label: "朧月価格", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_oborozuki_price")') },
  { key: "room_empty_grace_min", uiKey: "room_empty_grace_min", kind: "number", label: "空室からの削除猶予（分）", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_empty_grace_min")') },
  { key: "room_recruit_expire_hours", uiKey: "room_recruit_expire_hours", kind: "number", label: "蜜月募集の失効（時間）", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_recruit_expire_hours")') },
  { key: "room_recruit_refund", uiKey: "room_recruit_refund", kind: "number", label: "蜜月失効の返金", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_recruit_refund")') },
  { key: "bump_reward", uiKey: "bump_reward", kind: "number", label: "bump報酬（Land）", consumer: c("apps/bot/src/bump.ts", 'getNumber("bump_reward")') },
  { key: "ether_fuku_scale", uiKey: "ether_fuku_scale", kind: "number", label: "福の重みスケール", consumer: c("apps/bot/src/services.ts", 'getNumber("ether_fuku_scale")') },
  { key: "vip_price", uiKey: "vip_price", kind: "number", label: "VIP月会費（Land）", consumer: c("apps/bot/src/services.ts", 'getNumber("vip_price")') },
  { key: "vip_days", uiKey: "vip_days", kind: "number", label: "VIP日数", consumer: c("apps/bot/src/services.ts", 'getNumber("vip_days")') },
  { key: "vip_bet_cap_mult", uiKey: "vip_bet_cap_mult", kind: "number", label: "VIP賭け上限倍率", consumer: c("apps/bot/src/services.ts", 'getNumber("vip_bet_cap_mult")') },
  { key: "confession_body_retention_days", uiKey: "confession_body_retention_days", kind: "number", label: "トート本文の保持日数", consumer: c("apps/bot/src/commands/confession-base.ts", 'getNumber("confession_body_retention_days")') },
  { key: "confession_court_retention_days", uiKey: "confession_court_retention_days", kind: "number", label: "トート送致案件の本文保持日数", consumer: c("apps/bot/src/commands/confession-base.ts", 'getNumber("confession_court_retention_days")') },
  { key: "entry_require_name", uiKey: "entry_require_name", kind: "number", label: "入城に名前の登録を必須にする（1でON・既定0）", validation: "flag", consumer: c("apps/bot/src/commands/entry.ts", 'getNumber("entry_require_name")') },

  // Static operator settings managed by a dedicated flow or by deliberate DB operations.
  { key: "channel:bump", uiKey: "bump", kind: "channel", label: "BUMP観測チャンネル", surface: "manual", consumer: c("apps/bot/src/bump.ts", 'getString("channel:bump")') },
  { key: "channel:shop_purchase_log", uiKey: "shop_purchase_log", kind: "channel", label: "ショップ購入ログ", surface: "manual", consumer: c("apps/bot/src/outbox.ts", 'getString("channel:shop_purchase_log")') },
  { key: "role:swordsman", uiKey: "swordsman", kind: "role", label: "剣士", surface: "manual", consumer: c("apps/bot/src/dens.ts", 'getString("role:swordsman")') },

  { key: "vc_reward_rate_per_10min", uiKey: "vc_reward_rate_per_10min", kind: "number", label: "VC報酬（10分）", surface: "manual", consumer: c("packages/core/src/vc/rewards.ts", 'getNumber("vc_reward_rate_per_10min")') },
  { key: "vc_reward_sleep_rate_per_10min", uiKey: "vc_reward_sleep_rate_per_10min", kind: "number", label: "寝落ちVC報酬（10分）", surface: "manual", consumer: c("packages/core/src/vc/rewards.ts", 'getNumber("vc_reward_sleep_rate_per_10min")') },
  { key: "vc_reward_daily_cap", uiKey: "vc_reward_daily_cap", kind: "number", label: "VC報酬の日次上限", surface: "manual", consumer: c("packages/core/src/vc/rewards.ts", 'getNumber("vc_reward_daily_cap")') },
  { key: "vc_reward_min_session_min", uiKey: "vc_reward_min_session_min", kind: "number", label: "VC報酬の最短session（分）", surface: "manual", consumer: c("packages/core/src/vc/rewards.ts", 'getNumber("vc_reward_min_session_min")') },
  { key: "invite_marks_threshold", uiKey: "invite_marks_threshold", kind: "number", label: "招待印の人数閾値", surface: "manual", consumer: c("packages/core/src/entry/service.ts", 'getNumber("invite_marks_threshold")') },
  { key: "returnee_promotion_extra", uiKey: "returnee_promotion_extra", kind: "number", label: "出戻り昇格印の上乗せ", surface: "manual", consumer: c("packages/core/src/entry/returns.ts", 'getNumber("returnee_promotion_extra")') },
  { key: "room_unused_grace_min", uiKey: "room_unused_grace_min", kind: "number", label: "未使用部屋の削除猶予（分）", surface: "manual", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_unused_grace_min")') },
  { key: "room_normal_max_capacity", uiKey: "room_normal_max_capacity", kind: "number", label: "通常宿の最大定員", surface: "manual", consumer: c("packages/core/src/rooms/service.ts", 'getNumber("room_normal_max_capacity")') },
  { key: "daily_base", uiKey: "daily_base", kind: "number", label: "福分けbase", surface: "manual", consumer: c("apps/bot/src/services.ts", 'getNumber("daily_base")') },
  { key: "daily_relief_threshold", uiKey: "daily_relief_threshold", kind: "number", label: "福分け救済閾値", surface: "manual", consumer: c("apps/bot/src/services.ts", 'getNumber("daily_relief_threshold")') },
  { key: "daily_relief_max", uiKey: "daily_relief_max", kind: "number", label: "福分け救済上限", surface: "manual", consumer: c("apps/bot/src/services.ts", 'getNumber("daily_relief_max")') },
  { key: "casino_daily_loss_limit_bps", uiKey: "casino_daily_loss_limit_bps", kind: "number", label: "賭場日次損失上限（bps）", surface: "manual", consumer: c("apps/bot/src/services.ts", 'getNumber("casino_daily_loss_limit_bps")') },
  { key: "casino_daily_boundary_offset_minutes", uiKey: "casino_daily_boundary_offset_minutes", kind: "number", label: "賭場日次境界offset（分）", surface: "manual", consumer: c("apps/bot/src/services.ts", 'getNumber("casino_daily_boundary_offset_minutes")') },
  { key: "original_role_renew_price", uiKey: "original_role_renew_price", kind: "number", label: "オリジナルロール更新料", surface: "manual", consumer: c("apps/bot/src/commands/original-role.ts", 'getNumber("original_role_renew_price")') },

  { key: "guild:main", uiKey: "guild:main", kind: "string", label: "main guild ID", surface: "manual", consumer: c("apps/bot/src/vc-public-social-tracking.ts", 'getString("guild:main")') },
  { key: "bump_dissoku_bot_id", uiKey: "bump_dissoku_bot_id", kind: "string", label: "ディス速Bot ID", surface: "manual", consumer: c("apps/bot/src/bump.ts", 'getString("bump_dissoku_bot_id")') },
  { key: "entry:session_hours", uiKey: "entry:session_hours", kind: "string", label: "説明会の開始時刻", surface: "dedicated-ui", consumer: c("packages/core/src/entry/sessions.ts", 'SESSION_HOURS_KEY = "entry:session_hours"') },
  { key: "entry:session_skip_dow", uiKey: "entry:session_skip_dow", kind: "string", label: "説明会の休止曜日", surface: "dedicated-ui", consumer: c("packages/core/src/entry/sessions.ts", 'SESSION_SKIP_DOW_KEY = "entry:session_skip_dow"') },
  { key: "shop:original_role_item_id", uiKey: "shop:original_role_item_id", kind: "string", label: "オリジナルロール商品ID", surface: "dedicated-ui", consumer: c("apps/bot/src/commands/original-role.ts", 'getString("shop:original_role_item_id")') },
  { key: "shop:reeval_item_id", uiKey: "shop:reeval_item_id", kind: "string", label: "再評価商品ID", surface: "dedicated-ui", consumer: c("apps/bot/src/commands/reeval.ts", 'REEVAL_ITEM_SETTING_KEY = "shop:reeval_item_id"') },
  { key: "shop:sub_account_item_id", uiKey: "shop:sub_account_item_id", kind: "string", label: "サブアカウント商品ID", surface: "dedicated-ui", consumer: c("apps/bot/src/commands/sub-account.ts", 'getString("shop:sub_account_item_id")') },
  { key: "eval_policy_version", uiKey: "eval_policy_version", kind: "string", label: "評価policy version", surface: "manual", consumer: c("packages/core/src/evaluation/service.ts", 'getString("eval_policy_version")') },

  { key: "vc_sleep_list", uiKey: "vc_sleep_list", kind: "string-list", label: "寝落ちVC一覧", surface: "manual", consumer: c("packages/core/src/vc/rewards.ts", 'getJson<string[]>("vc_sleep_list"') },
  { key: "xp_excluded_channels", uiKey: "xp_excluded_channels", kind: "string-list", label: "XP除外channel/category一覧", surface: "dedicated-ui", consumer: c("apps/bot/src/rank-tracker.ts", 'getJson<string[]>("xp_excluded_channels"') },
  { key: "eval_mark_caps_by_role", uiKey: "eval_mark_caps_by_role", kind: "json", label: "ロール別評価印上限", surface: "dedicated-ui", consumerMode: "display-only", consumer: c("apps/bot/src/commands/admin-hub.ts", 'getJson<Record<string, unknown>>("eval_mark_caps_by_role"') },
  { key: "special_profile_roles", uiKey: "special_profile_roles", kind: "json", label: "特別プロフィールロール", surface: "dedicated-ui", consumer: c("apps/bot/src/special-profile.ts", 'SETTINGS_KEY = "special_profile_roles"') },
  { key: "room_game_tiers", uiKey: "room_game_tiers", kind: "json", label: "ゲーム部屋の人数別料金tier", surface: "manual", consumer: c("packages/core/src/rooms/service.ts", 'getJson<Array<[number, number]>>("room_game_tiers"') },

  { key: "roles:admin", uiKey: "admin", kind: "role-list", label: "管理コマンド利用ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"admin" // /管理') },
  { key: "roles:church_consult", uiKey: "church_consult", kind: "role-list", label: "相談対応ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"church_consult" //') },
  { key: "roles:church_manage", uiKey: "church_manage", kind: "role-list", label: "冥教会管理ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"church_manage" //') },
  { key: "roles:normal_ops", uiKey: "normal_ops", kind: "role-list", label: "通常運営ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"normal_ops" //') },
  { key: "roles:room_normal_free", uiKey: "room_normal_free", kind: "role-list", label: "通常部屋無料特典ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"room_normal_free" //') },
  { key: "roles:casino_pvp_notify", uiKey: "casino_pvp_notify", kind: "role-list", label: "賭場PVP募集通知ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"casino_pvp_notify" //') },
  { key: "roles:court", uiKey: "court", kind: "role-list", label: "冥府裁判所担当ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"court" //') },
  { key: "roles:emergency", uiKey: "emergency", kind: "role-list", label: "緊急対応担当ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"emergency" //') },
  { key: "roles:opinion", uiKey: "opinion", kind: "role-list", label: "意見・改善担当ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"opinion" //') },
  { key: "roles:discipline", uiKey: "discipline", kind: "role-list", label: "規律対応担当ロール", surface: "dedicated-ui", consumer: c("apps/bot/src/church-roles.ts", '"discipline";') },
] as const satisfies readonly OperatorSettingMeta[];

export const INTERNAL_SETTING_KEY_FAMILIES = [
  "payroll:last_period:*",
  "session:notify:*",
  "vc_reward:paid:*",
  "casino:opening:*",
  "panel:*",
  "dept_panel_channel:*",
  "dashboard:message_id",
  "waiters_board:message_id",
  "boost_reward:*",
  "bump:pending:*",
  "charon:notified:*",
  "event72:state",
  "autodrop:pending_role_sync",
] as const;

export const LEGACY_SETTING_KEYS = [
  "shop:original_role_legacy_item_id",
  "shop:sub_account_legacy_item_id",
] as const;

export function operatorSettingsFor(kind: OperatorSettingKind): OperatorSettingMeta[] {
  return OPERATOR_SETTINGS.filter((entry) => entry.kind === kind);
}

export function operatorSettingChoices(kind: OperatorSettingKind): Array<[string, string]> {
  return operatorSettingsFor(kind)
    .filter((entry) => (entry.surface ?? "generic-settings-ui") === "generic-settings-ui")
    .map((entry) => [entry.uiKey, entry.label]);
}

export function operatorSettingForUi(kind: OperatorSettingKind, uiKey: string): OperatorSettingMeta | undefined {
  return operatorSettingsFor(kind).find(
    (entry) =>
      entry.uiKey === uiKey &&
      (entry.surface ?? "generic-settings-ui") === "generic-settings-ui",
  );
}

export function operatorNumberKeysWith(validation: OperatorNumberValidation): Set<string> {
  return new Set(
    operatorSettingsFor("number").filter(
      (entry) =>
        (entry.surface ?? "generic-settings-ui") === "generic-settings-ui" &&
        entry.validation === validation,
    ).map(
      (entry) => entry.key,
    ),
  );
}
