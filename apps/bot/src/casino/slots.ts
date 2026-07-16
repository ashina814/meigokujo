import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, acquireSeat, applyAmulets, releaseSeat, sleep, validateBet } from "./common.js";
import { C_MAMMON } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🎰 スロット。casino-bot 準拠の忠実移植。
 * - 3リール、シンボルは冥獄城テーマ
 * - リール1→2→3 と順に止まる演出（サイクル絵柄でぐるぐる感）
 * - 1+2 リールが同じ絵柄で止まったら「あと一つで…」ニアミス煽り
 * - JP は純😈³のみ。積立=賭金1%、当選でプール半分獲得
 * - 魂片✨3つでフリースピン1回（自動再スピン・賭金不要）
 * - 結果画面に「最低/前回/最大」の3ボタン + 📖配当表ボタン
 */

const HOUSE_EDGE = 0.04;
const JP_CONTRIBUTION = 0.01;
const JP_WIN_SHARE = 0.5;
const SCATTER_TRIGGER_COUNT = 3;
const MAX_MULTIPLIER = 100; // マモン³=100倍。テーブルリミット判定用

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
];

const TRIPLE_PAYOUTS: Record<string, number> = {
  蝙蝠: 3,
  亡霊: 5,
  獄炎: 10,
  魔剣: 15,
  王冠: 30,
  マモン: 100,
  月: 25,
};

const DOUBLE_PAYOUTS: Record<string, number> = {
  蝙蝠: 1,
  亡霊: 1.5,
  獄炎: 2,
  魔剣: 3,
  王冠: 5,
  マモン: 10,
};

const CYCLE = ["🦇", "👻", "🔥", "⚔️", "👑", "😈", "🌙", "✨"] as const;
const cycleAt = (n: number) => CYCLE[n % CYCLE.length]!;

function spinReel(): SlotSymbol {
  const total = SYMBOLS.reduce((a, s) => a + s.weight, 0);
  let roll = Math.random() * total;
  for (const s of SYMBOLS) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return SYMBOLS[0]!;
}

const isScatter = (s: SlotSymbol) => s.kind === "scatter";
const isWild = (s: SlotSymbol) => s.kind === "wild";

interface SpinOutcome {
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
  payout: number;
  kind: "none" | "double" | "triple" | "wild_triple" | "jackpot";
  matched?: string;
  freeSpin: boolean;
}

function evaluate(reels: [SlotSymbol, SlotSymbol, SlotSymbol], bet: number): SpinOutcome {
  const scatterCount = reels.filter(isScatter).length;
  const freeSpin = scatterCount >= SCATTER_TRIGGER_COUNT;
  const noScatter = !reels.some(isScatter);
  const pay = (mult: number) => Math.floor(bet * mult * (1 - HOUSE_EDGE));

  if (noScatter && reels[0].name === reels[1].name && reels[1].name === reels[2].name) {
    const name = reels[0].name;
    const mult = TRIPLE_PAYOUTS[name] ?? 0;
    if (mult > 0) {
      if (name === "マモン") return { reels, payout: pay(mult), kind: "jackpot", matched: name, freeSpin };
      return { reels, payout: pay(mult), kind: name === "月" ? "wild_triple" : "triple", matched: name, freeSpin };
    }
  }
  if (noScatter) {
    const wilds = reels.filter(isWild).length;
    const normals = reels.filter((s) => s.kind === "normal");
    if (wilds > 0 && wilds < 3 && normals.length > 0 && normals.every((s) => s.name === normals[0]!.name)) {
      const mult = TRIPLE_PAYOUTS[normals[0]!.name] ?? 0;
      if (mult > 0) return { reels, payout: pay(mult), kind: "wild_triple", matched: normals[0]!.name, freeSpin };
    }
  }
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

function paytableEmbed(): EmbedBuilder {
  const tripleLines = Object.entries(TRIPLE_PAYOUTS)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      const label = name === "マモン" ? `${sym.emoji} ${name} (純3つでJP)` : `${sym.emoji} ${name}`;
      return `　${label}: **${mul}倍**`;
    })
    .join("\n");
  const doubleLines = Object.entries(DOUBLE_PAYOUTS)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      return `　${sym.emoji} ${name}: **${mul}倍**`;
    })
    .join("\n");
  return new EmbedBuilder()
    .setTitle("📖 スロット — 配当表")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**🎯 3つ揃い** (3リール同じ絵柄)",
        tripleLines,
        "",
        "**🎯 2つ揃い** (2リール同じ絵柄・ワイルド代用不可)",
        doubleLines,
        "",
        "**🌙 月（ワイルド）**",
        "　他の絵柄を補って3つ揃いを成立させる（マモン純3はJP扱いだがワイルド代用は通常配当）",
        "",
        "**✨ 魂片（スキャッター）**",
        `　位置不問で${SCATTER_TRIGGER_COUNT}つ出現 → **賭金不要でもう1回スピン**`,
        "",
        "**🏆 ジャックポット**",
        `　純3つの 😈 マモン で発動`,
        `　 → 通常配当 + JPプールの **${JP_WIN_SHARE * 100}%** を獲得`,
        `　 (プールは賭金の ${JP_CONTRIBUTION * 100}% を毎回積立)`,
        "",
        "**⚖️ 福の重み**",
        "　残高が多いほど勝ち利益から累進奉納（0/5/10/20/30%）。半分は JP・半分は救済プールへ",
        "**🔥 連鎖**",
        "　2連勝目から倍率が乗る（最大 ×2.0）。連敗でリセット",
      ].join("\n"),
    );
}

