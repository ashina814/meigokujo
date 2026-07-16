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
import { MAX_BET, MIN_BET, sleep } from "./common.js";
import { C_MAMMON } from "./ui.js";
import { buildPvpAbort, buildPvpInvite, buildPvpResult, collectStakes, refundAll, settlePvp } from "./pvp-common.js";

/**
 * ⚔ サシ勝負（casino-bot /サシ 準拠・1v1 コイントス的簡易勝負）。
 * - 挑戦者と対戦相手が同額を賭ける → 受諾されたら 50/50 で勝敗判定
 * - 勝者総取り（場代3%）。座敷童テーマは削除
 */
export async function playSashi(
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
  if (services.ether.balanceOf(challenger.id) < bet || services.ether.balanceOf(opponent.id) < bet) {
    await interaction.reply({ content: "どちらかのエテル残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const session = `sashi:${interaction.id}`;
  if (!collectStakes(services, [challenger.id], bet, session, "sashi")) return;

  const inviteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("sashi:accept").setLabel("受ける").setEmoji("⚔").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("sashi:decline").setLabel("断る").setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `<@${opponent.id}>`,
    embeds: [
      buildPvpInvite({
        game: "サシ勝負",
        icon: "⚔",
        challengerId: challenger.id,
        opponentId: opponent.id,
        bet,
        ruleLines: ["50/50 の一発勝負。", "運任せ、駆け引きなし。"],
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
      filter: (i) => i.user.id === opponent.id && (i.customId === "sashi:accept" || i.customId === "sashi:decline"),
      time: 60_000,
    });
    accepted = btn.customId === "sashi:accept";
    await btn.deferUpdate();
  } catch {
    /* timeout */
  }
  if (!accepted) {
    refundAll(services, [challenger.id], bet, session);
    await interaction.editReply({
      content: "",
      embeds: [buildPvpAbort("サシ勝負", "⚔", "受諾されなかった。挑戦者に全額返金。")],
      components: [],
    });
    return;
  }
  if (!collectStakes(services, [opponent.id], bet, session, "sashi")) {
    refundAll(services, [challenger.id], bet, session);
    return;
  }

  // 演出
  await interaction.editReply({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · サシ勝負" })
        .setColor(C_MAMMON)
        .setTitle("⚔  運命の分岐点……")
        .setDescription("*マモンが銀貨を弾く……*"),
    ],
    components: [],
  });
  await sleep(1500);

  const challengerWins = Math.random() < 0.5;
  const winnerId = challengerWins ? challenger.id : opponent.id;
  const loserId = challengerWins ? opponent.id : challenger.id;
  const { payout, houseCut } = settlePvp(services, [winnerId], bet * 2, session);

  await interaction.editReply({
    content: "",
    embeds: [buildPvpResult({ game: "サシ勝負", icon: "⚔", winnerId, loserId, bet, payout, houseCut })],
    components: [],
    allowedMentions: { users: [winnerId] },
  });
}
