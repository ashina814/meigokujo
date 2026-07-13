import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from "discord.js";
import { StockError, STOCK_HOLD_DAYS } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { MAMMON_COLOR } from "../casino/common.js";
import type { Services } from "../services.js";

/**
 * /株 — マモンの賭場の株式市場。
 * 6 銘柄・1時間ごとの価格更新・保有上限3日・売買はエテル建て。
 */
export const stocksCommand = new SlashCommandBuilder()
  .setName("株")
  .setDescription("📈 マモンの賭場の株式市場")
  .setDMPermission(false);

export async function handleStocksCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({
    embeds: [buildBoard(services, interaction.user.id)],
    components: buildComponents(services),
    flags: MessageFlags.Ephemeral,
  });
}

function buildBoard(services: Services, userId: string): EmbedBuilder {
  const stocks = services.stocks.list();
  const holdings = services.stocks.holdings(userId);
  const held = services.ether.balanceOf(userId);

  // 価格ボード（等幅コードブロックで縦揃え）
  const rows = stocks.map((s) => {
    const delta = s.price - s.prev_price;
    const pct = s.prev_price > 0 ? (delta / s.prev_price) * 100 : 0;
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "─";
    const trend = s.trend > 0.3 ? "🔥" : s.trend < -0.3 ? "❄" : "  ";
    // padding: 銘柄名 8chars, 価格 8chars, 差分 8chars
    const name = (s.emoji + " " + s.name).padEnd(10, " ");
    const price = s.price.toLocaleString("ja-JP").padStart(8, " ") + " ◈";
    const change = `${arrow} ${Math.abs(pct).toFixed(1)}%`.padEnd(10, " ");
    return `${name}  ${price}  ${change}${trend}`;
  });

  const boardStr = "```" + "\n" + rows.join("\n") + "\n" + "```";

  const holdingRows = holdings.map((h) => {
    const value = h.stock.price * h.shares;
    const cost = h.avg_cost * h.shares;
    const pnl = value - cost;
    const daysHeld = Math.floor((Date.now() / 1000 - h.bought_at) / 86_400);
    const pnlStr = (pnl >= 0 ? "+" : "−") + Math.abs(pnl).toLocaleString("ja-JP");
    return `${h.stock.emoji} **${h.stock.name}** ×${h.shares}   平均${fmtEther(h.avg_cost).replace(" ◈", "◈")}  時価${fmtEther(value).replace(" ◈", "◈")}  **${pnlStr}**  ${daysHeld}日`;
  });

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 株式市場" })
    .setColor(MAMMON_COLOR)
    .setTitle("📈  相場板")
    .setDescription(boardStr)
    .setFooter({
      text: `所持 ${fmtEther(held).replace(" ◈", "◈")} · 価格は1時間毎更新 · 保有 ${STOCK_HOLD_DAYS}日超で強制売却`,
    });

  if (holdingRows.length > 0) {
    embed.addFields({ name: "▸ お前の保有", value: holdingRows.join("\n"), inline: false });
  } else {
    embed.addFields({ name: "▸ お前の保有", value: "（なし）", inline: false });
  }
  return embed;
}

function buildComponents(services: Services): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const stocks = services.stocks.list();
  const buySelect = new StringSelectMenuBuilder()
    .setCustomId("stocks:buy")
    .setPlaceholder("買う銘柄を選ぶ")
    .addOptions(
      stocks.map((s) => ({
        label: `${s.name} — ${s.price.toLocaleString()} ◈`,
        value: s.id,
        emoji: s.emoji,
      })),
    );
  const sellSelect = new StringSelectMenuBuilder()
    .setCustomId("stocks:sell")
    .setPlaceholder("売る銘柄を選ぶ")
    .addOptions(
      stocks.map((s) => ({
        label: `${s.name} — ${s.price.toLocaleString()} ◈`,
        value: s.id,
        emoji: s.emoji,
      })),
    );
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buySelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sellSelect),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("stocks:refresh").setLabel("🔁 更新").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export async function handleStocksSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const action = interaction.customId.split(":")[1] as "buy" | "sell";
  const stockId = interaction.values[0]!;
  const modal = new ModalBuilder()
    .setCustomId(`stocks:${action}:${stockId}`)
    .setTitle(`${action === "buy" ? "買う" : "売る"} — ${stockId}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("shares").setLabel("株数").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleStocksModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // stocks:buy|sell:stockId
  const action = parts[1] as "buy" | "sell";
  const stockId = parts[2]!;
  const shares = Number(interaction.fields.getTextInputValue("shares").trim());
  if (!Number.isInteger(shares) || shares <= 0) {
    await interaction.reply({ content: "株数は正の整数で。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    if (action === "buy") {
      const r = services.stocks.buy(interaction.user.id, stockId, shares);
      await interaction.reply({
        content: `✅ ${stockId} × ${shares} 株を購入（総額 ${fmtEther(r.cost)} / 平均取得 ${fmtEther(r.avgCost)}）`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      const r = services.stocks.sell(interaction.user.id, stockId, shares);
      await interaction.reply({
        content: `✅ ${stockId} × ${shares} 株を売却（受取 ${fmtEther(r.proceeds)} / 残 ${r.remaining} 株）`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (e) {
    const msg =
      e instanceof StockError && e.code === "ERR_INSUFFICIENT_ETHER"
        ? "エテルが足りない。"
        : e instanceof StockError && e.code === "ERR_INSUFFICIENT_SHARES"
          ? "その株はそんなに持っていない。"
          : "処理に失敗した。";
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

export async function handleStocksButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "stocks:refresh") {
    await interaction.update({
      embeds: [buildBoard(services, interaction.user.id)],
      components: buildComponents(services),
    });
  }
}
