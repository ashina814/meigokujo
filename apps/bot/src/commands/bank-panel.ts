import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type Message,
  type TextChannel,
} from "discord.js";
import { fmtLd, formatHistLine } from "../format.js";
import { isAdmin } from "../permissions.js";
import { entryPanelMessage } from "./entry.js";
import type { Services } from "../services.js";

export const panelCommand = new SlashCommandBuilder()
  .setName("パネル設置")
  .setDescription("常設パネルをこのチャンネルに設置する（運営専用）")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("種別")
      .setDescription("設置するパネル")
      .setRequired(true)
      .addChoices({ name: "冥獄銀行", value: "bank" }, { name: "入城申請", value: "entry" }),
  );

const PANEL_KINDS = ["bank", "entry"] as const;

function bankPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("🏛 冥獄銀行")
    .setDescription(
      ["ボタンの応答はあなたにだけ表示されます。", "", "💸 送金は `/送金` — どのチャンネルからでも使えます。"].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bank:balance").setLabel("残高照会").setEmoji("💰").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bank:hist:0").setLabel("取引履歴").setEmoji("📜").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel as TextChannel | null;
  if (!channel?.isTextBased()) return;

  const kind = interaction.options.getString("種別", true);
  const sent = await channel.send(kind === "entry" ? entryPanelMessage() : bankPanelMessage());
  await sent.pin().catch(() => undefined); // ピン留め権限がなくても設置自体は成立させる
  services.settings.set(`panel:${kind}:${channel.id}`, sent.id, `user:${interaction.user.id}`);
  await interaction.reply({
    content: `✅ ${kind === "entry" ? "入城申請" : "冥獄銀行"}パネルを設置しました（会話で流れたら自動で貼り直します）。`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleBankButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const account = `user:${interaction.user.id}`;
  services.ledger.ensureAccount(account, "user");

  if (interaction.customId === "bank:balance") {
    await interaction.reply({
      content: `💰 所持 Land: **${fmtLd(services.ledger.balanceOf(account))}**`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId.startsWith("bank:hist:")) {
    const offset = Number(interaction.customId.split(":")[2] ?? 0);
    const pageSize = 10;
    const rows = services.ledger.history(account, { limit: pageSize + 1, offset });
    const hasNext = rows.length > pageSize;
    const page = rows.slice(0, pageSize);

    const lines =
      page.length > 0
        ? page.map((tx) => formatHistLine(tx, account)).join("\n")
        : "まだ取引がありません。";
    const embed = new EmbedBuilder()
      .setTitle("📜 取引履歴")
      .setDescription(lines)
      .setFooter({ text: `${offset + 1}〜${offset + page.length} 件目 / 残高 ${fmtLd(services.ledger.balanceOf(account))}` })
      .setColor(0x6b21a8);

    const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bank:hist:${Math.max(0, offset - pageSize)}`)
        .setLabel("新しい方へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(offset === 0),
      new ButtonBuilder()
        .setCustomId(`bank:hist:${offset + pageSize}`)
        .setLabel("古い方へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasNext),
    );

    // パネル上のボタン → 新規エフェメラル / エフェメラル内のページ送り → その場で更新
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.update({ embeds: [embed], components: [nav] });
    } else {
      await interaction.reply({ embeds: [embed], components: [nav], flags: MessageFlags.Ephemeral });
    }
  }
}

// ---- パネル自動再掲（UX原則8: パネルは埋もれたら貼り直す） ----

const lastRepost = new Map<string, number>();
const REPOST_DEBOUNCE_MS = 30_000;

export async function maybeRepostPanel(message: Message, services: Services): Promise<void> {
  if (message.author.bot) return;
  for (const kind of PANEL_KINDS) {
    const panelMsgId = services.settings.getString(`panel:${kind}:${message.channelId}`);
    if (!panelMsgId) continue;

    const now = Date.now();
    const key = `${kind}:${message.channelId}`;
    if ((lastRepost.get(key) ?? 0) > now - REPOST_DEBOUNCE_MS) continue;
    lastRepost.set(key, now);

    const channel = message.channel as TextChannel;
    const old = await channel.messages.fetch(panelMsgId).catch(() => null);
    if (old) await old.delete().catch(() => undefined);
    const sent = await channel.send(kind === "entry" ? entryPanelMessage() : bankPanelMessage());
    services.settings.set(`panel:${kind}:${channel.id}`, sent.id, "system:panel-repost");
  }
}
