import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, sleep } from "./common.js";
import { collectStakes, settleProportional } from "./pvp-common.js";
import { C_LOSE, C_MAMMON, C_WIN, E, boxDice, buildLobbyEmbed, fmtBigDelta } from "./ui.js";

/**
 * 🎴 多人数丁半（casino-bot /丁半 PvP 準拠）。
 * - 卓を開くと 60秒の受付。丁/半 に張る人が集まる
 * - 締切: 両側に張り手がいれば成立、片側だけなら全額返金
 * - 胴（BOT）が二賽を振って自動判定。勝ち側が負け側を賭け額比で山分け＋元本返却
 * - 場代 3% を JP プールへ（マモンの取り分）
 */
const LOBBY_SEC = 60;

interface Bet {
  userId: string;
  side: "cho" | "han";
  amount: number;
}

const activeSessions = new Set<string>();

export async function playChohanMulti(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const channelId = interaction.channelId;
  if (activeSessions.has(channelId)) {
    await interaction.reply({ content: "この卓は既に開いている。今の勝負が終わるのを待て。", flags: MessageFlags.Ephemeral });
    return;
  }
  activeSessions.add(channelId);
  try {
    await runSession(interaction, services);
  } finally {
    activeSessions.delete(channelId);
  }
}

async function runSession(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const bets = new Map<string, Bet>();
  const endAt = Date.now() + LOBBY_SEC * 1000;

  const buildLobby = (secondsLeft: number) => {
    const chos = [...bets.values()].filter((b) => b.side === "cho");
    const hans = [...bets.values()].filter((b) => b.side === "han");
    const choTotal = chos.reduce((s, b) => s + b.amount, 0);
    const hanTotal = hans.reduce((s, b) => s + b.amount, 0);
    const pot = choTotal + hanTotal;
    const embed = buildLobbyEmbed({
      game: "多人数丁半",
      title: "🎴  多人数丁半  ·  受付中",
      body: "壺の中で二賽が転がる。両側に張り手が揃わなければ不成立。",
      secondsLeft,
      totalBet: pot,
    });
    const choValue = chos.length > 0
      ? chos.map((b) => `　<@${b.userId}>  ${fmtEther(b.amount).replace(" ◈", "◈")}`).join("\n")
      : "　（誰も張っていない）";
    const hanValue = hans.length > 0
      ? hans.map((b) => `　<@${b.userId}>  ${fmtEther(b.amount).replace(" ◈", "◈")}`).join("\n")
      : "　（誰も張っていない）";
    embed.addFields(
      { name: `⚫ 丁（偶数）  ${chos.length}人  ·  ${fmtEther(choTotal).replace(" ◈", "◈")}`, value: choValue, inline: false },
      { name: `⚪ 半（奇数）  ${hans.length}人  ·  ${fmtEther(hanTotal).replace(" ◈", "◈")}`, value: hanValue, inline: false },
    );
    return embed;
  };

  const rows = (disabled = false) => [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("chm:cho").setLabel("丁（偶数）に張る").setEmoji("⚫").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId("chm:han").setLabel("半（奇数）に張る").setEmoji("⚪").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];

  await interaction.reply({ embeds: [buildLobby(LOBBY_SEC)], components: rows() });
  const reply = (await interaction.fetchReply()) as Message;

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.customId.startsWith("chm:"),
    time: LOBBY_SEC * 1000,
  });

  collector.on("collect", (btn: ButtonInteraction) => {
    void (async () => {
      const side = btn.customId.slice(4) as "cho" | "han";
      const modal = new ModalBuilder()
        .setCustomId(`chm:amt:${side}:${btn.id}`)
        .setTitle(`${side === "cho" ? "丁（偶数）" : "半（奇数）"} に張る`)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("amount")
              .setLabel(`賭けるエテル（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(9),
          ),
        );
      await btn.showModal(modal);
      const sub = await btn.awaitModalSubmit({ time: 55_000, filter: (m) => m.customId === `chm:amt:${side}:${btn.id}` }).catch(() => null);
      if (!sub) return;
      const amt = Number(sub.fields.getTextInputValue("amount").replaceAll(",", "").trim());
      if (!Number.isInteger(amt) || amt < MIN_BET || amt > MAX_BET) {
        await sub.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
        return;
      }
      // 既に張ってたら追加額を徴収して増額
      const existing = bets.get(btn.user.id);
      if (existing) {
        if (existing.side !== side) {
          await sub.reply({ content: "既に反対側に張っている。同じ卓では片側のみ。", flags: MessageFlags.Ephemeral });
          return;
        }
        const additional = amt - existing.amount;
        if (additional <= 0) {
          await sub.reply({ content: "既に張った額以上を指定してくれ（減額は不可）。", flags: MessageFlags.Ephemeral });
          return;
        }
        if (services.ether.balanceOf(btn.user.id) < additional) {
          await sub.reply({ content: "エテル残高が足りない。", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!collectStakes(services, [btn.user.id], additional)) {
          await sub.reply({ content: "徴収に失敗した。", flags: MessageFlags.Ephemeral });
          return;
        }
        existing.amount = amt;
      } else {
        if (services.ether.balanceOf(btn.user.id) < amt) {
          await sub.reply({ content: "エテル残高が足りない。", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!collectStakes(services, [btn.user.id], amt)) {
          await sub.reply({ content: "徴収に失敗した。", flags: MessageFlags.Ephemeral });
          return;
        }
        bets.set(btn.user.id, { userId: btn.user.id, side, amount: amt });
      }
      await sub.reply({ content: `✅ ${side === "cho" ? "丁" : "半"} に ${fmtEther(amt)} を張った。`, flags: MessageFlags.Ephemeral });
      await interaction.editReply({ embeds: [buildLobby(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))] }).catch(() => undefined);
    })();
  });

  // 残り時間表示
  for (const left of [30, 15, 5] as const) {
    const wait = endAt - left * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (collector.ended) break;
    await interaction.editReply({ embeds: [buildLobby(left)] }).catch(() => undefined);
  }
  await new Promise<void>((resolve) => collector.once("end", () => resolve()));

  const chos = [...bets.values()].filter((b) => b.side === "cho");
  const hans = [...bets.values()].filter((b) => b.side === "han");
  if (chos.length === 0 || hans.length === 0) {
    // 片側だけなら全額返金
    for (const b of bets.values()) services.ether.transfer("house", b.userId, b.amount);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "マモンの賭場 · 多人数丁半" })
          .setColor(C_LOSE)
          .setTitle("🎴  不成立")
          .setDescription("両側に張り手が揃わなかった。全額返金。"),
      ],
      components: [],
    });
    return;
  }

  // 抽選演出
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · 多人数丁半" })
        .setColor(C_MAMMON)
        .setTitle("🎴  締切  ·  壺を開く……")
        .setDescription("マモンの手が壺にかかる。"),
    ],
    components: [],
  });
  await sleep(1600);

  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  const total = d1 + d2;
  const isCho = total % 2 === 0;
  const winners = isCho ? chos : hans;
  const losers = isCho ? hans : chos;

  const { totalHouseCut } = settleProportional(
    services,
    winners.map((b) => ({ userId: b.userId, bet: b.amount })),
    losers.map((b) => ({ userId: b.userId, bet: b.amount })),
  );

  const resultLabel = isCho ? "丁（偶数）" : "半（奇数）";
  const winTotal = winners.reduce((s, w) => s + w.amount, 0);
  const loseTotal = losers.reduce((s, l) => s + l.amount, 0);
  const distributable = winTotal + loseTotal - totalHouseCut;

  const winnerLines = winners
    .sort((a, b) => b.amount - a.amount)
    .map((w) => {
      const share = Math.floor((distributable * w.amount) / winTotal);
      return `　${E.win}  <@${w.userId}>  賭け ${fmtEther(w.amount).replace(" ◈", "◈")} → 受取 **${fmtEther(share).replace(" ◈", "◈")}**  ${fmtBigDelta(share - w.amount)}`;
    })
    .join("\n");
  const loserLines = losers
    .map((l) => `　${E.lose}  <@${l.userId}>  ${fmtBigDelta(-l.amount)}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 多人数丁半" })
    .setColor(C_WIN)
    .setTitle(`🎴  ${resultLabel}  ·  ${boxDice([d1, d2])}  =  ${total}`)
    .addFields(
      { name: `${E.win} 勝ち側  ${winners.length}人`, value: winnerLines || "（なし）", inline: false },
      { name: `${E.lose} 負け側  ${losers.length}人`, value: loserLines || "（なし）", inline: false },
    )
    .setFooter({ text: `場代 ${fmtEther(totalHouseCut).replace(" ◈", "◈")} → JPプール` });
  await interaction.editReply({ embeds: [embed], components: [], allowedMentions: { parse: [] } });
}
