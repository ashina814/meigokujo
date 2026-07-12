import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET } from "../casino/common.js";
import { playSlots } from "../casino/slots.js";
import { playChohan } from "../casino/chohan.js";
import { playCrash } from "../casino/crash.js";
import { playChinchiro } from "../casino/chinchiro.js";
import { playRoulette } from "../casino/roulette.js";
import { playBlackjack } from "../casino/blackjack.js";
import { playPoker } from "../casino/poker.js";
import { playHoldem } from "../casino/holdem.js";

/**
 * /遊ぶ — マモンの賭場の全ソロゲーム集約コマンド（casino-bot の /遊ぶ 方式）。
 * 賭けはすべてエテル建て。両替はマモンの両替所パネルで。
 */
export const asobuCommand = new SlashCommandBuilder()
  .setName("遊ぶ")
  .setDescription("🎰 マモンの賭場で遊ぶ（エテル建て）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("スロット")
      .setDescription("🎰 スロットを回す（JPは😈マモン3つ揃い）")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("丁半")
      .setDescription("🎲 丁半 — 丁（偶数）か半（奇数）か")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("クラッシュ")
      .setDescription("📈 クラッシュ — 崩壊する前に離脱しろ")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("チンチロ")
      .setDescription("🎲 チンチロ — マモンと3つのサイコロで勝負")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("ルーレット").setDescription("🎡 ルーレット — 卓を開く（30秒受付・みんなで張れる）"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ブラックジャック")
      .setDescription("🃏 ブラックジャック — マモンと21勝負")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ポーカー")
      .setDescription("🃏 ドローポーカー（Jacks or Better・ロイヤル250倍）")
      .addIntegerOption((o) =>
        o.setName("賭け").setDescription("賭けるエテル").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ホールデム")
      .setDescription("🃏 テキサスホールデム（対マモン簡易版）")
      .addIntegerOption((o) =>
        o.setName("アンティ").setDescription("初期賭け金（各ラウンドでコール可）").setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET),
      ),
  );

export async function handleAsobuCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "ルーレット") return playRoulette(interaction, services);
  if (sub === "ホールデム") {
    const ante = interaction.options.getInteger("アンティ", true);
    return playHoldem(interaction, services, ante);
  }
  const bet = interaction.options.getInteger("賭け", true);
  if (sub === "スロット") return playSlots(interaction, services, bet);
  if (sub === "丁半") return playChohan(interaction, services, bet);
  if (sub === "クラッシュ") return playCrash(interaction, services, bet);
  if (sub === "チンチロ") return playChinchiro(interaction, services, bet);
  if (sub === "ブラックジャック") return playBlackjack(interaction, services, bet);
  if (sub === "ポーカー") return playPoker(interaction, services, bet);
}
