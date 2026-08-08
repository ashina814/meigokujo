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
import { BLACKJACK_MAX_PAYOUT_MULT, type CasinoRng } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import {
  MIN_BET,
  acquireSeat,
  releaseSeat,
  reserveBlackjackLiability,
  sleep,
  validateBet,
  withExplicitHouseReservation,
} from "./common.js";
import { C_MAMMON, C_WIN, C_LOSE } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  recordCasinoGameAbandonBestEffort,
  recordCasinoGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";

/**
 * 🃏 ブラックジャック（対マモン・ソロ）。
 * - ナチュラルBJ = 2.5倍 / 勝ち = 2倍 / プッシュ = 返金 / 負け = 没収
 * - マモン（ディーラー）は17以上でスタンド
 * - ヒット / スタンド / ダブル（最初の2枚のみ・賭け倍増）
 * - 結果画面に「最低/前回/最大/配当表/退席」ボタン
 */
/** ダブル後の勝ち = 4×初期賭け。core の債務モデルと同じ定数を読む（PR4） */
const MAX_MULT = BLACKJACK_MAX_PAYOUT_MULT;

interface Card {
  rank: string;
  value: number; // A=11（後で減算）
  suit: string;
}

function newDeck(rng: CasinoRng): Card[] {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks: Array<[string, number]> = [
    ["A", 11], ["2", 2], ["3", 3], ["4", 4], ["5", 5], ["6", 6], ["7", 7],
    ["8", 8], ["9", 9], ["10", 10], ["J", 10], ["Q", 10], ["K", 10],
  ];
  const deck: Card[] = [];
  for (const suit of suits) for (const [rank, value] of ranks) deck.push({ rank, value, suit });
  return rng.shuffle(deck);
}

function handValue(hand: Card[]): number {
  let total = hand.reduce((s, c) => s + c.value, 0);
  let aces = hand.filter((c) => c.rank === "A").length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

const showCard = (c: Card) => `${c.suit}${c.rank}`;
const showHand = (hand: Card[], hideSecond = false) =>
  hand.map((c, i) => (hideSecond && i === 1 ? "🂠" : showCard(c))).join(" ");

export function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 ブラックジャック — ルール")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**遊び方**",
        "・21以下でマモンより高い数字を作れば勝ち。22以上はバースト（負け）",
        "・A は 11 か 1、絵札は全て 10",
        "",
        "**配当**",
        "・ナチュラルBJ（最初の2枚で21）→ **2.5倍**",
        "・通常勝ち → **2倍**（賭け倍増込み）",
        "・プッシュ → 返金",
        "",
        "**行動**",
        "・**ヒット** もう1枚引く",
        "・**スタンド** 現在の手で勝負",
        "・**ダブル** 最初の2枚時のみ。賭け倍増＋強制1枚引いてスタンド",
        "",
        "**マモン（ディーラー）** 17以上で必ずスタンド",
      ].join("\n"),
    );
}

export async function playBlackjack(
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
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "ブラックジャック");
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
  bet: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  let doubleAllowed = true;
  await withExplicitHouseReservation(
    interaction,
    services,
    "ブラックジャック",
    (uid) => {
      const r = reserveBlackjackLiability(services, uid, bet, interaction.id);
      doubleAllowed = r.doubleAllowed;
      return r;
    },
    (reservationKey) => runRoundInner(interaction, services, bet, reservationKey, doubleAllowed, context),
  );
}

