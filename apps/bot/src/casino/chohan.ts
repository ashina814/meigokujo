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
} from "discord.js";
import { CHOHAN_PAYOUT, type CasinoRng } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, acquireSeat, applyAmulets, releaseSeat, sleep, validateBet } from "./common.js";
import { C_MAMMON, C_WIN, C_LOSE } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🎴 丁半（ソロ・casino-bot 準拠）。
 * - 丁/半 を選ぶ → サイコロ2つ振って偶奇判定 → 1.94倍配当（RTP 97%）
 * - 結果画面に「もう一回」「倍プッシュ」「配当表」「退席」の4ボタン
 * - 15秒無操作は賭け金返却
 */
// 配当倍率は core の CHOHAN_PAYOUT を唯一の真実源として使う（表示配当表・実払戻・RTPテストが一致）
const DICE_EMOJI: Record<number, string> = { 1: "①", 2: "②", 3: "③", 4: "④", 5: "⑤", 6: "⑥" };
const DIE = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

function rollDice(rng: CasinoRng): [number, number] {
  return [rng.int(1, 6), rng.int(1, 6)];
}

function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 丁半 — ルール")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**遊び方**",
        "・サイコロ2つの合計が **丁（偶数）** か **半（奇数）** かを当てる",
        "・的中したら賭金 **× 1.94倍** 払戻し（RTP 97%）",
        "",
        "**⚡ 倍プッシュ**",
        "　結果画面から前回の倍額で即再挑戦できる。連勝チャレンジ用",
        "",
        "**⚖️ 福の重み / 🔥 連鎖チェーン**",
        "　勝ちで発動（残高が多いほど奉納・連勝で倍率）",
      ].join("\n"),
    );
}

export async function playChohan(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, betRaw * 2);
  if (!check.ok) return;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  try {
    await runRound(interaction, services, check.bet);
  } finally {
    releaseSeat(uid);
  }
}

