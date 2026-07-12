import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";

/** マモンの賭場の共通定数・ヘルパ */
export const MAMMON_COLOR = 0xc9a227;
export const WIN_COLOR = 0x22c55e;
export const LOSE_COLOR = 0x7f1d1d;

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

/** 勝敗リザルトの共通embed */
export function resultEmbed(opts: {
  title: string;
  lines: string[];
  net: number;
  balance: number;
}): EmbedBuilder {
  const color = opts.net > 0 ? WIN_COLOR : opts.net < 0 ? LOSE_COLOR : MAMMON_COLOR;
  const mammonLine = opts.net > 0 ? Mammon.win() : opts.net < 0 ? Mammon.lose() : Mammon.push();
  return new EmbedBuilder()
    .setTitle(opts.title)
    .setColor(color)
    .setDescription([...opts.lines, "", `*「${mammonLine}」*`].join("\n"))
    .setFooter({ text: `所持: ${fmtEther(opts.balance).replace("◈", "エテル")}` });
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
