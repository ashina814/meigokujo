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
import { broadcastBigWin } from "./bigwin.js";
import { C_MAMMON, E, HR_THIN, buildResultEmbed, fmtBigDelta } from "./ui.js";

/**
 * 🃏 テキサスホールデム（対マモン簡易版・ソロ）。
 * casino-bot の多人数実装（1000+行）は簡略化し、対胴元1v1のシンプル版で実装。
 * - アンティ = 賭け金
 * - ホール2枚を各人に配布 → プレフロップ選択（コール +1x / フォールド）
 * - フロップ3枚 → ターン選択（コール +1x / チェック / フォールド）
 * - ターン1枚 → リバー選択
 * - リバー1枚 → 各人7枚から最強5枚役判定、勝者が pot 総取り
 * - マモンは常にコール（弱いブラフ判断は入れない・単純化）
 */
const MAX_MULT = 8; // アンティ×8 が最大 pot（アンティ+3ラウンドのコール = 4x per player = 8x pot）

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANK_LABEL = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;

interface Card {
  suit: (typeof SUITS)[number];
  rank: number;
}

const showCard = (c: Card) => `${c.suit}${RANK_LABEL[c.rank]}`;

function newDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ suit: s, rank: r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}

interface HandEval {
  category: number;
  tiebreak: number[];
  label: string;
}
const CAT_LABELS = [
  "",
  "ハイカード",
  "ペア",
  "ツーペア",
  "3カード",
  "ストレート",
  "フラッシュ",
  "フルハウス",
  "4カード",
  "ストレートフラッシュ",
  "ロイヤルフラッシュ",
] as const;

function evaluate5(hand: Card[]): HandEval {
  const ranks = hand.map((c) => c.rank).sort((a, b) => b - a);
  const suitCount: Record<string, number> = {};
  for (const c of hand) suitCount[c.suit] = (suitCount[c.suit] ?? 0) + 1;
  const isFlush = Object.values(suitCount).some((n) => n === 5);
  const unique = Array.from(new Set(ranks)).sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) {
      isStraight = true;
      straightHigh = unique[0]!;
    } else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      isStraight = true;
      straightHigh = 5;
    }
  }
  const rankCount: Record<number, number> = {};
  for (const r of ranks) rankCount[r] = (rankCount[r] ?? 0) + 1;
  const groups = Object.entries(rankCount)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  let cat = 1;
  let tb: number[] = ranks;
  if (isStraight && isFlush && straightHigh === 14) {
    cat = 10;
    tb = [14];
  } else if (isStraight && isFlush) {
    cat = 9;
    tb = [straightHigh];
  } else if (groups[0]!.count === 4) {
    cat = 8;
    tb = [groups[0]!.rank, groups[1]!.rank];
  } else if (groups[0]!.count === 3 && groups[1]?.count === 2) {
    cat = 7;
    tb = [groups[0]!.rank, groups[1]!.rank];
  } else if (isFlush) {
    cat = 6;
    tb = ranks;
  } else if (isStraight) {
    cat = 5;
    tb = [straightHigh];
  } else if (groups[0]!.count === 3) {
    cat = 4;
    tb = [groups[0]!.rank, ...groups.slice(1).map((g) => g.rank)];
  } else if (groups[0]!.count === 2 && groups[1]?.count === 2) {
    cat = 3;
    tb = [groups[0]!.rank, groups[1]!.rank, groups[2]!.rank];
  } else if (groups[0]!.count === 2) {
    cat = 2;
    tb = [groups[0]!.rank, ...groups.slice(1).map((g) => g.rank)];
  }
  return { category: cat, tiebreak: tb, label: CAT_LABELS[cat] ?? "不明" };
}

/** 7枚から最強5枚役を計算（C(7,5)=21通り総当たり） */
function bestOf7(cards: Card[]): HandEval {
  let best: HandEval | null = null;
  const n = cards.length;
  const combos: number[][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) combos.push([a, b, c, d, e]);
  for (const idx of combos) {
    const ev = evaluate5(idx.map((i) => cards[i]!));
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  return best!;
}

function compareEval(a: HandEval, b: HandEval): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const x = a.tiebreak[i] ?? 0;
    const y = b.tiebreak[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const showHand = (hand: Card[], hide = false) => (hide ? hand.map(() => "🂠").join(" ") : hand.map(showCard).join(" "));

export async function playHoldem(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, betRaw * MAX_MULT);
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
    await runRound(interaction, services, check.bet);
  } finally {
    releaseSeat(uid);
  }
}

