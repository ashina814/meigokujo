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
 * 📈 クラッシュ。倍率がじわじわ上がり、崩壊する前に「離脱」を押せば
 * その時点の倍率で払い戻し。崩壊点は E[payout] = 1 - 4% になる逆CDF分布。
 * 倍率上限 30x（テーブルリミット保護）。
 */
const HOUSE_EDGE = 0.04;
const MAX_MULT = 30;
const TICK_MS = 1_300;
/** 1tickごとの倍率成長（指数）。約9tickで2倍、心臓に悪いペース */
const GROWTH_PER_TICK = 1.22;

function generateCrashPoint(): number {
  const e = 1 - HOUSE_EDGE;
  const r = Math.random();
  if (r < 0.01) return 1.0; // 1% は即崩壊
  const crash = e / (1 - r);
  return Math.min(MAX_MULT, Math.max(1.0, Math.round(crash * 100) / 100));
}

function bar(mult: number): string {
  const steps = 15;
  const progress = Math.min(1, Math.log10(mult) / 1.5);
  const filled = Math.floor(progress * steps);
  return "▰".repeat(filled) + "😈" + "・".repeat(Math.max(0, steps - filled));
}

export async function playCrash(
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
    const crashPoint = generateCrashPoint();
    const row = (disabled = false) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("crash:out").setLabel("離脱する").setEmoji("🪂").setStyle(ButtonStyle.Success).setDisabled(disabled),
      );

    const render = (mult: number) =>
      [
        `📈 **クラッシュ** — 賭け ${fmtEther(bet)}`,
        "",
        `倍率 **${mult.toFixed(2)}x** ＝ 今離脱で ${fmtEther(Math.floor(bet * mult))}`,
        bar(mult),
        `*崩壊する前に「離脱」を押せ。*`,
      ].join("\n");

    const msg = await interaction.reply({ content: render(1.0), components: [row()], withResponse: true });
    const reply: Message | undefined = msg.resource?.message ?? undefined;
    if (!reply) throw new Error("reply unavailable");

    // TS は closure 内の代入で narrowing を解除しないため、state オブジェクトに持つ
    const state = { cashedOut: null as number | null, crashed: false };
    let displayed = 1.0; // プレイヤーが見ている倍率。払い戻しは常にこの値以下
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === uid && i.customId === "crash:out",
      time: 120_000,
    });

    collector.on("collect", async (i) => {
      // 崩壊後に滑り込んだクリックは無効（表示済みの倍率でのみ確定できる）
      if (!state.crashed && state.cashedOut === null) {
        state.cashedOut = displayed;
        collector.stop("cashout");
      }
      await i.deferUpdate().catch(() => undefined);
    });

    // tickループ: 崩壊点までじわじわ上げる
    while (state.cashedOut === null && !state.crashed) {
      await sleep(TICK_MS);
      if (state.cashedOut !== null) break;
      const next = Math.round(displayed * GROWTH_PER_TICK * 100) / 100;
      if (next >= crashPoint) {
        state.crashed = true;
        break;
      }
      displayed = next;
      await interaction.editReply({ content: render(displayed), components: [row()] }).catch(() => undefined);
    }
    collector.stop();

    const cashedOut = state.cashedOut;
    if (cashedOut !== null && cashedOut >= 1.0) {
      const payout = Math.floor(bet * cashedOut);
      services.casino.settle(uid, "crash", bet, payout);
      const net = payout - bet;
      await interaction.editReply({
        content: "",
        components: [],
        embeds: [
          resultEmbed({
            title: `📈 クラッシュ — +${fmtEther(net)}`,
            lines: [
              `🪂 離脱倍率 **${cashedOut.toFixed(2)}x** ／ 崩壊点は ${crashPoint.toFixed(2)}x だった`,
              `払戻し ${fmtEther(payout)}`,
            ],
            net,
            balance: services.ether.balanceOf(uid),
          }),
        ],
      });
      return;
    }

    // 崩壊
    services.casino.settle(uid, "crash", bet, 0);
    await interaction.editReply({
      content: "",
      components: [],
      embeds: [
        resultEmbed({
          title: `📉 クラッシュ — -${fmtEther(bet)}`,
          lines: [`💥 **${crashPoint.toFixed(2)}x** で崩壊した。`],
          net: -bet,
          balance: services.ether.balanceOf(uid),
        }),
      ],
    });
  } finally {
    releaseSeat(uid);
  }
}
