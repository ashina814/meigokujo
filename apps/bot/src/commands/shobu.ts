import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET } from "../casino/common.js";
import { playChohanMulti } from "../casino/chohan-multi.js";
import { playChinchiroDuel } from "../casino/chinchiro-duel.js";
import { playBjDuel } from "../casino/bj-duel.js";
import { playSashi } from "../casino/sashi.js";
import { playIndian } from "../casino/indian.js";
import { playPokerDuel } from "../casino/poker-duel.js";

/**
 * /勝負 — マモンの賭場の対人ゲーム集約コマンド。
 * ソロは /遊ぶ、対人は /勝負 の2本立て（casino-bot の方針を踏襲）。
 */
export const shobuCommand = new SlashCommandBuilder()
  .setName("勝負")
  .setDescription("⚔ マモンの賭場の対人ゲーム")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName("丁半").setDescription("🎴 多人数丁半（60秒受付・両側揃えば成立）"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("チンチロ")
      .setDescription("🎲 対戦チンチロ（1v1・両者振って自動判定）")
      .addUserOption((o) => o.setName("相手").setDescription("挑戦相手").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル（同額）").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("bj")
      .setDescription("🃏 BJデュエル（1v1・交互ヒットで21勝負）")
      .addUserOption((o) => o.setName("相手").setDescription("挑戦相手").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル（同額）").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("サシ")
      .setDescription("⚔ サシ勝負（1v1・50/50 の一発勝負）")
      .addUserOption((o) => o.setName("相手").setDescription("挑戦相手").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル（同額）").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("インディアン")
      .setDescription("🃏 インディアンポーカー（1v1・自分の手だけ見えない心理戦）")
      .addUserOption((o) => o.setName("相手").setDescription("挑戦相手").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル（同額）").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ポーカー")
      .setDescription("🃏 5枚交換ポーカー（相手指定でサシ・未指定でオープン募集）")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル（参加者全員同額）").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      )
      .addUserOption((o) => o.setName("相手").setDescription("相手指定でサシ（未指定なら誰でも参加できるオープン）").setRequired(false)),
  );

export async function handleShobuCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "丁半") return playChohanMulti(interaction, services);
  if (sub === "ポーカー") {
    const bet = interaction.options.getInteger("賭け", true);
    const opponent = interaction.options.getUser("相手", false);
    return playPokerDuel(interaction, services, opponent, bet);
  }
  const opponent = interaction.options.getUser("相手", true);
  const bet = interaction.options.getInteger("賭け", true);
  if (sub === "チンチロ") return playChinchiroDuel(interaction, services, opponent, bet);
  if (sub === "bj") return playBjDuel(interaction, services, opponent, bet);
  if (sub === "サシ") return playSashi(interaction, services, opponent, bet);
  if (sub === "インディアン") return playIndian(interaction, services, opponent, bet);
}
