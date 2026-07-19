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
  type Client,
  type GuildMember,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";
import type { ConfessionRow, ConfessionType, ReplyWish } from "@meigokujo/core";

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
/** 担当者向けの状態表示。Phase 1 は open/claimed/closed を人間向け語に写像 */
function statusText(row: ConfessionRow): string {
  switch (row.status) {
    case "open":
      return "🕯️ 未対応";
    case "claimed":
      return "🤝 対応中";
    case "closed":
      return "✅ 終結";
    default:
      return row.status;
  }
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

  // ここから下は運営操作
  if (action === "claim") {
    if (!isConfessionStaff(interaction, services)) {
      await interaction.reply({ content: "対応はスタッフのみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await claimConfession(interaction, services, Number(idStr));
    return;
  }
  if (action === "close") {
    if (!isConfessionStaff(interaction, services)) {
      await interaction.reply({ content: "スタッフのみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await closeConfession(interaction, services, Number(idStr));
    return;
  }
  if (action === "role") {
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
  if (action === "block") {
    if (!isConfessionStaff(interaction, services)) {
      await interaction.reply({ content: "スタッフのみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await blockConfession(interaction, services, Number(idStr));
    return;
  }
}

// ─────────────────────────────────────────────────────
// 文字列セレクト（告発者の種別・返信希望の選択）
// index.ts の StringSelectMenu(mimi:) 分岐から呼ぶ
// ─────────────────────────────────────────────────────
export async function handleConfessionStringSelect(
  interaction: StringSelectMenuInteraction,
  _services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  if (action !== "seltype" && action !== "selwish") return;

  // 現在の選択状態を「書く」ボタンの customId から読み、片方だけ更新して再描画
  const current = readSelection(interaction.message);
  const next =
    action === "seltype"
      ? { type: interaction.values[0] ?? "-", wish: current.wish }
      : { type: current.type, wish: interaction.values[0] ?? "-" };
  await interaction.update(selectionMessage(next.type, next.wish));
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
    await interaction.editReply({ content: "📨 運営に届けた。" });
    return;
  }
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

  // 案件情報（§8）。対応先は Phase 2 で追加予定のため現状は「未設定」
  const info = new EmbedBuilder()
    .setColor(claimed.type === "kinkyu" ? 0xdc2626 : PANEL_COLOR)
    .setTitle(`👂 トートの耳 ${recordNo(id)}`)
    .addFields(
      { name: "種別", value: typeText(claimed.type), inline: true },
      { name: "返信希望", value: wishText(claimed.reply_wish), inline: true },
      { name: "状態", value: statusText(claimed), inline: true },
      { name: "担当者", value: `<@${interaction.user.id}>`, inline: true },
      { name: "対応先", value: "未設定", inline: true },
      { name: "受付日時", value: jstStamp(claimed.created_at), inline: true },
    )
    .setDescription(`## 届いた声\n${(claimed.body ?? "（本文の記録なし）").slice(0, 4000)}`);

  // Phase 1 のスレッド操作はクローズのみ（ロール付与・出禁は撤去）
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mimi:close:${id}`).setLabel("クローズ").setEmoji("🔒").setStyle(ButtonStyle.Danger),
  );
  await thread.send({
    content: [
      `🤝 <@${interaction.user.id}> が **${recordNo(id)}** の対応を開始。`,
      "**このスレッドに書くと、トートが投稿者の DM へ匿名で届けます。**（投稿者の正体はトートしか知りません）",
    ].join("\n"),
    embeds: [info],
    components: [controls],
  });

  await interaction.editReply({ content: `✅ 対応スレッドを開きました: <#${thread.id}>` });
}

async function closeConfession(interaction: ButtonInteraction, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) return;
  services.confessions.close(id, interaction.user.id);
  await interaction.reply({ content: `🔒 <@${interaction.user.id}> が #${id} をクローズしました。` });
  // 告発者に通知
  const guild = interaction.guild;
  const member = guild ? await guild.members.fetch(row.user_id).catch(() => null) : null;
  await member?.send(`🔒 トートの耳 #${id} は運営側でクローズされた。ありがとう。`).catch(() => undefined);
  const thread = interaction.channel;
  if (thread?.isThread()) {
    await thread.setLocked(true).catch(() => undefined);
    await thread.setArchived(true).catch(() => undefined);
  }
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
}
