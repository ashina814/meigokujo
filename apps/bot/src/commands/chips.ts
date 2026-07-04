import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { ChipError, LedgerError } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

/** 1チップの表示価格（Land）。少額でも分かるよう小数2桁 */
function rateStr(services: Services): string {
  return `${services.chips.rate().toFixed(2)} Ld`;
}

export const exchangeCommand = new SlashCommandBuilder()
  .setName("為替")
  .setDescription("Land ⇄ チップ の両替（カジノの入口）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("両替")
      .setDescription("Land を払ってチップを買う")
      .addIntegerOption((o) => o.setName("land").setDescription("支払う Land").setRequired(true).setMinValue(10)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("換金")
      .setDescription("チップを Land に戻す（手数料あり）")
      .addIntegerOption((o) => o.setName("チップ").setDescription("換金するチップ数").setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) => sub.setName("相場").setDescription("チップの現在レートと準備状況"));

export async function handleExchangeCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "相場") {
    const embed = new EmbedBuilder()
      .setTitle("💱 チップ為替")
      .setColor(0x06b6d4)
      .setDescription(
        [
          `現在レート: **1チップ = ${rateStr(services)}**`,
          `発行チップ: ${services.chips.outstanding().toLocaleString()} 枚 ／ 準備プール: ${fmtLd(services.chips.pool())}`,
          `あなたの保有: **${services.chips.balanceOf(interaction.user.id).toLocaleString()} 枚**`,
          "",
          "両替は 20% 手数料（うち半分は焼却、半分はプールに残りチップ全体が値上がり）。",
          "チップは Land を 100% 準備した引換券で、新規発行はありません（非インフレ）。",
        ].join("\n"),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "両替") {
    const landIn = interaction.options.getInteger("land", true);
    const preview = services.chips.quoteBuy(landIn);
    try {
      const q = services.chips.buy(interaction.user.id, landIn, `chip-buy:${interaction.id}`);
      await interaction.reply({
        content: `💱 **${fmtLd(landIn)}** → **${q.output.toLocaleString()} チップ**（焼却 ${fmtLd(q.burned)}）。保有 ${services.chips.balanceOf(interaction.user.id).toLocaleString()} 枚 ／ レート 1チップ=${rateStr(services)}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      let msg = "両替に失敗しました。";
      if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))} / 必要: ${fmtLd(landIn)}）。`;
      else if (e instanceof ChipError) msg = "金額が不正です。";
      void preview;
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // 換金
  const chipsIn = interaction.options.getInteger("チップ", true);
  try {
    const q = services.chips.sell(interaction.user.id, chipsIn, `chip-sell:${interaction.id}`);
    await interaction.reply({
      content: `💱 **${chipsIn.toLocaleString()} チップ** → **${fmtLd(q.output)}**（焼却 ${fmtLd(q.burned)}）。残り ${services.chips.balanceOf(interaction.user.id).toLocaleString()} 枚 ／ レート 1チップ=${rateStr(services)}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    const msg = e instanceof ChipError && e.code === "ERR_INSUFFICIENT_CHIPS" ? `チップが足りません（保有 ${Number(e.meta.held).toLocaleString()} 枚）。` : "換金に失敗しました。";
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}
