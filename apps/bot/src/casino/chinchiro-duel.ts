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
  type User,
} from "discord.js";
import type { CasinoRng } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, sleep } from "./common.js";
import { C_MAMMON, C_WIN } from "./ui.js";
import {
  buildPvpAbort,
  buildPvpInvite,
  collectStakes,
  offerRematch,
  refundAll,
  settlePvp,
  type PvpInteraction,
} from "./pvp-common.js";

/**
 * 🎲 対戦チンチロ（casino-bot /チンチロ対戦 準拠・1v1 PvP）。
 * - 挑戦者と対戦相手が同額を賭ける → 両者エスクロー → BOT が両者の賽を同一戦略で振って自動判定
 * - 勝者総取り（pot × 97%）、場代3%はJPプールへ
 * - 同役は最大5回振り直し、決まらなければ全額返金
 */
const MAX_ROLLS = 3;
const REROLL_ON_TIE = 5;
const DIE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

type Dice = readonly [number, number, number];
type Hand =
  | { type: "pinzoro" }
  | { type: "zorome"; value: number }
  | { type: "shigoro" }
  | { type: "hifumi" }
  | { type: "me"; score: number }
  | { type: "menashi" };

const roll = (rng: CasinoRng): Dice => [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)] as const;

function evaluate(dice: Dice): Hand {
  const [a, b, c] = [...dice].sort((x, y) => x - y) as [number, number, number];
  if (a === b && b === c) return a === 1 ? { type: "pinzoro" } : { type: "zorome", value: a };
  if (a === 4 && b === 5 && c === 6) return { type: "shigoro" };
  if (a === 1 && b === 2 && c === 3) return { type: "hifumi" };
  if (a === b) return { type: "me", score: c };
  if (b === c) return { type: "me", score: a };
  return { type: "menashi" };
}

function handRank(h: Hand): number {
  switch (h.type) {
    case "pinzoro": return 1000;
    case "zorome": return 800 + h.value;
    case "shigoro": return 700;
    case "me": return 100 + h.score;
    case "menashi": return 0;
    case "hifumi": return -100;
  }
}

/** BOTの決定論的な振り戦略（原作 autoRollHand 準拠） */
function autoRollHand(rng: CasinoRng): { hand: Hand; dice: Dice } {
  let dice: Dice = [1, 1, 1] as const;
  let hand: Hand = { type: "menashi" };
  for (let rollNo = 1; rollNo <= MAX_ROLLS; rollNo++) {
    dice = roll(rng);
    hand = evaluate(dice);
    const meStop = hand.type === "me" && hand.score >= 5;
    const terminal = hand.type !== "me" && hand.type !== "menashi";
    if (terminal || meStop) break;
  }
  return { hand, dice };
}

function describe(h: Hand): string {
  switch (h.type) {
    case "pinzoro": return "🌟 ピンゾロ";
    case "zorome": return `🎯 ゾロ目 ${h.value}${h.value}${h.value}`;
    case "shigoro": return "🔥 シゴロ";
    case "hifumi": return "💀 ヒフミ";
    case "me": return `🎲 目 スコア ${h.score}`;
    case "menashi": return "🌀 メナシ";
  }
}

const showDice = (d: Dice) => `${DIE_FACES[d[0]]} ${DIE_FACES[d[1]]} ${DIE_FACES[d[2]]}`;

