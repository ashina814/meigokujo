import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  RoleSelectMenuInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
  type Client,
  type ForumChannel,
  type GuildMember,
  type Interaction,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import { isAdmin } from "../permissions.js";
import {
  isChurchConsult,
  isChurchManager,
  notifyRoleIdsForDisposition,
  notifyRoleIdsForType,
  getRoleIds,
  roleMention,
} from "../church-roles.js";
import type { Services } from "../services.js";
import {
  CONFESSION_SENDER_REPLY_DEADLINE_DAYS,
  Confessions,
  confessionBall,
  type AckState,
  type DeliveryOutcome,
  type ConfessionRow,
  type ConfessionStage,
  type ConfessionType,
  type Disposition,
  type CloseReason,
  type ReplyWish,
} from "@meigokujo/core";

/**
 * トートの耳（匿名タレコミ／懺悔）。
 *
 * 告発者は完全匿名。トートが仲介して運営↔告発者の会話を中継する。
 * - 告発: パネルのボタン → モーダル → トートが懺悔室chに匿名投稿（受付番号のみ）
 * - 対応: 運営が「対応する」→ トートが運営専用スレッドを作成
 * - 会話: 運営がスレッドに書く → 告発者DMへ転送 / 告発者がDMボタンで返信 → スレッドへ転送
 * - 運営操作: クローズ / ロール付与（匿名のまま）/ 出禁（以後サイレントドロップ）
 *
 * customId 体系: mimi:<action>[:<id>]
 * 秘匿の要: 懺悔室ch・スレッド・DBのどのUIにも告発者IDは一切出さない。
 */

const PANEL_COLOR = 0x4c1d95;

// ─────────────────────────────────────────────────────
// メタ情報（種別・返信希望・状態）の表示定義
// 値はコード（customId で運ぶ）、表示はここで解決する
// ─────────────────────────────────────────────────────
const TYPE_META: Record<ConfessionType, { emoji: string; label: string }> = {
  soudan: { emoji: "🕯️", label: "相談・悩み" },
  zange: { emoji: "🙏", label: "懺悔・気持ちを残す" },
  iken: { emoji: "📮", label: "意見・要望" },
  houkoku: { emoji: "⚠️", label: "問題・規約違反の報告" },
  kinkyu: { emoji: "🚨", label: "緊急の安全問題" },
};
const TYPE_ORDER: ConfessionType[] = ["soudan", "zange", "iken", "houkoku", "kinkyu"];

/**
 * 回答希望（response preference）。
 *
 * これは「この**内容について**運営から回答が必要か」だけを表す。
 * 「トートから何か届いてよいか」ではない——受領確認・会話の終了・追記は、
 * どの選択でも常に使える（Task #219 §1）。保存値 yes/either/no は据え置き、
 * 意味が伝わる文言へ改めただけ。
 */
const WISH_META: Record<ReplyWish, { emoji: string; label: string }> = {
  yes: { emoji: "✅", label: "回答がほしい" },
  either: { emoji: "🤔", label: "必要なら回答してほしい" },
  no: { emoji: "🕊️", label: "回答は不要" },
};
const WISH_ORDER: ReplyWish[] = ["yes", "either", "no"];

/** 緊急選択時に表示する警告（§6）。ファイル添付は今後も設けない方針 */
const EMERGENCY_WARNING = [
  "> 🚨 **緊急の安全問題について**",
  "> 未成年者に関する性的画像・違法コンテンツ・その他の危険な画像や動画を、トートや運営へ **送信・転載しないでください**。",
  "> 元の投稿が Discord 上にある場合は、Discord の通報機能を利用してください。",
  "> トートには、**対象アカウント・発生場所・メッセージリンク・現在も危険が続いているか** を文章で伝えてください。",
].join("\n");

/** 受付番号の表示形（T-0015） */
function recordNo(id: number): string {
  return `T-${String(id).padStart(4, "0")}`;
}

/** Discord の動的タイムスタンプ（閲覧者のローカル時刻で「2026年7月19日 16:11」表示） */
function jstStamp(unixSec: number): string {
  return `<t:${unixSec}:f>`;
}

function typeText(code: string | null): string {
  const m = code ? TYPE_META[code as ConfessionType] : undefined;
  return m ? `${m.emoji} ${m.label}` : "（未選択）";
}
function wishText(code: string | null): string {
  const m = code ? WISH_META[code as ReplyWish] : undefined;
  return m ? `${m.emoji} ${m.label}` : "（未選択）";
}
// ── 状態(stage)・対応先(disposition)・クローズ理由 の表示定義（Phase 2） ──
// 表示定義は既存 stage 値の後方互換のため全て残す。ただし新規案件で書き込まれる stage は
// active / awaiting_poster / awaiting_staff の3種のみ（会話状態は5種類: 未対応/対応中/
// 投稿者からの返信待ち/担当者からの返信待ち/終結）。裁判所送致と緊急共有は別欄で表示する。
const STAGE_META: Record<ConfessionStage, string> = {
  active: "🤝 対応中",
  awaiting_poster: "⏳ 投稿者からの返信待ち",
  awaiting_staff: "📥 担当者からの返信待ち",
  internal_hold: "🛠️ 運営側の確認待ち",
  handoff: "🤝 対応中（旧: 外部引継ぎ中）",
  court_review: "🤝 対応中（旧: 裁判所送致確認中）",
  court_sent: "🤝 対応中（旧: 裁判所送致済み・現在は付帯情報として表示）",
  emergency: "🤝 対応中（旧: 緊急対応中・現在は付帯情報として表示）",
};

const DISPO_META: Record<Disposition, { emoji: string; label: string }> = {
  church: { emoji: "⛪", label: "冥教会で相談継続" },
  normal: { emoji: "🏰", label: "通常運営で対応" },
  // 諧和廷連携は廃止（旧運用）。既存案件の表示互換のため定義は残すが、新規選択肢からは外す
  kaiwa: { emoji: "🤝", label: "諧和廷連携（旧運用・使用停止）" },
  court: { emoji: "⚖️", label: "冥府裁判所への送致を検討" },
  emergency: { emoji: "🚨", label: "緊急対応" },
  record: { emoji: "📁", label: "記録のみ" },
};
// 新規案件で選べる対応先（5種）。kaiwa は廃止したため含めない
const DISPO_ORDER: Disposition[] = ["church", "normal", "court", "emergency", "record"];

// 補助操作（管理者用）の手動変更セレクトで選べる状態。会話状態の5種のみ。
const STAGE_ORDER: ConfessionStage[] = [
  "active",
  "awaiting_poster",
  "awaiting_staff",
  "internal_hold",
];

const CLOSE_META: Record<CloseReason, string> = {
  resolved: "相談が完了した",
  poster_ended: "投稿者が終了を希望した",
  no_response: "投稿者から返答がない",
  handoff_normal: "通常運営へ引き継いだ",
  handoff_kaiwa: "諧和廷へ連携した（旧運用）",
  sent_court: "冥府裁判所へ送致した",
  info_only: "情報提供として記録した",
  no_action: "対応不要と判断した",
  voice_received: "あなたの声は届きました",
  other: "その他",
};
// 新規クローズで選べる理由。旧「対応先=記録のみ」は info_only の終了理由で表現する。
// handoff_kaiwa は廃止済（既存表示用に META は残す）
const CLOSE_ORDER: CloseReason[] = [
  "resolved",
  "poster_ended",
  "no_response",
  "handoff_normal",
  "sent_court",
  "info_only",
  "no_action",
  "other",
];

/**
 * 担当者向けの状態表示。**「次に誰の番か」が一意に読めることが目的**。
 *
 * 「投稿者の返答待ち」は期限つき（＝運営が明示的に待つと決めた）ものだけをそう呼ぶ。
 * 期限のない既存の awaiting_poster は、根拠が無いので運営側の番として出す
 * （勝手に投稿者待ちへ寄せて自動終了させない）。
 */
export function statusText(row: ConfessionRow): string {
  if (row.status === "open") return "🕯️ 未対応";
  if (row.status === "closed") return "✅ 終結";
  const ball = confessionBall(row);
  if (ball === "waiting_sender") return `⏳ 投稿者の返答待ち（<t:${row.reply_deadline_at}:R> に自動終了）`;
  if (ball === "waiting_staff") return "🛠️ 運営側の確認待ち";
  if (ball === "legacy_open") return "📥 要対応（既存案件・期限なし）";
  return STAGE_META[(row.stage as ConfessionStage) ?? "active"] ?? "🤝 対応中";
}
function dispoText(code: string | null): string {
  const m = code ? DISPO_META[code as Disposition] : undefined;
  return m ? `${m.emoji} ${m.label}` : "未設定";
}

const isEmergency = (code: string | null): boolean => code === "kinkyu";

/** 懺悔室に設置するパネル（§3 の推奨文面） */
export function confessionPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("👂 トートの耳")
    .setColor(PANEL_COLOR)
    .setDescription(
      [
        "運営や特定の役職へ、**匿名で** 伝えたいことを届けられる。",
        "告発・相談・懺悔・意見——内容は問わない。",
        "",
        "**投稿者の名前は担当者へ表示されません。**",
        "運営から返信がある場合は、トートがあなたの DM へ匿名で届けます。",
        "",
        "トートだけが、あなたの声を預かります。",
      ].join("\n"),
    )
    .setFooter({ text: "トートだけがあなたの声を預かる" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mimi:new").setLabel("そっと囁く").setEmoji("👂").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/**
 * 種別・返信希望を選ぶエフェメラルUI。
 * 選択状態は「書く」ボタンの customId (`mimi:compose:<type>:<wish>`) に埋め込んで持ち回る
 * ため、サーバ側でセッションを持たずに完結する。type/wish の "-" は未選択。
 */
function selectionMessage(type: string, wish: string) {
  const typeMenu = new StringSelectMenuBuilder()
    .setCustomId("mimi:seltype")
    .setPlaceholder("① 内容の種類を選ぶ")
    .addOptions(
      TYPE_ORDER.map((code) =>
        new StringSelectMenuOptionBuilder()
          .setValue(code)
          .setLabel(TYPE_META[code].label)
          .setEmoji(TYPE_META[code].emoji)
          .setDefault(code === type),
      ),
    );
  const wishMenu = new StringSelectMenuBuilder()
    .setCustomId("mimi:selwish")
    .setPlaceholder("② この内容について、運営からの回答は必要？")
    .addOptions(
      WISH_ORDER.map((code) =>
        new StringSelectMenuOptionBuilder()
          .setValue(code)
          .setLabel(WISH_META[code].label)
          .setEmoji(WISH_META[code].emoji)
          .setDefault(code === wish),
      ),
    );
  const ready = type !== "-" && wish !== "-";
  const composeBtn = new ButtonBuilder()
    .setCustomId(`mimi:compose:${type}:${wish}`)
    .setLabel("書く")
    .setEmoji("✍️")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!ready);

  const lines = [
    "**匿名で届けます。** 種類と回答希望を選んでから「書く」を押してください。",
    `　種類：${typeText(type === "-" ? null : type)}`,
    `　回答希望：${wishText(wish === "-" ? null : wish)}`,
    "",
    "> どれを選んでも、**届いたことのお知らせ**は必ず受け取れます。",
    "> 追記も、やり取りの終了も、いつでもあなたから行えます。",
  ];
  if (isEmergency(type)) lines.push("", EMERGENCY_WARNING);

  return {
    content: lines.join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(wishMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(composeBtn),
    ],
  };
}

/** 現在の「書く」ボタンから選択状態を読み取る（もう一方のセレクト値を保持するため） */
function readSelection(message: { components?: unknown }): { type: string; wish: string } {
  // メッセージの ActionRow を走査して mimi:compose:<type>:<wish> を探す
  const rows = (message.components ?? []) as { components?: { customId?: string }[] }[];
  for (const row of rows) {
    for (const c of row.components ?? []) {
      const cid = c.customId ?? "";
      if (cid.startsWith("mimi:compose:")) {
        const [, , t, w] = cid.split(":");
        return { type: t || "-", wish: w || "-" };
      }
    }
  }
  return { type: "-", wish: "-" };
}

function bodyModal(type: string, wish: string): ModalBuilder {
  const label = isEmergency(type)
    ? "状況（対象・発生場所・リンク・危険継続の有無）"
    : "伝えたいこと（匿名で運営に届きます）";
  const modal = new ModalBuilder().setCustomId(`mimi:body:${type}:${wish}`).setTitle("トートの耳（匿名）");
  const rows: ActionRowBuilder<TextInputBuilder>[] = [];
  if (isEmergency(type)) {
    // 緊急時はモーダル内にも注意書きを（画像等は送らない旨）
    rows.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("notice")
          .setLabel("※ 危険な画像・動画は送らないでください")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue("確認しました")
          .setMaxLength(20),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("text")
        .setLabel(label)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1800),
    ),
  );
  modal.addComponents(...rows);
  return modal;
}

function replyModal(id: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`mimi:replybody:${id}`)
    .setTitle(`トートの耳 #${id} へ追記`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("追記（匿名のまま運営に届きます）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800),
      ),
    );
}

/**
 * 「対応する」を押せる資格（案件の入口）。§8 の分離後は相談対応ロール（シスター・修道士）・
 * 冥教会管理ロール（大司教）・管理者。新設定が未投入の間は church_consult が ticket_staff へ
 * フォールバックする（church-roles 側で解決）。
 */
function isConfessionStaff(interaction: ButtonInteraction | RoleSelectMenuInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const member = interaction.member as GuildMember | null;
  return isChurchManager(member, services) || isChurchConsult(member, services);
}

