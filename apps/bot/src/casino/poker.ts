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
import { POKER_CATEGORY_PAYOUTS, type CasinoRng } from "@meigokujo/core";
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
import { C_JACKPOT, C_MAMMON, E, HR_THIN, fmtBigDelta } from "./ui.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  recordCasinoGameAbandonBestEffort,
  recordCasinoGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";

const MAX_MULT = POKER_CATEGORY_PAYOUTS[11]!;
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
  label: string;
  payMult: number;
}
const CAT_LABELS: readonly string[] = [
  "", "ハイカード", "ペア（低）", "ペア（J以上）", "ツーペア", "3カード", "ストレート",
  "フラッシュ", "フルハウス", "4カード", "ストレートフラッシュ", "ロイヤルフラッシュ",
];
const CAT_PAYS: readonly number[] = POKER_CATEGORY_PAYOUTS;

function evaluate(hand: Card[]): HandEval {
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
  if (isStraight && isFlush && straightHigh === 14) cat = 11;
  else if (isStraight && isFlush) cat = 10;
  else if (groups[0]!.count === 4) cat = 9;
  else if (groups[0]!.count === 3 && groups[1]?.count === 2) cat = 8;
  else if (isFlush) cat = 7;
  else if (isStraight) cat = 6;
  else if (groups[0]!.count === 3) cat = 5;
  else if (groups[0]!.count === 2 && groups[1]?.count === 2) cat = 4;
  else if (groups[0]!.count === 2 && groups[0]!.rank >= 11) cat = 3;
  else if (groups[0]!.count === 2) cat = 2;
  return { category: cat, label: CAT_LABELS[cat]!, payMult: CAT_PAYS[cat]! };
}

export function paytableEmbed(): EmbedBuilder {
  const lines = [
    "🏆  ロイヤルフラッシュ  ·  **×250**", "🌟  ストレートフラッシュ  ·  **×50**", "🎯  4カード  ·  **×25**",
    "🎴  フルハウス  ·  **×9**", "🔷  フラッシュ  ·  **×6**", "➡  ストレート  ·  **×4**",
    "🃏  3カード  ·  **×3**", "🎭  ツーペア  ·  **×2**", "💫  J以上のペア  ·  **×1**（元本返却+1倍）", "😔  それ以下  ·  負け",
  ];
  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · ポーカー" })
    .setColor(C_MAMMON)
    .setTitle("📖  配当表  ·  Jacks or Better")
    .setDescription("5枚配札 → 保持を選ぶ → 交換 → 役判定。52枚デッキ1組・RTP 約96%。")
    .addFields(
      { name: "▸ 配当", value: lines.join("\n"), inline: false },
      { name: "▸ ⚖️ 福の重み / 🔥 連鎖チェーン", value: "勝ちで発動（残高が多いほど福分け積立・連勝で倍率）", inline: false },
    );
}

export async function playPoker(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "ポーカー");
    if (!check.ok) return;
    await runRound(interaction, services, check.bet, context);
  } finally {
    releaseSeat(uid);
  }
}

async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  await withHouseReservation(interaction, services, "ポーカー", bet, interaction.id, (reservationKey) =>
    runRoundInner(interaction, services, bet, reservationKey, context),
  );
}

