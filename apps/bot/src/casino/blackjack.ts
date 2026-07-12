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
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, acquireSeat, releaseSeat, sleep, validateBet } from "./common.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🃏 ブラックジャック（対マモン・ソロ）。
 * - ナチュラルBJ = 2.5倍 / 勝ち = 2倍 / プッシュ = 返金 / 負け = 没収
 * - マモン（ディーラー）は17以上でスタンド
 * - ヒット / スタンド / ダブル（最初の2枚のみ・賭け倍増）
 * - 結果画面に「最低/前回/最大/配当表/退席」ボタン
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

function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 ブラックジャック — ルール")
    .setColor(MAMMON_COLOR)
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
  const player: Card[] = [deck.pop()!, deck.pop()!];
  const dealer: Card[] = [deck.pop()!, deck.pop()!];
  let totalBet = bet;

  const table = (hideDealer: boolean) =>
    new EmbedBuilder()
      .setTitle("🃏 ブラックジャック")
      .setColor(MAMMON_COLOR)
      .setDescription(
        [
          `賭け: ${fmtEther(totalBet)}`,
          "",
          `マモン: ${showHand(dealer, hideDealer)}${hideDealer ? "" : ` （**${handValue(dealer)}**）`}`,
          `お前:　 ${showHand(player)} （**${handValue(player)}**）`,
        ].join("\n"),
      );

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
    const settled = services.casino.settle(uid, "ブラックジャック", totalBet, rawPayout);
    const won = settled.net > 0;
    const push = settled.net === 0 && rawPayout > 0;
    const chainLine = settled.chainBonus > 0
      ? `${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
    const fukuLine = settled.fukuTax > 0
      ? `⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納`
      : "";
    const embed = new EmbedBuilder()
      .setTitle(`🃏 ブラックジャック — ${won ? `+${fmtEther(settled.net)}` : push ? "±0" : `-${fmtEther(-settled.net)}`}`)
      .setColor(won ? WIN_COLOR : push ? MAMMON_COLOR : LOSE_COLOR)
      .setDescription(
        [
          `マモン: ${showHand(dealer)} （**${handValue(dealer)}**）`,
          `お前:　 ${showHand(player)} （**${handValue(player)}**）`,
          "",
          note,
          chainLine,
          fukuLine,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setFooter({ text: `所持: ${fmtEther(services.ether.balanceOf(uid))}` });

    if (won) broadcastBigWin(interaction.client, services, { userId: uid, game: "ブラックジャック", bet: totalBet, payout: settled.payout });

    const held = services.ether.balanceOf(uid);
    const min = MIN_BET;
    const max = Math.min(MAX_BET, held);
    const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bj:retry:${min}`)
        .setLabel(`最低 ${min.toLocaleString()}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(held < min),
      new ButtonBuilder()
        .setCustomId(`bj:retry:${bet}`)
        .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(held < bet),
      new ButtonBuilder()
        .setCustomId(`bj:retry:${max}`)
        .setLabel(`最大 ${max.toLocaleString()}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(max < min),
      new ButtonBuilder().setCustomId("bj:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bj:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
    );
    await reply.edit({ embeds: [embed], components: [retryRow] }).catch(() => undefined);

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (i) => i.user.id === uid,
    });
    collector.on("collect", async (btn) => {
      if (btn.customId === "bj:paytable") {
        await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
        return;
      }
      if (btn.customId === "bj:quit") {
        collector.stop("quit");
        await btn.deferUpdate();
        await reply.edit({ components: [] }).catch(() => undefined);
        return;
      }
      if (btn.customId.startsWith("bj:retry:")) {
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
  const canDoubleNow = () =>
    player.length === 2 &&
    services.ether.balanceOf(uid) >= bet * 2 &&
    services.casino.canAccept(bet * MAX_MULT);
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
