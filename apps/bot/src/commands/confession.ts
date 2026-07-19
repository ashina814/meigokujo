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
import type { Services } from "../services.js";
import type {
  ConfessionRow,
  ConfessionStage,
  ConfessionType,
  Disposition,
  CloseReason,
  ReplyWish,
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

const WISH_META: Record<ReplyWish, { emoji: string; label: string }> = {
  yes: { emoji: "✅", label: "返信を希望する" },
  no: { emoji: "🚫", label: "返信は不要" },
  either: { emoji: "🤷", label: "どちらでもよい" },
};
const WISH_ORDER: ReplyWish[] = ["yes", "no", "either"];

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
const STAGE_META: Record<ConfessionStage, string> = {
  active: "🤝 対応中",
  awaiting_poster: "⏳ 投稿者からの返信待ち",
  awaiting_staff: "📥 担当者からの返信待ち",
  handoff: "🏰 外部への引継ぎ中",
  court_review: "⚖️ 裁判所への送致確認中",
  court_sent: "⚖️ 裁判所へ送致済み",
  emergency: "🚨 緊急対応中",
};

const DISPO_META: Record<Disposition, { emoji: string; label: string }> = {
  church: { emoji: "⛪", label: "冥教会で相談継続" },
  normal: { emoji: "🏰", label: "通常の運営対応" },
  kaiwa: { emoji: "🤝", label: "諧和廷へ連携" },
  court: { emoji: "⚖️", label: "冥府裁判所への送致を検討" },
  emergency: { emoji: "🚨", label: "緊急対応" },
  record: { emoji: "📁", label: "記録のみ" },
};
const DISPO_ORDER: Disposition[] = ["church", "normal", "kaiwa", "court", "emergency", "record"];

const STAGE_ORDER: ConfessionStage[] = [
  "active",
  "awaiting_poster",
  "awaiting_staff",
  "handoff",
  "court_review",
  "court_sent",
  "emergency",
];

const CLOSE_META: Record<CloseReason, string> = {
  resolved: "相談が完了した",
  poster_ended: "投稿者が終了を希望した",
  no_response: "投稿者から返答がない",
  handoff_normal: "通常運営へ引き継いだ",
  handoff_kaiwa: "諧和廷へ連携した",
  sent_court: "冥府裁判所へ送致した",
  no_action: "対応不要と判断した",
  other: "その他",
};
const CLOSE_ORDER: CloseReason[] = [
  "resolved",
  "poster_ended",
  "no_response",
  "handoff_normal",
  "handoff_kaiwa",
  "sent_court",
  "no_action",
  "other",
];

/** 担当者向けの状態表示。open/closed は status、対応中の内訳は stage を見る */
function statusText(row: ConfessionRow): string {
  if (row.status === "open") return "🕯️ 未対応";
  if (row.status === "closed") return "✅ 終結";
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
    .setPlaceholder("② 運営からの返信を希望する？")
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
    "**匿名で届けます。** 種類と返信希望を選んでから「書く」を押してください。",
    `　種類：${typeText(type === "-" ? null : type)}`,
    `　返信希望：${wishText(wish === "-" ? null : wish)}`,
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
    .setTitle(`トートの耳 #${id} へ返信`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("返信（匿名のまま運営に届きます）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800),
      ),
    );
}

function isConfessionStaff(interaction: ButtonInteraction | RoleSelectMenuInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const roleId = services.settings.getString("role:ticket_staff");
  if (!roleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(roleId) ?? false;
}

/**
 * 案件の操作・閲覧が許されるか（§Phase2-3）。
 * 「役職を持っているだけ」では不可。担当者（追加担当を含む）または管理者のみ。
 */
function canOperate(interaction: Interaction, services: Services, id: number): boolean {
  if (isAdmin(interaction, services)) return true;
  // 主担当(claimed_by) は常に可（Phase 2 以前に claim され assignees 未登録の旧案件も救済）
  if (services.confessions.get(id)?.claimed_by === interaction.user.id) return true;
  return services.confessions.isAssignee(id, interaction.user.id);
}

/** 本文の表示。purge済みなら削除された旨を出す（§Phase2-5） */
function bodyOrPurgeNotice(row: ConfessionRow): string {
  if (row.body_purged_at) {
    return "## 届いた声\n> この案件の本文は、保存期間の経過または管理者操作により削除されています。";
  }
  return `## 届いた声\n${(row.body ?? "（本文の記録なし）").slice(0, 3800)}`;
}

/** 対応スレッドの管理パネル embed（案件の現状を一覧表示）。担当者IDのみ表示、投稿者IDは出さない */
function buildCaseEmbed(row: ConfessionRow, assigneeIds: string[]): EmbedBuilder {
  const color = row.type === "kinkyu" || row.stage === "emergency" ? 0xdc2626 : row.status === "closed" ? 0x6b7280 : PANEL_COLOR;
  const staff = assigneeIds.length > 0 ? assigneeIds.map((u) => `<@${u}>`).join("・") : row.claimed_by ? `<@${row.claimed_by}>` : "—";
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`👂 トートの耳 ${recordNo(row.id)}`)
    .addFields(
      { name: "種別", value: typeText(row.type), inline: true },
      { name: "返信希望", value: wishText(row.reply_wish), inline: true },
      { name: "状態", value: statusText(row), inline: true },
      { name: "担当者", value: staff, inline: true },
      { name: "対応先", value: dispoText(row.disposition), inline: true },
      { name: "受付日時", value: jstStamp(row.created_at), inline: true },
    );
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

/** 管理パネルの操作ボタン。閉じている案件は再オープンのみ */
function managementControls(id: number, row: ConfessionRow): ActionRowBuilder<ButtonBuilder>[] {
  if (row.status === "closed") {
    const btns = [
      new ButtonBuilder().setCustomId(`mimi:reopen:${id}`).setLabel("再オープン").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
    ];
    // 本文がまだ残っているなら、管理者向けに手動purge・保持延長を出す（§Phase2-5）
    if (row.body && !row.body_purged_at) {
      btns.push(
        new ButtonBuilder().setCustomId(`mimi:extend:${id}`).setLabel("保持延長").setEmoji("📅").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mimi:purgenow:${id}`).setLabel("本文を削除").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
      );
    }
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...btns)];
  }
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mimi:disp:${id}`).setLabel("対応先").setEmoji("📍").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mimi:stage:${id}`).setLabel("状態").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mimi:assign:${id}`).setLabel("担当者").setEmoji("👥").setStyle(ButtonStyle.Secondary),
  );
  // 送致状況で裁判所ボタンの意味を切り替える
  let courtBtn: ButtonBuilder;
  if (row.court_status === "sent") {
    courtBtn = new ButtonBuilder().setCustomId(`mimi:courtcaseno:${id}`).setLabel("事件番号").setEmoji("⚖️").setStyle(ButtonStyle.Success);
  } else if (row.court_status === "pending_consent") {
    courtBtn = new ButtonBuilder().setCustomId(`mimi:courtcancel:${id}`).setLabel("送致を取消").setEmoji("⚖️").setStyle(ButtonStyle.Secondary);
  } else {
    courtBtn = new ButtonBuilder().setCustomId(`mimi:court:${id}`).setLabel("裁判所へ送致").setEmoji("⚖️").setStyle(ButtonStyle.Secondary);
  }
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    courtBtn,
    new ButtonBuilder().setCustomId(`mimi:emg:${id}`).setLabel("緊急対応").setEmoji("🚨").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mimi:close:${id}`).setLabel("クローズ").setEmoji("🔒").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2];
}

/** スレッドの管理パネル（panel_msg_id）を現状で描き直す */
async function refreshPanel(client: Client, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row?.thread_id || !row.panel_msg_id) return;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.isThread()) return;
  const msg = await thread.messages.fetch(row.panel_msg_id).catch(() => null);
  if (!msg) return;
  await msg
    .edit({ embeds: [buildCaseEmbed(row, services.confessions.assignees(id))], components: managementControls(id, row) })
    .catch(() => undefined);
}

/** スレッドへ操作ログ行を残す（人間可読。EventLog とは別に、その場で見えるように） */
async function threadLog(client: Client, services: Services, id: number, line: string): Promise<void> {
  const row = services.confessions.get(id);
  if (!row?.thread_id) return;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (thread?.isThread()) await thread.send({ content: line, allowedMentions: { parse: [] } }).catch(() => undefined);
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
      await interaction.reply({ content: "種類と返信希望を先に選んでください。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(bodyModal(type, wish));
    return;
  }

  // 告発者: DM の「返信する」→ モーダル
  if (action === "reply") {
    const id = Number(idStr);
    const row = services.confessions.get(id);
    if (!row || row.status === "closed") {
      await interaction.reply({ content: "この件は既に閉じられています。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(replyModal(id));
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
    case "disp":
      await opGuarded(() => interaction.reply({ ...dispSelectMsg(id), flags: MessageFlags.Ephemeral }));
      return;
    case "stage":
      await opGuarded(() => interaction.reply({ ...stageSelectMsg(id), flags: MessageFlags.Ephemeral }));
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
    case "purgenow":
      // 本文の手動削除は管理者のみ（限定された管理者による手動purge・§Phase2-5）
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
      if (!isAdmin(interaction, services)) {
        await interaction.reply({ content: "保持延長は管理者のみ可能です。", flags: MessageFlags.Ephemeral });
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

  // ── 対応先の確定（§Phase2-1） ──
  if (action === "dispset") {
    if (!canOperate(interaction, services, id)) {
      await interaction.update({ content: "担当者または管理者のみ操作できます。", components: [] });
      return;
    }
    const disp = interaction.values[0] as Disposition;
    services.confessions.setDisposition(id, disp, interaction.user.id);
    await threadLog(
      interaction.client,
      services,
      id,
      `📍 <@${interaction.user.id}> が対応先を「${DISPO_META[disp].emoji} ${DISPO_META[disp].label}」へ変更しました。`,
    );
    await refreshPanel(interaction.client, services, id);
    await interaction.update({ content: `📍 対応先を「${DISPO_META[disp].label}」に設定しました。`, components: [] });
    return;
  }

  // ── 状態の変更（§Phase2-2） ──
  if (action === "stageset") {
    if (!canOperate(interaction, services, id)) {
      await interaction.update({ content: "担当者または管理者のみ操作できます。", components: [] });
      return;
    }
    const stage = interaction.values[0] as ConfessionStage;
    services.confessions.setStage(id, stage, interaction.user.id);
    await threadLog(interaction.client, services, id, `🔄 <@${interaction.user.id}> が状態を「${STAGE_META[stage]}」へ変更しました。`);
    await refreshPanel(interaction.client, services, id);
    await interaction.update({ content: `🔄 状態を「${STAGE_META[stage]}」に変更しました。`, components: [] });
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
    // 緊急種別はひと目で分かるよう色を変える
    const embed = new EmbedBuilder()
      .setAuthor({ name: "👂 トートの耳 — 匿名の囁き" })
      .setColor(type === "kinkyu" ? 0xdc2626 : PANEL_COLOR)
      .setTitle(recordNo(row.id))
      .addFields(
        { name: "種別", value: typeText(row.type), inline: true },
        { name: "返信希望", value: wishText(row.reply_wish), inline: true },
        { name: "状態", value: statusText(row), inline: true },
        { name: "受付日時", value: jstStamp(row.created_at), inline: false },
      )
      .setDescription(`## 届いた声\n${text.slice(0, 4000)}`)
      .setFooter({ text: "投稿者は匿名。対応を開始するとトートが仲介します。" });
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mimi:claim:${row.id}`).setLabel("対応する").setEmoji("🤝").setStyle(ButtonStyle.Primary),
    );
    const staffRoleId = services.settings.getString("role:ticket_staff");
    await (ch as TextChannel)
      .send({
        content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
        embeds: [embed],
        components: [controls],
        allowedMentions: { roles: staffRoleId ? [staffRoleId] : [] },
      })
      .catch(() => undefined);

    await interaction.editReply({
      content: "🕯 あなたの声は、トートの耳に届いた。運営から返信があれば、この DM にそっと届く。",
    });
    return;
  }

  // 告発者: 返信
  if (action === "replybody") {
    const id = Number(parts[2]);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const row = services.confessions.get(id);
    if (!row || row.status === "closed" || row.user_id !== interaction.user.id) {
      await interaction.editReply({ content: "この件は既に閉じられているか、返信できません。" });
      return;
    }
    if (!row.thread_id) {
      await interaction.editReply({ content: "まだ運営が対応を開始していません。少し待ってください。" });
      return;
    }
    const text = interaction.fields.getTextInputValue("text").trim();
    const thread = await interaction.client.channels.fetch(row.thread_id).catch(() => null);
    if (thread?.isThread()) {
      await thread
        .send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x0ea5e9)
              .setAuthor({ name: "🗣 告発者より（匿名）" })
              .setDescription(text.slice(0, 4000))
              .setTimestamp(new Date()),
          ],
        })
        .catch(() => undefined);
    }
    // 投稿者が返信した → 担当者の番。状態を「担当者からの返信待ち」へ
    if (row.stage !== "emergency" && row.stage !== "court_sent") {
      services.confessions.setStage(id, "awaiting_staff", "system:relay");
      await refreshPanel(interaction.client, services, id);
    }
    await interaction.editReply({ content: "📨 運営に届けた。" });
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
    embeds: [buildCaseEmbed(claimed, services.confessions.assignees(id))],
    components: managementControls(id, claimed),
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
  services.confessions.close(id, interaction.user.id, reason, retentionDays);
  // 未終了の緊急対応があれば併せて終了
  const openEmg = services.confessions.openEmergencyFor(id);
  if (openEmg) services.confessions.closeEmergency(openEmg.id, interaction.user.id);

  // 告発者へ終了通知（§16 の文面）
  const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
  await user
    ?.send(
      [
        "# 🕯️ トートの耳",
        "",
        "この相談への対応は終了しました。",
        "",
        `**終了理由：** ${CLOSE_META[reason]}`,
        "",
        "再び伝えたいことがある場合は、トートの耳から新しく囁くことができます。",
      ].join("\n"),
    )
    .catch(() => undefined);

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
  const body = message.content.trim();
  if (!body) return;

  const user = await client.users.fetch(row.user_id).catch(() => null);
  if (!user) return;
  const sent = await user
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(PANEL_COLOR)
          .setAuthor({ name: `👂 トートの耳 #${row.id} — 運営より` })
          .setDescription(body.slice(0, 4000))
          .setFooter({ text: "下のボタンから匿名のまま返信できます" }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mimi:reply:${row.id}`).setLabel("返信する").setEmoji("✍️").setStyle(ButtonStyle.Primary),
        ),
      ],
    })
    .then(() => true)
    .catch(() => false);

  // 届いたか/届かなかったかをスレッドに小さくフィードバック（リアクション）
  await message.react(sent ? "📨" : "⚠️").catch(() => undefined);

  // 担当者が発信した → 投稿者の番。通常の対応中のみ状態を更新（緊急/送致済みは維持）
  if (sent && (row.stage === "active" || row.stage === "awaiting_staff" || row.stage === "awaiting_poster")) {
    if (row.stage !== "awaiting_poster") {
      services.confessions.setStage(row.id, "awaiting_poster", "system:relay");
      await refreshPanel(client, services, row.id);
    }
  }
}

// ═════════════════════════════════════════════════════
// Phase 2: 対応先・状態・担当者・クローズ の選択UI
// ═════════════════════════════════════════════════════
function dispSelectMsg(id: number) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:dispset:${id}`)
    .setPlaceholder("対応先を選ぶ")
    .addOptions(
      DISPO_ORDER.map((code) =>
        new StringSelectMenuOptionBuilder().setValue(code).setLabel(DISPO_META[code].label).setEmoji(DISPO_META[code].emoji),
      ),
    );
  return { content: "この案件の対応先を選んでください。", components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

function stageSelectMsg(id: number) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mimi:stageset:${id}`)
    .setPlaceholder("状態を選ぶ")
    .addOptions(STAGE_ORDER.map((code) => new StringSelectMenuOptionBuilder().setValue(code).setLabel(STAGE_META[code])));
  return { content: "現在の状態を選んでください。", components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

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