/**
 * 案件の操作・閲覧が許されるか。
 * 「新着通知でメンションされただけ」では不可。以下のみ:
 * - 管理者
 * - 主担当（claimed_by）
 * - 案件へ正式に追加された担当者
 * - 大司祭（冥教会管理ロール）は、相談・懺悔の案件のみ自動で監督できる。
 *   意見・報告・緊急・裁判所案件などは「支援を求める」から相談要請が入って共同担当に
 *   追加された場合のみアクセスできる（役職を持っているだけでは閲覧できない）。
 */
function canOperate(interaction: Interaction, services: Services, id: number): boolean {
  if (isAdmin(interaction, services)) return true;
  const row = services.confessions.get(id);
  if (!row) return false;
  // 主担当(claimed_by) は常に可（Phase 2 以前に claim され assignees 未登録の旧案件も救済）
  if (row.claimed_by === interaction.user.id) return true;
  if (services.confessions.isAssignee(id, interaction.user.id)) return true;
  // 大司祭の自動監督範囲は「相談・懺悔」のみに限定
  if (
    isChurchManager(interaction.member as GuildMember | null, services) &&
    (row.type === "soudan" || row.type === "zange")
  ) {
    return true;
  }
  return false;
}

/** 本文の表示。purge済みなら削除された旨を出す（§Phase2-5） */
function bodyOrPurgeNotice(row: ConfessionRow): string {
  if (row.body_purged_at) {
    return "## 届いた声\n> この案件の本文は、保存期間の経過または管理者操作により削除されています。";
  }
  return `## 届いた声\n${(row.body ?? "（本文の記録なし）").slice(0, 3800)}`;
}

/**
 * 対応スレッドの管理パネル embed。担当者IDのみ表示し、投稿者IDは出さない。
 * 「対応先」欄は廃止済のため、既存案件で値がある場合だけ「旧設定」として表示する。
 * 裁判所送致・緊急共有は会話状態ではなく付帯情報として別欄で示す。
 */
function buildCaseEmbed(
  row: ConfessionRow,
  assigneeIds: string[],
  extras: { hasOpenEmergency?: boolean; ackState?: AckState; unrelayedFollowUps?: number } = {},
): EmbedBuilder {
  const color =
    row.type === "kinkyu" || extras.hasOpenEmergency
      ? 0xdc2626
      : row.status === "closed"
        ? 0x6b7280
        : PANEL_COLOR;
  const staff = assigneeIds.length > 0 ? assigneeIds.map((u) => `<@${u}>`).join("・") : row.claimed_by ? `<@${row.claimed_by}>` : "—";
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`👂 トートの耳 ${recordNo(row.id)}`)
    .addFields(
      { name: "種別", value: typeText(row.type), inline: true },
      { name: "回答希望", value: wishText(row.reply_wish), inline: true },
      { name: "状態", value: statusText(row), inline: true },
      { name: "担当者", value: staff, inline: true },
      { name: "受付日時", value: jstStamp(row.created_at), inline: true },
    );
  const ackValue: Record<AckState, string> = {
    none: "— 未送信",
    in_flight: "📨 送信中",
    delivered: row.acknowledged_at
      ? `📨 届きました（${jstStamp(row.acknowledged_at)}${row.acknowledged_by ? ` / <@${row.acknowledged_by}>` : ""}）`
      : "📨 届きました",
    failed: "⚠️ 届きませんでした（未送達）",
    unknown: "❓ 送信結果を確認できず",
  };
  embed.addFields({ name: "受領確認", value: ackValue[extras.ackState ?? "none"], inline: true });
  if (extras.unrelayedFollowUps && extras.unrelayedFollowUps > 0) {
    embed.addFields({
      name: "未引き渡しの追記",
      value: `⚠️ ${extras.unrelayedFollowUps}件。投稿者からは受け取れていますが、このスレッドへ渡せていません。`,
      inline: true,
    });
  }
  if (extras.hasOpenEmergency) {
    embed.addFields({ name: "緊急共有", value: "🚨 登録あり（別ロールへ確認要請中）", inline: true });
  }
  // 旧「対応先」は新規UIから廃止。既存案件で値が残っているものだけ「旧設定」として可視化する。
  if (row.disposition) {
    embed.addFields({ name: "対応先（旧設定）", value: dispoText(row.disposition), inline: true });
  }
  // 送致済みなら送致先を出す
  if (row.court_case_no || row.court_url || row.court_thread_id) {
    const link = row.court_url ?? (row.court_thread_id ? `<#${row.court_thread_id}>` : "—");
    embed.addFields({
      name: "冥府裁判所",
      value: [
        row.court_case_no ? `事件番号：**${row.court_case_no}**` : "事件番号：（未登録）",
        `事件リンク：${link}`,
        row.court_sent_at ? `送致：${jstStamp(row.court_sent_at)}${row.court_sent_by ? ` / <@${row.court_sent_by}>` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      inline: false,
    });
  }
  if (row.status === "closed" && row.close_reason) {
    embed.addFields({ name: "終了理由", value: CLOSE_META[row.close_reason as CloseReason] ?? row.close_reason, inline: false });
  }
  embed.setDescription(bodyOrPurgeNotice(row));
  return embed;
}

/**
 * 管理パネルの操作ボタン。
 *
 * 通常担当者向けは 5操作へ絞る（§整理後の管理パネル案）:
 *   [Row1] 👥 担当管理 / 🆘 支援を求める / ⚖️ 裁判所へ送致
 *   [Row2] 🚨 緊急共有 / 🔒 クローズ
 * 管理者用（権限がない者には表示しない）:
 *   [Row3] 🛠️ 補助操作 / 📅 保持延長 / 🗑️ 本文を削除
 *
 * 状態変更セレクトは通常担当者に常設しない（会話状態は自動更新）。管理者は補助操作から手動変更できる。
 */
function managementControls(
  id: number,
  row: ConfessionRow,
  ackState: AckState = row.acknowledged_at ? "delivered" : "none",
): ActionRowBuilder<ButtonBuilder>[] {
  if (row.status === "closed") {
    // クローズ済み案件: 再オープン中心。本文が残っていれば管理者用の保持延長・削除を並置。
    const btns = [
      new ButtonBuilder().setCustomId(`mimi:reopen:${id}`).setLabel("再オープン").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
    ];
    if (row.body && !row.body_purged_at) {
      btns.push(
        new ButtonBuilder().setCustomId(`mimi:extend:${id}`).setLabel("保持延長").setEmoji("📅").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mimi:purgenow:${id}`).setLabel("本文を削除").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
      );
    }
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...btns)];
  }

  // 送致状況で裁判所ボタンの意味を切り替える
  let courtBtn: ButtonBuilder;
  if (row.court_status === "sent") {
    courtBtn = new ButtonBuilder().setCustomId(`mimi:courtcaseno:${id}`).setLabel("事件番号").setEmoji("⚖️").setStyle(ButtonStyle.Success);
  } else if (row.court_status === "pending_consent") {
    courtBtn = new ButtonBuilder().setCustomId(`mimi:courtcancel:${id}`).setLabel("送致を取消").setEmoji("⚖️").setStyle(ButtonStyle.Secondary);
  } else {
    courtBtn = new ButtonBuilder().setCustomId(`mimi:court:${id}`).setLabel("裁判所へ送致").setEmoji("⚖️").setStyle(ButtonStyle.Secondary);
  }

  // Row1 は**会話**の操作だけ。受領・回答・終了を1列で見分けられるようにする（§9）。
  // 「送信済み」と読める形にしてよいのは、投稿者へ**届いたと確認できた**ときだけ。
  const ackLabel: Record<AckState, string> = {
    none: "届きました",
    in_flight: "送信中…",
    delivered: "届きました（送信済み）",
    failed: "届きました（未達・再送）",
    unknown: "届きました（結果不明）",
  };
  const ackBtn = new ButtonBuilder()
    .setCustomId(`mimi:ack:${id}`)
    .setLabel(ackLabel[ackState])
    .setEmoji("📨")
    .setStyle(ackState === "delivered" ? ButtonStyle.Success : ackState === "none" ? ButtonStyle.Success : ButtonStyle.Danger)
    .setDisabled(ackState === "delivered" || ackState === "in_flight");
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ackBtn,
    new ButtonBuilder().setCustomId(`mimi:replystaff:${id}`).setLabel("返信する").setEmoji("💬").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mimi:hold:${id}`)
      .setLabel("待機")
      .setEmoji("⏳")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(row.stage === "internal_hold"),
    new ButtonBuilder().setCustomId(`mimi:close:${id}`).setLabel("終了").setEmoji("✅").setStyle(ButtonStyle.Secondary),
  );
  // Row2 は案件そのものの取り回し（既存機能はそのまま）
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mimi:assign:${id}`).setLabel("担当管理").setEmoji("👥").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mimi:support:${id}`).setLabel("支援を求める").setEmoji("🆘").setStyle(ButtonStyle.Secondary),
    courtBtn,
    new ButtonBuilder().setCustomId(`mimi:emg:${id}`).setLabel("緊急共有").setEmoji("🚨").setStyle(ButtonStyle.Danger),
  );
  // 管理者用は「補助操作」に集約し、通常UIから隠す（実際の権限判定は各ハンドラで再確認）
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mimi:admin:${id}`).setLabel("補助操作").setEmoji("🛠️").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2, row3];
}

/** スレッドの管理パネル（panel_msg_id）を現状で描き直す */
async function refreshPanel(client: Client, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row?.thread_id || !row.panel_msg_id) return;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.isThread()) return;
  const msg = await thread.messages.fetch(row.panel_msg_id).catch(() => null);
  if (!msg) return;
  const ackState = services.confessions.ackState(id);
  await msg
    .edit({
      embeds: [
        buildCaseEmbed(row, services.confessions.assignees(id), {
          hasOpenEmergency: !!services.confessions.openEmergencyFor(id),
          ackState,
          unrelayedFollowUps: services.confessions.listUnrelayedFollowUps(id).length,
        }),
      ],
      components: managementControls(id, row, ackState),
    })
    .catch(() => undefined);
}

/** スレッドへ操作ログ行を残す（人間可読。EventLog とは別に、その場で見えるように） */
async function threadLog(client: Client, services: Services, id: number, line: string): Promise<void> {
  const row = services.confessions.get(id);
  if (!row?.thread_id) return;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (thread?.isThread()) await thread.send({ content: line, allowedMentions: { parse: [] } }).catch(() => undefined);
}

/**
 * 引継ぎ・呼び出しの「見出しだけ」を通知するチャンネルへ、本文を含めずに掲示する（§5/§7）。
 * 通知されたロールへ自動で案件閲覧権は与えない。閲覧・対応するには正式な担当追加が必要。
 * 掲示先は channel:handoff_notify、無ければ channel:confession。どちらも無ければ掲示しない。
 * @returns 通知したロール数（0=未通知）
 */
