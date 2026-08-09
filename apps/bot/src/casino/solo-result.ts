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
import { C_BIGWIN, C_JACKPOT, C_LOSE, C_PUSH, C_WIN, E, balanceLine, fmtBigDelta, sub } from "./ui.js";

export const CASINO_RESULT_PREFIX = "casino:result:";
export const CASINO_EXIT_PREFIX = "casino:exit:";
export const CASINO_RETRY_PREFIX = "casino:retry:";

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

export function retryCustomIdFor(game: CasinoSoloGame, retryBet: number, ownerId: string): string {
  return `${CASINO_RETRY_PREFIX}${game}:${retryBet}:${ownerId}`;
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
  /** フッターへ足す控えめな情報（JP残高・連勝数など）。読めなくても困らないものだけ */
  footerExtra?: string;
}): InteractionReplyOptions {
  const won = opts.net > 0;
  const push = opts.net === 0;
  const bigWin = won && typeof opts.wager === "number" && opts.wager > 0 && opts.net >= opts.wager * 5;
  const color = opts.colorOverride ?? (opts.isJackpot ? C_JACKPOT : bigWin ? C_BIGWIN : won ? C_WIN : push ? C_PUSH : C_LOSE);
  const tag = opts.titleOverride ?? (opts.isJackpot ? `${E.jp} JACKPOT!` : bigWin ? `${E.fire} 大勝ち` : won ? `${E.win} 勝ち` : push ? `${E.push} 引き分け` : `${E.lose} 負け`);

  const wallet = readAvailableWallet(opts.services, opts.userId);
  const embed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(color)
    .setTitle(`${tag}  ${fmtBigDelta(opts.net)}`)
    .setDescription(
      [
        // 盤面（賽・手札・リール）。各ゲームが組み立てて渡す
        opts.description,
        // 所持は毎回ここ。フッターの極小灰文字だと肝心の数字が読めない
        walletBlock(wallet),
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .setFooter({ text: [resultFooter(wallet, opts.wager), opts.footerExtra].filter(Boolean).join(" · ") });

  if (opts.sections?.length) {
    embed.addFields(...opts.sections.map((s): APIEmbedField => ({ name: s.name, value: s.value, inline: s.inline ?? false })));
  }

  return { embeds: [embed], components: soloResultActions(opts.services, opts.userId, opts.game, opts.retryBet) };
}

/**
 * 結果画面のボタン。**役割で2段に分ける**。
 * 上段＝この卓を続ける操作 / 下段＝この卓から離れる操作。
 * 5つを1行に詰めると Discord 側の折り返し位置がクライアント幅任せになり、
 * 「別の遊び」と「賭場を出る」が隣り合って誤爆する。
 */
export function soloResultActions(
  services: Services,
  userId: string,
  game: CasinoSoloGame,
  retryBet: number,
): Array<ActionRowBuilder<ButtonBuilder>> {
  const retry = retryStatus(services, userId, game, retryBet);
  const continueRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(retryCustomIdFor(game, retryBet, userId))
      .setEmoji("🔁")
      .setLabel(`もう一度 ${retryBet.toLocaleString("ja-JP")} Ld`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!retry.ok),
    new ButtonBuilder()
      .setCustomId(resultAmountCustomId(game, userId))
      .setEmoji("🎯")
      .setLabel("金額を変える")
      .setStyle(ButtonStyle.Secondary),
  );
  const leaveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(resultGamesCustomId(userId))
      .setEmoji("🎲")
      .setLabel("別の遊び")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(resultRulesCustomId(game, userId))
      .setEmoji("📖")
      .setLabel("ルール")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(resultExitCustomId(userId))
      .setEmoji("🚪")
      .setLabel("賭場を出る")
      .setStyle(ButtonStyle.Secondary),
  );
  return [continueRow, leaveRow];
}

function retryStatus(services: Services, userId: string, game: CasinoSoloGame, retryBet: number): { ok: true } | { ok: false } {
  try {
    return checkRetry(services, userId, retryBet, game).ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * 本文の所持ブロック。
 *
 * 帳簿が読めていないときに **通常Landの額を「所持」として断定してはいけない**。
 * 自由チップと預け中が不明なまま数字を出すと、利用者は確定額として読む。
 * その場合は額そのものを出さず「確認停止」と言い切り、確実に判っている
 * 通常Landだけを内訳として添える。
 */
function walletBlock(wallet: ReturnType<typeof readAvailableWallet>): string {
  if (wallet.status === "formal" && wallet.freeChips !== null && wallet.escrowed !== null) {
    return balanceLine(wallet.available);
  }
  return ["所持 **確認停止**", sub(`通常Land ${fmtLd(wallet.land)}・自由チップと預け中は読めていない`)].join("\n");
}

/**
 * フッターは「読めなくても困らない情報」だけ。所持は本文の walletBlock に出す。
 */
function resultFooter(wallet: ReturnType<typeof readAvailableWallet>, wager: number | "無料"): string {
  const wagerText = wager === "無料" ? "賭け 無料" : `賭け ${fmtLd(wager)}`;
  if (wallet.status === "formal" && wallet.freeChips !== null && wallet.escrowed !== null) {
    return [wagerText, wallet.escrowed > 0 ? `預け中 ${fmtLd(wallet.escrowed)}` : ""].filter(Boolean).join(" · ");
  }
  return wagerText;
}