async function runRoundInner(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  reservationKey: string,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  const playContext = casinoPlayContext(context);
  recordCasinoGameStartBestEffort(services, { userId: uid, game: "ポーカー", operationId: interaction.id, wager: bet, source: playContext.source });
  const deck = newDeck(services.rng);
  const hand: Card[] = [];
  for (let i = 0; i < 5; i++) hand.push(deck.pop()!);
  const held = new Set<number>();

  const buildEmbed = (phase: "draw" | "reveal", finalEval?: HandEval) => {
    const cardsLine = hand.map((c, i) => (held.has(i) ? `[**${showCard(c)}**]` : `[${showCard(c)}]`)).join("  ");
    return new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · ポーカー" })
      .setColor(C_MAMMON)
      .setTitle(`🃏  ドロー  ·  保持 ${held.size}枚 / 交換 ${5 - held.size}枚`)
      .setDescription([
        cardsLine, HR_THIN,
        phase === "draw" ? "保持したい札のボタンを押す（再押しで解除）→ **交換** で確定" : finalEval ? `**${finalEval.label}**  ·  配当倍率 **×${finalEval.payMult}**` : "",
      ].filter(Boolean).join("\n"))
      .setFooter({ text: `賭け ${fmtEther(bet).replace(" Ld", "Ld")}` });
  };

  const cardButtons = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...hand.map((c, i) => new ButtonBuilder().setCustomId(`poker:hold:${i}`).setLabel(showCard(c)).setStyle(held.has(i) ? ButtonStyle.Success : ButtonStyle.Secondary)),
  );
  const actionRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("poker:draw").setLabel(`交換（${5 - held.size}枚）`).setEmoji("♻️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("poker:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
  );

  let reply: Message;
  if (interaction.replied || interaction.deferred) reply = (await interaction.followUp({ embeds: [buildEmbed("draw")], components: [cardButtons(), actionRow()] })) as Message;
  else {
    await interaction.reply({ embeds: [buildEmbed("draw")], components: [cardButtons(), actionRow()] });
    reply = (await interaction.fetchReply()) as Message;
  }

  await new Promise<void>((resolve, reject) => {
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === uid && i.customId.startsWith("poker:"),
      time: 90_000,
    });
    collector.on("collect", async (btn) => {
      if (btn.customId === "poker:paytable") {
        await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
        return;
      }
      if (btn.customId === "poker:draw") {
        collector.stop("draw");
        await btn.deferUpdate();
        resolve();
        return;
      }
      if (btn.customId.startsWith("poker:hold:")) {
        const idx = Number(btn.customId.split(":")[2]);
        if (held.has(idx)) held.delete(idx); else held.add(idx);
        await btn.update({ embeds: [buildEmbed("draw")], components: [cardButtons(), actionRow()] });
      }
    });
    collector.on("end", (_c, reason) => {
      if (reason === "draw") return;
      if (reason === "time") {
        recordCasinoGameAbandonBestEffort(services, {
          userId: uid, game: "ポーカー", operationId: interaction.id, wager: bet, source: playContext.source, reason: "draw_timeout",
        });
        resolve();
        return;
      }
      reject(new Error(`poker collector ended without timeout: ${reason}`));
    });
  });

  for (let i = 0; i < hand.length; i++) if (!held.has(i)) hand[i] = deck.pop()!;
  await reply.edit({ embeds: [buildEmbed("draw")], components: [] }).catch(() => undefined);
  await sleep(700);

  const ev = evaluate(hand);
  const rawPayout = ev.payMult > 0 ? bet * ev.payMult : 0;
  const settled = services.casino.settleSolo(uid, "ポーカー", bet, rawPayout, { operationId: interaction.id, reservationKey });
  recordCasinoGameFinishBestEffort(services, {
    userId: uid, game: "ポーカー", operationId: interaction.id, wager: bet, payout: settled.payout, net: settled.net, source: playContext.source,
  });
  const bonusBits: string[] = [];
  if (settled.chainBonus > 0) bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  ${fmtBigDelta(settled.chainBonus)}`);
  if (settled.fukuTax > 0) bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  ${fmtBigDelta(-settled.fukuTax)}`);
  if (settled.amuletNote) bonusBits.push(`${E.sparkle} ${settled.amuletNote}`);

  const isJp = ev.category === 11;
  const resultPayload = buildSoloResult({
    services,
    userId: uid,
    game: "ポーカー",
    net: settled.net,
    wager: bet,
    retryBet: bet,
    isJackpot: isJp,
    sections: [
      { name: "🃏 手札", value: hand.map((c) => `[${showCard(c)}]`).join("  "), inline: false },
      { name: `🏆 ${ev.label}  ·  配当倍率 ×${ev.payMult}`, value: bonusBits.length > 0 ? bonusBits.join("\n") : "─", inline: false },
    ],
  });
  const resultEmbed = resultPayload.embeds![0] as EmbedBuilder;
  if (isJp) resultEmbed.setColor(C_JACKPOT).setTitle(`💎  ロイヤルフラッシュ  ${fmtBigDelta(settled.net)}`);
  if (settled.net > 0) {
    broadcastBigWin(interaction.client, services, { userId: uid, game: "ポーカー", bet, payout: settled.payout, isJackpot: isJp });
  }
  await reply.edit({ embeds: [resultEmbed], components: resultPayload.components }).catch(() => undefined);
}
