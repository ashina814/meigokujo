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
import { collectStakes, refundAll, settlePvp } from "./pvp-common.js";

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
  if (!collectStakes(services, [challenger.id], bet)) return;

  const inviteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("sashi:accept").setLabel("受ける").setEmoji("⚔").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("sashi:decline").setLabel("断る").setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `<@${opponent.id}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle("⚔ サシ勝負")
        .setColor(MAMMON_COLOR)
        .setDescription(
          [
            `<@${challenger.id}> が <@${opponent.id}> にサシ勝負を挑んだ。`,
            "",
            `**賭け金**: ${fmtEther(bet)}（両者から徴収）`,
            "",
            "**50/50 の一発勝負**。勝者総取り（場代3% → JPプール）。",
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
      filter: (i) => i.user.id === opponent.id && (i.customId === "sashi:accept" || i.customId === "sashi:decline"),
      time: 60_000,
    });
    accepted = btn.customId === "sashi:accept";
    await btn.deferUpdate();
  } catch {
    /* timeout */
  }
  if (!accepted) {
    services.ether.transfer("house", challenger.id, bet);
    await interaction.editReply({
      content: "",
      embeds: [new EmbedBuilder().setTitle("⚔ サシ勝負 — 不成立").setColor(LOSE_COLOR).setDescription("受諾されなかった。返金。")],
      components: [],
    });
    return;
  }
  if (!collectStakes(services, [opponent.id], bet)) {
    services.ether.transfer("house", challenger.id, bet);
    return;
  }

  // 演出
  await interaction.editReply({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle("⚔ サシ勝負 — 決着中")
        .setColor(MAMMON_COLOR)
        .setDescription("運命の分岐点……"),
    ],
    components: [],
  });
  await sleep(1500);

  const challengerWins = Math.random() < 0.5;
  const winnerId = challengerWins ? challenger.id : opponent.id;
  const loserId = challengerWins ? opponent.id : challenger.id;
  const { payout, houseCut } = settlePvp(services, [winnerId], bet * 2);

  await interaction.editReply({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle(`⚔ サシ勝負 — 勝者 <@${winnerId}>`)
        .setColor(WIN_COLOR)
        .setDescription(
          [
            `**勝ち** <@${winnerId}> +${fmtEther(payout - bet)}（受取 ${fmtEther(payout)}）`,
            `**負け** <@${loserId}> -${fmtEther(bet)}`,
            `場代 ${fmtEther(houseCut)} → JPプール`,
          ].join("\n"),
        ),
    ],
    components: [],
    allowedMentions: { users: [winnerId] },
  });
}