async function postHandoffNotice(
  client: Client,
  services: Services,
  id: number,
  opts: { title: string; roleIds: string[]; note?: string; color?: number },
): Promise<number> {
  if (opts.roleIds.length === 0) return 0;
  const chId = services.settings.getString("channel:handoff_notify") ?? services.settings.getString("channel:confession");
  if (!chId) return 0;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch?.isTextBased() || !("send" in ch)) return 0;
  const row = services.confessions.get(id);
  const embed = new EmbedBuilder()
    .setColor(opts.color ?? PANEL_COLOR)
    .setTitle(opts.title)
    .setDescription(
      [
        `案件：**${recordNo(id)}**`,
        opts.note ?? "",
        row?.thread_id ? `対応スレッド：<#${row.thread_id}>（閲覧には正式な担当追加が必要です）` : "",
        "> ※ 相談本文は含まれていません。通知されただけでは案件を閲覧できません。",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  const mention = roleMention(opts.roleIds);
  await ch
    .send({ content: mention.content, embeds: [embed], allowedMentions: { roles: mention.roleIds } })
    .catch(() => undefined);
  return opts.roleIds.length;
}

/** 対応先変更の通知（§7）。record は通知なし。通知内容は EventLog にも記録する */
async function notifyDispositionChange(
  client: Client,
  services: Services,
  id: number,
  disp: Disposition,
  actorId: string,
): Promise<number> {
  const roleIds = notifyRoleIdsForDisposition(services, disp);
  if (roleIds.length === 0) return 0;
  const label = DISPO_META[disp]?.label ?? disp;
  const n = await postHandoffNotice(client, services, id, {
    title: `📍 対応先の変更：${label}`,
    roleIds,
    note: `<@${actorId}> が対応先を「${label}」へ変更しました。`,
    color: disp === "emergency" ? 0xdc2626 : PANEL_COLOR,
  });
  services.events.log("confession_disposition_notify", {
    actor: actorId,
    payload: { id, disposition: disp, roleIds, notified: n },
  });
  await threadLog(client, services, id, `📣 対応先「${label}」の担当ロール（${n}件）へ通知しました。`);
  return n;
}

// ═════════════════════════════════════════════════════
// 会話の終端（Task #219）
//
// 受領確認 / 内容への回答 / 会話の終了 を、UI の上でも別々のものとして扱う。
// 投稿者へ出す文面は**すべてこの1つの renderer** から作る（回答希望ごとに
// 別ロジックを乱立させない）。
//
// 外部送信は「押した」「送り始めた」「届いた」「届かなかった」「分からなかった」を
// **混同しない**。Discord に真の exactly-once は無いので、無い保証を装わず、
// 分からないものは分からないまま担当者へ返す。
// ═════════════════════════════════════════════════════

/** 投稿者向けの見出し。内部語（case/close/resolve）は一切出さない */
const SENDER_TITLE = "🕯️ トートの耳";

/**
 * 受領確認の文面。共通の1行＋回答希望ごとの一言だけが違う。
 * 未選択(null)は「回答不要」と同じ扱いにはしない——控えめな汎用文にする。
 */
const ACK_TAIL: Record<string, string> = {
  yes: "運営からの回答をお待ちください。",
  either: "必要に応じて運営からお返事します。",
  no: "ありがとうございます。",
};
function ackText(wish: string | null): string {
  return `あなたの声は届きました。${ACK_TAIL[wish ?? ""] ?? "必要に応じて運営からお返事します。"}`;
}

/**
 * Discord が返してきたものを「届かなかった」と「分からなかった」に分ける。
 *
 * `DiscordAPIError` は**サーバからの確定応答**（DMを開いていない・相手がいない等）なので、
 * 届いていないと言い切れる＝安全に再送できる。それ以外（接続断・timeout・中断）は
 * 送れたかどうかが分からない——ここを failed と混ぜると、届いている本文をもう一度
 * 送ってしまう。
 */
function classifyDeliveryError(error: unknown): "failed" | "unknown" {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? "failed" : "unknown";
}

/**
 * 投稿者が自分で操作できる導線。**やり取りが続いている間は常に付ける。**
 * 「終了」が履歴の削除だと誤解されないよう、確認画面で必ず明示する。
 */
function senderControls(id: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mimi:reply:${id}`).setLabel("追記する").setEmoji("✏️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`mimi:senderclose:${id}`)
        .setLabel("もう大丈夫です")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

type SenderNotice =
  | { kind: "received"; wish: string | null }
  | { kind: "acknowledged"; wish: string | null }
  | { kind: "reply"; body: string; waiting: boolean; deadlineAt: number | null }
  | { kind: "closed_by_staff"; body: string }
  | { kind: "closed_by_sender" }
  | { kind: "closed_by_timeout" };

/**
 * 投稿者へ届く1通を組み立てる唯一の場所。
 *
 * `allowedMentions` は常に空。自由文に @everyone / ロール / ユーザー宛てが混じっていても、
 * それが誰かを呼び出すことはない（本文は embed に入れるが、二重の安全策として明示する）。
 */
function senderDm(id: number, notice: SenderNotice): MessageCreateOptions {
  const embed = new EmbedBuilder().setColor(PANEL_COLOR).setAuthor({ name: `${SENDER_TITLE} #${id}` });
  const open = notice.kind === "received" || notice.kind === "acknowledged" || notice.kind === "reply";

  switch (notice.kind) {
    case "received":
      embed.setDescription(
        [
          "**あなたの声を預かりました。**",
          "",
          // 「回答は不要」を選んだ人にも、例外があることを最初から隠さない。
          // 隠すと、安全上どうしても連絡が要ったときに約束を破ったことになる。
          notice.wish === "no"
            ? "回答不要として受け付けました。原則として内容へのお返事はしません。ただし、安全上・運営上どうしても必要な連絡がある場合にかぎり、トートからお知らせすることがあります。"
            : notice.wish === "yes"
              ? "運営が確認しだい、この DM へ回答が届きます。"
              : "必要があれば、運営からこの DM へお返事が届きます。",
          "",
          "伝え忘れたことは **追記する** から足せます。",
          "もう十分だと思ったら、いつでも **もう大丈夫です** でこのやり取りを終えられます。",
        ].join("\n"),
      );
      break;
    case "acknowledged":
      embed.setDescription(
        [`**${ackText(notice.wish)}**`, "", "追記も、やり取りの終了も、引き続きあなたから行えます。"].join("\n"),
      );
      break;
    case "reply":
      embed.setDescription(notice.body.slice(0, 3500));
      embed.addFields({
        name: "​",
        value: notice.waiting
          ? [
              "**必要なら追記できます。もう大丈夫であれば、このやり取りを終了できます。**",
              notice.deadlineAt
                ? `返信がない場合、このやり取りは <t:${notice.deadlineAt}:R>（${CONFESSION_SENDER_REPLY_DEADLINE_DAYS}日後）に自動で終了します。急ぐ必要はありません。`
                : "",
            ]
              .filter(Boolean)
              .join("\n")
          : "**このやり取りはここで終了しました。**\nまた伝えたいことがあれば、新しくトートへ送れます。",
      });
      break;
    case "closed_by_staff":
      embed.setDescription(notice.body.slice(0, 3500));
      embed.addFields({
        name: "​",
        value: "**このやり取りはここで終了しました。**\nまた伝えたいことがあれば、新しくトートへ送れます。",
      });
      break;
    case "closed_by_sender":
      embed.setDescription(
        [
          "**このやり取りを終了しました。**",
          "",
          "話してくれてありがとう。",
          "また伝えたいことがあれば、いつでも新しくトートへ送れます。",
        ].join("\n"),
      );
      break;
    case "closed_by_timeout":
      embed.setDescription(
        [
          "**一定期間返信がなかったため、このやり取りはいったん終了しました。**",
          "",
          "何かを断ったわけでも、拒否されたわけでもありません。",
          "必要になった場合は、いつでも新しくトートへ送れます。",
        ].join("\n"),
      );
      break;
  }

  return {
    embeds: [embed],
    components: open ? senderControls(id) : [],
    allowedMentions: { parse: [] },
  };
}

/** 投稿者へ1通届ける。結末を3値で返す——boolean にすると unknown が失敗へ潰れる。 */
async function sendSenderDm(
  client: Client,
  userId: string,
  message: MessageCreateOptions,
): Promise<DeliveryOutcome> {
  const user = await client.users.fetch(userId).catch((error: unknown) => {
    // 「そんなユーザーはいない」は確定応答、接続の問題は不明。
    throw Object.assign(new Error("fetch failed"), { code: (error as { code?: unknown })?.code });
  }).catch((error: unknown) => error as Error);
  if (user instanceof Error) return classifyDeliveryError(user);
  try {
    await user.send(message);
    return "delivered";
  } catch (error) {
    return classifyDeliveryError(error);
  }
}

/** 運営スレッドへ1通届ける。こちらも結末を3値で返す。 */
async function sendThreadMessage(
  client: Client,
  threadId: string | null,
  message: MessageCreateOptions,
): Promise<DeliveryOutcome> {
  if (!threadId) return "failed";
  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.isThread()) return "failed";
    await thread.send(message);
    return "delivered";
  } catch (error) {
    return classifyDeliveryError(error);
  }
}

/** 終了時に使う本文保持日数（既存の運用設定をそのまま使う） */
function retentionDaysFor(services: Services, row: ConfessionRow): number | undefined {
  return row.court_status === "sent"
    ? services.settings.getNumber("confession_court_retention_days")
    : services.settings.getNumber("confession_body_retention_days");
}

// ── 📨 受領確認 ───────────────────────────────────────
/**
 * 「運営がこの声を受け取った」だけを伝える。
 * 回答したことにも、終了したことにもしない——状態は一切動かさない。
 *
 * **「送信済み」と表示してよいのは、届いたと確認できたときだけ。**
 * 明確な失敗はやり直せるようにし、結果が分からなかった場合は
 * 勝手に送り直さず、担当者に判断を委ねる。
 */
