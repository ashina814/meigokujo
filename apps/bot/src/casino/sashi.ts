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
import {
  buildPvpAbort,
  buildPvpInvite,
  pvpViewFromInteraction,
  runFundedSession,
  type FundedPvpContext,
  buildPvpResult,
  collectStakes,
  offerRematch,
  refundAll,
  settlePvp,
  stakeFailureText,
  type PvpInteraction,
} from "./pvp-common.js";

/**
 * ⚔ サシ勝負（casino-bot /サシ 準拠・1v1 コイントス的簡易勝負）。
 * - 挑戦者と対戦相手が同額を賭ける → 受諾されたら 50/50 で勝敗判定
 * - 勝者総取り（場代3%）。座敷童テーマは削除
 */
export async function playSashi(
  interaction: PvpInteraction,
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
    await interaction.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} Ld で。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.chips.balanceOf(challenger.id) < bet || services.chips.balanceOf(opponent.id) < bet) {
    await interaction.reply({ content: "どちらかのLand残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const session = `sashi:${interaction.id}`;
  const challengerStake = collectStakes(services, [challenger.id], bet, `${session}:collect:challenger`, session, "sashi");
  if (!challengerStake.ok) {
    await interaction.reply({ content: stakeFailureText(challengerStake), flags: MessageFlags.Ephemeral });
    return;
  }

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
    refundAll(services, [challenger.id], bet, `${session}:refund:declined`, session);
    await interaction.editReply({
      content: "",
      embeds: [buildPvpAbort("サシ勝負", "⚔", "受諾されなかった。挑戦者に全額返金。")],
      components: [],
    });
    return;
  }
  const opponentStake = collectStakes(services, [opponent.id], bet, `${session}:collect:opponent`, session, "sashi");
  if (!opponentStake.ok) {
    refundAll(services, [challenger.id], bet, `${session}:refund:opponent_broke`, session);
    await interaction.editReply({
      content: "",
      embeds: [buildPvpAbort("サシ勝負", "⚔", `${stakeFailureText(opponentStake)}挑戦者に全額返金。`)],
      components: [],
    });
    return;
  }

  await runFundedSashiDuel(services, {
    challenger,
    opponent,
    bet,
    session,
    view: pvpViewFromInteraction(interaction),
    rematchInteraction: interaction,
  });
}

/**
 * サシ勝負の本体。
 *
 * ⚠️ **`collectStakes()` が両者について成功済みであることを前提とする。**
 * 新規の入口から直接呼ばず、指名招待（{@link playSashi}）または公開募集の
 * 成立処理を経由すること。
 */
export async function runFundedSashiDuel(services: Services, ctx: FundedPvpContext): Promise<void> {
  const { challenger, opponent, bet, session, view, rematchInteraction } = ctx;

  await runFundedSession(services, session, async (markResolved) => {
  // 演出
  await view.edit({
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

  const challengerWins = services.rng.int(0, 1) === 0;
  const winnerId = challengerWins ? challenger.id : opponent.id;
  const loserId = challengerWins ? opponent.id : challenger.id;
  const { payout, houseCut } = settlePvp(services, [winnerId], bet * 2, `${session}:settle`, session);
  markResolved();

  await view.edit({
    content: "",
    embeds: [buildPvpResult({ game: "サシ勝負", icon: "⚔", winnerId, loserId, bet, payout, houseCut })],
    components: [],
    allowedMentions: { users: [winnerId] },
  });
  });

  if (!rematchInteraction) return;
  await offerRematch(rematchInteraction, {
    aId: challenger.id,
    bId: opponent.id,
    bet,
    game: "サシ勝負",
    replay: (btn) => playSashi(btn, services, btn.user.id === challenger.id ? opponent : challenger, bet),
  });
}
