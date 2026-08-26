import type { ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { playSlots } from "../casino/slots.js";
import { playChohan } from "../casino/chohan.js";
import { playCrash } from "../casino/crash.js";
import { playChinchiro } from "../casino/chinchiro.js";
import { playRoulette } from "../casino/roulette.js";
import { playBlackjack } from "../casino/blackjack.js";
import { playPoker } from "../casino/poker.js";
import { playHoldem } from "../casino/holdem.js";

/**
 * @deprecated slash registrationから退役済み。`/賭場` のhome/panelからrunnerを再利用する。
 * /遊ぶ — マモンの賭場の全ソロゲーム集約コマンド（casino-bot の /遊ぶ 方式）。
 * 賭けはすべてLand建て。入退場はゲーム開始時の自動預入・「賭場を出る」ボタンで。
 *
 * Discord側に残る旧interactionとの互換handlerだけを維持する。
 */
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
