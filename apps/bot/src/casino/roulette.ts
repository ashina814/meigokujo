import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { LOSE_COLOR, MAMMON_COLOR, MAX_BET, MIN_BET, WIN_COLOR, sleep } from "./common.js";

/**
 * 🎡 ルーレット（チャンネル共有セッション）。casino-bot 準拠。
 * - 誰かが /遊ぶ ルーレット で卓を開く → 30秒の受付 → 0〜36 抽選 → 一括精算
 * - 賭け先: 赤/黒/奇数/偶数/大/小 = 2倍、零(0) = 36倍
 * - 1人1口（張り直しは上書き）。徴収は抽選時（受付中に残高が消えた賭けは無効）
 */
const LOBBY_SEC = 30;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

type BetType = "red" | "black" | "green" | "odd" | "even" | "high" | "low";

const LABELS: Record<BetType, string> = {
  red: "🔴 赤",
  black: "⚫ 黒",
  green: "🟢 零",
  odd: "奇数",
  even: "偶数",
  high: "大(19-36)",
  low: "小(1-18)",
};

const PAYOUTS: Record<BetType, number> = {
  red: 2,
  black: 2,
  green: 36,
  odd: 2,
  even: 2,
  high: 2,
  low: 2,
};

function hits(type: BetType, n: number): boolean {
  switch (type) {
    case "red": return RED.has(n);
    case "black": return n !== 0 && !RED.has(n);
    case "green": return n === 0;
    case "odd": return n > 0 && n % 2 === 1;
    case "even": return n > 0 && n % 2 === 0;
    case "high": return n >= 19;
    case "low": return n >= 1 && n <= 18;
  }
}

function colorOf(n: number): string {
  if (n === 0) return "🟢";
  return RED.has(n) ? "🔴" : "⚫";
}

interface SessionBet {
  userId: string;
  type: BetType;
  amount: number;
}

/** チャンネルごとに1卓 */
const activeSessions = new Set<string>();