async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  ante: number,
): Promise<void> {
  const uid = interaction.user.id;
  const deck = newDeck();
  const pHand: [Card, Card] = [deck.pop()!, deck.pop()!];
  const dHand: [Card, Card] = [deck.pop()!, deck.pop()!];
  const flop: Card[] = [deck.pop()!, deck.pop()!, deck.pop()!];
  const turn: Card = deck.pop()!;
  const river: Card = deck.pop()!;

  let playerBet = ante;
  let dealerBet = ante;

  const render = (phase: "preflop" | "flop" | "turn" | "river" | "showdown", note?: string) => {
    const board =
      phase === "preflop"
        ? "🂠 🂠 🂠 🂠 🂠"
        : phase === "flop"
          ? `${showHand(flop)}  🂠 🂠`
          : phase === "turn"
            ? `${showHand([...flop, turn])} 🂠`
            : showHand([...flop, turn, river]);
    const phaseLabel = {
      preflop: "プリフロップ",
      flop: "フロップ",
      turn: "ターン",
      river: "リバー",
      showdown: "ショウダウン",
    }[phase];
    const pot = playerBet + dealerBet;
    return new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · ホールデム" })
      .setColor(C_MAMMON)
      .setTitle(`🃏  ${phaseLabel}  ·  Pot ${fmtEther(pot).replace(" ◈", "◈")}`)
      .setDescription(
        [
          `**ボード**   ${board}`,
          `${E.demon} マモン   ${phase === "showdown" ? showHand(dHand) : "🂠 🂠"}`,
          `${E.crown} お前     ${showHand(pHand)}`,
          note ? `${HR_THIN}\n${note}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setFooter({ text: `賭け ${fmtEther(playerBet).replace(" ◈", "◈")} / マモン ${fmtEther(dealerBet).replace(" ◈", "◈")}` });
  };

  const actionRow = (phase: string) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`holdem:call:${phase}`).setLabel(`コール (+${fmtEther(ante)})`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`holdem:check:${phase}`).setLabel("チェック").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`holdem:fold:${phase}`).setLabel("フォールド").setStyle(ButtonStyle.Danger),
    );

  // アンティ徴収は最終精算時（Casino.settle）に一括で
  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [render("preflop")], components: [actionRow("preflop")] })) as Message;
  } else {
    await interaction.reply({ embeds: [render("preflop")], components: [actionRow("preflop")] });
    reply = (await interaction.fetchReply()) as Message;
  }

  const phases: Array<"preflop" | "flop" | "turn" | "river"> = ["preflop", "flop", "turn", "river"];
  let folded = false;
  for (const phase of phases) {
    if (folded) break;
    let action: "call" | "check" | "fold";
    try {
      const btn = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === uid && i.customId.startsWith(`holdem:`) && i.customId.endsWith(`:${phase}`),
        time: 60_000,
      });
      const parsed = btn.customId.split(":")[1];
      action = parsed === "call" ? "call" : parsed === "fold" ? "fold" : "check";
      await btn.deferUpdate();
    } catch {
      action = "check";
    }
    if (action === "fold") {
      folded = true;
      break;
    }
    if (action === "call" && services.ether.balanceOf(uid) >= playerBet + ante) {
      playerBet += ante;
      dealerBet += ante; // マモンも同額コール
    }
    // 次フェーズの表示を描画
    const nextIdx = phases.indexOf(phase) + 1;
    if (nextIdx < phases.length) {
      const nextPhase = phases[nextIdx]!;
      await reply.edit({ embeds: [render(nextPhase)], components: [actionRow(nextPhase)] }).catch(() => undefined);
      await sleep(400);
    }
  }

  // ── 精算 ──
  let rawPayout = 0;
  let note = "";
  if (folded) {
    // フォールド: playerBet を没収
    rawPayout = 0;
    note = "🏳 フォールド。賭けはマモンのもの。";
  } else {
    // ショウダウン
    const pBest = bestOf7([...pHand, ...flop, turn, river]);
    const dBest = bestOf7([...dHand, ...flop, turn, river]);
    const cmp = compareEval(pBest, dBest);
    const pot = playerBet + dealerBet;
    if (cmp > 0) {
      rawPayout = pot; // 総取り
      note = `**${pBest.label}** vs **${dBest.label}** — お前の勝ち！`;
    } else if (cmp < 0) {
      rawPayout = 0;
      note = `**${pBest.label}** vs **${dBest.label}** — マモンの勝ち。`;
    } else {
      rawPayout = playerBet; // プッシュ（自分の賭けを返却）
      note = `**${pBest.label}** — 引き分け（プッシュ）`;
    }
    await reply.edit({ embeds: [render("showdown", note)], components: [] }).catch(() => undefined);
    await sleep(1200);
  }

  const amulet = applyAmulets(services, uid, playerBet, rawPayout);
  const settled = services.casino.settle(uid, "ホールデム", playerBet, amulet.payout);

  const won = settled.net > 0;
  const bonusBits: string[] = [];
  if (settled.chainBonus > 0) {
    bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  ${fmtBigDelta(settled.chainBonus)}`);
  }
  if (settled.fukuTax > 0) {
    bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  ${fmtBigDelta(-settled.fukuTax)}`);
  }
  if (amulet.note) bonusBits.push(`${E.sparkle} ${amulet.note}`);

  const resultEmbed = buildResultEmbed({
    game: "ホールデム",
    net: settled.net,
    bet: playerBet,
    balance: services.ether.balanceOf(uid),
    sections: [
      { icon: "🃏", label: "ボード", value: showHand([...flop, turn, river]), inline: false },
      {
        icon: "👥",
        label: "手役",
        value: [
          `${E.crown} お前     ${showHand(pHand)}`,
          `${E.demon} マモン   ${folded ? "🂠 🂠" : showHand(dHand)}`,
          note,
        ]
          .filter(Boolean)
          .join("\n"),
        inline: false,
      },
      ...(bonusBits.length > 0
        ? [{ icon: "🔥", label: "ボーナス", value: bonusBits.join("\n"), inline: false } as const]
        : []),
    ],
  });

  if (won) {
    broadcastBigWin(interaction.client, services, { userId: uid, game: "ホールデム", bet: playerBet, payout: settled.payout });
  }

  const heldEther = services.ether.balanceOf(uid);
  const min = MIN_BET;
  const max = Math.min(MAX_BET, heldEther);
  const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`holdem:retry:${min}`)
      .setLabel(`最低 ${min.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(heldEther < min),
    new ButtonBuilder()
      .setCustomId(`holdem:retry:${ante}`)
      .setLabel(`🎰 もう一回 ${ante.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(heldEther < ante),
    new ButtonBuilder()
      .setCustomId(`holdem:retry:${max}`)
      .setLabel(`最大 ${max.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(max < min),
    new ButtonBuilder().setCustomId("holdem:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
  );
  await reply.edit({ embeds: [resultEmbed], components: [retryRow] }).catch(() => undefined);

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "holdem:quit") {
      collector.stop("quit");
      await btn.deferUpdate();
      await reply.edit({ components: [] }).catch(() => undefined);
      return;
    }
    if (btn.customId.startsWith("holdem:retry:")) {
      collector.stop("retry");
      const retryBet = Number(btn.customId.split(":")[2]);
      if (retryBet < MIN_BET || retryBet > MAX_BET) return;
      await btn.deferUpdate();
      releaseSeat(uid);
      if (acquireSeat(uid)) {
        try {
          await runRound(btn, services, retryBet);
        } finally {
          releaseSeat(uid);
        }
      }
    }
  });
  collector.on("end", async (_c, reason) => {
    if (reason !== "retry" && reason !== "quit") await reply.edit({ components: [] }).catch(() => undefined);
  });
}