export async function playChinchiroDuel(
  interaction: PvpInteraction,
  services: Services,
  opponent: User,
  bet: number,
): Promise<void> {
  const challenger = interaction.user;
  if (opponent.bot) {
    await interaction.reply({ content: "ボットは対戦相手にできない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (opponent.id === challenger.id) {
    await interaction.reply({ content: "自分自身は挑戦できない。", flags: MessageFlags.Ephemeral });
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

  // 挑戦者から先に徴収（受諾されなければ返金）
  const session = `ccduel:${interaction.id}`;
  if (!collectStakes(services, [challenger.id], bet, session, "chinchiro-duel")) {
    await interaction.reply({ content: "徴収に失敗した。", flags: MessageFlags.Ephemeral });
    return;
  }

  const inviteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ccd:accept").setLabel("受ける").setEmoji("🎲").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ccd:decline").setLabel("断る").setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `<@${opponent.id}>`,
    embeds: [
      buildPvpInvite({
        game: "対戦チンチロ",
        icon: "🎲",
        challengerId: challenger.id,
        opponentId: opponent.id,
        bet,
        ruleLines: [
          "BOTが両者の賽を同一戦略で振って自動判定。",
          "ピンゾロ5倍・ゾロ目3倍・シゴロ2倍・ヒフミ倍付け負け。",
          "同役は最大5回振り直し、決まらねば全額返金。",
        ],
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
      filter: (i) => i.user.id === opponent.id && (i.customId === "ccd:accept" || i.customId === "ccd:decline"),
      time: 60_000,
    });
    accepted = btn.customId === "ccd:accept";
    await btn.deferUpdate();
  } catch {
    // 時間切れ
  }

  if (!accepted) {
    refundAll(services, [challenger.id], bet, session);
    await interaction.editReply({
      content: "",
      embeds: [buildPvpAbort("対戦チンチロ", "🎲", `<@${opponent.id}> が受けなかった（時間切れ or 辞退）。挑戦者に全額返金。`)],
      components: [],
    });
    return;
  }
  // 受諾: 対戦相手からも徴収
  if (!collectStakes(services, [opponent.id], bet, session, "chinchiro-duel")) {
    refundAll(services, [challenger.id], bet, session);
    await interaction.editReply({
      content: "",
      embeds: [buildPvpAbort("対戦チンチロ", "🎲", "対戦相手のエテル徴収に失敗。挑戦者に全額返金。")],
      components: [],
    });
    return;
  }

  // ── 両者振る（同一戦略・同役なら最大5回振り直し） ──
  let cResult = autoRollHand(services.rng);
  let oResult = autoRollHand(services.rng);
  let ties = 0;
  while (handRank(cResult.hand) === handRank(oResult.hand) && ties < REROLL_ON_TIE) {
    ties++;
    cResult = autoRollHand(services.rng);
    oResult = autoRollHand(services.rng);
  }

  const pot = bet * 2;
  const cRank = handRank(cResult.hand);
  const oRank = handRank(oResult.hand);

  await interaction.editReply({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle("🎲 対戦チンチロ — 決着")
        .setColor(C_MAMMON)
        .setDescription(
          [
            `<@${challenger.id}>: ${showDice(cResult.dice)} → ${describe(cResult.hand)}`,
            `<@${opponent.id}>: ${showDice(oResult.dice)} → ${describe(oResult.hand)}`,
          ].join("\n"),
        ),
    ],
    components: [],
    allowedMentions: { parse: [] },
  });
  await sleep(1200);

  if (cRank === oRank) {
    // 同役続き → 全額返金
    refundAll(services, [challenger.id, opponent.id], bet, session);
    await interaction.followUp({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎲 引き分け")
          .setColor(C_MAMMON)
          .setDescription("何度振っても同役だった。全額返金。"),
      ],
      allowedMentions: { parse: [] },
    });
  } else {
    const winnerId = cRank > oRank ? challenger.id : opponent.id;
    const loserId = cRank > oRank ? opponent.id : challenger.id;
    const { payout, houseCut } = settlePvp(services, [winnerId], pot, session);

    await interaction.followUp({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🎲 対戦チンチロ — 勝者 <@${winnerId}>`)
          .setColor(C_WIN)
          .setDescription(
            [
              `**勝ち** <@${winnerId}> +${fmtEther(payout - bet)}（受取 ${fmtEther(payout)}）`,
              `**負け** <@${loserId}> -${fmtEther(bet)}`,
              `場代 ${fmtEther(houseCut)} → JPプール`,
            ].join("\n"),
          ),
      ],
      allowedMentions: { users: [winnerId] },
    });
  }

  await offerRematch(interaction, {
    aId: challenger.id,
    bId: opponent.id,
    bet,
    game: "対戦チンチロ",
    replay: (btn) => playChinchiroDuel(btn, services, btn.user.id === challenger.id ? opponent : challenger, bet),
  });
}
