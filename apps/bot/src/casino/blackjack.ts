import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { acquireSeat, releaseSeat, resultEmbed, sleep, validateBet } from "./common.js";

/**
 * 🃏 ブラックジャック（対マモン・ソロ）。casino-bot 準拠。
 * - ナチュラルBJ = 2.5倍 / 勝ち = 2倍 / プッシュ = 返金 / 負け = 没収
 * - ディーラー（マモン）は17以上でスタンド
 * - ヒット / スタンド / ダブル（最初の2枚のみ・賭け倍増）
 */
const MAX_MULT = 4; // ダブル後の勝ち = 4×初期賭け

interface Card {
  rank: string;
  value: number; // A=11（後で減算）
  suit: string;
}

function newDeck(): Card[] {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks: Array<[string, number]> = [
    ["A", 11], ["2", 2], ["3", 3], ["4", 4], ["5", 5], ["6", 6], ["7", 7],
    ["8", 8], ["9", 9], ["10", 10], ["J", 10], ["Q", 10], ["K", 10],
  ];
  const deck: Card[] = [];
  for (const suit of suits) for (const [rank, value] of ranks) deck.push({ rank, value, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
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

export async function playBlackjack(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction, services, betRaw, betRaw * MAX_MULT);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: 64 });
    return;
  }
  const bet = check.bet;
  try {
    const deck = newDeck();
    const player: Card[] = [deck.pop()!, deck.pop()!];
    const dealer: Card[] = [deck.pop()!, deck.pop()!];
    let totalBet = bet;

    const header = () => `🃏 **ブラックジャック** — 賭け ${fmtEther(totalBet)}`;
    const table = (hideDealer: boolean) =>
      [
        header(),
        "",
        `マモン: ${showHand(dealer, hideDealer)}${hideDealer ? "" : ` （**${handValue(dealer)}**）`}`,
        `お前:　 ${showHand(player)} （**${handValue(player)}**）`,
      ].join("\n");

    const playerNatural = handValue(player) === 21;
    const dealerNatural = handValue(dealer) === 21;

    const finish = async (payout: number, note: string) => {
      services.casino.settle(uid, "blackjack", totalBet, payout);
      const net = payout - totalBet;
      await interaction.editReply({
        content: "",
        components: [],
        embeds: [
          resultEmbed({
            title: `🃏 ブラックジャック — ${net > 0 ? `+${fmtEther(net)}` : net < 0 ? `-${fmtEther(-net)}` : "±0"}`,
            lines: [
              `マモン: ${showHand(dealer)} （**${handValue(dealer)}**）`,
              `お前:　 ${showHand(player)} （**${handValue(player)}**）`,
              "",
              note,
            ],
            net,
            balance: services.ether.balanceOf(uid),
          }),
        ],
      });
    };

    // ── ナチュラル判定 ──
    if (playerNatural || dealerNatural) {
      await interaction.reply({ content: table(false) });
      await sleep(900);
      if (playerNatural && dealerNatural) return void (await finish(totalBet, "両者ブラックジャック。プッシュ。"));
      if (playerNatural) return void (await finish(Math.floor(bet * 2.5), "**ブラックジャック！** 2.5倍払い。"));
      return void (await finish(0, "マモンのブラックジャック。"));
    }

    // ── プレイヤーのターン ──
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

    const canDoubleNow = () =>
      player.length === 2 &&
      services.ether.balanceOf(uid) >= bet * 2 &&
      services.casino.canAccept(bet * MAX_MULT);

    const msg = await interaction.reply({ content: table(true), components: [buttons(canDoubleNow())], withResponse: true });
    const reply: Message | undefined = msg.resource?.message ?? undefined;
    if (!reply) throw new Error("reply unavailable");

    let standing = false;
    while (!standing) {
      let action: "hit" | "stand" | "double";
      try {
        const btn = await reply.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === uid && i.customId.startsWith("bj:"),
          time: 60_000,
        });
        action = btn.customId.slice(3) as "hit" | "stand" | "double";
        await btn.deferUpdate();
      } catch {
        action = "stand"; // 時間切れはスタンド
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
        await interaction.editReply({ content: table(true), components: [buttons(false)] });
        continue;
      }
      standing = true;
    }

    // ── マモンのターン（17以上でスタンド）──
    await interaction.editReply({ content: table(false), components: [] });
    while (handValue(dealer) < 17) {
      await sleep(900);
      dealer.push(deck.pop()!);
      await interaction.editReply({ content: table(false), components: [] }).catch(() => undefined);
    }
    await sleep(700);

    const pv = handValue(player);
    const dv = handValue(dealer);
    if (dv > 21) return void (await finish(totalBet * 2, "マモンが**バースト**。お前の勝ちだ。"));
    if (pv > dv) return void (await finish(totalBet * 2, `**${pv} 対 ${dv}** — お前の勝ち。`));
    if (pv === dv) return void (await finish(totalBet, `**${pv} 対 ${dv}** — プッシュ。`));
    return void (await finish(0, `**${pv} 対 ${dv}** — マモンの勝ち。`));
  } finally {
    releaseSeat(uid);
  }
}
