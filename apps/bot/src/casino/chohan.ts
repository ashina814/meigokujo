import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { acquireSeat, releaseSeat, resultEmbed, sleep, validateBet } from "./common.js";

/**
 * 🎲 丁半（ソロ）。サイコロ2つの合計が丁（偶数）か半（奇数）か。
 * 的中で 賭け × 2 × (1 - 3%) 払戻し。
 */
const HOUSE_EDGE = 0.03;
const DICE = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

export async function playChohan(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction, services, betRaw, betRaw * 2);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: 64 });
    return;
  }
  const bet = check.bet;
  let seated = true;
  try {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("chohan:cho").setLabel("丁（偶数）").setEmoji("⚫").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("chohan:han").setLabel("半（奇数）").setEmoji("⚪").setStyle(ButtonStyle.Danger),
    );
    const msg = await interaction.reply({
      content: [`🎲 **丁半** — 賭け ${fmtEther(bet)}`, "壺を振った。丁か、半か。", `*「${Mammon.betPlaced()}」*`].join("\n"),
      components: [row],
      withResponse: true,
    });

    const reply = msg.resource?.message;
    if (!reply) throw new Error("reply unavailable");
    let picked: "cho" | "han" | null = null;
    try {
      const btn = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === uid && i.customId.startsWith("chohan:"),
        time: 60_000,
      });
      picked = btn.customId === "chohan:cho" ? "cho" : "han";
      await btn.deferUpdate();
    } catch {
      await interaction.editReply({ content: "⏱ 時間切れだ。賭けは成立しなかった。", components: [] });
      return;
    }

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const isCho = (d1 + d2) % 2 === 0;
    const won = (picked === "cho") === isCho;
    const payout = won ? Math.floor(bet * 2 * (1 - HOUSE_EDGE)) : 0;
    services.casino.settle(uid, "chohan", bet, payout);
    releaseSeat(uid);
    seated = false;

    await interaction.editReply({ content: `🎲 **丁半** — 賭け ${fmtEther(bet)}\n壺を開ける……`, components: [] });
    await sleep(1200);

    const net = payout - bet;
    const resultLabel = isCho ? "丁（偶数）" : "半（奇数）";
    await interaction.editReply({
      content: "",
      embeds: [
        resultEmbed({
          title: `🎲 丁半 — ${won ? `+${fmtEther(net)}` : `-${fmtEther(bet)}`}`,
          lines: [
            `${DICE[d1]} ${DICE[d2]} → **${d1 + d2}** の **${resultLabel}**`,
            `お前の張り: **${picked === "cho" ? "丁（偶数）" : "半（奇数）"}** — ${won ? "的中！" : "外れ"}`,
            won ? `払戻し ${fmtEther(payout)}` : "",
          ].filter(Boolean),
          net,
          balance: services.ether.balanceOf(uid),
        }),
      ],
    });
  } finally {
    if (seated) releaseSeat(uid);
  }
}
