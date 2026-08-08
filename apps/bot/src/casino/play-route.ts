import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { Services } from "../services.js";
import { playSlots } from "./slots.js";
import { playChohan } from "./chohan.js";
import { playCrash } from "./crash.js";
import { playChinchiro } from "./chinchiro.js";
import { playBlackjack } from "./blackjack.js";
import { playPoker } from "./poker.js";
import { playHoldem } from "./holdem.js";
import { isCasinoSoloGame, type CasinoSoloGame } from "./games.js";
import { parseStrictPositiveInteger } from "./wager-input.js";

/**
 * `casino:play:<ゲーム>:<額>` の入口（PR5）。
 *
 * 胴元の余力が足りずに断ったとき、「いま押せる金額」のボタンを出す（正本 §5.4 ③）。
 * そのボタンは**新しい ephemeral メッセージ**に付くので、各ゲームのコレクタでは拾えない。
 * ここを全体のボタン経路に置いて、どのメッセージからでも同じ入口へ入れるようにする。
 */
const PLAYERS: Readonly<Record<CasinoSoloGame, (i: ButtonInteraction, s: Services, bet: number) => Promise<void>>> = {
  スロット: playSlots,
  丁半: playChohan,
  クラッシュ: playCrash,
  チンチロ: playChinchiro,
  ブラックジャック: playBlackjack,
  ポーカー: playPoker,
  ホールデム: playHoldem,
};

export function isCasinoPlayButton(customId: string): boolean {
  return customId.startsWith("casino:play:");
}

export type CasinoPlayButtonParse =
  | { ok: true; game: CasinoSoloGame; amount: number }
  | { ok: false };

export function parseCasinoPlayButton(customId: string): CasinoPlayButtonParse {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== "casino" || parts[1] !== "play") return { ok: false };
  const [, , game, amountRaw] = parts;
  if (!game || !isCasinoSoloGame(game)) return { ok: false };
  const parsed = parseStrictPositiveInteger(amountRaw ?? "");
  if (!parsed.ok) return { ok: false };
  return { ok: true, game, amount: parsed.amount };
}

export async function handleCasinoPlayButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parsed = parseCasinoPlayButton(interaction.customId);
  if (!parsed.ok) {
    await interaction.reply({ content: "❌ 不明な卓だ。", flags: MessageFlags.Ephemeral });
    return;
  }
  await PLAYERS[parsed.game](interaction, services, parsed.amount);
}
