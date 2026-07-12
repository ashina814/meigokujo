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
import { HOUSE_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, sleep } from "./common.js";
import { collectStakes, refundAll, settlePvp } from "./pvp-common.js";

/**
 * 🃏 インディアンポーカー（1v1心理戦）。casino-bot 準拠。
 * - 両者に 1 枚カード（A=1..K=13）を配る
 * - **自分の手は見えず、相手の手は見える**（DM で相手のカードを通知）
 * - 各自 ステイ / フォールド を選ぶ
 *   - 両者ステイ → 開示、数値高い方が勝ち（同値=引き分け返金）
 *   - 片方フォールド → もう片方の勝ち（フォールド側はステーク没収）
 *   - 両者フォールド → 両者返金
 * - 勝者総取り 2×stake（場代3% → JP）
 */

const RANK_NAMES = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const SUITS = ["♠", "♥", "♦", "♣"] as const;
const rankName = (n: number) => RANK_NAMES[n] ?? "?";

function draw(): { rank: number; suit: string } {
  return { rank: 1 + Math.floor(Math.random() * 13), suit: SUITS[Math.floor(Math.random() * SUITS.length)]! };
}

export async function playIndian(
  interaction: ChatInputCommandInteraction,
  services: Services,
  opponent: User,
  stake: number,
): Promise<void> {
  const challenger = interaction.user;
  if (opponent.bot || opponent.id === challenger.id) {
    await interaction.reply({ content: "対戦相手が不正。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!Number.isInteger(stake) || stake < MIN_BET || stake > MAX_BET) {
    await interaction.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.ether.balanceOf(challenger.id) < stake || services.ether.balanceOf(opponent.id) < stake) {
    await interaction.reply({ content: "どちらかのエテル残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!collectStakes(services, [challenger.id], stake)) return;

  const inviteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ind:accept").setLabel("受ける").setEmoji("🃏").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ind:decline").setLabel("断る").setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `<@${opponent.id}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 インディアンポーカー — 挑戦")
        .setColor(MAMMON_COLOR)
        .setDescription(
          [
            `<@${challenger.id}> が <@${opponent.id}> にインディアン勝負を挑んだ。`,
            "",
            `**賭け金**: ${fmtEther(stake)}（両者から徴収）`,
            "",
            "**自分の手は見えず、相手の手は DM で通知される**。",
            "両者ステイなら数値高い方の勝ち。片方フォールドなら残った方の勝ち。",
            "勝者総取り（場代3% → JPプール）",
          ].join("\n"),
        ),
    ],
    components: [inviteRow],
    allowedMentions: { users: [opponent.id] },
  });
  const reply = (await interaction.fetchReply()) as Message;

  let accepted = false;
  try {
    const btn = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === opponent.id && (i.customId === "ind:accept" || i.customId === "ind:decline"),
      time: 60_000,
    });
    accepted = btn.customId === "ind:accept";
    await btn.deferUpdate();
  } catch {
    /* timeout */
  }
  if (!accepted) {
    services.ether.transfer(HOUSE_HOLDER, challenger.id, stake);
    await interaction.editReply({
      content: "",
      embeds: [new EmbedBuilder().setTitle("🃏 インディアン — 不成立").setColor(LOSE_COLOR).setDescription("受諾されなかった。返金。")],
      components: [],
    });
    return;
  }
  if (!collectStakes(services, [opponent.id], stake)) {
    services.ether.transfer(HOUSE_HOLDER, challenger.id, stake);
    return;
  }

  // 配札
  const cChallenger = draw();
  const cOpponent = draw();

  // 各人に相手のカードを DM で通知
  await challenger
    .send(`🃏 **インディアン対戦** — 相手 <@${opponent.id}> のカード: **${cOpponent.suit}${rankName(cOpponent.rank)}**（あなた自身の手は見えない）`)
    .catch(async () => {
      await interaction.followUp({
        content: `<@${challenger.id}> DM が閉じていて相手のカードを送れなかった。この対戦は流す（両者返金）。`,
        allowedMentions: { users: [challenger.id] },
      });
      refundAll(services, [challenger.id, opponent.id], stake);
      return;
    });
  await opponent
    .send(`🃏 **インディアン対戦** — 相手 <@${challenger.id}> のカード: **${cChallenger.suit}${rankName(cChallenger.rank)}**（あなた自身の手は見えない）`)
    .catch(async () => {
      await interaction.followUp({
        content: `<@${opponent.id}> DM が閉じていて相手のカードを送れなかった。この対戦は流す（両者返金）。`,
        allowedMentions: { users: [opponent.id] },
      });
      refundAll(services, [challenger.id, opponent.id], stake);
      return;
    });

  // 各自 ステイ / フォールドの入力
  const decisionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ind:stay").setLabel("ステイ").setEmoji("✋").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ind:fold").setLabel("フォールド").setEmoji("🏳").setStyle(ButtonStyle.Danger),
  );
  await interaction.editReply({
    content: `<@${challenger.id}> <@${opponent.id}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 インディアンポーカー — 決断")
        .setColor(MAMMON_COLOR)
        .setDescription(
          [
            "DM に相手のカードが届いた。**自分の手はまだ見えない**。",
            "60秒以内にステイかフォールドを選べ（無応答＝フォールド）。",
          ].join("\n"),
        ),
    ],
    components: [decisionRow],
    allowedMentions: { users: [challenger.id, opponent.id] },
  });

  const decisions = new Map<string, "stay" | "fold">();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) =>
      (i.user.id === challenger.id || i.user.id === opponent.id) && (i.customId === "ind:stay" || i.customId === "ind:fold"),
    time: 60_000,
  });
  collector.on("collect", async (btn) => {
    if (decisions.has(btn.user.id)) {
      await btn.reply({ content: "既に選択済み。", flags: MessageFlags.Ephemeral });
      return;
    }
    decisions.set(btn.user.id, btn.customId === "ind:stay" ? "stay" : "fold");
    await btn.reply({ content: `✅ ${btn.customId === "ind:stay" ? "ステイ" : "フォールド"}`, flags: MessageFlags.Ephemeral });
    if (decisions.size === 2) collector.stop("both");
  });
  await new Promise<void>((resolve) => collector.once("end", () => resolve()));

  const cDecision = decisions.get(challenger.id) ?? "fold";
  const oDecision = decisions.get(opponent.id) ?? "fold";
  const pot = stake * 2;

  let title = "";
  let winner: string | null = null;
  let note = "";
  if (cDecision === "fold" && oDecision === "fold") {
    // 両者フォールド → 全額返金
    refundAll(services, [challenger.id, opponent.id], stake);
    title = "🃏 インディアン — 両者フォールド";
    note = "両者ともフォールド。全額返金。";
    winner = null;
  } else if (cDecision === "fold") {
    winner = opponent.id;
    note = `<@${challenger.id}> がフォールド。<@${opponent.id}> の不戦勝。`;
  } else if (oDecision === "fold") {
    winner = challenger.id;
    note = `<@${opponent.id}> がフォールド。<@${challenger.id}> の不戦勝。`;
  } else {
    // 両者ステイ → 開示比較（A=1 が最弱扱い / 原作準拠）
    if (cChallenger.rank > cOpponent.rank) winner = challenger.id;
    else if (cChallenger.rank < cOpponent.rank) winner = opponent.id;
    else winner = null; // 同値
    note = `両者ステイ → 開示: <@${challenger.id}> **${cChallenger.suit}${rankName(cChallenger.rank)}** vs <@${opponent.id}> **${cOpponent.suit}${rankName(cOpponent.rank)}**`;
  }

  if (winner === null && cDecision === "stay" && oDecision === "stay") {
    // 同値ドロー
    refundAll(services, [challenger.id, opponent.id], stake);
    title = "🃏 インディアン — 引き分け";
    note += "\n同値。全額返金。";
  } else if (winner !== null) {
    const { payout, houseCut } = settlePvp(services, [winner], pot);
    const loser = winner === challenger.id ? opponent.id : challenger.id;
    title = `🃏 インディアン — 勝者 <@${winner}>`;
    note += `\n**勝ち** <@${winner}> +${fmtEther(payout - stake)}\n**負け** <@${loser}> -${fmtEther(stake)}\n場代 ${fmtEther(houseCut)} → JP`;
  } else if (cDecision === "fold" && oDecision === "fold") {
    // すでに処理済み
  }

  await interaction.editReply({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setColor(winner ? WIN_COLOR : MAMMON_COLOR)
        .setDescription(
          [
            `<@${challenger.id}>: **${cChallenger.suit}${rankName(cChallenger.rank)}** — ${cDecision === "stay" ? "ステイ" : "フォールド"}`,
            `<@${opponent.id}>: **${cOpponent.suit}${rankName(cOpponent.rank)}** — ${oDecision === "stay" ? "ステイ" : "フォールド"}`,
            "",
            note,
          ].join("\n"),
        ),
    ],
    components: [],
    allowedMentions: winner ? { users: [winner] } : { parse: [] },
  });
  void sleep;
}
