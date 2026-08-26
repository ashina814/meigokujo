import type { ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { playChohanMulti } from "../casino/chohan-multi.js";
import { playChinchiroDuel } from "../casino/chinchiro-duel.js";
import { playBjDuel } from "../casino/bj-duel.js";
import { playSashi } from "../casino/sashi.js";
import { playIndian } from "../casino/indian.js";
import { playPokerDuel } from "../casino/poker-duel.js";

/**
 * @deprecated `/勝負` slashは退役済み。公開対人入口は専用常設パネルへ集約した。
 * Discord側に残る旧interactionとの互換handlerとgame runnerを維持する。
 */
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