async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
): Promise<void> {
  const uid = interaction.user.id;

  const bettingEmbed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 丁半" })
    .setColor(C_MAMMON)
    .setTitle("🎴  丁 か 半 か")
    .setDescription(
      [
        "壺の中で二賽が転がる。",
        "**丁（偶数）** か **半（奇数）** か——15秒以内に選べ。",
      ].join("\n"),
    )
    .setFooter({ text: `賭け ${fmtEther(bet).replace(" ◈", "◈")}` });
  const choiceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("chohan:cho").setLabel("丁（偶数）").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("chohan:han").setLabel("半（奇数）").setStyle(ButtonStyle.Danger),
  );

  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [bettingEmbed], components: [choiceRow] })) as Message;
  } else {
    await interaction.reply({ embeds: [bettingEmbed], components: [choiceRow] });
    reply = (await interaction.fetchReply()) as Message;
  }

  let picked: "cho" | "han" | null = null;
  try {
    const btn = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === uid && i.customId.startsWith("chohan:"),
      time: 15_000,
    });
    picked = btn.customId === "chohan:cho" ? "cho" : "han";
    await btn.deferUpdate();
  } catch {
    await reply.edit({ content: "⏱ 時間切れ。この卓は流れた。", embeds: [], components: [] }).catch(() => undefined);
    return;
  }

  // ── サイコロを振る演出（シェイク3フレーム→確定） ──
  const shakeEmbed = (frame: number) => {
    // 見た目のシェイクアニメだけは軽い擬似乱数で十分（結果には影響しない）
    const d1 = services.rng.int(1, 6);
    const d2 = services.rng.int(1, 6);
    return new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · 丁半" })
      .setColor(C_MAMMON)
      .setTitle(`🎴  壺を振る……  ${"・".repeat(frame + 1)}`)
      .setDescription(
        [
          "```",
          `╭─────╮   ╭─────╮`,
          `│  ${DIE[d1]}  │   │  ${DIE[d2]}  │`,
          `╰─────╯   ╰─────╯`,
          "```",
        ].join("\n"),
      )
      .setFooter({ text: `賭け ${fmtEther(bet).replace(" ◈", "◈")}` });
  };
  for (let f = 0; f < 3; f++) {
    await reply.edit({ embeds: [shakeEmbed(f)], components: [] }).catch(() => undefined);
    await sleep(280);
  }

  const [d1, d2] = rollDice(services.rng);
  const total = d1 + d2;
  const isCho = total % 2 === 0;
  const won = (picked === "cho") === isCho;
  const rawPayout = won ? Math.floor(bet * CHOHAN_PAYOUT) : 0;
  const amulet = applyAmulets(services, uid, bet, rawPayout);
  // 連鎖ボーナスは無効化。丁半は 50% 勝率と CHOHAN_PAYOUT=1.94 で RTP 97% だが、
  // 連鎖有効時は実効 RTP が 106% を超える回帰が実測レポートで確認された（クラッシュと同構造）。
  const settled = services.casino.settle(uid, "丁半", bet, amulet.payout, 0, { chain: false });

  const totalPayout = settled.payout;
  const net = settled.net;
  const resultLabel = isCho ? "丁（偶数）" : "半（奇数）";
  const playerLabel = picked === "cho" ? "丁" : "半";
  const streakLine =
    settled.chainBonus > 0
      ? `${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
  const fukuLine =
    settled.fukuTax > 0 ? `⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納` : "";

  const tag = won ? "🟢 的中" : settled.net === 0 ? "⚪ 返金（お守り）" : "🔴 外れ";
  const netStr = settled.net === 0 ? "±0 ◈" : `${settled.net > 0 ? "+" : "−"}${Math.abs(settled.net).toLocaleString("ja-JP")} ◈`;
  const bonusBits: string[] = [];
  if (streakLine) bonusBits.push(streakLine);
  if (fukuLine) bonusBits.push(fukuLine);
  if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);

  const resultEmbed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 丁半" })
    .setColor(won ? C_WIN : settled.net === 0 ? 0x78716c : C_LOSE)
    .setTitle(`${tag}  **${netStr}**`)
    .setDescription(
      [
        "```",
        `╭─────╮   ╭─────╮`,
        `│  ${DIE[d1]}  │   │  ${DIE[d2]}  │`,
        `╰─────╯   ╰─────╯`,
        "```",
        `**${d1 + d2}** → **${resultLabel}**   ／   お前の張り: **${playerLabel}**`,
      ].join("\n"),
    )
    .addFields(...(bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : []))
    .setFooter({
      text: [`所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}`, `賭け ${fmtEther(bet).replace(" ◈", "◈")}`].join(" · "),
    });
  void DICE_EMOJI;
  void total;
  void totalPayout;
  void net;

  if (won) {
    broadcastBigWin(interaction.client, services, {
      userId: uid,
      game: "丁半",
      bet,
      payout: totalPayout,
    });
  }

  const held = services.ether.balanceOf(uid);
  const nextBet = bet;
  const doubleBet = bet * 2;
  const nextRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`chohan:retry:${nextBet}`)
      .setLabel(`🎰 もう一回 ${nextBet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(held < nextBet),
    new ButtonBuilder()
      .setCustomId(`chohan:retry:${doubleBet}`)
      .setLabel(`⚡ 倍プッシュ ${doubleBet.toLocaleString()}`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(held < doubleBet || doubleBet > MAX_BET),
    new ButtonBuilder().setCustomId("chohan:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("chohan:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
  );
  await reply.edit({ embeds: [resultEmbed], components: [nextRow] }).catch(() => undefined);

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "chohan:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId === "chohan:quit") {
      collector.stop("quit");
      await btn.deferUpdate();
      await reply.edit({ components: [] }).catch(() => undefined);
      return;
    }
    if (btn.customId.startsWith("chohan:retry:")) {
      collector.stop("retry");
      const retryBet = Number(btn.customId.split(":")[2]);
      if (retryBet < MIN_BET || retryBet > MAX_BET) return;
      await btn.deferUpdate();
      releaseSeat(uid);
      if (acquireSeat(uid)) {
        try {
          await runRound(btn, services, retryBet);
        } finally {
          releaseSeat(uid);
        }
      }
    }
  });
  collector.on("end", async (_c, reason) => {
    if (reason !== "retry" && reason !== "quit") await reply.edit({ components: [] }).catch(() => undefined);
  });
}
