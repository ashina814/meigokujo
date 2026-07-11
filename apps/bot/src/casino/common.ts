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
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET) {
    await interaction.reply({
      content: `賭け額は ${MIN_BET.toLocaleString()}〜${MAX_BET.toLocaleString()} ◈ で。`,
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
