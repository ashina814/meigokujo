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
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, acquireSeat, applyAmulets, releaseSeat, sleep, validateBet } from "./common.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🃏 ドローポーカー（Jacks or Better・ソロ）。対胴元の簡易版。
 * - 5枚配布 → プレイヤーが保持するカードを選択 → 残りを交換 → 役判定 → 配当
 * - 配当表（ジャックス・オア・ベター）:
 *   ロイヤル 250倍 / ストレートフラッシュ 50倍 / 4カード 25倍 /
 *   フルハウス 9倍 / フラッシュ 6倍 / ストレート 4倍 /
 *   3カード 3倍 / ツーペア 2倍 / J以上のペア 1倍 / それ以下 負け
 * - 最大配当250倍 → テーブルリミット判定に使う
 */
const MAX_MULT = 250;
const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANK_LABEL = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;

interface Card {
  suit: (typeof SUITS)[number];
  rank: number; // 2..14 (A=14)
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
  category: number; // 1..10
  label: string;
  payMult: number; // 配当倍率（賭け金に対する payout 総額）
}
const CAT_LABELS: readonly string[] = [
  "",
  "ハイカード",
  "ペア（低）",
  "ペア（J以上）",
  "ツーペア",
  "3カード",
  "ストレート",
  "フラッシュ",
  "フルハウス",
  "4カード",
  "ストレートフラッシュ",
  "ロイヤルフラッシュ",
];
const CAT_PAYS: readonly number[] = [0, 0, 0, 2, 3, 4, 5, 7, 10, 26, 51, 251]; // payout(=bet+profit) 倍率
// ※ ジャックス・オア・ベター（1x）= 賭け金返却+1x = 2x payout。以降 profit=(bet*X)-bet の関係。

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

function paytableEmbed(): EmbedBuilder {
  const lines = [
    "🏆 ロイヤルフラッシュ — **250倍**",
    "🌟 ストレートフラッシュ — **50倍**",
    "🎯 4カード — **25倍**",
    "🎴 フルハウス — **9倍**",
    "🔷 フラッシュ — **6倍**",
    "➡ ストレート — **4倍**",
    "🃏 3カード — **3倍**",
    "🎭 ツーペア — **2倍**",
    "💫 J以上のペア — **1倍**（賭け金返却+1倍）",
    "😔 それ以下 — 負け",
  ];
  return new EmbedBuilder()
    .setTitle("📖 ポーカー — 配当表（Jacks or Better）")
    .setColor(MAMMON_COLOR)
    .setDescription(
      [
        "**遊び方**",
        "・5枚配札 → 保持したいカードを選ぶ → 残りを交換 → 役判定",
        "・ジャック以上のペアで元本+1倍返し。以降は表通り",
        "・52枚デッキ 1組。RTP は約 96%",
        "",
        ...lines,
        "",
        "**⚖️ 福の重み / 🔥 連鎖チェーン**",
        "　勝ちで発動（残高が多いほど奉納・連勝で倍率）",
      ].join("\n"),
    );
}

