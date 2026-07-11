import type { ChatInputCommandInteraction } from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { acquireSeat, releaseSeat, resultEmbed, sleep, validateBet } from "./common.js";

/**
 * 🎰 スロット。casino-bot の数学を踏襲（絵柄は冥獄城テーマに差し替え）。
 * - ワイルド🌙 は3揃いの代用のみ（2揃いには効かない）
 * - スキャッター✨ が3つでフリースピン1回（連鎖なし）
 * - JP は純マモン😈³ のみ。積立=賭金1%、当選でプール半分獲得（半分はシード残留）
 * - ハウスエッジ 4%
 */

const HOUSE_EDGE = 0.04;
const JP_CONTRIBUTION = 0.01;
const JP_WIN_SHARE = 0.5;
/** 最大配当倍率（テーブルリミット判定用）: マモン³=100倍 */
const MAX_MULTIPLIER = 100;

interface SlotSymbol {
  emoji: string;
  name: string;
  weight: number;
  kind: "normal" | "wild" | "scatter";
}

const SYMBOLS: readonly SlotSymbol[] = [
  { emoji: "🦇", name: "蝙蝠", weight: 28, kind: "normal" },
  { emoji: "👻", name: "亡霊", weight: 23, kind: "normal" },
  { emoji: "🔥", name: "獄炎", weight: 17, kind: "normal" },
  { emoji: "⚔️", name: "魔剣", weight: 13, kind: "normal" },
  { emoji: "👑", name: "王冠", weight: 8, kind: "normal" },
  { emoji: "😈", name: "マモン", weight: 3, kind: "normal" },
  { emoji: "🌙", name: "月", weight: 5, kind: "wild" },
  { emoji: "✨", name: "魂片", weight: 3, kind: "scatter" },
] as const;

const TRIPLE_PAYOUTS: Record<string, number> = {
  蝙蝠: 3,
  亡霊: 5,
  獄炎: 10,
  魔剣: 15,
  王冠: 30,
  マモン: 100, // 純3つ揃いはJP扱い
  月: 25, // ワイルド自体の3揃い
};

const DOUBLE_PAYOUTS: Record<string, number> = {
  蝙蝠: 1,
  亡霊: 1.5,
  獄炎: 2,
  魔剣: 3,
  王冠: 5,
  マモン: 10,
};

function spinReel(): SlotSymbol {
  const total = SYMBOLS.reduce((a, s) => a + s.weight, 0);
  let roll = Math.random() * total;
  for (const s of SYMBOLS) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return SYMBOLS[0]!;
}

interface SpinOutcome {
  reels: SlotSymbol[];
  payout: number;
  kind: "none" | "double" | "triple" | "wild_triple" | "jackpot";
  matched?: string;
  freeSpin: boolean;
}

function evaluate(reels: SlotSymbol[], bet: number): SpinOutcome {
  const isWild = (s: SlotSymbol) => s.kind === "wild";
  const isScatter = (s: SlotSymbol) => s.kind === "scatter";
  const freeSpin = reels.filter(isScatter).length >= 3;
  const noScatter = !reels.some(isScatter);
  const pay = (mult: number) => Math.floor(bet * mult * (1 - HOUSE_EDGE));

  // 純3つ揃い
  if (noScatter && reels[0]!.name === reels[1]!.name && reels[1]!.name === reels[2]!.name) {
    const name = reels[0]!.name;
    const mult = TRIPLE_PAYOUTS[name] ?? 0;
    if (mult > 0) {
      if (name === "マモン") return { reels, payout: pay(mult), kind: "jackpot", matched: name, freeSpin };
      return { reels, payout: pay(mult), kind: name === "月" ? "wild_triple" : "triple", matched: name, freeSpin };
    }
  }
  // ワイルド代用3つ揃い（マモンはJP扱いせず通常配当）
  if (noScatter) {
    const wilds = reels.filter(isWild).length;
    const normals = reels.filter((s) => s.kind === "normal");
    if (wilds > 0 && wilds < 3 && normals.length > 0 && normals.every((s) => s.name === normals[0]!.name)) {
      const mult = TRIPLE_PAYOUTS[normals[0]!.name] ?? 0;
      if (mult > 0) return { reels, payout: pay(mult), kind: "wild_triple", matched: normals[0]!.name, freeSpin };
    }
  }
  // 純2つ揃い
  if (noScatter) {
    for (const sym of SYMBOLS) {
      if (sym.kind !== "normal") continue;
      if (reels.filter((r) => r.name === sym.name).length === 2) {
        const mult = DOUBLE_PAYOUTS[sym.name] ?? 0;
        if (mult > 0) return { reels, payout: pay(mult), kind: "double", matched: sym.name, freeSpin };
      }
    }
  }
  return { reels, payout: 0, kind: "none", freeSpin };
}