async function runRoundInner(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  reservationKey: string,
  /** ダブルぶんの債務まで予約できたか。false ならダブルボタンだけ無効化する */
  doubleAllowed: boolean,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  const playContext = casinoPlayContext(context);
  recordCasinoGameStartBestEffort(services, {
    userId: uid,
    game: "ブラックジャック",
    operationId: interaction.id,
    wager: bet,
    source: playContext.source,
  });
  const deck = newDeck(services.rng);
  const player: Card[] = [deck.pop()!, deck.pop()!];
  const dealer: Card[] = [deck.pop()!, deck.pop()!];
  let totalBet = bet;

  const table = (hideDealer: boolean) => {
    return new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · ブラックジャック" })
      .setColor(C_MAMMON)
      .setTitle(`🃏 21 を狙え  ·  賭け ${fmtEther(totalBet)}`)
      .setDescription(
        [
          "```",
          `😈 マモン    ${showHand(dealer, hideDealer)}`,
          `           合計 ${hideDealer ? "?" : String(handValue(dealer))}`,
          "─────────────────────────────",
          `👤 お前      ${showHand(player)}`,
          `           合計 ${handValue(player)}`,
          "```",
        ].join("\n"),
      );
  };

  let reply: Message;
  const buttons = (canDouble: boolean) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("bj:hit").setLabel("ヒット").setEmoji("🃏").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bj:stand").setLabel("スタンド").setEmoji("✋").setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("bj:double")
        .setLabel("ダブル")
        .setEmoji("⚡")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!canDouble),
    );

  const playerNatural = handValue(player) === 21;
  const dealerNatural = handValue(dealer) === 21;

  const openInitial = async (hide: boolean, components: ActionRowBuilder<ButtonBuilder>[] = []) => {
    if (interaction.replied || interaction.deferred) {
      const m = (await interaction.followUp({ embeds: [table(hide)], components })) as Message;
      return m;
    }
    await interaction.reply({ embeds: [table(hide)], components });
    return (await interaction.fetchReply()) as Message;
  };

  const finish = async (rawPayout: number, note: string) => {
    // お守りの消費も賭け・配当と同じグループの中（settleSolo）。外で消すと精算が落ちたときお守りだけ消える
    const settled = services.casino.settleSolo(uid, "ブラックジャック", totalBet, rawPayout, {
      operationId: interaction.id, reservationKey,
    });
    recordCasinoGameFinishBestEffort(services, {
      userId: uid,
      game: "ブラックジャック",
      operationId: interaction.id,
      wager: totalBet,
      payout: settled.payout,
      net: settled.net,
      source: playContext.source,
    });
    const amulet = { note: settled.amuletNote };
    const won = settled.net > 0;
    const push = settled.net === 0 && rawPayout > 0;
    const chainLine = settled.chainBonus > 0
      ? `${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
    const fukuLine = settled.fukuTax > 0
      ? `⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 福分け積立`
      : "";
    const tag = won ? "🟢 勝ち" : push ? "⚪ プッシュ" : "🔴 負け";
    const netStr = settled.net === 0 ? "±0 Ld" : `${settled.net > 0 ? "+" : "−"}${Math.abs(settled.net).toLocaleString("ja-JP")} Ld`;
    const bonusBits: string[] = [];
    if (chainLine) bonusBits.push(chainLine);
    if (fukuLine) bonusBits.push(fukuLine);
    if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);

    const resultPayload = buildSoloResult({
      services,
      userId: uid,
      game: "ブラックジャック",
      net: settled.net,
      wager: totalBet,
      retryBet: bet,
      titleOverride: won ? "🟢 勝ち" : push ? "⚪ 引き分け" : "🔴 負け",
      colorOverride: won ? C_WIN : push ? 0x78716c : C_LOSE,
      description:
        [
          "```",
          `😈 マモン    ${showHand(dealer)}   合計 ${handValue(dealer)}`,
          "─────────────────────────────",
          `👤 お前      ${showHand(player)}   合計 ${handValue(player)}`,
          "```",
          note,
        ].join("\n"),
      sections: bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : [],
    });

    if (won) broadcastBigWin(interaction.client, services, { userId: uid, game: "ブラックジャック", bet: totalBet, payout: settled.payout });
    await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
  };

  // ── ナチュラル判定 ──
  if (playerNatural || dealerNatural) {
    reply = await openInitial(false);
    await sleep(900);
    if (playerNatural && dealerNatural) return void (await finish(totalBet, "両者ブラックジャック。プッシュ。"));
    if (playerNatural) return void (await finish(Math.floor(bet * 2.5), "**ブラックジャック！** 2.5倍払い。"));
    return void (await finish(0, "マモンのブラックジャック。"));
  }

  // ── プレイヤーのターン ──
  // ダブルの可否は**開始時の予約結果**で決まる（PR5）。
  // ここで改めて胴元残高を見ると、予約済みの自分の枠を二重に数えて弾いてしまう
  const canDoubleNow = () => player.length === 2 && doubleAllowed && services.chips.balanceOf(uid) >= bet * 2;
  reply = await openInitial(true, [buttons(canDoubleNow())]);

  let standing = false;
  while (!standing) {
    let action: "hit" | "stand" | "double";
    try {
      const btn = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === uid && (i.customId === "bj:hit" || i.customId === "bj:stand" || i.customId === "bj:double"),
        time: 60_000,
      });
      action = btn.customId.slice(3) as "hit" | "stand" | "double";
      await btn.deferUpdate();
    } catch {
      recordCasinoGameAbandonBestEffort(services, {
        userId: uid,
        game: "ブラックジャック",
        operationId: interaction.id,
        wager: totalBet,
        source: playContext.source,
        reason: "action_timeout",
      });
      action = "stand";
    }

    if (action === "double" && canDoubleNow()) {
      totalBet = bet * 2;
      player.push(deck.pop()!);
      if (handValue(player) > 21) return void (await finish(0, "⚡ ダブルでバースト……。"));
      standing = true;
      break;
    }
    if (action === "hit") {
      player.push(deck.pop()!);
      if (handValue(player) > 21) return void (await finish(0, "**バースト！** 21を超えた。"));
      if (handValue(player) === 21) {
        standing = true;
        break;
      }
      await reply.edit({ embeds: [table(true)], components: [buttons(false)] }).catch(() => undefined);
      continue;
    }
    standing = true;
  }

  // ── マモンのターン ──
  await reply.edit({ embeds: [table(false)], components: [] }).catch(() => undefined);
  while (handValue(dealer) < 17) {
    await sleep(900);
    dealer.push(deck.pop()!);
    await reply.edit({ embeds: [table(false)], components: [] }).catch(() => undefined);
  }
  await sleep(700);

  const pv = handValue(player);
  const dv = handValue(dealer);
  if (dv > 21) return void (await finish(totalBet * 2, "マモンが**バースト**。お前の勝ち。"));
  if (pv > dv) return void (await finish(totalBet * 2, `**${pv} 対 ${dv}** — お前の勝ち。`));
  if (pv === dv) return void (await finish(totalBet, `**${pv} 対 ${dv}** — プッシュ。`));
  return void (await finish(0, `**${pv} 対 ${dv}** — マモンの勝ち。`));
}
