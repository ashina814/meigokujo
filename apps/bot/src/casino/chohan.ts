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
import {
  MIN_BET,
  acquireSeat,
  releaseSeat,
  sleep,
  validateBet,
  withHouseReservation,
} from "./common.js";
import { C_MAMMON, C_WIN, C_LOSE, diceBlock, diceHiddenArt } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  isCollectorTimeoutError,
  recordCasinoGameAbandonBestEffort,
  recordCasinoGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";
import { recordCasinoParticipationBestEffort } from "./participation-history.js";

/**
 * 🎴 丁半（ソロ・casino-bot 準拠）。
 * - 丁/半 を選ぶ → サイコロ2つ振って偶奇判定 → 1.94倍配当（RTP 97%）
 * - 結果画面に「もう一回」「倍プッシュ」「配当表」「退席」の4ボタン
 * - 15秒無操作は賭け金返却
 */
// 配当倍率は core の CHOHAN_PAYOUT を唯一の真実源として使う（表示配当表・実払戻・RTPテストが一致）

function rollDice(rng: CasinoRng): [number, number] {
  return [rng.int(1, 6), rng.int(1, 6)];
}

export function paytableEmbed(): EmbedBuilder {
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
        "　勝ちで発動（残高が多いほど福分け積立・連勝で倍率）",
      ].join("\n"),
    );
}

export async function playChohan(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  try {
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "丁半");
    if (!check.ok) return;
    await runRound(interaction, services, check.bet, context);
  } finally {
    releaseSeat(uid);
  }
}

/**
 * 1回ぶんの入口。**先に最悪ケースの債務を予約**してから本体へ入る（PR5・正本 §11.2）。
 * 予約が取れなければ本体を一度も呼ばず、押せる金額を提示して戻る（金は1 Ld も動かない）。
 */
async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  await withHouseReservation(interaction, services, "丁半", bet, interaction.id, (reservationKey) =>
    runRoundInner(interaction, services, bet, reservationKey, context),
  );
}

async function runRoundInner(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  reservationKey: string,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  const playContext = casinoPlayContext(context);
  recordCasinoGameStartBestEffort(services, {
    userId: uid,
    game: "丁半",
    operationId: interaction.id,
    wager: bet,
    source: playContext.source,
  });

  const bettingEmbed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 丁半" })
    .setColor(C_MAMMON)
    .setTitle("🎴  丁 か 半 か")
    .setDescription(
      [
        "```",
        diceHiddenArt(2),
        "```",
        "壺の中で二賽が転がる。**丁（偶数）** か **半（奇数）** か——15秒以内に選べ。",
      ].join("\n"),
    )
    .setFooter({ text: `賭け ${fmtEther(bet).replace(" Ld", "Ld")}` });
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
  } catch (error) {
    if (!isCollectorTimeoutError(error)) throw error;
    recordCasinoGameAbandonBestEffort(services, {
      userId: uid,
      game: "丁半",
      operationId: interaction.id,
      wager: bet,
      source: playContext.source,
      reason: "choice_timeout",
    });
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
      .setDescription(diceBlock([d1, d2]))
      .setFooter({ text: `賭け ${fmtEther(bet).replace(" Ld", "Ld")}` });
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
  // 連鎖ボーナスは無効化。丁半は 50% 勝率と CHOHAN_PAYOUT=1.94 で RTP 97% だが、
  // 連鎖有効時は実効 RTP が 106% を超える回帰が実測レポートで確認された（クラッシュと同構造）。
  // お守りの消費も賭け・配当と同じグループの中（settleSolo）
  const settled = services.casino.settleSolo(uid, "丁半", bet, rawPayout, { chain: false, operationId: interaction.id, reservationKey });
  // settleSolo()が実際にダイス目・賭け・配当を単一atomic transactionで確定させた
  // 正本——ここへ到達した時点で初めて「実際のroundが成立した」と言える。丁選択の
  // 15秒timeoutはここへ到達せず早期returnするので参加記録されない（PR #163レビュー§3）。
  recordCasinoParticipationBestEffort(services, {
    participationKey: `solo:chohan:${interaction.id}`,
    activityKey: "chohan",
    participantUserIds: [uid],
  });
  recordCasinoGameFinishBestEffort(services, {
    userId: uid,
    game: "丁半",
    operationId: interaction.id,
    wager: bet,
    payout: settled.payout,
    net: settled.net,
    source: playContext.source,
  });
  const amulet = { note: settled.amuletNote };

  const totalPayout = settled.payout;
  const resultLabel = isCho ? "丁（偶数）" : "半（奇数）";
  const playerLabel = picked === "cho" ? "丁" : "半";
  const streakLine =
    settled.chainBonus > 0
      ? `${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
  const fukuLine =
    settled.fukuTax > 0 ? `⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 福分け積立` : "";

  // 丁半は「勝ち/負け」より卓の言葉に近い「的中/外れ」で出す
  const tag = won ? "🟢 的中" : settled.net === 0 ? "⚪ 返金（お守り）" : "🔴 外れ";
  const bonusBits: string[] = [];
  if (streakLine) bonusBits.push(streakLine);
  if (fukuLine) bonusBits.push(fukuLine);
  if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);

  const resultPayload = buildSoloResult({
    services,
    userId: uid,
    game: "丁半",
    net: settled.net,
    wager: bet,
    retryBet: bet,
    titleOverride: tag,
    colorOverride: won ? C_WIN : settled.net === 0 ? 0x78716c : C_LOSE,
    description:
      [
        diceBlock([d1, d2]),
        `出目 **${d1 + d2}** → **${resultLabel}**　／　お前の張り **${playerLabel}**`,
      ].join("\n"),
    sections: bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : [],
  });

  if (won) {
    broadcastBigWin(interaction.client, services, {
      userId: uid,
      game: "丁半",
      bet,
      payout: totalPayout,
    });
  }

  await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
}