const face = (reels: SlotSymbol[], visible: number) =>
  reels.map((s, i) => (i < visible ? s.emoji : "❓")).join(" │ ");

export async function playSlots(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction, services, betRaw, betRaw * MAX_MULTIPLIER);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: 64 });
    return;
  }
  const bet = check.bet;
  try {
    const reels = [spinReel(), spinReel(), spinReel()];
    const spin1 = evaluate(reels, bet);

    // フリースピン（連鎖なし・同額扱いで追加払い出し）
    let free: SpinOutcome | null = null;
    if (spin1.freeSpin) {
      const reels2 = [spinReel(), spinReel(), spinReel()];
      free = evaluate(reels2, bet);
    }

    // 精算を先に確定（演出中の残高変動で失敗しないように。結果は既に決まっている）
    let totalPayout = spin1.payout + (free?.payout ?? 0);
    const jpCut = Math.max(1, Math.floor(bet * JP_CONTRIBUTION));
    services.casino.settle(uid, "slots", bet, totalPayout, jpCut);
    let jpWon = 0;
    if (spin1.kind === "jackpot") {
      jpWon = services.casino.seizeJackpot(uid, "slots", JP_WIN_SHARE);
      totalPayout += jpWon;
    }

    // 演出: 左→中→右 と止める
    await interaction.reply({ content: `🎰 **スロット** — 賭け ${fmtEther(bet)}\n${face(reels, 0)}` });
    await sleep(700);
    await interaction.editReply(`🎰 **スロット** — 賭け ${fmtEther(bet)}\n${face(reels, 1)}`);
    await sleep(700);
    await interaction.editReply(`🎰 **スロット** — 賭け ${fmtEther(bet)}\n${face(reels, 2)}`);
    await sleep(spin1.kind === "none" ? 700 : 1100);

    const lines: string[] = [`${face(reels, 3)}`];
    if (spin1.kind === "jackpot") {
      lines.push("", `😈😈😈 **ジャックポット！** 😈😈😈`, `配当 ${fmtEther(spin1.payout)} ＋ JP **${fmtEther(jpWon)}**`, `*「${Mammon.jackpot()}」*`);
    } else if (spin1.payout > 0) {
      lines.push("", `**${spin1.matched}** が揃った — 配当 ${fmtEther(spin1.payout)}`);
    } else {
      lines.push("", "外れだ。");
    }
    if (free) {
      lines.push("", `✨ 魂片が3つ——**フリースピン**発動！`, `${face(free.reels, 3)}`, free.payout > 0 ? `追加配当 ${fmtEther(free.payout)}` : "何も出なかった。");
    }

    const net = totalPayout - bet;
    await interaction.editReply({
      content: "",
      embeds: [
        resultEmbed({
          title: `🎰 スロット — ${net > 0 ? `+${fmtEther(net)}` : net < 0 ? `-${fmtEther(-net)}` : "±0"}`,
          lines,
          net,
          balance: services.ether.balanceOf(uid),
        }),
      ],
    });
  } finally {
    releaseSeat(uid);
  }
}