export async function playPoker(
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
  bet: number,
): Promise<void> {
  const uid = interaction.user.id;
  const deck = newDeck();
  const hand: Card[] = [];
  for (let i = 0; i < 5; i++) hand.push(deck.pop()!);
  const held = new Set<number>();

  const buildEmbed = (phase: "draw" | "reveal", finalEval?: HandEval) =>
    new EmbedBuilder()
      .setTitle("🃏 ポーカー — ドロー")
      .setColor(phase === "draw" ? MAMMON_COLOR : finalEval && finalEval.payMult > 0 ? WIN_COLOR : LOSE_COLOR)
      .setDescription(
        [
          `賭け: ${fmtEther(bet)}`,
          "",
          hand.map((c, i) => (held.has(i) ? `[**${showCard(c)}**]` : `[${showCard(c)}]`)).join("  "),
          "",
          phase === "draw"
            ? "**保持したいカードのボタンを押す**（もう一度押すと解除）→ **交換** で確定"
            : finalEval
              ? `**${finalEval.label}** — 配当倍率 **${finalEval.payMult}x**`
              : "",
        ].join("\n"),
      );

  const cardButtons = () =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...hand.map((c, i) =>
        new ButtonBuilder()
          .setCustomId(`poker:hold:${i}`)
          .setLabel(showCard(c))
          .setStyle(held.has(i) ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    );
  const actionRow = () =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("poker:draw").setLabel(`交換（${5 - held.size}枚）`).setEmoji("♻️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("poker:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
    );

  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [buildEmbed("draw")], components: [cardButtons(), actionRow()] })) as Message;
  } else {
    await interaction.reply({ embeds: [buildEmbed("draw")], components: [cardButtons(), actionRow()] });
    reply = (await interaction.fetchReply()) as Message;
  }

  // ── ドローフェーズ: 保持選択 → 交換 ──
  await new Promise<void>((resolve) => {
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
        if (held.has(idx)) held.delete(idx);
        else held.add(idx);
        await btn.update({ embeds: [buildEmbed("draw")], components: [cardButtons(), actionRow()] });
      }
    });
    collector.on("end", (_c, reason) => {
      if (reason !== "draw") resolve();
    });
  });

  // ── 交換 ──
  for (let i = 0; i < hand.length; i++) {
    if (!held.has(i)) hand[i] = deck.pop()!;
  }
  await reply.edit({ embeds: [buildEmbed("draw")], components: [] }).catch(() => undefined);
  await sleep(700);

  // ── 判定 & 精算 ──
  const ev = evaluate(hand);
  const rawPayout = ev.payMult > 0 ? bet * ev.payMult : 0;
  const amulet = applyAmulets(services, uid, bet, rawPayout);
  const settled = services.casino.settle(uid, "ポーカー", bet, amulet.payout);

  const won = settled.net > 0;
  const chainLine =
    settled.chainBonus > 0
      ? `${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
  const fukuLine =
    settled.fukuTax > 0 ? `⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納` : "";

  const resultEmbed = new EmbedBuilder()
    .setTitle(ev.category === 11 ? "🔥🔥🔥 🏆 ロイヤルフラッシュ 🔥🔥🔥" : "🃏 ポーカー — 結果")
    .setColor(won ? WIN_COLOR : LOSE_COLOR)
    .setDescription(
      [
        hand.map((c) => `[${showCard(c)}]`).join("  "),
        "",
        `**${ev.label}** — 配当倍率 ${ev.payMult}x`,
        won ? `💰 +${fmtEther(settled.net)}` : `💸 -${fmtEther(-settled.net)}`,
        amulet.note ? `✨ ${amulet.note}` : "",
        chainLine,
        fukuLine,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setFooter({ text: `所持: ${fmtEther(services.ether.balanceOf(uid))}` });

  if (won) {
    broadcastBigWin(interaction.client, services, {
      userId: uid,
      game: "ポーカー",
      bet,
      payout: settled.payout,
      isJackpot: ev.category === 11,
    });
  }

  // ── リトライボタン ──
  const heldEther = services.ether.balanceOf(uid);
  const min = MIN_BET;
  const max = Math.min(MAX_BET, heldEther);
  const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`poker:retry:${min}`)
      .setLabel(`最低 ${min.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(heldEther < min),
    new ButtonBuilder()
      .setCustomId(`poker:retry:${bet}`)
      .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(heldEther < bet),
    new ButtonBuilder()
      .setCustomId(`poker:retry:${max}`)
      .setLabel(`最大 ${max.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(max < min),
    new ButtonBuilder().setCustomId("poker:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("poker:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
  );
  await reply.edit({ embeds: [resultEmbed], components: [retryRow] }).catch(() => undefined);

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "poker:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId === "poker:quit") {
      collector.stop("quit");
      await btn.deferUpdate();
      await reply.edit({ components: [] }).catch(() => undefined);
      return;
    }
    if (btn.customId.startsWith("poker:retry:")) {
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
