import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
  type InteractionReplyOptions,
} from "discord.js";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";
import { checkRetry } from "./common.js";
import { type CasinoSoloGame } from "./games.js";
import { readAvailableWallet } from "./wallet.js";
import { C_BIGWIN, C_JACKPOT, C_LOSE, C_PUSH, C_WIN, E, fmtBigDelta } from "./ui.js";

export const CASINO_RESULT_PREFIX = "casino:result:";
export const CASINO_EXIT_PREFIX = "casino:exit:";

const RETRY_PREFIX: Readonly<Record<CasinoSoloGame, string>> = {
  スロット: "slots:retry",
  丁半: "chohan:retry",
  クラッシュ: "crash:retry",
  チンチロ: "chinchiro:retry",
  ブラックジャック: "bj:retry",
  ポーカー: "poker:retry",
  ホールデム: "holdem:retry",
};

export interface SoloResultSection {
  name: string;
  value: string;
  inline?: boolean;
}

export function resultAmountCustomId(game: CasinoSoloGame, ownerId: string): string {
  return `${CASINO_RESULT_PREFIX}amount:${game}:${ownerId}`;
}

export function resultGamesCustomId(ownerId: string): string {
  return `${CASINO_RESULT_PREFIX}games:${ownerId}`;
}

export function resultRulesCustomId(game: CasinoSoloGame, ownerId: string): string {
  return `${CASINO_RESULT_PREFIX}rules:${game}:${ownerId}`;
}

export function resultExitCustomId(ownerId: string): string {
  return `${CASINO_EXIT_PREFIX}${ownerId}`;
}

export function retryCustomIdFor(game: CasinoSoloGame, retryBet: number): string {
  return `${RETRY_PREFIX[game]}:${retryBet}`;
}

export function buildSoloResult(opts: {
  services: Services;
  userId: string;
  game: CasinoSoloGame;
  net: number;
  wager: number | "無料";
  retryBet: number;
  description?: string;
  sections?: SoloResultSection[];
  isJackpot?: boolean;
  titleOverride?: string;
  colorOverride?: number;
}): InteractionReplyOptions {
  const won = opts.net > 0;
  const push = opts.net === 0;
  const bigWin = won && typeof opts.wager === "number" && opts.wager > 0 && opts.net >= opts.wager * 5;
  const color = opts.colorOverride ?? (opts.isJackpot ? C_JACKPOT : bigWin ? C_BIGWIN : won ? C_WIN : push ? C_PUSH : C_LOSE);
  const tag = opts.titleOverride ?? (opts.isJackpot ? `${E.jp} JACKPOT!` : bigWin ? `${E.fire} 大勝ち` : won ? `${E.win} 勝ち` : push ? `${E.push} 引き分け` : `${E.lose} 負け`);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(color)
    .setTitle(`${tag}  ${fmtBigDelta(opts.net)}`)
    .setFooter({ text: resultFooter(opts.services, opts.userId, opts.wager) });

  if (opts.description) embed.setDescription(opts.description);
  if (opts.sections?.length) {
    embed.addFields(...opts.sections.map((s): APIEmbedField => ({ name: s.name, value: s.value, inline: s.inline ?? false })));
  }

  return { embeds: [embed], components: [soloResultActions(opts.services, opts.userId, opts.game, opts.retryBet)] };
}

export function soloResultActions(
  services: Services,
  userId: string,
  game: CasinoSoloGame,
  retryBet: number,
): ActionRowBuilder<ButtonBuilder> {
  const retry = retryStatus(services, userId, game, retryBet);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(retryCustomIdFor(game, retryBet))
      .setLabel(`もう一度 ${retryBet.toLocaleString("ja-JP")} Ld`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!retry.ok),
    new ButtonBuilder()
      .setCustomId(resultAmountCustomId(game, userId))
      .setLabel("金額を変える")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(resultGamesCustomId(userId))
      .setLabel("別の遊び")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(resultRulesCustomId(game, userId))
      .setLabel("ルール")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(resultExitCustomId(userId))
      .setLabel("賭場を出る")
      .setStyle(ButtonStyle.Secondary),
  );
}

function retryStatus(services: Services, userId: string, game: CasinoSoloGame, retryBet: number): { ok: true } | { ok: false } {
  try {
    return checkRetry(services, userId, retryBet, game).ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function resultFooter(services: Services, userId: string, wager: number | "無料"): string {
  const wallet = readAvailableWallet(services, userId);
  const wagerText = wager === "無料" ? "賭け 無料" : `賭け ${fmtLd(wager)}`;
  if (wallet.status === "formal" && wallet.freeChips !== null && wallet.escrowed !== null) {
    return [
      `所持 ${fmtLd(wallet.available)}`,
      wallet.escrowed > 0 ? `預け中 ${fmtLd(wallet.escrowed)}` : "",
      wagerText,
    ].filter(Boolean).join(" · ");
  }
  return [`所持 確認停止`, `通常Land ${fmtLd(wallet.land)}`, wagerText].join(" · ");
}
