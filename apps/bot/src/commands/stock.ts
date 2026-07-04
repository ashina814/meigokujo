import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { LedgerError, StockError } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * 魂株市場。住人に投資し、昇格で値上がり（配当）、迷霊落ちで紙くず。
 * 価格は bonding-curve AMM（板なし）。買い/売りは全員、上場/廃止は運営。
 */
export const stockCommand = new SlashCommandBuilder()
  .setName("魂株")
  .setDescription("魂株市場（住人への投資）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("上場")
      .setDescription("住人を上場する（運営）")
      .addUserOption((o) => o.setName("対象").setDescription("上場する住人").setRequired(true))
      .addIntegerOption((o) => o.setName("初期株価").setDescription("1株の初期価格（既定1,000）").setMinValue(1))
      .addIntegerOption((o) => o.setName("変動幅").setDescription("1株ごとの値動き（既定100）").setMinValue(0))
      .addIntegerOption((o) => o.setName("昇格ボーナス").setDescription("昇格時の株価上昇＝配当原資（既定5,000）").setMinValue(0)),
  )
  .addSubcommand((sub) =>
    sub.setName("廃止").setDescription("上場を廃止（保有は紙くず・運営）").addUserOption((o) => o.setName("対象").setDescription("対象").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("買い")
      .setDescription("魂株を買う")
      .addUserOption((o) => o.setName("対象").setDescription("投資先の住人").setRequired(true))
      .addIntegerOption((o) => o.setName("株数").setDescription("買う株数").setRequired(true).setMinValue(1).setMaxValue(100000)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("売り")
      .setDescription("魂株を売る")
      .addUserOption((o) => o.setName("対象").setDescription("売る銘柄の住人").setRequired(true))
      .addIntegerOption((o) => o.setName("株数").setDescription("売る株数").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) => sub.setName("相場").setDescription("上場中の銘柄と株価"))
  .addSubcommand((sub) => sub.setName("資産").setDescription("自分の保有銘柄と評価額"));

export async function handleStockCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "相場") {
    const rows = services.stocks.listListed();
    const embed = new EmbedBuilder()
      .setTitle("📈 魂株 相場")
      .setColor(0x22c55e)
      .setDescription(
        rows.length > 0
          ? rows.map((s) => `<@${s.subject_id}> — **${fmtLd(services.stocks.price(s))}**／株（発行 ${s.shares}株${s.promotion_credited ? "・昇格済" : ""}）`).join("\n")
          : "上場中の銘柄はありません。",
      )
      .setFooter({ text: "昇格で株価↑（配当）・迷霊落ちで紙くず" });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === "資産") {
    const pf = services.stocks.portfolio(interaction.user.id);
    const total = pf.reduce((s, h) => s + h.value, 0);
    const lines = pf.map((h) => `<@${h.subject_id}> — ${h.shares}株 評価 **${fmtLd(h.value)}**${h.status === "delisted" ? "（紙くず）" : `（${fmtLd(h.price)}/株）`}`);
    await interaction.reply({
      content: pf.length > 0 ? [`💼 保有評価 合計 **${fmtLd(total)}**`, ...lines].join("\n") : "保有している魂株はありません。`/魂株 相場` で銘柄を見てみましょう。",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const target = interaction.options.getUser("対象", true);

  if (sub === "上場" || sub === "廃止") {
    if (!isAdmin(interaction, services)) {
      await interaction.reply({ content: "上場・廃止は運営のみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (sub === "上場") {
      if (target.bot) {
        await interaction.reply({ content: "Bot は上場できません。", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        const s = services.stocks.list(target.id, {
          basePrice: interaction.options.getInteger("初期株価") ?? undefined,
          step: interaction.options.getInteger("変動幅") ?? undefined,
          promotionBonus: interaction.options.getInteger("昇格ボーナス") ?? undefined,
          createdBy: `user:${interaction.user.id}`,
        });
        await interaction.reply({ content: `✅ <@${target.id}> を上場しました（初期株価 ${fmtLd(services.stocks.price(s))}／株、変動幅 ${fmtLd(s.step)}）。`, allowedMentions: { parse: [] } });
      } catch (e) {
        const msg = e instanceof StockError && e.code === "ERR_STOCK_EXISTS" ? "その住人はすでに上場中です。" : "上場に失敗しました。";
        await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }
    // 廃止
    try {
      const reclaimed = services.stocks.delist(target.id, `user:${interaction.user.id}`);
      await interaction.reply({ content: `🗑 <@${target.id}> を廃止しました（エスクロー ${fmtLd(reclaimed)} を国庫回収・保有は紙くず）。`, allowedMentions: { parse: [] } });
    } catch (e) {
      const msg = e instanceof StockError && e.code === "ERR_STOCK_NOT_FOUND" ? "その銘柄は存在しません。" : "廃止に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // 買い / 売り
  const qty = interaction.options.getInteger("株数", true);
  try {
    if (sub === "買い") {
      const r = services.stocks.buy(target.id, interaction.user.id, qty, `stock-buy:${interaction.id}`);
      await interaction.reply({ content: `📈 <@${target.id}> を **${qty}株** 購入（−${fmtLd(r.cash)}）。現在株価 ${fmtLd(r.newPrice)}／株、保有 ${services.stocks.sharesOf(target.id, interaction.user.id)}株。`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    // 売り
    const r = services.stocks.sell(target.id, interaction.user.id, qty, `stock-sell:${interaction.id}`);
    await interaction.reply({ content: `📉 <@${target.id}> を **${qty}株** 売却（＋${fmtLd(r.cash)}）。現在株価 ${fmtLd(r.newPrice)}／株、保有 ${services.stocks.sharesOf(target.id, interaction.user.id)}株。`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  } catch (e) {
    let msg = "取引に失敗しました。";
    if (e instanceof StockError && e.code === "ERR_STOCK_NOT_FOUND") msg = "その住人は上場していません。";
    else if (e instanceof StockError && e.code === "ERR_STOCK_DELISTED") msg = "その銘柄は廃止されています。";
    else if (e instanceof StockError && e.code === "ERR_NO_SHARES") msg = `保有株が足りません（保有 ${Number(e.meta.held)}株）。`;
    else if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))} / 必要: ${fmtLd(Number(e.details.required))}）。`;
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}