export async function playRoulette(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const channelId = interaction.channelId;
  if (activeSessions.has(channelId)) {
    await interaction.reply({ content: "この卓はもう回っている。今の勝負が終わるのを待て。", flags: MessageFlags.Ephemeral });
    return;
  }
  activeSessions.add(channelId);
  try {
    const bets = new Map<string, SessionBet>(); // userId -> bet（上書き）

    const lobbyEmbed = (secondsLeft: number) => {
      const totalPot = [...bets.values()].reduce((s, b) => s + b.amount, 0);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ルーレット" })
        .setColor(MAMMON_COLOR)
        .setTitle(`🎡  受付中  ·  締切まで ${secondsLeft}秒`)
        .setDescription(
          [
            "```",
            `赤・黒・奇数・偶数・大・小  ×  2倍`,
            `🟢 零                       ×  36倍`,
            "```",
            `*「${Mammon.greeting()}」*`,
          ].join("\n"),
        )
        .setFooter({ text: `参加 ${bets.size}人 · 総額 ${fmtEther(totalPot).replace(" ◈", "◈")}` });

      if (bets.size > 0) {
        // 賭け目ごとにまとめて表示
        const byType = new Map<string, { user: string; amt: number }[]>();
        for (const b of bets.values()) {
          if (!byType.has(b.type)) byType.set(b.type, []);
          byType.get(b.type)!.push({ user: b.userId, amt: b.amount });
        }
        const sortedTypes = [...byType.keys()].sort();
        for (const t of sortedTypes) {
          const arr = byType.get(t)!;
          const total = arr.reduce((s, x) => s + x.amt, 0);
          const users = arr.map((x) => `<@${x.user}> ${fmtEther(x.amt).replace(" ◈", "◈")}`).join("・");
          embed.addFields({ name: `${LABELS[t as keyof typeof LABELS]}  ·  ${fmtEther(total).replace(" ◈", "◈")}`, value: users, inline: false });
        }
      }
      return embed;
    };

    const rows = (disabled = false) => [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("rl:red").setLabel("🔴 赤").setStyle(ButtonStyle.Danger).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:black").setLabel("⚫ 黒").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:green").setLabel("🟢 零 (36倍)").setStyle(ButtonStyle.Success).setDisabled(disabled),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("rl:odd").setLabel("奇数").setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:even").setLabel("偶数").setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:high").setLabel("大 19-36").setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:low").setLabel("小 1-18").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      ),
    ];

    const msg = await interaction.reply({ embeds: [lobbyEmbed(LOBBY_SEC)], components: rows(), withResponse: true });
    const reply: Message | undefined = msg.resource?.message ?? undefined;
    if (!reply) throw new Error("reply unavailable");

    const endAt = Date.now() + LOBBY_SEC * 1000;
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.customId.startsWith("rl:"),
      time: LOBBY_SEC * 1000,
    });

    collector.on("collect", (btn: ButtonInteraction) => {
      void (async () => {
        const type = btn.customId.slice(3) as BetType;
        const modal = new ModalBuilder()
          .setCustomId(`rl:amt:${type}:${btn.id}`)
          .setTitle(`${LABELS[type]} に張る`)
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("amount").setLabel(`賭けるエテル（${MIN_BET}〜${MAX_BET.toLocaleString()}）`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(9),
            ),
          );
        await btn.showModal(modal);
        const sub = await btn.awaitModalSubmit({ time: 25_000, filter: (m) => m.customId === `rl:amt:${type}:${btn.id}` }).catch(() => null);
        if (!sub) return;
        const amt = Number(sub.fields.getTextInputValue("amount").replaceAll(",", "").trim());
        if (!Number.isInteger(amt) || amt < MIN_BET || amt > MAX_BET) {
          await sub.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
          return;
        }
        const held = services.ether.balanceOf(btn.user.id);
        if (held < amt) {
          await sub.reply({ content: `${Mammon.broke()}（所持 ${fmtEther(held)}）`, flags: MessageFlags.Ephemeral });
          return;
        }
        // テーブルリミット: この卓の最大支払い合計が胴元残高を超えない範囲で受ける
        const potential = [...bets.values()]
          .filter((b) => b.userId !== btn.user.id)
          .reduce((s, b) => s + b.amount * PAYOUTS[b.type], 0);
        if (!services.casino.canAccept(potential + amt * PAYOUTS[type])) {
          await sub.reply({ content: Mammon.tableClosed(), flags: MessageFlags.Ephemeral });
          return;
        }
        if (collector.ended) {
          await sub.reply({ content: "締切に間に合わなかった。次の卓で。", flags: MessageFlags.Ephemeral });
          return;
        }
        bets.set(btn.user.id, { userId: btn.user.id, type, amount: amt });
        await sub.reply({ content: `✅ ${LABELS[type]} に ${fmtEther(amt)} を張った。`, flags: MessageFlags.Ephemeral });
        await interaction.editReply({ embeds: [lobbyEmbed(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))] }).catch(() => undefined);
      })();
    });

    // 残り時間の表示更新
    for (const left of [20, 10] as const) {
      const wait = endAt - left * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      if (collector.ended) break;
      await interaction.editReply({ embeds: [lobbyEmbed(left)] }).catch(() => undefined);
    }
    // 締切まで待つ
    await new Promise<void>((resolve) => collector.once("end", () => resolve()));

    if (bets.size === 0) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle("🎡 ルーレット — 流れた").setColor(LOSE_COLOR).setDescription("誰も張らなかったので、この卓は流れた。")],
        components: [],
      });
      return;
    }

    // 抽選演出
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("🎡 ルーレット — 締切").setColor(MAMMON_COLOR).setDescription("球が回る……")],
      components: [],
    });
    await sleep(1800);

    const n = Math.floor(Math.random() * 37);
    const lines: string[] = [];
    let anyWin = false;
    for (const b of bets.values()) {
      const won = hits(b.type, n);
      const payout = won ? Math.floor(b.amount * PAYOUTS[b.type]) : 0;
      try {
        services.casino.settle(b.userId, "roulette", b.amount, payout, 0, { chain: false, fuku: false });
      } catch {
        lines.push(`・<@${b.userId}> — 残高不足で無効`);
        continue;
      }
      if (won) anyWin = true;
      lines.push(
        won
          ? `・<@${b.userId}> — ${LABELS[b.type]} 的中！ **+${fmtEther(payout - b.amount)}**`
          : `・<@${b.userId}> — ${LABELS[b.type]} 外れ（-${fmtEther(b.amount)}）`,
      );
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎡 ルーレット — 出目 ${colorOf(n)} **${n}**`)
      .setColor(anyWin ? WIN_COLOR : LOSE_COLOR)
      .setDescription([...lines, "", `*「${anyWin ? Mammon.win() : Mammon.lose()}」*`].join("\n"));
    await interaction.editReply({ embeds: [embed], components: [] });
  } finally {
    activeSessions.delete(channelId);
  }
}
