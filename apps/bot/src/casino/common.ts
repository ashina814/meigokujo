import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { C_BIGWIN, C_LOSE, C_MAMMON, C_PUSH, C_WIN, E, fmtBigDelta } from "./ui.js";

/** 後方互換: 既存コードが参照している色エイリアス */
export const MAMMON_COLOR = C_MAMMON;
export const WIN_COLOR = C_WIN;
export const LOSE_COLOR = C_LOSE;

export const MIN_BET = 50;
export const MAX_BET = 1_000_000;

/** VIP なら賭け上限倍率を掛ける。ゲーム側は effectiveMaxBet(services, userId) で判定 */
export function effectiveMaxBet(services: Services, userId: string): number {
  if (services.vip.isVip(userId)) return MAX_BET * services.vip.betCapMult();
  return MAX_BET;
}

/** 同時プレイ防止（1人1卓）。プロセス内ロックで足りる（bot は単一プロセス） */
const playing = new Set<string>();

export function acquireSeat(userId: string): boolean {
  if (playing.has(userId)) return false;
  playing.add(userId);
  return true;
}
export function releaseSeat(userId: string): void {
  playing.delete(userId);
}

export interface BetCheck {
  ok: boolean;
  bet: number;
}

/**
 * 賭けの共通前処理。座席確保はしない（呼び出し側で）。
 * - bet の整数/範囲チェック
 * - 残高チェック（不足ならマモンが両替所へ誘導）
 * - テーブルリミット（胴元が最悪配当を払えるか）
 * NG のときは reply 済みで ok:false を返す。
 */
export async function validateBet(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
  maxPayout: number,
): Promise<BetCheck> {
  const bet = Math.floor(betRaw);
  const cap = effectiveMaxBet(services, interaction.user.id);
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > cap) {
    await interaction.reply({
      content: `賭け額は ${MIN_BET.toLocaleString()}〜${cap.toLocaleString()} ◈ で。${cap > MAX_BET ? "（💎 VIP 賭け上限拡張中）" : ""}`,
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  const held = services.ether.balanceOf(interaction.user.id);
  if (held < bet) {
    await interaction.reply({
      content: `${Mammon.broke()}（所持 ${fmtEther(held)}）\n→ 両替所パネルで Land をエテルに替えてこい。`,
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  if (!services.casino.canAccept(maxPayout)) {
    // 胴元が最悪ケースの配当を払えない。今の胴元残高で受けられる上限を教える
    const multiplier = maxPayout / bet;
    const maxAcceptable = Math.floor(services.casino.houseBalance() / multiplier);
    await interaction.reply({
      content: [
        Mammon.tableClosed(),
        maxAcceptable >= MIN_BET
          ? `（この卓で今受けられるのは **${maxAcceptable.toLocaleString()} ◈** まで）`
          : "（胴元の資金が尽きている。運営: /管理 → 賭場 → 資金投入）",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  return { ok: true, bet };
}

/**
 * 勝敗リザルトの共通embed（洗練版）。
 * - Author: 「マモンの賭場 · {ゲーム名}」
 * - Title: 勝ち/負けタグ + 大きな純損益（±付き）
 * - Description: 状態詳細のライン
 * - Footer: 所持 + 連勝バッジ
 */
export function resultEmbed(opts: {
  title: string; // ゲーム名（"スロット" 等・タグと組み合わせる）
  lines: string[];
  net: number;
  balance: number;
  bet?: number;
  isJackpot?: boolean;
  streak?: number; // 現在の連勝数（設定なら Footer に出す）
}): EmbedBuilder {
  const won = opts.net > 0;
  const push = opts.net === 0;
  const bigWin = won && opts.bet && opts.net >= opts.bet * 5;
  const color = opts.isJackpot ? 0xf0b429 : bigWin ? C_BIGWIN : won ? C_WIN : push ? C_PUSH : C_LOSE;

  const tag = opts.isJackpot
    ? `${E.jp} JACKPOT!`
    : bigWin
      ? `${E.fire} 大勝ち`
      : won
        ? `${E.win} 勝ち`
        : push
          ? `${E.push} 引き分け`
          : `${E.lose} 負け`;

  const mammonLine = opts.isJackpot ? Mammon.jackpot() : bigWin ? Mammon.bigWin() : won ? Mammon.win() : push ? Mammon.push() : Mammon.lose();

  const footerBits = [`所持 ${fmtEther(opts.balance).replace(" ◈", "◈")}`];
  if (opts.bet) footerBits.push(`賭け ${fmtEther(opts.bet).replace(" ◈", "◈")}`);
  if (opts.streak && opts.streak >= 2) footerBits.push(`${E.fire} ${opts.streak}連勝`);

  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.title.replace(/^[🎰🎲🎡🃏📈🌟💥🏆]\s?/, "").split(" ")[0] ?? "賭場"}` })
    .setTitle(`${tag}  ${fmtBigDelta(opts.net)}`)
    .setColor(color)
    .setDescription([...opts.lines, "", `*「${mammonLine}」*`].join("\n"))
    .setFooter({ text: footerBits.join(" · ") });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * お守り消費: 勝ちなら armed_win で配当倍増、負けなら armed_loss で返金。
 * ゲーム側は raw payout を計算した後にこれを呼ぶ。返される payout を最終値として使う。
 * @param bet 賭け額（負け保護の返金額計算に使う）
 * @param rawPayout 生の払戻総額（0=負け）
 * @returns { payout: 調整後の払戻, note?: string 発動メッセージ }
 */
export function applyAmulets(
  services: Services,
  userId: string,
  bet: number,
  rawPayout: number,
): { payout: number; note?: string } {
  if (rawPayout > bet) {
    const bonus = services.items.consumeWinBonus(userId);
    if (bonus.mult !== 1) return { payout: Math.floor(rawPayout * bonus.mult), note: bonus.note };
    return { payout: rawPayout };
  }
  if (rawPayout < bet) {
    const prot = services.items.consumeLossProtection(userId);
    if (prot.refundRate > 0) {
      const refund = Math.floor(bet * prot.refundRate);
      return { payout: refund, note: prot.note };
    }
  }
  return { payout: rawPayout };
}
