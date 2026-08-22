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
import { HOLDEM_MAX_PAYOUT_MULT, type CasinoRng } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import {
  MIN_BET,
  acquireSeat,
  releaseSeat,
  sleep,
  validateBet,
  withHouseReservation,
} from "./common.js";
import { broadcastBigWin } from "./bigwin.js";
import { C_MAMMON, E, fmtBigDelta, handHeadline, handText } from "./ui.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  isCollectorTimeoutError,
  recordCasinoGameAbandonBestEffort,
  recordCasinoGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";
import { recordCasinoParticipationBestEffort } from "./participation-history.js";

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
/**
 * アンティに対する最大 pot 倍率（PR4 で訂正）。
 *
 * 旧値 8 は「アンティ + 3ラウンドのコール」を想定していたが、実際には
 * preflop / flop / turn / river の**4局面すべてでコールできる**ので、
 * 片側の総賭けは 5×ante、pot は 10×ante。受付時のテーブルリミットが
 * 1ラウンドぶん最悪ケースを覆っていなかった。
 */
const MAX_MULT = HOLDEM_MAX_PAYOUT_MULT;

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANK_LABEL = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;

interface Card {
  suit: (typeof SUITS)[number];
  rank: number;
}

const showCard = (c: Card) => `${c.suit}${RANK_LABEL[c.rank]}`;

function newDeck(rng: CasinoRng): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ suit: s, rank: r });
  return rng.shuffle(d);
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

/**
 * 伏せ札。`🂠`(U+1F0A0) は環境によって豆腐や極小カードになるので使わない。
 * `▮` なら通常テキストでもボタンでも確実に描画される。
 */
const BACK = "▮";
const backs = (n: number) => handText(Array.from({ length: n }, () => BACK));
const showHand = (hand: Card[], hide = false) =>
  hide ? backs(hand.length) : handText(hand.map(showCard));

export function holdemRulesEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · ホールデム" })
    .setColor(C_MAMMON)
    .setTitle("📖 ホールデム — ルール")
    .setDescription(
      [
        "2枚の手札と5枚の共有札から最強の5枚役を作る。",
        "プリフロップ、フロップ、ターン、リバーでコール・チェック・フォールドを選ぶ。",
        "コールは開始anteと同額を追加し、マモンも同額を積む。",
        "ショウダウンでは強い役がpot総取り。引き分けは自分の最終賭けを返却。",
      ].join("\n"),
    );
}

export async function playHoldem(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  try {
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "ホールデム");
    if (!check.ok) return;
    await runRound(interaction, services, check.bet, context);
  } finally {
    releaseSeat(uid);
  }
}

/**
 * 1回ぶんの入口。**先に最悪ケースの債務を予約**してから本体へ入る（PR5・正本 §11.2）。
 * 予約が取れなければ本体を一度も呼ばず、押せる金額を提示して戻る（金は1 Ld も動かない）。
 */
async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  ante: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  await withHouseReservation(interaction, services, "ホールデム", ante, interaction.id, (reservationKey) =>
    runRoundInner(interaction, services, ante, reservationKey, context),
  );
}

async function runRoundInner(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  ante: number,
  reservationKey: string,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  const playContext = casinoPlayContext(context);
  recordCasinoGameStartBestEffort(services, {
    userId: uid,
    game: "ホールデム",
    operationId: interaction.id,
    wager: ante,
    source: playContext.source,
  });
  const deck = newDeck(services.rng);
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
        ? backs(5)
        : phase === "flop"
          ? `${showHand(flop)}  ${backs(2)}`
          : phase === "turn"
            ? `${showHand([...flop, turn])}  ${BACK}`
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
      .setTitle(`🃏  ${phaseLabel}  ·  Pot ${fmtEther(pot).replace(" Ld", "Ld")}`)
      .setDescription(
        [
          // 共有札はこの卓の主役なので見出しサイズで。手役は下に通常サイズで並べる
          handHeadline([board]),
          `${E.demon} **マモン**　${phase === "showdown" ? showHand(dHand) : backs(2)}`,
          `${E.crown} **お前**　　${showHand(pHand)}`,
          note ? `\n${note}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setFooter({ text: `賭け ${fmtEther(playerBet).replace(" Ld", "Ld")} / マモン ${fmtEther(dealerBet).replace(" Ld", "Ld")}` });
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
    } catch (error) {
      if (!isCollectorTimeoutError(error)) throw error;
      recordCasinoGameAbandonBestEffort(services, {
        userId: uid,
        game: "ホールデム",
        operationId: interaction.id,
        wager: playerBet,
        source: playContext.source,
        reason: "action_timeout",
      });
      action = "check";
    }
    if (action === "fold") {
      folded = true;
      break;
    }
    if (action === "call" && services.chips.balanceOf(uid) >= playerBet + ante) {
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

  // お守りの消費も賭け・配当と同じグループの中（settleSolo）
  const settled = services.casino.settleSolo(uid, "ホールデム", playerBet, rawPayout, {
    operationId: interaction.id, reservationKey,
  });
  // settleSolo()が実際にshowdown/fold結果・賭け・配当を単一atomic transactionで確定
  // させた正本——ここへ到達した時点で初めて「実際のroundが成立した」と言える。
  // foldもshowdownも必ずこの単一settle呼び出しへ合流する（PR #163レビュー§3）。
  recordCasinoParticipationBestEffort(services, {
    participationKey: `solo:holdem:${interaction.id}`,
    activityKey: "holdem",
    participantUserIds: [uid],
  });
  recordCasinoGameFinishBestEffort(services, {
    userId: uid,
    game: "ホールデム",
    operationId: interaction.id,
    wager: playerBet,
    payout: settled.payout,
    net: settled.net,
    source: playContext.source,
  });
  const amulet = { note: settled.amuletNote };

  const won = settled.net > 0;
  const bonusBits: string[] = [];
  if (settled.chainBonus > 0) {
    bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  ${fmtBigDelta(settled.chainBonus)}`);
  }
  if (settled.fukuTax > 0) {
    bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  ${fmtBigDelta(-settled.fukuTax)}`);
  }
  if (amulet.note) bonusBits.push(`${E.sparkle} ${amulet.note}`);

  const resultPayload = buildSoloResult({
    services,
    userId: uid,
    game: "ホールデム",
    net: settled.net,
    wager: playerBet,
    retryBet: ante,
    // 盤面はフィールドに分割せず description にまとめる。
    // 対戦中の画面と同じ並びのまま結果になるので、目が迷わない
    description: [
      handHeadline([showHand([...flop, turn, river])]),
      `${E.demon} **マモン**　${folded ? backs(2) : showHand(dHand)}`,
      `${E.crown} **お前**　　${showHand(pHand)}`,
      note ? `\n${note}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    sections: bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : [],
  });

  if (won) {
    broadcastBigWin(interaction.client, services, { userId: uid, game: "ホールデム", bet: playerBet, payout: settled.payout });
  }

  await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
}
