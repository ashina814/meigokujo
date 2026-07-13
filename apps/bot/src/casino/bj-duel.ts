import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
  type User,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, sleep } from "./common.js";
import { buildPvpAbort, buildPvpInvite, buildPvpResult, collectStakes, refundAll, settlePvp } from "./pvp-common.js";

/**
 * 🃏 BJデュエル（casino-bot /BJ対戦 準拠・1v1 PvP）。
 * - 挑戦者と対戦相手が同額。両者エスクロー
 * - 交互にヒット/スタンド。バーストで即負け。両者スタンドで数字比較
 * - 21超えず高い方が勝ち。同点は引き分け（全額返金）
 * - 勝者総取り（場代3%）
 */
type Card = { rank: string; value: number; suit: string };

function newDeck(): Card[] {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks: Array<[string, number]> = [
    ["A", 11], ["2", 2], ["3", 3], ["4", 4], ["5", 5], ["6", 6], ["7", 7],
    ["8", 8], ["9", 9], ["10", 10], ["J", 10], ["Q", 10], ["K", 10],
  ];
  const d: Card[] = [];
  for (const s of suits) for (const [r, v] of ranks) d.push({ rank: r, value: v, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}
function handValue(h: Card[]): number {
  let t = h.reduce((s, c) => s + c.value, 0);
  let a = h.filter((c) => c.rank === "A").length;
  while (t > 21 && a > 0) {
    t -= 10;
    a--;
  }
  return t;
}
const showHand = (h: Card[]) => h.map((c) => `${c.suit}${c.rank}`).join(" ");

export async function playBjDuel(
  interaction: ChatInputCommandInteraction,
  services: Services,
  opponent: User,
  bet: number,
): Promise<void> {
  const challenger = interaction.user;
  if (opponent.bot || opponent.id === challenger.id) {
    await interaction.reply({ content: "対戦相手が不正。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET) {
    await interaction.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.ether.balanceOf(challenger.id) < bet) {
    await interaction.reply({ content: "自分のエテル残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.ether.balanceOf(opponent.id) < bet) {
    await interaction.reply({ content: `<@${opponent.id}> のエテル残高が足りない。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!collectStakes(services, [challenger.id], bet)) return;

  const inviteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bjd:accept").setLabel("受ける").setEmoji("🃏").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bjd:decline").setLabel("断る").setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `<@${opponent.id}>`,
    embeds: [
      buildPvpInvite({
        game: "BJデュエル",
        icon: "🃏",
        challengerId: challenger.id,
        opponentId: opponent.id,
        bet,
        ruleLines: ["21以下でより高い数字を作った方が勝ち。", "バーストで即負け。交互にヒット／スタンド。"],
      }),
    ],
    components: [inviteRow],
    allowedMentions: { users: [opponent.id] },
  });
  const reply = (await interaction.fetchReply()) as Message;

  let accepted = false;
  try {
    const btn = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === opponent.id && (i.customId === "bjd:accept" || i.customId === "bjd:decline"),
      time: 60_000,
    });
    accepted = btn.customId === "bjd:accept";
    await btn.deferUpdate();
  } catch {
    /* timeout */
  }
  if (!accepted) {
    services.ether.transfer("house", challenger.id, bet);
    await interaction.editReply({
      content: "",
      embeds: [buildPvpAbort("BJデュエル", "🃏", "対戦相手が受けなかった。挑戦者に全額返金。")],
      components: [],
    });
    return;
  }
  if (!collectStakes(services, [opponent.id], bet)) {
    services.ether.transfer("house", challenger.id, bet);
    return;
  }

  const deck = newDeck();
  const cHand: Card[] = [deck.pop()!, deck.pop()!];
  const oHand: Card[] = [deck.pop()!, deck.pop()!];
  let cStand = false;
  let oStand = false;

  const table = (turn: string | null, hideOther = false) => {
    const cVis = handValue(cHand);
    const oVis = handValue(oHand);
    return new EmbedBuilder()
      .setTitle("🃏 BJデュエル")
      .setColor(MAMMON_COLOR)
      .setDescription(
        [
          `<@${challenger.id}>: ${showHand(cHand)} （**${cVis}**）${cStand ? " [スタンド]" : ""}`,
          `<@${opponent.id}>: ${showHand(oHand)} （**${oVis}**）${oStand ? " [スタンド]" : ""}`,
          "",
          turn ? `**${turn}** の番` : "",
        ].join("\n"),
      );
  };

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bjd:hit").setLabel("ヒット").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bjd:stand").setLabel("スタンド").setStyle(ButtonStyle.Success),
  );

  const finishGame = async (result: "challenger_win" | "opponent_win" | "push", note: string) => {
    if (result === "push") {
      refundAll(services, [challenger.id, opponent.id], bet);
      await interaction.editReply({
        content: "",
        embeds: [
          new EmbedBuilder()
            .setAuthor({ name: "マモンの賭場 · BJデュエル" })
            .setColor(0x78716c)
            .setTitle("🃏  引き分け")
            .setDescription(
              [
                "```",
                `<@${challenger.id}>: ${showHand(cHand)}   合計 ${handValue(cHand)}`,
                "─────────────────────────────",
                `<@${opponent.id}>: ${showHand(oHand)}   合計 ${handValue(oHand)}`,
                "```",
                note,
                "全額返金。",
              ].join("\n"),
            ),
        ],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    const winnerId = result === "challenger_win" ? challenger.id : opponent.id;
    const loserId = result === "challenger_win" ? opponent.id : challenger.id;
    const { payout, houseCut } = settlePvp(services, [winnerId], bet * 2);
    await interaction.editReply({
      content: "",
      embeds: [
        buildPvpResult({
          game: "BJデュエル",
          icon: "🃏",
          winnerId,
          loserId,
          bet,
          payout,
          houseCut,
          extra:
            "```" +
            "\n" +
            `<@${challenger.id}>: ${showHand(cHand)}   合計 ${handValue(cHand)}` +
            "\n─────────────────────────────\n" +
            `<@${opponent.id}>: ${showHand(oHand)}   合計 ${handValue(oHand)}` +
            "\n```\n" +
            note,
        }),
      ],
      components: [],
      allowedMentions: { users: [winnerId] },
    });
  };

  // ── ターン制ループ ──
  let currentTurn: "c" | "o" = "c";
  while (!cStand || !oStand) {
    const currentId = currentTurn === "c" ? challenger.id : opponent.id;
    const currentHand = currentTurn === "c" ? cHand : oHand;
    const alreadyStood = currentTurn === "c" ? cStand : oStand;
    if (alreadyStood) {
      currentTurn = currentTurn === "c" ? "o" : "c";
      continue;
    }
    await interaction.editReply({
      content: "",
      embeds: [table(`<@${currentId}>`)],
      components: [btnRow],
      allowedMentions: { users: [currentId] },
    });
    let action: "hit" | "stand";
    try {
      const btn = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === currentId && (i.customId === "bjd:hit" || i.customId === "bjd:stand"),
        time: 45_000,
      });
      action = btn.customId === "bjd:hit" ? "hit" : "stand";
      await btn.deferUpdate();
    } catch {
      action = "stand";
    }

    if (action === "hit") {
      currentHand.push(deck.pop()!);
      const v = handValue(currentHand);
      if (v > 21) {
        // バースト → 相手の勝ち
        const winner = currentTurn === "c" ? "opponent_win" : "challenger_win";
        await sleep(600);
        return void (await finishGame(winner, `<@${currentId}> が **バースト**（${v}）`));
      }
      if (v === 21) {
        if (currentTurn === "c") cStand = true;
        else oStand = true;
      }
    } else {
      if (currentTurn === "c") cStand = true;
      else oStand = true;
    }
    currentTurn = currentTurn === "c" ? "o" : "c";
  }

  const cv = handValue(cHand);
  const ov = handValue(oHand);
  await sleep(600);
  if (cv > ov) return void (await finishGame("challenger_win", `**${cv} 対 ${ov}**`));
  if (cv < ov) return void (await finishGame("opponent_win", `**${cv} 対 ${ov}**`));
  return void (await finishGame("push", `**${cv} 対 ${ov}** — 引き分け`));
}