/**
 * リール表示（枠線で囲む・二重枠で目立たせる）
 * ╔═══╦═══╦═══╗
 * ║ 🦇 ║ 👻 ║ 🔥 ║
 * ╚═══╩═══╩═══╝
 */
const face = (a: string, b: string, c: string) =>
  ["╔═════╦═════╦═════╗", `║  ${a}  ║  ${b}  ║  ${c}  ║`, "╚═════╩═════╩═════╝"].join("\n");

function buildSpinEmbed(
  services: Services,
  bet: number,
  isFreeSpin: boolean,
  label: string,
  slots: [string, string, string],
): EmbedBuilder {
  const jp = services.casino.jackpotPool();
  const jpHigh = jp >= 100_000;
  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · スロット${isFreeSpin ? " · フリースピン" : ""}` })
    .setColor(jpHigh ? 0xf0b429 : C_MAMMON)
    .setTitle(`🎰  ${label}`)
    .setDescription(face(slots[0], slots[1], slots[2]))
    .setFooter({
      text: [
        isFreeSpin ? "ベット: 無料" : `ベット ${fmtEther(bet).replace(" ◈", "◈")}`,
        `JP ${fmtEther(jp).replace(" ◈", "◈")}${jpHigh ? " 🔥" : ""}`,
      ].join(" · "),
    });
}

function retryButtons(uid: string, bet: number, services: Services): ActionRowBuilder<ButtonBuilder> {
  const held = services.ether.balanceOf(uid);
  const min = MIN_BET;
  const max = Math.min(MAX_BET, held);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`slots:retry:${min}`)
      .setLabel(`最低 ${min.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(held < min),
    new ButtonBuilder()
      .setCustomId(`slots:retry:${bet}`)
      .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(held < bet),
    new ButtonBuilder()
      .setCustomId(`slots:retry:${max}`)
      .setLabel(`最大 ${max.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(max < min),
    new ButtonBuilder().setCustomId("slots:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
  );
}

export async function playSlots(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, betRaw * MAX_MULTIPLIER);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  try {
    await runOne(interaction, services, check.bet, false);
  } finally {
    releaseSeat(uid);
  }
}

async function runOne(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  isFreeSpin: boolean,
): Promise<void> {
  const uid = interaction.user.id;
  const reelsRaw: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(), spinReel(), spinReel()];
  const spin = evaluate(reelsRaw, bet);

  // お守り: 勝ちなら勝利ボーナス、負けなら返金保護
  const amulet = applyAmulets(services, uid, bet, spin.payout);
  const adjustedPayout = amulet.payout;
  // 精算を先に確定（演出中の残高変動で失敗しないよう）。フリースピンなら賭けは無料
  const jpCut = isFreeSpin ? 0 : Math.max(1, Math.floor(bet * JP_CONTRIBUTION));
  let settled: import("@meigokujo/core").SettleResult | null = null;
  let jpWon = 0;
  if (isFreeSpin) {
    // フリースピンは配当のみ（賭けなし）。settle は使わず胴元→プレイヤーの直接転送
    if (adjustedPayout > 0 && services.casino.canAccept(adjustedPayout)) {
      services.ether.transfer("house", uid, adjustedPayout);
    }
  } else {
    settled = services.casino.settle(uid, "スロット", bet, adjustedPayout, jpCut);
  }
  // JP はフリースピンでも当選する（原作準拠）
  if (spin.kind === "jackpot") {
    jpWon = services.casino.seizeJackpot(uid, "slots", JP_WIN_SHARE);
  }

  // ── Phase 1: スピンアニメ ──
  const initialEmbed = buildSpinEmbed(services, bet, isFreeSpin, "壺の中で運命が転がる……", ["❓", "❓", "❓"]);
  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [initialEmbed] })) as Message;
  } else {
    await interaction.reply({ embeds: [initialEmbed] });
    reply = (await interaction.fetchReply()) as Message;
  }

  const edit = async (embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = []) => {
    try {
      await reply.edit({ embeds: [embed], components });
    } catch {
      /* ignore */
    }
  };

  // リール1: サイクル→確定
  for (let t = 0; t < 3; t++) {
    await sleep(160);
    await edit(buildSpinEmbed(services, bet, isFreeSpin, "ぐるぐる……", [cycleAt(t * 3), cycleAt(t * 3 + 1), cycleAt(t * 3 + 2)]));
  }
  await sleep(160);
  await edit(buildSpinEmbed(services, bet, isFreeSpin, "ふむ……", [reelsRaw[0].emoji, cycleAt(99), cycleAt(98)]));

  // リール2: サイクル→確定
  for (let t = 0; t < 3; t++) {
    await sleep(160);
    await edit(buildSpinEmbed(services, bet, isFreeSpin, "おぉ……", [reelsRaw[0].emoji, cycleAt(t * 5), cycleAt(t * 5 + 1)]));
  }
  await sleep(160);

  // リール1+2 のニアミス煽り
  const isNearMiss =
    !isScatter(reelsRaw[0]) &&
    !isScatter(reelsRaw[1]) &&
    reelsRaw[0].kind === "normal" &&
    reelsRaw[1].kind === "normal" &&
    reelsRaw[0].name === reelsRaw[1].name;
  const teaseLabel = isNearMiss ? `あと一つで **${reelsRaw[0].name}** が揃う……！` : "むむ……";
  await edit(buildSpinEmbed(services, bet, isFreeSpin, teaseLabel, [reelsRaw[0].emoji, reelsRaw[1].emoji, "❓"]));
  await sleep(isNearMiss ? 1900 : 1100);

  // ── Phase 2: 結果 ──
  const payoutLabel = (() => {
    switch (spin.kind) {
      case "jackpot": return `🎉 **JACKPOT！** 純3マモン揃い`;
      case "triple": return `3つ揃い (${spin.matched})`;
      case "wild_triple": return `🌙 ワイルド3つ揃い (${spin.matched})`;
      case "double": return `2つ揃い (${spin.matched})`;
      default: return "";
    }
  })();
  const reelDisplay = face(reelsRaw[0].emoji, reelsRaw[1].emoji, reelsRaw[2].emoji);

  const won = adjustedPayout > 0;
  const totalPayout = adjustedPayout + jpWon + (settled?.chainBonus ?? 0) - (settled?.fukuTax ?? 0);
  const net = totalPayout - (isFreeSpin ? 0 : bet);
  const stats = services.casino.stats(uid);
  const winStreak = won ? stats.current_win_streak : 0;
  const streakBadge = winStreak >= 2 ? `🔥 ${winStreak}連勝中！\n` : "";

  const jpLine = jpWon > 0 ? `\n💎 JPプール獲得: **${fmtEther(jpWon)}** (残 ${fmtEther(services.casino.jackpotPool())})` : "";
  const freeSpinNotice = spin.freeSpin && !isFreeSpin ? `\n\n✨✨ **魂片3つ！フリースピン獲得！** ✨✨` : "";
  const chainLine =
    settled && settled.chainBonus > 0
      ? `\n${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
  const fukuLine =
    settled && settled.fukuTax > 0
      ? `\n⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納`
      : "";

  // 結果 embed（Fields でセクション化）
  const isJp = spin.kind === "jackpot";
  const bigWin = won && totalPayout >= bet * 5;
  const color = isJp ? 0xf0b429 : bigWin ? 0x16a34a : won ? 0x22c55e : 0x991b1b;

  const tag = isJp ? "💎 JACKPOT!" : bigWin ? "🔥 大勝ち" : won ? "🟢 勝ち" : "🔴 ハズレ";
  const netStr = net === 0 ? "±0 ◈" : `${net > 0 ? "+" : "−"}${Math.abs(net).toLocaleString("ja-JP")} ◈`;

  const bonusBits: string[] = [];
  if (settled && settled.chainBonus > 0) {
    bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  +${fmtEther(settled.chainBonus)}`);
  }
  if (settled && settled.fukuTax > 0) {
    bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  −${fmtEther(settled.fukuTax)}`);
  }
  if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);
  if (jpWon > 0) bonusBits.push(`💎 JP獲得  +${fmtEther(jpWon)}（残 ${fmtEther(services.casino.jackpotPool())}）`);

  const resultEmbed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · スロット${isFreeSpin ? " · フリースピン" : ""}` })
    .setColor(color)
    .setTitle(`${tag}  **${netStr}**`)
    .setDescription(reelDisplay + (payoutLabel ? `\n\n${payoutLabel}` : "") + (spin.freeSpin && !isFreeSpin ? `\n\n✨ **魂片3つ！フリースピン獲得！** ✨` : ""))
    .addFields(
      ...(bonusBits.length > 0
        ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }]
        : []),
    )
    .setFooter({
      text: [
        `所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}`,
        !isFreeSpin ? `賭け ${fmtEther(bet).replace(" ◈", "◈")}` : "無料",
        winStreak >= 2 ? `🔥 ${winStreak}連勝` : "",
        `JP ${fmtEther(services.casino.jackpotPool()).replace(" ◈", "◈")}`,
      ].filter(Boolean).join(" · "),
    });
  void streakBadge;
  void chainLine;
  void fukuLine;
  void amulet;
  void freeSpinNotice;
  void jpLine;

  // 大勝ち速報
  if (won) {
    broadcastBigWin(interaction.client, services, {
      userId: uid,
      game: "スロット",
      bet: isFreeSpin ? 0 : bet,
      payout: totalPayout,
      isJackpot: spin.kind === "jackpot",
    });
  }

  // フリースピンなら結果表示後に自動で再スピン（原作準拠）
  if (spin.freeSpin && !isFreeSpin) {
    await edit(resultEmbed, []);
    await sleep(2500);
    await runOne(interaction, services, bet, true);
    return;
  }

  await edit(resultEmbed, [retryButtons(uid, bet, services)]);

  // ── 「もう一回」/配当表 コレクタ ──
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "slots:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId.startsWith("slots:retry:")) {
      collector.stop("retry");
      const retryBet = Number(btn.customId.split(":")[2]);
      await btn.deferUpdate();
      // acquireSeat のためこの playSlots は releaseSeat 後に呼ぶ必要があるが、
      // 現在の座席は runOne の親（playSlots）が持っている。ここで一旦解放して再取得する。
      releaseSeat(uid);
      if (acquireSeat(uid)) {
        try {
          await runOne(btn, services, retryBet, false);
        } finally {
          releaseSeat(uid);
        }
      }
    }
  });
  collector.on("end", async (_col, reason) => {
    if (reason !== "retry") await edit(resultEmbed, []).catch(() => undefined);
  });
}
