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

/** 懺悔室に設置するパネル */
export function confessionPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("👂 トートの耳")
    .setColor(PANEL_COLOR)
    .setDescription(
      [
        "運営や特定の役職に、**完全に匿名で** 伝えたいことを届けられる。",
        "告発・相談・懺悔——なんでもいい。",
        "",
        "ボタンを押すと入力欄が開く。**あなたが誰かは運営には一切分からない**。",
        "運営から返信があれば、トートがあなたの DM にそっと届ける。",
      ].join("\n"),
    )
    .setFooter({ text: "トートだけがあなたの声を預かる" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mimi:new").setLabel("そっと囁く").setEmoji("👂").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function bodyModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("mimi:body")
    .setTitle("トートの耳（匿名）")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("伝えたいこと（匿名で運営に届きます）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800),
      ),
    );
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

  // 告発者: そっと囁く → モーダル
  if (action === "new") {
    await interaction.showModal(bodyModal());
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
// モーダル送信
// ─────────────────────────────────────────────────────
export async function handleConfessionModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  // 告発者: 新規の囁き
  if (action === "body") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const uid = interaction.user.id;
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

    const row = services.confessions.create(uid);
    const embed = new EmbedBuilder()
      .setAuthor({ name: "👂 トートの耳 — 匿名の囁き" })
      .setColor(PANEL_COLOR)
      .setTitle(`#${row.id}`)
      .setDescription(text.slice(0, 4000))
      .setFooter({ text: "投稿者は完全匿名。対応するとトートが仲介します。" })
      .setTimestamp(new Date());
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
  services.confessions.claim(id, thread.id, interaction.user.id);

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mimi:close:${id}`).setLabel("クローズ").setEmoji("🔒").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mimi:role:${id}`).setLabel("ロール付与").setEmoji("🎭").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mimi:block:${id}`).setLabel("出禁").setEmoji("🚫").setStyle(ButtonStyle.Secondary),
  );
  await thread.send({
    content: [
      `🤝 <@${interaction.user.id}> が **トートの耳 #${id}** の対応を開始。`,
      "**このスレッドに書くと、トートが告発者の DM に匿名で届けます。**（告発者の正体はトートしか知りません）",
    ].join("\n"),
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
