import {
  ActionRowBuilder,
  AutocompleteInteraction,
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
import { AuctionError, LedgerError, type AuctionRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { notifyUser } from "../notify.js";
import type { Services } from "../services.js";

export const auctionCommand = new SlashCommandBuilder()
  .setName("競売")
  .setDescription("冥界競売（オークション）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("作成")
      .setDescription("競売を出品する（運営）")
      .addStringOption((o) => o.setName("品名").setDescription("出品名（例: 色ロール命名権）").setRequired(true).setMaxLength(100))
      .addIntegerOption((o) => o.setName("開始価格").setDescription("Land").setRequired(true).setMinValue(0))
      .addIntegerOption((o) => o.setName("時間").setDescription("締切までの時間（h）").setRequired(true).setMinValue(1).setMaxValue(168))
      .addStringOption((o) => o.setName("説明").setDescription("品の説明（任意）").setMaxLength(500))
      .addIntegerOption((o) => o.setName("最低増分").setDescription("1回の最低上乗せ額（既定1,000）").setMinValue(1)),
  )
  .addSubcommand((sub) => sub.setName("一覧").setDescription("開催中の競売を表示"))
  .addSubcommand((sub) =>
    sub
      .setName("締切")
      .setDescription("競売を早めに締め切って落札確定（運営）")
      .addIntegerOption((o) => o.setName("競売").setDescription("対象の競売").setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("取消")
      .setDescription("競売を取り消して返金（運営）")
      .addIntegerOption((o) => o.setName("競売").setDescription("対象の競売").setRequired(true).setAutocomplete(true)),
  );

// ---- パネル ----

export function auctionPanelMessage(services: Services, a: AuctionRow) {
  const open = a.status === "open";
  const leader = a.current_bidder ? `<@${a.current_bidder}>` : "—";
  const priceLine = a.current_bid
    ? `現在の最高額: **${fmtLd(a.current_bid)}**（${leader}）`
    : `開始価格: **${fmtLd(a.start_price)}**（入札なし）`;
  const embed = new EmbedBuilder()
    .setTitle(`🔨 競売 #${a.id}: ${a.title}`)
    .setColor(open ? 0xf0b429 : 0x52525b)
    .setDescription(
      [
        a.description ?? "",
        "",
        priceLine,
        open ? `次の最低入札額: ${fmtLd(services.auctions.minNextBid(a))}` : "",
        open ? `締切: <t:${a.ends_at}:R>（<t:${a.ends_at}:f>）` : a.status === "closed" ? "🏁 **落札しました**" : "🚫 取り消されました",
      ]
        .filter((s) => s !== "")
        .join("\n"),
    )
    .setFooter({ text: `入札 ${services.auctions.bidCount(a.id)} 件` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`auc:bid:${a.id}`)
      .setLabel(open ? "入札する" : "終了")
      .setEmoji("🔨")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!open),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

/** 保存済みパネルメッセージを最新状態に貼り替える */
export async function refreshAuctionPanel(client: Client, services: Services, a: AuctionRow): Promise<void> {
  if (!a.channel_id || !a.message_id) return;
  const ch = (await client.channels.fetch(a.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(a.message_id).catch(() => null);
  await msg?.edit(auctionPanelMessage(services, a)).catch(() => undefined);
}

// ---- コマンド ----

export async function handleAuctionCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "一覧") {
    const rows = services.auctions.listOpen();
    const embed = new EmbedBuilder()
      .setTitle("🔨 開催中の競売")
      .setColor(0xf0b429)
      .setDescription(
        rows.length > 0
          ? rows
              .map((a) => `**#${a.id} ${a.title}** — ${a.current_bid ? `最高 ${fmtLd(a.current_bid)}` : `開始 ${fmtLd(a.start_price)}`}　締切 <t:${a.ends_at}:R>`)
              .join("\n")
          : "開催中の競売はありません。",
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  // 作成/締切/取消 は運営
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "作成") {
    const title = interaction.options.getString("品名", true);
    const startPrice = interaction.options.getInteger("開始価格", true);
    const hours = interaction.options.getInteger("時間", true);
    const description = interaction.options.getString("説明") ?? undefined;
    const minIncrement = interaction.options.getInteger("最低増分") ?? 1_000;
    const endsAt = Math.floor(Date.now() / 1000) + hours * 3600;

    const auction = services.auctions.create({
      title,
      description,
      startPrice,
      minIncrement,
      endsAt,
      createdBy: `user:${interaction.user.id}`,
    });

    const channel = interaction.channel as TextChannel | null;
    if (channel?.isTextBased()) {
      const sent = await channel.send(auctionPanelMessage(services, auction)).catch(() => null);
      if (sent) {
        services.auctions.setPanel(auction.id, sent.channelId, sent.id);
        await sent.pin().catch(() => undefined);
      }
    }
    await interaction.reply({ content: `✅ 競売 #${auction.id}「${title}」を出品しました（締切 <t:${endsAt}:R>）。`, flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getInteger("競売", true);
  try {
    if (sub === "締切") {
      const res = services.auctions.close(id, `user:${interaction.user.id}`);
      await refreshAuctionPanel(interaction.client, services, res.auction);
      await announceResult(interaction.client, services, res.auction, res.winnerId, res.amount);
      await interaction.reply({
        content: res.winnerId ? `🏁 #${id} 落札: <@${res.winnerId}>（${fmtLd(res.amount)}）` : `🏁 #${id} 入札なしで終了しました。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (sub === "取消") {
      const a = services.auctions.cancel(id, `user:${interaction.user.id}`);
      await refreshAuctionPanel(interaction.client, services, a);
      await interaction.reply({ content: `🚫 #${id} を取り消しました${a.current_bidder ? "（最高額者へ返金済み）" : ""}。`, flags: MessageFlags.Ephemeral });
      return;
    }
  } catch (e) {
    const msg = e instanceof AuctionError && e.code === "ERR_AUCTION_NOT_FOUND" ? "その競売は見つかりません。" : e instanceof AuctionError && e.code === "ERR_AUCTION_CLOSED" ? "その競売はすでに終了しています。" : "処理に失敗しました。";
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

// ---- 入札（ボタン → モーダル）----

export async function handleAuctionButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const id = Number(interaction.customId.split(":")[2]);
  const a = services.auctions.get(id);
  if (!a || a.status !== "open") {
    await interaction.reply({ content: "この競売は終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`auc:bidmodal:${id}`)
    .setTitle(`競売#${id} に入札`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel(`入札額（最低 ${services.auctions.minNextBid(a).toLocaleString()} Ld）`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(15),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleAuctionBidModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const id = Number(interaction.customId.split(":")[2]);
  const raw = interaction.fields.getTextInputValue("amount").replace(/[,，\s]/g, "");
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    await interaction.reply({ content: "入札額は正の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    const res = services.auctions.bid({
      auctionId: id,
      bidderId: interaction.user.id,
      amount,
      idempotencyKey: `auc-bid:${interaction.id}`,
    });
    await refreshAuctionPanel(interaction.client, services, res.auction);
    await interaction.reply({ content: `✅ #${id} に **${fmtLd(amount)}** で入札しました。あなたが最高額です。`, flags: MessageFlags.Ephemeral });

    // 上書きされた前点者へ通知（DM→不達なら集令ch）
    if (res.refundedBidder && res.refundedBidder !== interaction.user.id) {
      await notifyUser(
        interaction.client,
        services,
        res.refundedBidder,
        `🔨 競売 #${id}「${res.auction.title}」であなたの入札が上回られました（${fmtLd(res.refundedAmount)} は返金済み）。競り続けるならもう一度入札を。`,
        { fallbackChannelKey: "channel:shurei" },
      ).catch(() => undefined);
    }
  } catch (e) {
    let msg = "入札に失敗しました。";
    if (e instanceof AuctionError && e.code === "ERR_BID_TOO_LOW") msg = `入札額が低すぎます（最低 ${fmtLd(Number(e.meta.min))}）。`;
    else if (e instanceof AuctionError && e.code === "ERR_ALREADY_TOP") msg = "すでにあなたが最高額です。";
    else if (e instanceof AuctionError && (e.code === "ERR_AUCTION_ENDED" || e.code === "ERR_AUCTION_CLOSED")) msg = "この競売は終了しています。";
    else if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))} / 必要: ${fmtLd(amount)}）。`;
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

// ---- 落札の告知（締切・自動締切共通）----

export async function announceResult(
  client: Client,
  services: Services,
  a: AuctionRow,
  winnerId: string | null,
  amount: number,
): Promise<void> {
  if (a.channel_id) {
    const ch = (await client.channels.fetch(a.channel_id).catch(() => null)) as TextChannel | null;
    if (ch?.isTextBased()) {
      await ch
        .send({
          content: winnerId
            ? `🏁 競売 #${a.id}「${a.title}」は <@${winnerId}> が **${fmtLd(amount)}** で落札しました。おめでとう。`
            : `🏁 競売 #${a.id}「${a.title}」は入札なしで終了しました。`,
          allowedMentions: { users: winnerId ? [winnerId] : [] },
        })
        .catch(() => undefined);
    }
  }
  if (winnerId) {
    await notifyUser(client, services, winnerId, `🏁 競売「${a.title}」を **${fmtLd(amount)}** で落札しました。運営から品の受け渡しがあります。`, {
      fallbackChannelKey: "channel:shurei",
    }).catch(() => undefined);
    // 運営へ受け渡し依頼
    const shureiId = services.settings.getString("channel:shurei");
    if (shureiId) {
      const ch = (await client.channels.fetch(shureiId).catch(() => null)) as TextChannel | null;
      await ch?.send({ content: `📦 競売 #${a.id}「${a.title}」落札者 <@${winnerId}> への品の受け渡しをお願いします。`, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
  }
}

// ---- オートコンプリート ----

export async function handleAuctionAutocomplete(interaction: AutocompleteInteraction, services: Services): Promise<void> {
  const focused = interaction.options.getFocused().toString().toLowerCase();
  const choices = services.auctions
    .listOpen()
    .filter((a) => !focused || `${a.id}`.includes(focused) || a.title.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((a) => ({ name: `#${a.id} ${a.title}`.slice(0, 100), value: a.id }));
  await interaction.respond(choices).catch(() => undefined);
}
