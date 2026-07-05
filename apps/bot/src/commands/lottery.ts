import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type TextChannel,
} from "discord.js";
import { LedgerError, LotteryError, type DrawResult, type LotteryRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { notifyUser } from "../notify.js";
import type { Services } from "../services.js";

export const lotteryCommand = new SlashCommandBuilder()
  .setName("籤")
  .setDescription("輪廻籤（宝くじ）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("開催")
      .setDescription("新しい輪廻籤を開く（運営）")
      .addIntegerOption((o) => o.setName("価格").setDescription("1枚あたりの Land").setRequired(true).setMinValue(1))
      .addIntegerOption((o) => o.setName("時間").setDescription("抽選までの時間（h）").setRequired(true).setMinValue(1).setMaxValue(336))
      .addIntegerOption((o) => o.setName("控除率").setDescription("ハウスエッジ％（既定20）").setMinValue(0).setMaxValue(90)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("積立")
      .setDescription("繰越（当選プール）を国庫から積む（運営）")
      .addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) => sub.setName("抽選").setDescription("開催中の籤を今すぐ抽選する（運営）"))
  .addSubcommand((sub) => sub.setName("取消").setDescription("開催中の籤を取り消して全額返金（運営）"))
  .addSubcommand((sub) => sub.setName("状況").setDescription("開催中の籤の状況と自分の枚数"));

// ---- パネル ----

export function lotteryPanelMessage(services: Services, l: LotteryRow) {
  const open = l.status === "open";
  const total = services.lottery.totalTickets(l.id);
  const embed = new EmbedBuilder()
    .setTitle(`🎟 輪廻籤 #${l.id}`)
    .setColor(open ? 0x8b5cf6 : 0x52525b)
    .setDescription(
      [
        `想定当選額: **${fmtLd(services.lottery.jackpot(l))}**${l.carryover_in > 0 ? `（うち繰越 ${fmtLd(l.carryover_in)}）` : ""}`,
        `1枚 **${fmtLd(l.ticket_price)}** ／ 控除 ${(l.house_edge_bps / 100).toFixed(0)}%`,
        `参加 ${services.lottery.entries(l.id).length}名 ／ 総枚数 ${total}枚`,
        open ? `抽選: <t:${l.draws_at}:R>（<t:${l.draws_at}:f>）` : l.status === "drawn" ? (l.winner_id ? `🎉 当選: <@${l.winner_id}>（${fmtLd(l.prize ?? 0)}）` : "参加者なしで終了（繰越へ）") : "🚫 取り消されました",
      ].join("\n"),
    )
    .setFooter({ text: "当選確率は購入枚数に比例します" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lot:qbuy:${l.id}:1`).setLabel("1枚").setEmoji("🎟").setStyle(ButtonStyle.Primary).setDisabled(!open),
    new ButtonBuilder().setCustomId(`lot:qbuy:${l.id}:10`).setLabel("10枚").setEmoji("🎟").setStyle(ButtonStyle.Primary).setDisabled(!open),
    new ButtonBuilder().setCustomId(`lot:buy:${l.id}`).setLabel(open ? "まとめ買い…" : "終了").setStyle(ButtonStyle.Secondary).setDisabled(!open),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

export async function refreshLotteryPanel(client: Client, services: Services, l: LotteryRow): Promise<void> {
  if (!l.channel_id || !l.message_id) return;
  const ch = (await client.channels.fetch(l.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(l.message_id).catch(() => null);
  await msg?.edit(lotteryPanelMessage(services, l)).catch(() => undefined);
}

// ---- コマンド ----

export async function handleLotteryCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "状況") {
    const l = services.lottery.activeOpen();
    if (!l) {
      await interaction.reply({ content: "開催中の輪廻籤はありません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const mine = services.lottery.ticketsOf(l.id, interaction.user.id);
    await interaction.reply({
      content: [
        `🎟 輪廻籤 #${l.id} — 想定当選額 **${fmtLd(services.lottery.jackpot(l))}**`,
        `1枚 ${fmtLd(l.ticket_price)} ／ あなたの持ち枚数 **${mine}枚** ／ 抽選 <t:${l.draws_at}:R>`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "開催") {
    const ticketPrice = interaction.options.getInteger("価格", true);
    const hours = interaction.options.getInteger("時間", true);
    const edgePct = interaction.options.getInteger("控除率") ?? 20;
    const drawsAt = Math.floor(Date.now() / 1000) + hours * 3600;
    try {
      const l = services.lottery.open({ ticketPrice, houseEdgeBps: edgePct * 100, drawsAt, createdBy: `user:${interaction.user.id}` });
      const channel = interaction.channel as TextChannel | null;
      if (channel?.isTextBased()) {
        const sent = await channel.send(lotteryPanelMessage(services, l)).catch(() => null);
        if (sent) {
          services.lottery.setPanel(l.id, sent.channelId, sent.id);
          await sent.pin().catch(() => undefined);
        }
      }
      await interaction.reply({ content: `✅ 輪廻籤 #${l.id} を開催しました（抽選 <t:${drawsAt}:R>）。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      const msg = e instanceof LotteryError && e.code === "ERR_LOTTERY_EXISTS" ? "すでに開催中の籤があります。先に抽選/取消してください。" : "開催に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (sub === "積立") {
    const amount = interaction.options.getInteger("金額", true);
    try {
      const carry = services.lottery.seed(amount, `user:${interaction.user.id}`);
      const l = services.lottery.activeOpen();
      if (l) await refreshLotteryPanel(interaction.client, services, services.lottery.get(l.id)!);
      await interaction.reply({ content: `✅ 繰越に **${fmtLd(amount)}** を積みました（現在の繰越 ${fmtLd(carry)}）。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      const msg = e instanceof LedgerError ? `台帳エラー: ${e.code}` : "積立に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // 抽選 / 取消
  const l = services.lottery.activeOpen();
  if (!l) {
    await interaction.reply({ content: "開催中の輪廻籤はありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (sub === "抽選") {
    const res = services.lottery.draw(l.id, `user:${interaction.user.id}`);
    await refreshLotteryPanel(interaction.client, services, res.lottery);
    await announceDraw(interaction.client, services, res);
    await interaction.reply({
      content: res.winnerId ? `🎉 #${l.id} 当選: <@${res.winnerId}>（${fmtLd(res.prize)}）／ 控除 ${fmtLd(res.rake)}` : `#${l.id} 参加者なしで終了。繰越は次回へ持ち越します。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (sub === "取消") {
    services.lottery.cancel(l.id, `user:${interaction.user.id}`);
    await refreshLotteryPanel(interaction.client, services, services.lottery.get(l.id)!);
    await interaction.reply({ content: `🚫 #${l.id} を取り消し、参加者へ返金しました。`, flags: MessageFlags.Ephemeral });
    return;
  }
}

// ---- 購入（ボタン → モーダル）----

export async function handleLotteryButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // lot:buy:id / lot:qbuy:id:qty
  const id = Number(parts[2]);
  const l = services.lottery.get(id);
  if (!l || l.status !== "open") {
    await interaction.reply({ content: "この籤は終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }

  // クイック購入（1枚/10枚）はモーダルなしで即時
  if (parts[1] === "qbuy") {
    const qty = Number(parts[3]);
    try {
      const res = services.lottery.buy({ lotteryId: id, userId: interaction.user.id, qty, idempotencyKey: `lot-qbuy:${interaction.id}` });
      const fresh = services.lottery.get(id)!;
      await refreshLotteryPanel(interaction.client, services, fresh);
      await interaction.reply({ content: `✅ ${qty}枚 購入しました（−${fmtLd(res.cost)}）。持ち枚数 **${res.qty}枚** ／ 想定当選額 ${fmtLd(services.lottery.jackpot(fresh))}`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      let msg = "購入に失敗しました。";
      if (e instanceof LotteryError && (e.code === "ERR_LOTTERY_ENDED" || e.code === "ERR_LOTTERY_CLOSED")) msg = "この籤は終了しています。";
      else if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))}）。`;
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`lot:buymodal:${id}`)
    .setTitle(`輪廻籤#${id} 購入`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("qty").setLabel(`枚数（1枚 ${l.ticket_price.toLocaleString()} Ld）`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleLotteryBuyModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const id = Number(interaction.customId.split(":")[2]);
  const qty = Number(interaction.fields.getTextInputValue("qty").replace(/[,，\s]/g, ""));
  if (!Number.isInteger(qty) || qty <= 0) {
    await interaction.reply({ content: "枚数は正の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    const res = services.lottery.buy({ lotteryId: id, userId: interaction.user.id, qty, idempotencyKey: `lot-buy:${interaction.id}` });
    const l = services.lottery.get(id)!;
    await refreshLotteryPanel(interaction.client, services, l);
    await interaction.reply({ content: `✅ ${qty}枚 購入しました（−${fmtLd(res.cost)}）。持ち枚数 **${res.qty}枚** ／ 想定当選額 ${fmtLd(services.lottery.jackpot(l))}`, flags: MessageFlags.Ephemeral });
  } catch (e) {
    let msg = "購入に失敗しました。";
    if (e instanceof LotteryError && (e.code === "ERR_LOTTERY_ENDED" || e.code === "ERR_LOTTERY_CLOSED")) msg = "この籤は終了しています。";
    else if (e instanceof LotteryError && e.code === "ERR_BAD_QTY") msg = "枚数が不正です（1〜1000）。";
    else if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))}）。`;
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

// ---- 抽選告知（手動・自動共通）----

export async function announceDraw(client: Client, services: Services, res: DrawResult): Promise<void> {
  const l = res.lottery;
  if (l.channel_id) {
    const ch = (await client.channels.fetch(l.channel_id).catch(() => null)) as TextChannel | null;
    if (ch?.isTextBased()) {
      await ch
        .send({
          content: res.winnerId
            ? `🎉 輪廻籤 #${l.id} 当選発表！ <@${res.winnerId}> が **${fmtLd(res.prize)}** を引き当てました（総 ${res.totalTickets}枚 / 参加 ${res.participants}名）。`
            : `🎟 輪廻籤 #${l.id} は参加者がなく、当選プールは次回へ繰り越されました。`,
          allowedMentions: { users: res.winnerId ? [res.winnerId] : [] },
        })
        .catch(() => undefined);
    }
  }
  if (res.winnerId) {
    await notifyUser(client, services, res.winnerId, `🎉 輪廻籤 #${l.id} に当選しました！ **${fmtLd(res.prize)}** を獲得。`, { fallbackChannelKey: "channel:shurei" }).catch(() => undefined);
  }
}