async function acknowledgeCase(
  interaction: ButtonInteraction,
  services: Services,
  id: number,
  opts: { retryUnknown?: boolean } = {},
): Promise<void> {
  const state = services.confessions.ackState(id);
  // 前回の結果が不明なまま黙って送り直すと、届いている DM をもう1通重ねてしまう。
  if (state === "unknown" && opts.retryUnknown !== true) {
    await interaction.reply({
      content: [
        "⚠️ **前回の送信結果を確認できませんでした。**",
        "既に投稿者へ届いている可能性があります（届いていない可能性もあります）。",
        "",
        "もう一度送ると、二重に届くことがあります。それでも送りますか？",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`mimi:ackretry:${id}`)
            .setLabel("それでももう一度送る")
            .setEmoji("📨")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const begun = services.confessions.beginAcknowledgement(id, interaction.user.id);
  if (!begun.ok) {
    await interaction.editReply({
      content:
        begun.code === "already_delivered"
          ? "📨 この案件へは既に受領確認が届いています（重ねては送りません）。"
          : begun.code === "attempt_in_flight"
            ? "📨 いま別の送信が進行中です。結果が出るまでお待ちください。"
            : begun.code === "already_closed"
              ? "この会話は既に終了しています。"
              : "この件が見つかりません。",
    });
    return;
  }

  const outcome = await sendSenderDm(
    interaction.client,
    begun.row.user_id,
    senderDm(id, { kind: "acknowledged", wish: begun.row.reply_wish }),
  );
  services.confessions.settleAcknowledgement(begun.attemptId, outcome, interaction.user.id);

  const note =
    outcome === "delivered"
      ? `📨 <@${interaction.user.id}> が受領確認を送り、投稿者へ届きました（回答・終了はしていません）。`
      : outcome === "failed"
        ? `⚠️ <@${interaction.user.id}> の受領確認を投稿者へ届けられませんでした（DM 拒否の可能性）。まだ「届きました」とは伝わっていません。`
        : `❓ <@${interaction.user.id}> の受領確認は、送信結果を確認できませんでした。届いたかどうか分かりません。`;
  await threadLog(interaction.client, services, id, note);
  await refreshPanel(interaction.client, services, id);
  await interaction.editReply({
    content:
      outcome === "delivered"
        ? "📨 「あなたの声は届きました」と伝えました。案件は開いたままです。"
        : outcome === "failed"
          ? "⚠️ 投稿者へ届けられませんでした（DM 拒否の可能性）。**まだ受領確認は伝わっていません。** もう一度 📨 を押すとやり直せます。"
          : "❓ 送信結果を確認できませんでした。届いたかどうか分かりません。もう一度送る場合は 📨 を押してください（重複の確認を挟みます）。",
  });
}

// ── ⏳ 待機（運営側の確認待ち）───────────────────────────
/**
 * 「運営側でまだやることがある」を明示する。投稿者待ちへ逃がさないので、
 * 7日の自動終了には**絶対にかからない**。
 */
async function holdCase(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const result = services.confessions.setInternalHold(id, interaction.user.id);
  if (!result.ok) {
    await interaction.reply({ content: "この会話は既に終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }
  await threadLog(interaction.client, services, id, `⏳ <@${interaction.user.id}> が「運営側の確認待ち」にしました（自動終了しません）。`);
  await refreshPanel(interaction.client, services, id);
  await interaction.reply({
    content: "⏳ 運営側の確認待ちにしました。要対応の一覧からは下がりますが、自動では終了しません。",
    flags: MessageFlags.Ephemeral,
  });
}

// ── 💬 自由返信（投稿者へ外部返信する唯一の経路）─────────
function staffReplyModal(id: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`mimi:staffreplybody:${id}`)
    .setTitle(`${recordNo(id)} へ返信`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("投稿者へ届く本文（匿名のまま届きます）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800),
      ),
    );
}

/**
 * 「返信する」の入口。
 *
 * 回答不要を選んでいる相手には、hard block ではなく**明示の確認**を挟む
 * （重要な連絡が必要なことはある）。確認を通しても `reply_wish` は書き換えない。
 */
async function startStaffReply(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.reply({ content: "この件が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.status === "closed") {
    await interaction.reply({ content: "この会話は既に終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.reply_wish === "no") {
    await interaction.reply({
      content: [
        "🕊️ **この方は「回答は不要」を選択しています。**",
        "",
        "それでも内容について返信しますか？",
        "（受領確認だけを伝えたい場合は 📨 届きました をお使いください）",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`mimi:replyno:${id}`)
            .setLabel("それでも返信する")
            .setEmoji("💬")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.showModal(staffReplyModal(id));
}

/**
 * 本文を書いただけでは送らない。**「返答を待つ」か「この返信で終了する」かを必ず選ばせる。**
 * 暗黙の open も暗黙の close も作らない（§3-A）。
 */
async function stageStaffReply(interaction: ModalSubmitInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row || row.status === "closed") {
    await interaction.reply({ content: "この会話は既に終了しています。返信は送っていません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const body = interaction.fields.getTextInputValue("text").trim();
  if (!body) {
    await interaction.reply({ content: "本文が空です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const draft = services.confessions.createReplyDraft(id, interaction.user.id, body, retentionDaysFor(services, row));
  const overrode = row.reply_wish === "no";
  await interaction.reply({
    content: [
      `💬 **${recordNo(id)} への返信内容を預かりました。まだ送っていません。**`,
      overrode ? "（この方は「回答は不要」を選んでいます。回答希望の記録は変更しません）" : "",
      "",
      "この返信のあと、どうしますか？",
      `・**返答を待つ** … 投稿者へ届け、返答を待ちます（${CONFESSION_SENDER_REPLY_DEADLINE_DAYS}日返信が無ければ自動で終了します）`,
      "・**この返信で終了する** … 投稿者へ届けたうえで、このやり取りを終えます",
    ]
      .filter(Boolean)
      .join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mimi:replywait:${draft.id}`)
          .setLabel("返答を待つ")
          .setEmoji("⏳")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`mimi:replyend:${draft.id}`)
          .setLabel("この返信で終了する")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * 預かった返信を実際に送る。
 *
 * 送信権は下書き行の消費で1つに絞られるので、二度押しでも本文は1回しか届かない。
 * **届いたと確認できたときだけ**案件の状態を進める。さらに、その状態遷移自体も
 * 条件付き——送信中に投稿者が会話を終えていた場合、その終了が正本であって、
 * あとから届いた確定がそれを塗り替えることはない。
 */
async function commitStaffReply(
  interaction: ButtonInteraction,
  services: Services,
  draftId: number,
  intent: "wait" | "close",
): Promise<void> {
  const pending = services.confessions.getReplyDraft(draftId);
  if (!pending) {
    await interaction.reply({ content: "この返信の下書きが見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canOperate(interaction, services, pending.confession_id)) {
    await interaction.reply({ content: "この案件の担当者、または管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const claim = services.confessions.claimReplyDraft(draftId, interaction.user.id, intent);
  if (!claim.ok) {
    await interaction.editReply({
      content:
        claim.code === "already_consumed"
          ? "この返信は既に送信済みです（重ねては送りません）。"
          : claim.code === "case_closed"
            ? "この会話は既に終了しています。返信は送っていません。再開する場合は 🔓 再オープン を使ってください。"
            : claim.code === "not_owner"
              ? "この返信を書いた担当者だけが送信できます。"
              : "この返信の下書きが見つかりません。",
    });
    return;
  }

  const id = claim.row.id;
  const closing = intent === "close";
  const deadlineAt = closing ? null : Confessions.senderReplyDeadlineFrom(Math.floor(Date.now() / 1000));
  const body = claim.draft.body ?? "";
  const outcome = await sendSenderDm(
    interaction.client,
    claim.row.user_id,
    closing
      ? senderDm(id, { kind: "closed_by_staff", body })
      : senderDm(id, { kind: "reply", body, waiting: true, deadlineAt }),
  );
  services.confessions.finishReplyDraft(draftId, outcome);

  if (outcome !== "delivered") {
    // 届いたか分からないものを「返信した」ことにしない。状態は動かさず、担当者へ返す。
    await threadLog(
      interaction.client,
      services,
      id,
      outcome === "failed"
        ? `⚠️ <@${interaction.user.id}> の返信を投稿者へ届けられませんでした。案件の状態は変えていません。`
        : `❓ <@${interaction.user.id}> の返信は、送信結果を確認できませんでした。案件の状態は変えていません。`,
    );
    await refreshPanel(interaction.client, services, id);
    await interaction.editReply({
      content:
        outcome === "failed"
          ? "⚠️ 投稿者へ DM を届けられませんでした（DM 拒否の可能性）。状態は変えていません。もう一度 💬 返信する からやり直せます。"
          : "❓ 送信結果を確認できませんでした。届いたかどうか分かりません。状態は変えていません。同じ内容を送り直すと二重に届く可能性があります。",
    });
    return;
  }

  // ここから先は「届いた」あと。送信中に投稿者が終えていたら、その終了が正本。
  const settled = closing
    ? services.confessions.close(id, interaction.user.id, "resolved", retentionDaysFor(services, claim.row), "staff")
    : services.confessions.applyStaffReplyWaiting(id, interaction.user.id);

  if (!settled.ok) {
    const after = services.confessions.get(id);
    await threadLog(
      interaction.client,
      services,
      id,
      `⚠️ <@${interaction.user.id}> の返信は投稿者へ届きましたが、送信中に${
        after?.closed_side === "sender" ? "投稿者が" : after?.closed_side === "timeout" ? "期限で" : ""
      }このやり取りが終了していました。終了はそのまま維持しています。`,
    );
    await refreshPanel(interaction.client, services, id);
    await interaction.editReply({
      content: [
        "⚠️ **返信は投稿者へ届きましたが、送信中にこのやり取りは終了していました。**",
        after?.closed_side === "sender"
          ? "投稿者が「もう大丈夫です」で終了しています。その終了を維持しました。"
          : after?.closed_side === "timeout"
            ? "返答期限が過ぎて自動終了しています。その終了を維持しました。"
            : "先に成立していた終了を維持しました。",
        "続ける必要がある場合は 🔓 再オープン を使ってください。",
      ].join("\n"),
    });
    return;
  }

  if (closing) {
    const openEmg = services.confessions.openEmergencyFor(id);
    if (openEmg) services.confessions.closeEmergency(openEmg.id, interaction.user.id);
  }

  await threadLog(
    interaction.client,
    services,
    id,
    closing
      ? `✅ <@${interaction.user.id}> が返信を届けたうえで、このやり取りを終了しました。`
      : `💬 <@${interaction.user.id}> が返信を届け、投稿者の返答を待っています（<t:${deadlineAt}:R> に自動終了）。`,
  );
  await refreshPanel(interaction.client, services, id);
  await interaction.editReply({
    content: closing
      ? "✅ 返信を届けて、このやり取りを終了しました。"
      : `💬 返信を届けました。投稿者の返答待ちです（返答が無ければ <t:${deadlineAt}:R> に自動終了）。`,
  });

  if (closing) {
    const thread = claim.row.thread_id
      ? await interaction.client.channels.fetch(claim.row.thread_id).catch(() => null)
      : null;
    if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
  }
}

// ── ✏️ 投稿者の追記 ────────────────────────────────────
/** 運営スレッドへ出す追記の見た目（初回も再試行も同じものを使う） */
function followUpRelayMessage(body: string): MessageCreateOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x0ea5e9)
        .setAuthor({ name: "🗣 投稿者より（匿名・追記）" })
        .setDescription(body.slice(0, 4000))
        .setTimestamp(new Date()),
    ],
    allowedMentions: { parse: [] },
  };
}

/**
 * 投稿者の追記を受け取る。
 *
 * **本文の確定と期限の解除は Discord へ触る前に済ませる。** 中継が落ちても本文は
 * 消えず、期限で勝手に閉じられもしない。そして届いたと確認できるまで
 * 「運営に届けました」とは言わない——匿名相談で、届いていない本文を届いたと
 * 伝えるのがいちばんやってはいけないこと。
 */
async function submitSenderFollowUp(
  interaction: ModalSubmitInteraction,
  services: Services,
  id: number,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const row = services.confessions.get(id);
  if (!row || row.status === "closed" || row.user_id !== interaction.user.id) {
    await interaction.editReply({
      content: "このやり取りは既に終了しているか、追記できません。伝えたいことがあれば、トートの耳から新しく送ってください。",
    });
    return;
  }
  const text = interaction.fields.getTextInputValue("text").trim();
  if (!text) {
    await interaction.editReply({ content: "本文が空です。" });
    return;
  }

  const accepted = services.confessions.recordSenderFollowUp(id, interaction.user.id, text, retentionDaysFor(services, row));
  if (!accepted.ok) {
    await interaction.editReply({
      content: "このやり取りは既に終了しています。伝えたいことがあれば、トートの耳から新しく送ってください。",
    });
    return;
  }

  const outcome = await sendThreadMessage(interaction.client, row.thread_id, followUpRelayMessage(text));
  services.confessions.settleFollowUpRelay(accepted.followUpId, outcome);
  await refreshPanel(interaction.client, services, id);

  if (outcome === "delivered") {
    await interaction.editReply({ content: "✏️ 運営に届けました。自動終了の予定は解除されています。" });
    return;
  }
  // **届いていないものを「届けました」と言わない。**
  await interaction.editReply({
    content: [
      "✏️ **あなたの追記は確かに預かりました。**",
      outcome === "failed"
        ? "ただ、いま運営へ渡すことができませんでした。トートが引き続き渡そうとします（同じ内容が二重に渡ることはありません）。"
        : "ただ、運営へ渡せたかどうかを確認できませんでした。担当者側にも未確認として表示されます。",
      "",
      "内容は失われていません。自動終了の予定も解除されています。",
    ].join("\n"),
  });
}

/**
 * 明確に失敗した追記だけを、刻時盤から拾い直して運営へ渡す。
 *
 * `unknown`（送れたか分からない）は入れない——届いている可能性のある本文を
 * 勝手にもう一度送ると、匿名の相談が二重に運営へ流れる。
 */
export async function retryPendingFollowUps(client: Client, services: Services): Promise<number> {
  const pending = services.confessions.listRetryableFollowUps();
  let relayed = 0;
  for (const item of pending) {
    const claimed = services.confessions.claimFollowUpRetry(item.id);
    if (!claimed?.body) continue;
    const row = services.confessions.get(claimed.confession_id);
    const outcome = await sendThreadMessage(client, row?.thread_id ?? null, followUpRelayMessage(claimed.body));
    services.confessions.settleFollowUpRelay(claimed.id, outcome);
    if (outcome === "delivered") {
      relayed += 1;
      await refreshPanel(client, services, claimed.confession_id);
    }
  }
  return relayed;
}

// ── ✅ 投稿者自身の終了 ────────────────────────────────
/**
 * 押した本人が投稿者であることを**サーバ側で確認する**。
 * ボタンを出すかどうかの表示制御を権限の代わりにしない。
 */
async function confirmSenderClose(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row || row.user_id !== interaction.user.id) {
    await interaction.reply({ content: "この操作はできません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.status === "closed") {
    await interaction.reply({ content: "このやり取りは既に終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content: [
      "**このやり取りを終了しますか？**",
      "",
      "終了しても、これまでのやり取りが消えることはありません。",
      "また伝えたいことがあれば、新しく送れます。",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mimi:senderclosego:${id}`)
          .setLabel("終了する")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`mimi:sendercloseno:${id}`).setLabel("戻る").setStyle(ButtonStyle.Secondary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function applySenderClose(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const before = services.confessions.get(id);
  if (!before || before.user_id !== interaction.user.id) {
    await interaction.reply({ content: "この操作はできません。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = services.confessions.senderCloseAtomic(id, interaction.user.id, retentionDaysFor(services, before));
  if (!result.ok) {
    await interaction.editReply({
      content: result.code === "already_closed" ? "このやり取りは既に終了しています。" : "この操作はできません。",
    });
    return;
  }
  const openEmg = services.confessions.openEmergencyFor(id);
  if (openEmg) services.confessions.closeEmergency(openEmg.id, "system:sender_close");

  await sendSenderDm(interaction.client, result.row.user_id, senderDm(id, { kind: "closed_by_sender" }));
  await threadLog(
    interaction.client,
    services,
    id,
    "✅ **投稿者がこのやり取りを終了しました。**（履歴は残っています）",
  );
  await refreshPanel(interaction.client, services, id);
  await interaction.editReply({ content: "✅ このやり取りを終了しました。話してくれてありがとう。" });

  const thread = result.row.thread_id ? await interaction.client.channels.fetch(result.row.thread_id).catch(() => null) : null;
  if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
}

// ── ⌛ 期限切れの自動終了（刻時盤から呼ぶ）──────────────
/**
 * 「運営が返答を待つと決めた」案件だけを、期限到来で終了する。
 *
 * 未対応・運営側の待機・期限のない既存案件は `listDueSenderTimeouts` の時点で入らない。
 * 閉じるのは**読んだときの期限と一致する**ときだけなので、古い実行が新しい会話を閉じない。
 */
export async function closeExpiredSenderWaits(
  client: Client,
  services: Services,
  atTs: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const due = services.confessions.listDueSenderTimeouts(atTs);
  let closed = 0;
  for (const row of due) {
    const deadline = row.reply_deadline_at;
    if (deadline === null) continue;
    const result = services.confessions.autoCloseExpiredAtomic(row.id, deadline, retentionDaysFor(services, row));
    if (!result.ok) continue;
    closed += 1;
    const openEmg = services.confessions.openEmergencyFor(row.id);
    if (openEmg) services.confessions.closeEmergency(openEmg.id, "system:scheduler");
    await sendSenderDm(client, result.row.user_id, senderDm(row.id, { kind: "closed_by_timeout" }));
    await threadLog(
      client,
      services,
      row.id,
      `⌛ 返答が無いまま期限を過ぎたため、このやり取りを自動で終了しました（履歴は残ります）。`,
    );
    await refreshPanel(client, services, row.id);
    const thread = result.row.thread_id ? await client.channels.fetch(result.row.thread_id).catch(() => null) : null;
    if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
  }
  return closed;
}

// ─────────────────────────────────────────────────────
// ボタン
// ─────────────────────────────────────────────────────
export async function handleConfessionButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");

  // 告発者: そっと囁く → 種別・返信希望の選択UI（§4/§5）
  if (action === "new") {
    await interaction.reply({ ...selectionMessage("-", "-"), flags: MessageFlags.Ephemeral });
    return;
  }

  // 告発者: 選択後の「書く」→ 本文モーダル（選択は customId から取得）
  if (action === "compose") {
    const type = idStr ?? "-";
    const wish = interaction.customId.split(":")[3] ?? "-";
    if (type === "-" || wish === "-") {
      await interaction.reply({ content: "種類と回答希望を先に選んでください。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(bodyModal(type, wish));
    return;
  }

  // 投稿者: DM の「追記する」→ モーダル
  if (action === "reply") {
    const id = Number(idStr);
    const row = services.confessions.get(id);
    if (!row || row.status === "closed") {
      await interaction.reply({
        content: "このやり取りは既に終了しています。伝えたいことがあれば、トートの耳から新しく送ってください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // 追記できるのは本人だけ（表示制御に頼らない）
    if (row.user_id !== interaction.user.id) {
      await interaction.reply({ content: "この操作はできません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(replyModal(id));
    return;
  }

  // 投稿者: 「もう大丈夫です」→ 確認 → 終了（本人確認は各段で行う）
  if (action === "senderclose") {
    await confirmSenderClose(interaction, services, Number(idStr));
    return;
  }
  if (action === "senderclosego") {
    await applySenderClose(interaction, services, Number(idStr));
    return;
  }
  if (action === "sendercloseno") {
    await interaction.update({ content: "やり取りはそのまま続いています。", components: [] });
    return;
  }

  // 告発者: 裁判所送致の意思確認DM（§Phase3-2）への応答
  if (action === "consent") {
    await handleConsentButton(interaction, services);
    return;
  }

  // ── ここから下は運営操作 ──
  // 対応開始はスタッフ全員が可能（案件の入口）。以降の個別操作は担当者/管理者のみ。
  if (action === "claim") {
    if (!isConfessionStaff(interaction, services)) {
      await interaction.reply({ content: "対応はスタッフのみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await claimConfession(interaction, services, Number(idStr));
    return;
  }

  const id = Number(idStr);
  const opGuarded = async (fn: () => Promise<unknown>): Promise<void> => {
    if (!canOperate(interaction, services, id)) {
      await interaction.reply({ content: "この案件の担当者、または管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    await fn();
  };

  switch (action) {
    // ── 会話の操作（Task #219）──
    // 受領確認。回答希望に関係なく常に使える。回答でも終了でもない。
    case "ack":
      await opGuarded(() => acknowledgeCase(interaction, services, id));
      return;
    // 送信結果が不明だったものを、担当者が「重複しうる」と承知のうえで送り直す
    case "ackretry":
      await opGuarded(() => acknowledgeCase(interaction, services, id, { retryUnknown: true }));
      return;
    // 旧「あなたの声は届きました」ボタン（返信不要案件のパネルにだけ出ていた）。
    // 押すと即クローズする実装は廃止したので、受領確認だけを行い、終了は別操作だと案内する。
    case "voice_received":
      await opGuarded(async () => {
        await acknowledgeCase(interaction, services, id);
        await interaction.followUp({
          content: "ℹ️ このボタンは受領確認のみになりました。やり取りを終える場合は ✅ 終了 を押してください。",
          flags: MessageFlags.Ephemeral,
        });
      });
      return;
    case "replystaff":
      await opGuarded(() => startStaffReply(interaction, services, id));
      return;
    // 「回答は不要」の相手への返信を、担当者が明示的に確認した後の入口
    case "replyno":
      await opGuarded(() => interaction.showModal(staffReplyModal(id)));
      return;
    case "hold":
      await opGuarded(() => holdCase(interaction, services, id));
      return;
    // 預かった返信の送信。idStr は案件ではなく下書きID（権限は下書きから案件を引いて確認する）
    case "replywait":
      await commitStaffReply(interaction, services, Number(idStr), "wait");
      return;
    case "replyend":
      await commitStaffReply(interaction, services, Number(idStr), "close");
      return;
    // 旧「対応先」ボタン。新規UIから廃止したが、旧メッセージの押下で例外にしないため no-op ephemeral で応答
    case "disp":
      await interaction.reply({
        content: "「対応先」の設定は廃止されました。担当者の追加は 👥 担当管理、他機関への通知は 🆘 支援を求める、送致は ⚖️ 裁判所へ送致 をご利用ください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    case "stage":
      // 状態は自動更新される。管理者用の手動変更は 🛠️ 補助操作 経由でのみ提供する
      await interaction.reply({
        content: "会話状態は操作から自動更新されます。手動で変更する場合は 🛠️ 補助操作 からお願いします。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    case "assign":
      await opGuarded(() =>
        interaction.reply({ ...assignPanelMsg(id, services.confessions.assignees(id)), flags: MessageFlags.Ephemeral }),
      );
      return;
    case "close":
      await opGuarded(() => interaction.reply({ ...closeSelectMsg(id), flags: MessageFlags.Ephemeral }));
      return;
    case "reopen":
      await opGuarded(() => reopenConfession(interaction, services, id));
      return;
    // 旧「大司教を呼ぶ」ボタン。押下時は新しい「支援を求める」フローへ案内する
    case "callbishop":
      await interaction.reply({
        content: "「大司祭を呼ぶ」は 🆘 支援を求める に統合されました。そちらから「大司祭へ監督相談」を選んでください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    case "support":
      await opGuarded(() =>
        interaction.reply({ ...supportSelectMsg(id), flags: MessageFlags.Ephemeral }),
      );
      return;
    case "accept":
      // 支援の引き受け（対象ロールを持つ人が押す）。担当追加とスレッド参加まで一気通貫
      await handleAcceptSupport(interaction, services);
      return;
    case "admin":
      // 補助操作パネル。管理者以外はここで弾く（通常UIから直接見えないよう button だけは残す）
      if (!isAdmin(interaction, services)) {
        await interaction.reply({ content: "🛠️ 補助操作は管理者のみ利用できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ ...adminSubPanelMsg(id), flags: MessageFlags.Ephemeral });
      return;
    case "purgenow":
      // 本文の即時削除は管理者のみ（大司祭には本操作を認めない）
      if (!isAdmin(interaction, services)) {
        await interaction.reply({ content: "本文の削除は管理者のみ可能です。", flags: MessageFlags.Ephemeral });
        return;
      }
      services.confessions.purgeBody(id, interaction.user.id);
      await threadLog(interaction.client, services, id, `🗑️ <@${interaction.user.id}> が相談本文を削除しました。`);
      await refreshPanel(interaction.client, services, id);
      await interaction.reply({ content: "🗑️ 相談本文を削除しました（案件番号・操作ログは残ります）。", flags: MessageFlags.Ephemeral });
      return;
    case "extend":
      // 保持延長は管理者、または大司祭（担当している冥教会案件のみ canOperate 経由で通す）
      if (
        !isAdmin(interaction, services) &&
        !(isChurchManager(interaction.member as GuildMember | null, services) && canOperate(interaction, services, id))
      ) {
        await interaction.reply({ content: "保持延長は管理者または大司祭のみ可能です。", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(extendModal(id));
      return;
    case "court":
      await opGuarded(() => interaction.reply({ ...courtStartMsg(id, "-", "-"), flags: MessageFlags.Ephemeral }));
      return;
    case "courtnext": {
      // mimi:courtnext:<cat>:<consent>:<id>
      const [, , cat, consent, idS] = interaction.customId.split(":");
      const cid = Number(idS);
      if (!canOperate(interaction, services, cid)) {
        await interaction.reply({ content: "担当者または管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (cat === "-" || consent === "-") {
        await interaction.reply({ content: "事件分類と意思確認状況を選んでください。", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(courtFormModal(cid, cat!, consent!));
      return;
    }
    case "courtcaseno":
      await opGuarded(() => interaction.showModal(courtCaseNoModal(id)));
      return;
    case "courtcancel":
      await opGuarded(() => cancelCourtReferral(interaction, services, id));
      return;
    case "emg":
      await opGuarded(() => interaction.reply({ ...emgStartMsg(id, "-", ""), flags: MessageFlags.Ephemeral }));
      return;
    case "emgnext": {
      // mimi:emgnext:<danger>:<measuresCsv>:<id>
      const [, , danger, measuresCsv, idS] = interaction.customId.split(":");
      const cid = Number(idS);
      if (!canOperate(interaction, services, cid)) {
        await interaction.reply({ content: "担当者または管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (danger === "-") {
        await interaction.reply({ content: "危険継続の有無を選んでください。", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(emgFormModal(cid, danger!, measuresCsv ?? ""));
      return;
    }
    case "emgconfirm":
      await handleEmergencyConfirm(interaction, services, id);
      return;
    case "role": {
      // 旧メッセージ互換の残置（新UIからは撤去済み）
      if (!isConfessionStaff(interaction, services)) {
        await interaction.reply({ content: "スタッフのみ可能です。", flags: MessageFlags.Ephemeral });
        return;
      }
      const menu = new RoleSelectMenuBuilder().setCustomId(`mimi:roleset:${idStr}`).setPlaceholder("告発者に付与するロールを選ぶ");
      await interaction.reply({
        content: "付与するロールを選んでください（告発者は匿名のまま付与されます）。",
        components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    case "block": {
      // 旧メッセージ互換の残置（出禁は裏機能として維持）
      if (!isConfessionStaff(interaction, services)) {
        await interaction.reply({ content: "スタッフのみ可能です。", flags: MessageFlags.Ephemeral });
        return;
      }
      await blockConfession(interaction, services, id);
      return;
    }
  }
}

// ─────────────────────────────────────────────────────
// 文字列セレクト（告発者の種別・返信希望の選択）
// index.ts の StringSelectMenu(mimi:) 分岐から呼ぶ
// ─────────────────────────────────────────────────────
export async function handleConfessionStringSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  // 告発者: 種別・返信希望の選択（選択状態は「書く」ボタンの customId に持つ）
  if (action === "seltype" || action === "selwish") {
    const current = readSelection(interaction.message);
    const next =
      action === "seltype"
        ? { type: interaction.values[0] ?? "-", wish: current.wish }
        : { type: current.type, wish: interaction.values[0] ?? "-" };
    await interaction.update(selectionMessage(next.type, next.wish));
    return;
  }

  const id = Number(parts[2]);

  // ── 旧「対応先」セレクト。廃止済のため no-op で応答（旧メッセージでもエラーにしない） ──
  if (action === "dispset") {
    await interaction.update({
      content: "「対応先」の設定は廃止されました。担当追加は 👥 担当管理、他機関への支援要請は 🆘 支援を求める をご利用ください。",
      components: [],
    });
    return;
  }

  // ── 状態の手動変更（管理者用・補助操作から到達）──
  if (action === "stageset") {
    if (!isAdmin(interaction, services)) {
      await interaction.update({ content: "手動での状態変更は管理者のみ利用できます（通常は自動更新されます）。", components: [] });
      return;
    }
    const stage = interaction.values[0] as ConfessionStage;
    services.confessions.setStage(id, stage, interaction.user.id);
    await threadLog(interaction.client, services, id, `🔄 <@${interaction.user.id}> が状態を「${STAGE_META[stage]}」へ手動変更しました。`);
    await refreshPanel(interaction.client, services, id);
    await interaction.update({ content: `🔄 状態を「${STAGE_META[stage]}」に変更しました。`, components: [] });
    return;
  }

  // ── 🆘 支援を求める セレクト。対象を選ぶ → 引受フローの通知を出す ──
  if (action === "supset") {
    if (!canOperate(interaction, services, id)) {
      await interaction.update({ content: "この案件の担当者、または管理者のみ操作できます。", components: [] });
      return;
    }
    await handleSupportTarget(interaction, services, id, interaction.values[0]!);
    return;
  }

  // ── クローズ理由の確定（§Phase2-4） ──
  if (action === "closeset") {
    if (!canOperate(interaction, services, id)) {
      await interaction.update({ content: "担当者または管理者のみ操作できます。", components: [] });
      return;
    }
    await applyClose(interaction, services, id, interaction.values[0] as CloseReason);
    return;
  }

  // ── 裁判所送致フォームの分類/意思確認（状態は「続ける」ボタンに持ち回る） ──
  if (action === "courtcat" || action === "courtcon") {
    const cur = readCourtSel(interaction.message);
    const next =
      action === "courtcat"
        ? { cat: interaction.values[0] ?? "-", con: cur.con }
        : { cat: cur.cat, con: interaction.values[0] ?? "-" };
    await interaction.update(courtStartMsg(id, next.cat, next.con));
    return;
  }

  // ── 緊急対応フォームの危険継続/一時措置（状態を「続ける」ボタンに持ち回る） ──
  if (action === "emgdanger" || action === "emgmeasures") {
    const cur = readEmgSel(interaction.message);
    const next =
      action === "emgdanger"
        ? { danger: interaction.values[0] ?? "-", measures: cur.measures }
        : { danger: cur.danger, measures: interaction.values };
    await interaction.update(emgStartMsg(id, next.danger, next.measures.join(",")));
    return;
  }
}

// ─────────────────────────────────────────────────────
// ユーザーセレクト（担当者の追加・解除）
// index.ts の UserSelectMenu(mimi:) 分岐から呼ぶ
// ─────────────────────────────────────────────────────
export async function handleConfessionUserSelect(
  interaction: UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const id = Number(parts[2]);
  if (action !== "assignadd" && action !== "assignrm") return;
  if (!canOperate(interaction, services, id)) {
    await interaction.update({ content: "担当者または管理者のみ操作できます。", components: [] });
    return;
  }
  const row = services.confessions.get(id);
  const targetId = interaction.values[0]!;
  const thread = row?.thread_id ? await interaction.client.channels.fetch(row.thread_id).catch(() => null) : null;

  if (action === "assignadd") {
    services.confessions.addAssignee(id, targetId, interaction.user.id);
    if (thread?.isThread()) await thread.members.add(targetId).catch(() => undefined);
    await threadLog(interaction.client, services, id, `👥 <@${interaction.user.id}> が <@${targetId}> を担当に追加しました。`);
    await refreshPanel(interaction.client, services, id);
    await interaction.update({ content: `👥 <@${targetId}> を担当に追加しました。`, components: [] });
    return;
  }
  // assignrm
  if (targetId === row?.claimed_by) {
    await interaction.update({ content: "主担当は解除できません（別の担当を追加してから対応を引き継いでください）。", components: [] });
    return;
  }
  services.confessions.removeAssignee(id, targetId, interaction.user.id);
  if (thread?.isThread()) await thread.members.remove(targetId).catch(() => undefined);
  await threadLog(interaction.client, services, id, `👥 <@${interaction.user.id}> が <@${targetId}> を担当から解除しました。`);
  await refreshPanel(interaction.client, services, id);
  await interaction.update({ content: `👥 <@${targetId}> を担当から解除しました（スレッド閲覧も解除）。`, components: [] });
}

// ─────────────────────────────────────────────────────
// モーダル送信
// ─────────────────────────────────────────────────────
export async function handleConfessionModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  // 告発者: 新規の囁き
  if (action === "body") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const uid = interaction.user.id;
    const type = (parts[2] && parts[2] !== "-" ? parts[2] : null) as ConfessionType | null;
    const wish = (parts[3] && parts[3] !== "-" ? parts[3] : null) as ReplyWish | null;
    const text = interaction.fields.getTextInputValue("text").trim();

    // 出禁: サイレントドロップ（本人には受け付けたように見せる）
    if (services.confessions.isBlocked(uid)) {
      await interaction.editReply({ content: "🕯 あなたの声は、トートの耳に届いた。" });
      return;
    }

    const chId = services.settings.getString("channel:confession");
    if (!chId) {
      await interaction.editReply({ content: "⚠️ まだトートの耳の宛先が設定されていません。運営に連絡してください。" });
      return;
    }
    const ch = await interaction.client.channels.fetch(chId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: "⚠️ 宛先チャンネルが不正です。運営に連絡してください。" });
      return;
    }

    const row = services.confessions.create(uid, {
      type: type ?? undefined,
      replyWish: wish ?? undefined,
      body: text,
    });
    // 本文は「対応する」を押した人だけが専用スレッドで見られる。
    // 通知チャンネルには受付情報だけを載せ、閲覧制限を機能させる（同チャンネル閲覧者への漏洩を防ぐ）。
    const embed = new EmbedBuilder()
      .setAuthor({ name: "👂 トートの耳 — 匿名の囁き" })
      .setColor(type === "kinkyu" ? 0xdc2626 : PANEL_COLOR)
      .setTitle(recordNo(row.id))
      .addFields(
        { name: "種別", value: typeText(row.type), inline: true },
        { name: "回答希望", value: wishText(row.reply_wish), inline: true },
        { name: "状態", value: "🕯️ 未対応", inline: true },
        { name: "受付日時", value: jstStamp(row.created_at), inline: false },
      )
      .setDescription("匿名の声が届きました。\n**対応する** を押すと専用スレッドが開き、そこで本文を確認できます。")
      .setFooter({ text: "投稿者は匿名。本文はスレッドに参加した者だけが読めます。" });
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mimi:claim:${row.id}`).setLabel("対応する").setEmoji("🤝").setStyle(ButtonStyle.Primary),
    );
    // §4 投稿種別ごとに、その種別に設定されたロールだけを通知する（大司教は通常新着では呼ばない）
    const mention = roleMention(notifyRoleIdsForType(services, row.type as ConfessionType | null));
    await (ch as TextChannel)
      .send({
        content: mention.content,
        embeds: [embed],
        components: [controls],
        allowedMentions: { roles: mention.roleIds },
      })
      .catch(() => undefined);

    // **投稿者にも手元の窓口を渡す。** これが無いと、届いたのか・何を待てばいいのか・
    // どうやって終えればいいのかが本人からは一切見えない。
    const handed = await sendSenderDm(interaction.client, uid, senderDm(row.id, { kind: "received", wish: row.reply_wish }));
    await interaction.editReply({
      content: handed
        ? "🕯 あなたの声は、トートの耳に届いた。DM に受付の控えを送ったので、追記も終了もそこから行える。"
        : "🕯 あなたの声は、トートの耳に届いた。（DM を送れなかったため、追記・終了のボタンは届いていない。DM を開けておくと使える）",
    });
    return;
  }

  // 投稿者: 追記（本文を先に確定させてから運営へ渡す）
  if (action === "replybody") {
    await submitSenderFollowUp(interaction, services, Number(parts[2]));
    return;
  }

  // 担当者: 自由返信の本文（送信はまだしない。次の選択で確定する）
  if (action === "staffreplybody") {
    await stageStaffReply(interaction, services, Number(parts[2]));
    return;
  }

  // 担当者: 裁判所送致フォーム送信（§Phase3-1）
  if (action === "courtform") {
    await submitCourtForm(interaction, services);
    return;
  }
  // 担当者: 事件番号の登録（§Phase3-4）
  if (action === "courtcaseno") {
    await submitCourtCaseNo(interaction, services);
    return;
  }
  // 担当者: 緊急対応フォーム送信（§Phase4-1）
  if (action === "emgform") {
    await submitEmergencyForm(interaction, services);
    return;
  }
  // 管理者: 本文の保持延長（§Phase2-5）
  if (action === "extendform") {
    const id = Number(parts[2]);
    const days = Number(interaction.fields.getTextInputValue("days").replaceAll(",", "").trim());
    const reason = interaction.fields.getTextInputValue("reason").trim();
    if (!Number.isFinite(days) || days <= 0) {
      await interaction.reply({ content: "延長日数は正の数で入力してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const newPurgeAt = Math.floor(Date.now() / 1000) + days * 86_400;
    services.confessions.extendRetention(id, newPurgeAt, reason, interaction.user.id);
    await threadLog(interaction.client, services, id, `📅 <@${interaction.user.id}> が本文の保持を ${days}日 延長しました（理由: ${reason}）。`);
    await refreshPanel(interaction.client, services, id);
    await interaction.reply({ content: `📅 保持を ${days}日 延長しました（削除予定：<t:${newPurgeAt}:D>）。`, flags: MessageFlags.Ephemeral });
    return;
  }
}

function extendModal(id: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`mimi:extendform:${id}`)
    .setTitle(`本文の保持延長 ${recordNo(id)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("days").setLabel("今から何日後まで保持するか").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("延長する理由").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ),
    );
}

// ─────────────────────────────────────────────────────
// ロールセレクト（付与）
// ─────────────────────────────────────────────────────
export async function handleConfessionSelect(interaction: RoleSelectMenuInteraction, services: Services): Promise<void> {
  const [, action, idStr] = interaction.customId.split(":");
  if (action !== "roleset") return;
  if (!isConfessionStaff(interaction, services)) {
    await interaction.reply({ content: "スタッフのみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = Number(idStr);
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.update({ content: "この件が見つかりません。", components: [] });
    return;
  }
  const roleId = interaction.values[0]!;
  const guild = interaction.guild;
  const member = guild ? await guild.members.fetch(row.user_id).catch(() => null) : null;
  if (!member) {
    await interaction.update({ content: "❌ 告発者がサーバーにいないため付与できません。", components: [] });
    return;
  }
  const ok = await member.roles.add(roleId).then(() => true).catch(() => false);
  await interaction.update({
    content: ok ? `✅ 告発者に <@&${roleId}> を付与しました（匿名のまま）。` : "❌ ロール付与に失敗しました（ボットのロール順を確認）。",
    components: [],
  });
  // 告発者にも通知
  if (ok) {
    await member
      .send(`🎭 トートの耳 #${id} の対応で、あなたに新しいロールが付与された。`)
      .catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────
// 運営操作の実体
// ─────────────────────────────────────────────────────
async function claimConfession(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.reply({ content: "この件が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.thread_id) {
    await interaction.reply({ content: `既に対応中です: <#${row.thread_id}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "テキストチャンネルで押してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 運営専用のプライベートスレッド（告発者は入れない＝匿名維持）
  const thread = await (channel as TextChannel).threads.create({
    name: `トートの耳 #${id}`,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });
  const claimed = services.confessions.claim(id, thread.id, interaction.user.id) ?? row;

  // 案件の現状を示す管理パネル（§8）。以後の操作はこのパネルのボタンから行う
  const panel = await thread.send({
    content: [
      `🤝 <@${interaction.user.id}> が **${recordNo(id)}** の対応を開始。`,
      "**このスレッドに書くと、トートが投稿者の DM へ匿名で届けます。**（投稿者の正体はトートしか知りません）",
    ].join("\n"),
    embeds: [
      buildCaseEmbed(claimed, services.confessions.assignees(id), {
        hasOpenEmergency: !!services.confessions.openEmergencyFor(id),
        ackState: services.confessions.ackState(id),
        unrelayedFollowUps: services.confessions.listUnrelayedFollowUps(id).length,
      }),
    ],
    components: managementControls(id, claimed, services.confessions.ackState(id)),
  });
  services.confessions.setPanelMsg(id, panel.id);

  await interaction.editReply({ content: `✅ 対応スレッドを開きました: <#${thread.id}>` });
}

/** クローズ理由を確定して実際に閉じる（§Phase2-4）。本文purge予定も設定する */
async function applyClose(
  interaction: StringSelectMenuInteraction,
  services: Services,
  id: number,
  reason: CloseReason,
): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.update({ content: "この件が見つかりません。", components: [] });
    return;
  }
  // 送致済み案件は本文保持を延長（審理中に確認できるように）
  const retentionDays =
    row.court_status === "sent"
      ? services.settings.getNumber("confession_court_retention_days")
      : services.settings.getNumber("confession_body_retention_days");
  const closed = services.confessions.close(id, interaction.user.id, reason, retentionDays, "staff");
  if (!closed.ok) {
    await interaction.update({ content: "この会話は既に終了しています（先に成立した終了を維持しました）。", components: [] });
    return;
  }
  // 未終了の緊急対応があれば併せて終了
  const openEmg = services.confessions.openEmergencyFor(id);
  if (openEmg) services.confessions.closeEmergency(openEmg.id, interaction.user.id);

  // 告発者へ終了通知（§16 の文面）
  await sendSenderDm(interaction.client, row.user_id, {
    embeds: [
      new EmbedBuilder()
        .setColor(PANEL_COLOR)
        .setAuthor({ name: `${SENDER_TITLE} #${id}` })
        .setDescription(
          [
            "**このやり取りはここで終了しました。**",
            "",
            "終了しても、これまでのやり取りが消えることはありません。",
            "また伝えたいことがあれば、新しくトートへ送れます。",
          ].join("\n"),
        ),
    ],
    allowedMentions: { parse: [] },
  });

  await threadLog(interaction.client, services, id, `🔒 <@${interaction.user.id}> が「${CLOSE_META[reason]}」でクローズしました。`);
  await refreshPanel(interaction.client, services, id);
  await interaction.update({ content: `🔒 「${CLOSE_META[reason]}」でクローズしました。`, components: [] });

  // クローズ後はスレッドをアーカイブ（再オープンで自動的に復帰する。ロックはしない）
  const thread = row.thread_id ? await interaction.client.channels.fetch(row.thread_id).catch(() => null) : null;
  if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
}

/** 再オープン（§17 再オープン）。誤クローズや相談再開に使う */
async function reopenConfession(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.reply({ content: "この件が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  services.confessions.reopen(id, interaction.user.id);
  const thread = row.thread_id ? await interaction.client.channels.fetch(row.thread_id).catch(() => null) : null;
  if (thread?.isThread() && thread.archived) await thread.setArchived(false).catch(() => undefined);
  await threadLog(interaction.client, services, id, `🔓 <@${interaction.user.id}> がこの案件を再オープンしました。`);
  await refreshPanel(interaction.client, services, id);
  await interaction.reply({ content: "🔓 再オープンしました。", flags: MessageFlags.Ephemeral });
}

async function blockConfession(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) return;
  services.confessions.block(row.user_id, interaction.user.id);
  await interaction.reply({
    content: `🚫 この告発者を出禁にしました。今後この人の囁きはトートの耳に届かなくなります（本人には通常通り届いたように見えます）。`,
    flags: MessageFlags.Ephemeral,
  });
}

// ─────────────────────────────────────────────────────
// 運営 → 告発者の中継（対応スレッドの運営メッセージを DM 転送）
// index.ts の MessageCreate から呼ぶ
// ─────────────────────────────────────────────────────
export async function relayStaffMessage(client: Client, services: Services, message: import("discord.js").Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const row = services.confessions.byThread(message.channel.id);
  if (!row || row.status === "closed") return;
  if (!message.content.trim()) return;

  // **スレッドへ書いても投稿者へは送らない。**
  //
  // 外部返信の経路は 💬 返信する 1本だけにする。ここから自動転送していた頃は、
  // 「返答を待つのか、この返信で終えるのか」を選ばないまま外へ出てしまい、
  // 期限も付かず、届いたかどうかも案件に残らなかった。互換のために黙って
  // 迂回路を残すと、その穴だけが生き続ける。
  //
  // スレッドの文章は内部メモとしてそのまま残る（消さない・転記しない）。
  await message.react("📝").catch(() => undefined);
  if (relayHintShown.has(message.channel.id)) return;
  relayHintShown.add(message.channel.id);
  await message.channel
    .send({
      content: [
        "📝 **このメッセージは投稿者へ送信していません。**（このスレッドの記録として残ります）",
        "投稿者へ返信する場合は、上の管理パネルの 💬 **返信する** をお使いください。",
        "そこで「返答を待つ」か「この返信で終了する」かを選ぶと、投稿者へ届きます。",
      ].join("\n"),
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

/** 同じスレッドで案内を何度も出さない（案内は1スレッド1回で足りる） */
const relayHintShown = new Set<string>();

// ═════════════════════════════════════════════════════
// 担当者・クローズ の選択UI（旧「対応先／状態」の常設セレクトは廃止）
// ═════════════════════════════════════════════════════
function closeSelectMsg(id: number) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:closeset:${id}`)
    .setPlaceholder("終了理由を選ぶ")
    .addOptions(CLOSE_ORDER.map((code) => new StringSelectMenuOptionBuilder().setValue(code).setLabel(CLOSE_META[code])));
  return {
    content: "終了理由を選ぶとクローズします。投稿者へは終了をDMでお知らせします。",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

// ═════════════════════════════════════════════════════
// 🆘 支援を求める（運営判断・大司祭相談・別のシスターの共同担当）
// 3種の"通知だけの連携"を一つのボタンに統合し、押した後の選択で対象を分ける。
// いずれも「見出しのみ通知 → 引き受ける → 担当追加＋スレッド参加」の同じ流れで処理する。
// ═════════════════════════════════════════════════════
type SupportTarget = "ops" | "bishop" | "sister";
const SUPPORT_META: Record<SupportTarget, { label: string; emoji: string; slot: "normal_ops" | "church_manage" | "church_consult"; header: string; noRole: string }> = {
  ops: {
    label: "通常運営へ判断を依頼",
    emoji: "🏰",
    slot: "normal_ops",
    header: "🏰 運営判断の依頼",
    noRole: "通常運営ロールが未設定です。/管理 → 設定 → 機関ロール で設定してください。",
  },
  bishop: {
    label: "大司祭へ監督相談",
    emoji: "⛪",
    slot: "church_manage",
    header: "⛪ 大司祭への監督相談",
    noRole: "冥教会管理ロール（大司祭）が未設定です。/管理 → 設定 → 機関ロール で設定してください。",
  },
  sister: {
    label: "別のシスター／修道士を共同担当へ",
    emoji: "👥",
    slot: "church_consult",
    header: "👥 冥教会 相談担当への支援要請",
    noRole: "相談対応ロール（シスター／修道士）が未設定です。/管理 → 設定 → 機関ロール で設定してください。",
  },
};

function supportSelectMsg(id: number) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:supset:${id}`)
    .setPlaceholder("誰に支援を求めるか選ぶ")
    .addOptions(
      (Object.keys(SUPPORT_META) as SupportTarget[]).map((k) =>
        new StringSelectMenuOptionBuilder().setValue(k).setLabel(SUPPORT_META[k].label).setEmoji(SUPPORT_META[k].emoji),
      ),
    );
  return {
    content: [
      "🆘 **支援を求める**",
      "対象ロールへ「見出しのみ」の通知を出し、相手が **引き受ける** を押した時点で共同担当へ追加されます。",
      "通知だけでは案件本文は閲覧できません。",
    ].join("\n"),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

async function handleSupportTarget(
  interaction: StringSelectMenuInteraction,
  services: Services,
  id: number,
  targetStr: string,
): Promise<void> {
  const target = targetStr as SupportTarget;
  const meta = SUPPORT_META[target];
  if (!meta) {
    await interaction.update({ content: "不明な支援先です。", components: [] });
    return;
  }
  const roleIds = getRoleIds(services, meta.slot);
  if (roleIds.length === 0) {
    await interaction.update({ content: meta.noRole, components: [] });
    return;
  }
  const chId = services.settings.getString("channel:handoff_notify") ?? services.settings.getString("channel:confession");
  if (!chId) {
    await interaction.update({ content: "通知先チャンネルが未設定です。", components: [] });
    return;
  }
  const ch = await interaction.client.channels.fetch(chId).catch(() => null);
  if (!ch?.isTextBased() || !("send" in ch)) {
    await interaction.update({ content: "通知先チャンネルへ送信できません。", components: [] });
    return;
  }

  const row = services.confessions.get(id);
  const mention = roleMention(roleIds);
  const embed = new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setTitle(meta.header)
    .setDescription(
      [
        `案件：**${recordNo(id)}**`,
        `依頼者：<@${interaction.user.id}>`,
        row?.thread_id ? `対応スレッド：<#${row.thread_id}>` : "",
        "",
        "**引き受ける** を押すと、共同担当としてこの案件のスレッドへ追加されます。",
        "本文はそこで初めて確認できます（通知だけでは閲覧できません）。",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  const accept = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mimi:accept:${target}:${id}`)
      .setLabel("引き受ける")
      .setEmoji("🤝")
      .setStyle(ButtonStyle.Primary),
  );
  await ch
    .send({ content: mention.content, embeds: [embed], components: [accept], allowedMentions: { roles: mention.roleIds } })
    .catch(() => undefined);

  services.events.log("confession_support_request", {
    actor: interaction.user.id,
    payload: { id, target, notified: roleIds.length },
  });
  await threadLog(
    interaction.client,
    services,
    id,
    `🆘 <@${interaction.user.id}> が「${meta.label}」を要請しました（${roleIds.length}ロールへ通知）。引き受けを待機しています。`,
  );
  await interaction.update({
    content: `${meta.emoji} 「${meta.label}」を通知しました。相手が **引き受ける** を押すと共同担当に追加されます。`,
    components: [],
  });
}

/** 引き受けボタン処理。対象ロール保持者のみ受理し、担当追加とスレッド参加まで実行する */
async function handleAcceptSupport(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , target, idS] = interaction.customId.split(":"); // mimi:accept:<target>:<id>
  const id = Number(idS);
  const meta = SUPPORT_META[target as SupportTarget];
  if (!meta) {
    await interaction.reply({ content: "不明な支援先です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.reply({ content: "案件が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const member = interaction.member as GuildMember | null;
  const allowed = isAdmin(interaction, services) || memberHasSlot(member, services, meta.slot);
  if (!allowed) {
    await interaction.reply({
      content: `この引き受けは ${meta.label} の担当ロール保持者のみ可能です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // 既に主担当・共同担当ならスキップして通知だけ更新
  const already =
    row.claimed_by === interaction.user.id || services.confessions.isAssignee(id, interaction.user.id);
  if (!already) {
    services.confessions.addAssignee(id, interaction.user.id, interaction.user.id);
    if (row.thread_id) {
      const thread = await interaction.client.channels.fetch(row.thread_id).catch(() => null);
      if (thread?.isThread()) await thread.members.add(interaction.user.id).catch(() => undefined);
    }
    services.events.log("confession_support_accepted", {
      actor: interaction.user.id,
      payload: { id, target },
    });
    await threadLog(
      interaction.client,
      services,
      id,
      `🤝 <@${interaction.user.id}>（${meta.label}）が引き受け、共同担当に追加されました。`,
    );
    await refreshPanel(interaction.client, services, id);
  }
  // 通知メッセージ自体を「引受済み」に更新して、他の候補者に押させない
  await interaction.update({
    embeds: interaction.message.embeds,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mimi:accepted:${id}`)
          .setLabel(`<@${interaction.user.id}> が引き受け済み`.replace(/<@\d+>/, "担当者が"))
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      ),
    ],
    content: `${meta.emoji} <@${interaction.user.id}> が引き受けました。`,
    allowedMentions: { parse: [] },
  });
}

function memberHasSlot(
  member: GuildMember | null,
  services: Services,
  slot: "normal_ops" | "church_manage" | "church_consult",
): boolean {
  if (!member) return false;
  const ids = getRoleIds(services, slot);
  return ids.some((rid) => member.roles.cache.has(rid));
}

/** 補助操作の ephemeral パネル（管理者のみ）。会話状態の手動変更などを提供する */
function adminSubPanelMsg(id: number) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:stageset:${id}`)
    .setPlaceholder("会話状態を手動で変更する")
    .addOptions(STAGE_ORDER.map((code) => new StringSelectMenuOptionBuilder().setValue(code).setLabel(STAGE_META[code])));
  return {
    content: [
      "🛠️ **補助操作（管理者のみ）**",
      "会話状態は通常、担当者・投稿者のやり取りから自動更新されます。何らかの理由で表示がズレた場合のみここで手動変更してください。",
    ].join("\n"),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

function assignPanelMsg(id: number, assignees: string[]) {
  const current = assignees.length > 0 ? assignees.map((u) => `<@${u}>`).join("・") : "（追加担当なし）";
  const add = new UserSelectMenuBuilder().setCustomId(`mimi:assignadd:${id}`).setPlaceholder("担当に追加する人を選ぶ").setMaxValues(1);
  const rm = new UserSelectMenuBuilder().setCustomId(`mimi:assignrm:${id}`).setPlaceholder("担当から解除する人を選ぶ").setMaxValues(1);
  return {
    content: [
      `現在の担当者：${current}`,
      "追加すると、その人はこの案件のプライベートスレッドを閲覧・対応できます。",
      "解除すると、スレッドの閲覧も解除されます。",
    ].join("\n"),
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(add),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(rm),
    ],
  };
}

// ═════════════════════════════════════════════════════
// Phase 3: 冥府裁判所への送致
// ═════════════════════════════════════════════════════
const COURT_CAT_META: Record<string, string> = {
  civil: "民事事件",
  criminal: "刑事事件",
  joined: "併合事件",
  enma: "閻魔に判断を委ねる",
};
const COURT_CAT_ORDER = ["civil", "criminal", "joined", "enma"];

const COURT_CONSENT_META: Record<string, string> = {
  poster_wants: "投稿者本人が裁判を希望している",
  confirmed: "投稿者の同意を確認済み",
  not_asked: "まだ確認していない",
  safety_override: "安全上の理由により、同意を待たず運営判断で送致する",
  // 投稿者DM応答で入る内部値
  confirmed_by_poster: "投稿者が同意（DM確認済み）",
  poster_declined: "投稿者は相談継続を選択",
};
const COURT_CONSENT_ORDER = ["poster_wants", "confirmed", "not_asked", "safety_override"];

function courtCatText(code: string | null): string {
  return code ? (COURT_CAT_META[code] ?? code) : "（未選択）";
}
function courtConsentText(code: string | null): string {
  return code ? (COURT_CONSENT_META[code] ?? code) : "（未選択）";
}

/** 「続ける」ボタンの customId から分類・意思確認状況を復元 */
function readCourtSel(message: { components?: unknown }): { cat: string; con: string } {
  const rows = (message.components ?? []) as { components?: { customId?: string }[] }[];
  for (const r of rows) for (const c of r.components ?? []) {
    const cid = c.customId ?? "";
    if (cid.startsWith("mimi:courtnext:")) {
      const [, , cat, con] = cid.split(":");
      return { cat: cat || "-", con: con || "-" };
    }
  }
  return { cat: "-", con: "-" };
}

function courtStartMsg(id: number, cat: string, con: string) {
  const catMenu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:courtcat:${id}`)
    .setPlaceholder("① 事件分類候補")
    .addOptions(COURT_CAT_ORDER.map((c) => new StringSelectMenuOptionBuilder().setValue(c).setLabel(COURT_CAT_META[c] ?? c).setDefault(c === cat)));
  const conMenu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:courtcon:${id}`)
    .setPlaceholder("② 投稿者の意思確認状況")
    .addOptions(
      COURT_CONSENT_ORDER.map((c) => new StringSelectMenuOptionBuilder().setValue(c).setLabel(COURT_CONSENT_META[c] ?? c).setDefault(c === con)),
    );
  const ready = cat !== "-" && con !== "-";
  const next = new ButtonBuilder()
    .setCustomId(`mimi:courtnext:${cat}:${con}:${id}`)
    .setLabel("送致フォームへ")
    .setEmoji("⚖️")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!ready);
  const lines = [
    "**冥府裁判所への送致**（人間の確認を挟みます。ここではまだ送致されません）",
    `　事件分類候補：${courtCatText(cat === "-" ? null : cat)}`,
    `　意思確認状況：${courtConsentText(con === "-" ? null : con)}`,
    con === "not_asked" ? "※「まだ確認していない」を選ぶと、投稿者へ意思確認DMを送ってから送致します。" : "",
    con === "safety_override" ? "※ 運営判断での送致です。投稿者へは同意確認ではなく『送致した旨』を通知します。" : "",
  ].filter(Boolean);
  return {
    content: lines.join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(conMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(next),
    ],
  };
}

function courtFormModal(id: number, cat: string, con: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`mimi:courtform:${cat}:${con}:${id}`)
    .setTitle(`送致フォーム ${recordNo(id)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("送致を検討する理由").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("summary")
          .setLabel("裁判所へ渡す事件概要（本文は転記されません）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("wants").setLabel("投稿者が求めていること").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000),
      ),
    );
}

function courtCaseNoModal(id: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`mimi:courtcaseno:${id}`)
    .setTitle(`事件番号の登録 ${recordNo(id)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("caseno")
          .setLabel("事件番号（例：冥府刑事第003号）")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(60),
      ),
    );
}

/** 投稿者への意思確認DMを送る */
async function sendConsentDM(client: Client, services: Services, id: number): Promise<boolean> {
  const row = services.confessions.get(id);
  if (!row) return false;
  const user = await client.users.fetch(row.user_id).catch(() => null);
  if (!user) return false;
  return user
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle("⚖️ トートより確認")
          .setDescription(
            [
              "あなたから届いた内容について、正式な判断を行うため、冥府裁判所へ引き継ぐ案が出ています。",
              "",
              "裁判所へ引き継いだ場合、必要な範囲で担当者へ内容が共有されます。",
              "",
              "下のボタンから選んでください。",
            ].join("\n"),
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mimi:consent:agree:${id}`).setLabel("送致に同意する").setEmoji("⚖️").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`mimi:consent:stay:${id}`).setLabel("相談のまま続ける").setEmoji("🕯️").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mimi:consent:explain:${id}`).setLabel("先に説明を聞く").setEmoji("❓").setStyle(ButtonStyle.Secondary),
        ),
      ],
    })
    .then(() => true)
    .catch(() => false);
}

/** 冥府裁判所フォーラムへ送致投稿を作成。相談本文は転記せず、担当者の概要のみ */
async function createCourtForumPost(
  client: Client,
  services: Services,
  id: number,
  staffId: string,
): Promise<{ ok: boolean; message: string; url?: string }> {
  const forumId = services.settings.getString("channel:court_forum");
  if (!forumId) return { ok: false, message: "冥府裁判所フォーラム（channel:court_forum）が未設定です。/管理 で設定してください。" };
  const forum = (await client.channels.fetch(forumId).catch(() => null)) as ForumChannel | null;
  if (!forum || forum.type !== ChannelType.GuildForum) return { ok: false, message: "送致先がフォーラムチャンネルではありません。" };
  const row = services.confessions.get(id);
  if (!row) return { ok: false, message: "案件が見つかりません。" };
  const form = (() => {
    try {
      return row.court_form ? (JSON.parse(row.court_form) as { reason: string; summary: string; wants: string }) : null;
    } catch {
      return null;
    }
  })();
  const content = [
    `## ⚖️ 送致案件 ${recordNo(id)}`,
    `**送致担当者：** <@${staffId}>`,
    `**事件分類候補：** ${courtCatText(row.court_category)}`,
    `**意思確認状況：** ${courtConsentText(row.court_consent)}`,
    `**送致日時：** ${jstStamp(Math.floor(Date.now() / 1000))}`,
    "",
    `**事件概要：**\n${form?.summary || "—"}`,
    "",
    `**投稿者が求めていること：**\n${form?.wants || "—"}`,
    "",
    `**送致を検討した理由：**\n${form?.reason || "—"}`,
    "",
    row.thread_id ? `**元のトート案件：** <#${row.thread_id}>` : "",
    "> ※ トートへの相談本文は転記していません。担当者が入力した必要な概要のみを記載しています。",
  ]
    .filter(Boolean)
    .join("\n");
  const thread = await forum.threads
    .create({ name: `【送致案件】${recordNo(id)}`.slice(0, 90), message: { content } })
    .catch(() => null);
  if (!thread) return { ok: false, message: "フォーラム投稿の作成に失敗しました（権限を確認してください）。" };
  services.confessions.recordCourtPost(id, { threadId: thread.id, url: thread.url, staffId });
  await threadLog(client, services, id, `⚖️ 冥府裁判所へ送致しました：${thread.url}`);
  await refreshPanel(client, services, id);
  return { ok: true, message: "送致投稿を作成しました。", url: thread.url };
}

/** 送致フォーム送信 */
async function submitCourtForm(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const [, , cat, con, idS] = interaction.customId.split(":");
  const id = Number(idS);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.editReply({ content: "案件が見つかりません。" });
    return;
  }
  const form = {
    reason: interaction.fields.getTextInputValue("reason").trim(),
    summary: interaction.fields.getTextInputValue("summary").trim(),
    wants: (interaction.fields.getTextInputValue("wants") || "").trim(),
  };
  services.confessions.recordCourtReferral(id, { category: cat!, consent: con!, staffId: interaction.user.id, form });

  // まだ意思確認していない → 投稿者へ確認DM。送致は同意後
  if (con === "not_asked") {
    const dm = await sendConsentDM(interaction.client, services, id);
    await threadLog(
      interaction.client,
      services,
      id,
      `⚖️ <@${interaction.user.id}> が送致を起案し、投稿者へ意思確認DMを${dm ? "送信しました" : "送ろうとしましたが届きませんでした"}。`,
    );
    await refreshPanel(interaction.client, services, id);
    await interaction.editReply({
      content: dm
        ? "⚖️ 投稿者へ意思確認DMを送りました。**同意が得られ次第、送致します**。"
        : "⚠️ 投稿者へDMを送れませんでした（DM拒否設定の可能性）。スレッドで担当者が状況を確認してください。",
    });
    return;
  }

  // それ以外（本人希望・同意済み・安全上の運営判断）→ ただちに送致
  const res = await createCourtForumPost(interaction.client, services, id, interaction.user.id);
  if (!res.ok) {
    await interaction.editReply({ content: `⚠️ ${res.message}` });
    return;
  }
  // 安全上の運営判断のときは「送致した旨」を投稿者へ通知（同意確認ではない）
  if (con === "safety_override") {
    const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
    await user
      ?.send(
        "⚖️ あなたから届いた内容について、安全上の理由により、運営判断で冥府裁判所へ引き継ぎました。必要な範囲で担当者に共有されます。",
      )
      .catch(() => undefined);
  }
  await interaction.editReply({ content: `⚖️ 送致しました：${res.url}` });
}

/** 事件番号の登録 */
async function submitCourtCaseNo(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const id = Number(interaction.customId.split(":")[2]);
  const caseNo = interaction.fields.getTextInputValue("caseno").trim();
  services.confessions.setCourtCaseNo(id, caseNo, interaction.user.id);
  await threadLog(interaction.client, services, id, `⚖️ <@${interaction.user.id}> が事件番号「${caseNo}」を登録しました。`);
  await refreshPanel(interaction.client, services, id);
  await interaction.reply({ content: `⚖️ 事件番号「${caseNo}」を登録しました。`, flags: MessageFlags.Ephemeral });
}

/** 送致の取消し */
async function cancelCourtReferral(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  services.confessions.cancelCourtReferral(id, interaction.user.id);
  await threadLog(interaction.client, services, id, `⚖️ <@${interaction.user.id}> が送致（意思確認）を取消しました。`);
  await refreshPanel(interaction.client, services, id);
  await interaction.reply({ content: "⚖️ 送致を取消しました（対応中に戻しました）。", flags: MessageFlags.Ephemeral });
}

/** 投稿者の意思確認DMボタン応答 */
async function handleConsentButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , sub, idS] = interaction.customId.split(":");
  const id = Number(idS);
  const row = services.confessions.get(id);
  if (!row || row.user_id !== interaction.user.id) {
    await interaction.reply({ content: "この確認には応答できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === "agree") {
    services.confessions.setCourtConsent(id, "confirmed_by_poster", interaction.user.id);
    await threadLog(interaction.client, services, id, "⚖️ 投稿者が裁判所への送致に同意しました。");
    const staffId = row.claimed_by ?? "system";
    const res = await createCourtForumPost(interaction.client, services, id, staffId);
    await interaction.update({
      content: res.ok ? "⚖️ 送致に同意いただきました。担当へ引き継ぎます。" : "⚖️ 同意を受け付けました。担当が手続きを進めます。",
      embeds: [],
      components: [],
    });
    return;
  }
  if (sub === "stay") {
    services.confessions.setCourtConsent(id, "poster_declined", interaction.user.id);
    services.confessions.cancelCourtReferral(id, interaction.user.id);
    await threadLog(interaction.client, services, id, "🕯 投稿者は「相談のまま続ける」を選びました。送致は保留されました。");
    await refreshPanel(interaction.client, services, id);
    await interaction.update({ content: "🕯 承知しました。このまま相談を続けます。", embeds: [], components: [] });
    return;
  }
  // explain
  await threadLog(interaction.client, services, id, "❓ 投稿者が『先に詳しい説明を聞きたい』と回答しました。");
  await interaction.update({ content: "❓ 担当者へ伝えました。追って説明が届きます。", embeds: [], components: [] });
}

// ═════════════════════════════════════════════════════
// Phase 4: 緊急対応（通知と記録。処分は自動実行しない）
// ═════════════════════════════════════════════════════
const EMG_MEASURE_META: Record<string, string> = {
  notify: "担当運営への緊急通知",
  isolate: "対象者の一時隔離",
  suspend: "権限の一時停止",
  nocontact: "一時的な接触停止",
  tempban: "一時BANの検討",
  other: "その他",
};
const EMG_MEASURE_ORDER = ["notify", "isolate", "suspend", "nocontact", "tempban", "other"];

function measuresText(csv: string): string {
  const codes = csv.split(",").filter(Boolean);
  if (codes.length === 0) return "—";
  return codes.map((c) => `・${EMG_MEASURE_META[c] ?? c}`).join("\n");
}

/** 「続ける」ボタンの customId から危険継続・一時措置を復元 */
function readEmgSel(message: { components?: unknown }): { danger: string; measures: string[] } {
  const rows = (message.components ?? []) as { components?: { customId?: string }[] }[];
  for (const r of rows) for (const c of r.components ?? []) {
    const cid = c.customId ?? "";
    if (cid.startsWith("mimi:emgnext:")) {
      const [, , danger, measuresCsv] = cid.split(":");
      return { danger: danger || "-", measures: (measuresCsv || "").split(",").filter(Boolean) };
    }
  }
  return { danger: "-", measures: [] };
}

function emgStartMsg(id: number, danger: string, measuresCsv: string) {
  const measures = measuresCsv.split(",").filter(Boolean);
  const dangerMenu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:emgdanger:${id}`)
    .setPlaceholder("① 現在も危険が続いているか")
    .addOptions(
      new StringSelectMenuOptionBuilder().setValue("yes").setLabel("現在も危険が続いている").setEmoji("🔴").setDefault(danger === "yes"),
      new StringSelectMenuOptionBuilder().setValue("no").setLabel("現在は継続していない").setEmoji("🟡").setDefault(danger === "no"),
    );
  const measureMenu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:emgmeasures:${id}`)
    .setPlaceholder("② 必要と考える一時措置（複数可）")
    .setMinValues(0)
    .setMaxValues(EMG_MEASURE_ORDER.length)
    .addOptions(
      EMG_MEASURE_ORDER.map((c) => new StringSelectMenuOptionBuilder().setValue(c).setLabel(EMG_MEASURE_META[c] ?? c).setDefault(measures.includes(c))),
    );
  const next = new ButtonBuilder()
    .setCustomId(`mimi:emgnext:${danger}:${measures.join(",")}:${id}`)
    .setLabel("緊急対応フォームへ")
    .setEmoji("🚨")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(danger === "-");
  return {
    content: [
      "**緊急対応の登録**（処分は自動実行されません。運営が確認して実行します）",
      "危険な画像・動画は送らないでください。文章で状況を記録してください。",
      `　危険継続：${danger === "yes" ? "🔴 あり" : danger === "no" ? "🟡 なし" : "（未選択）"}`,
      `　一時措置：${measures.length ? measures.map((c) => EMG_MEASURE_META[c]).join("・") : "（未選択）"}`,
    ].join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dangerMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(measureMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(next),
    ],
  };
}

function emgFormModal(id: number, danger: string, measuresCsv: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`mimi:emgform:${danger}:${measuresCsv}:${id}`)
    .setTitle(`緊急対応 ${recordNo(id)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("緊急対応が必要と考える理由").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("target").setLabel("対象者（分かる範囲で）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("review").setLabel("見直し予定日時（例：3日後 / 7月25日）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(60),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("note").setLabel("補足").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(800),
      ),
    );
}

/** 緊急通知を送る（投稿者の名前・IDは含めない） */
async function notifyEmergency(client: Client, services: Services, id: number, emgId: number): Promise<boolean> {
  const emg = services.confessions.getEmergency(emgId);
  const row = services.confessions.get(id);
  if (!emg || !row) return false;
  const chId = services.settings.getString("channel:emergency_reports");
  const roleId = services.settings.getString("role:emergency_staff");
  const embed = new EmbedBuilder()
    .setColor(0xdc2626)
    .setTitle(`🚨 緊急対応 ${recordNo(id)}`)
    .addFields(
      { name: "担当者", value: `<@${emg.created_by}>`, inline: true },
      { name: "危険継続", value: emg.danger_ongoing ? "🔴 あり" : "🟡 なし", inline: true },
      { name: "対象者", value: emg.target.slice(0, 1024), inline: false },
      { name: "緊急理由", value: emg.reason.slice(0, 1024), inline: false },
      { name: "検討する一時措置", value: measuresText(emg.measures), inline: false },
      { name: "見直し予定", value: emg.review_note || "—", inline: true },
      { name: "元案件", value: row.thread_id ? `<#${row.thread_id}>` : "—", inline: true },
    )
    .setFooter({ text: "処分はBotが自動実行しません。権限を持つ運営が内容を確認の上で実施してください。" });
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mimi:emgconfirm:${emgId}`).setLabel("確認した").setEmoji("✅").setStyle(ButtonStyle.Success),
    ),
  ];
  const ch = chId ? await client.channels.fetch(chId).catch(() => null) : null;
  if (ch?.isTextBased() && "send" in ch) {
    await ch
      .send({ content: roleId ? `<@&${roleId}>` : undefined, embeds: [embed], components, allowedMentions: { roles: roleId ? [roleId] : [] } })
      .catch(() => undefined);
    return true;
  }
  return false;
}

/** 緊急対応フォーム送信 */
async function submitEmergencyForm(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const danger = parts[2];
  const measuresCsv = parts[3] ?? "";
  const id = Number(parts[4]);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.editReply({ content: "案件が見つかりません。" });
    return;
  }
  const emg = services.confessions.createEmergency({
    confessionId: id,
    createdBy: interaction.user.id,
    reason: interaction.fields.getTextInputValue("reason").trim(),
    target: interaction.fields.getTextInputValue("target").trim(),
    dangerOngoing: danger === "yes",
    measures: measuresCsv,
    reviewNote: (interaction.fields.getTextInputValue("review") || "").trim() || null,
    note: (interaction.fields.getTextInputValue("note") || "").trim() || null,
  });
  const notified = await notifyEmergency(interaction.client, services, id, emg.id);
  await threadLog(
    interaction.client,
    services,
    id,
    `🚨 <@${interaction.user.id}> が緊急対応を登録しました（危険継続: ${danger === "yes" ? "あり" : "なし"}）。`,
  );
  await refreshPanel(interaction.client, services, id);
  await interaction.editReply({
    content: notified
      ? "🚨 緊急対応を登録し、担当運営へ通知しました。"
      : "🚨 緊急対応を登録しました。⚠️ 通知先（channel:emergency_reports）が未設定のため、通知は送れていません。/管理 で設定してください。",
  });
}

/** 緊急通知の「確認した」ボタン */
async function handleEmergencyConfirm(interaction: ButtonInteraction, services: Services, emgId: number): Promise<void> {
  const roleId = services.settings.getString("role:emergency_staff");
  const member = interaction.member as GuildMember | null;
  const allowed = isAdmin(interaction, services) || (roleId ? (member?.roles.cache.has(roleId) ?? false) : false);
  if (!allowed) {
    await interaction.reply({ content: "緊急対応担当または管理者のみ確認できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  const emg = services.confessions.confirmEmergency(emgId, interaction.user.id);
  if (emg) await threadLog(interaction.client, services, emg.confession_id, `✅ <@${interaction.user.id}> が緊急対応を確認しました。`);
  await interaction.reply({ content: `✅ <@${interaction.user.id}> が確認しました。`, allowedMentions: { parse: [] } });
}
