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
import {
  CRASH_HOUSE_EDGE,
  CRASH_MAX_MULT_CAP,
  CRASH_MIN_CASHOUT,
  crashPoint as generateCrashPoint,
} from "@meigokujo/core";
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
import { C_MAMMON, C_WIN } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  recordCasinoGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";

/**
 * 📈 クラッシュ。casino-bot 準拠の忠実移植。
 * - 崩壊点は core の crashPoint() を使用（RTP モデルと同じ実装・単一の真実源）
 * - 実時間で滑らかに指数成長: M = exp(0.00015 * ms)
 * - 最低降車ライン CRASH_MIN_CASHOUT
 * - 結果画面に「最低/前回/最大/配当表/退席」ボタン
 * - 連鎖ボーナスは無効。1.5倍固定戦略のような高勝率戦略と連鎖倍率の組み合わせで
 *   実効RTPが 100% を超える裁定が可能になるため（PR#6 レビュー指摘）。
 */
const GROWTH_RATE = 0.00015; // per ms
const MIN_CASHOUT = CRASH_MIN_CASHOUT;
const MAX_MULT_CAP = CRASH_MAX_MULT_CAP;
const UPDATE_INTERVAL_MS = 1500;

/**
 * 降車ボタンを押した瞬間に確定する倍率（PR3）。
 *
 * 以前は `MAX_MULT_CAP` を**受付時のテーブルリミット判定にしか使っておらず**、
 * 実際の払戻倍率は崩壊点まで青天井だった（成長率 0.00015/ms なので約31秒粘れば100倍を超える）。
 * 胴元は `bet × 100` しか引き当てていないので、それを超えた分は引き当ての無い債務になる。
 * 受付時に見ている上限と払戻の上限を同じ値に揃える。
 *
 * @param elapsedMs 開始から押下までの実時間
 * @param crashPoint この回の崩壊点（押下時刻が崩壊前であることは呼び出し側が確認済み）
 */
export function cashOutMultiplier(elapsedMs: number, crashPoint: number): number {
  const raw = Math.exp(GROWTH_RATE * elapsedMs);
  const capped = Math.min(raw, crashPoint, MAX_MULT_CAP);
  const floored = Math.floor(capped * 100) / 100;
  if (!Number.isFinite(floored)) return 1.0;
  return Math.max(1.0, floored);
}

function progressBar(mult: number): string {
  const steps = 15;
  const progress = Math.min(1, Math.log10(mult) / 1.5);
  const filled = Math.floor(progress * steps);
  return "▰".repeat(filled) + "😈" + "・".repeat(Math.max(0, steps - filled));
}

export function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 クラッシュ — ルール")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**遊び方**",
        "・倍率がじわじわ上昇。**崩壊する前に「降りる」** を押した瞬間の倍率で払戻し",
        `・最低降車ラインは **${MIN_CASHOUT.toFixed(2)}x**。それ未満では降りられない`,
        `・払戻の上限は **${MAX_MULT_CAP}x**。これ以上粘っても倍率は伸びない（受付時のテーブルリミットと同じ値）`,
        `・崩壊点は分布的にランダム（1%は即崩壊）。数学的 RTP は **${((1 - CRASH_HOUSE_EDGE) * 100).toFixed(0)}%**（M に依らず一定）`,
        "",
        "**⚡ 遅かった**",
        "　押した瞬間の実時間が崩壊時刻を超えていたら、通信の裏で墜ちている",
        "",
        "**⚖️ 福の重み**",
        "　勝ちで発動（残高が多いほど福分け積立）",
        "**🔥 連鎖チェーン**",
        "　クラッシュでは無効（他ゲームより勝率が高いため）",
      ].join("\n"),
    );
}

export async function playCrash(
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
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "クラッシュ");
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
  await withHouseReservation(interaction, services, "クラッシュ", bet, interaction.id, (reservationKey) =>
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
    game: "クラッシュ",
    operationId: interaction.id,
    wager: bet,
    source: playContext.source,
  });
  const crashPoint = generateCrashPoint(services.rng);

  const START_TIME = Date.now();
  const t_crash_ms = Math.log(crashPoint) / GROWTH_RATE;
  const CRASH_TIME = START_TIME + t_crash_ms;
  const MIN_CASHOUT_TIME = START_TIME + Math.log(MIN_CASHOUT) / GROWTH_RATE;

  let currentMultiplier = 1.0;
  let cashedOut = false;
  let cashOutMul = 0;

  const makeEmbed = (multi: number) => {
    const currentValue = Math.floor(bet * multi);
    const canCashOut = multi >= MIN_CASHOUT;
    // 倍率が上がるほど色が緑→黄→オレンジと熱くなる（心理演出）
    const color = multi >= 5 ? 0xf59e0b : multi >= 2 ? 0xeab308 : canCashOut ? 0x22c55e : 0x64748b;
    return new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · クラッシュ" })
      .setColor(color)
      .setTitle(`📈  ${multi.toFixed(2)}x   ${canCashOut ? "🟢" : "🔒"}`)
      .setDescription(
        [
          "```",
          progressBar(multi),
          "```",
          canCashOut
            ? `**降りる → ${fmtEther(currentValue)}** で確定`
            : `⛓ 最低降車 **${MIN_CASHOUT.toFixed(2)}x** まで降りれない`,
          "",
          "*押した瞬間の倍率が適用される。通信の裏で崩壊してたら「遅かった」*",
        ].join("\n"),
      )
      .setFooter({ text: `賭け ${fmtEther(bet).replace(" Ld", "Ld")}` });
  };

  const cashOutRow = (multi: number) => {
    const val = Math.floor(bet * multi);
    const ready = multi >= MIN_CASHOUT;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("crash:out")
        .setLabel(ready ? `💰 降りる (${val.toLocaleString()})` : `🔒 ${MIN_CASHOUT.toFixed(2)}x まで降りれぬ`)
        .setStyle(ready ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!ready),
    );
  };

  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [makeEmbed(1.0)], components: [cashOutRow(1.0)] })) as Message;
  } else {
    await interaction.reply({ embeds: [makeEmbed(1.0)], components: [cashOutRow(1.0)] });
    reply = (await interaction.fetchReply()) as Message;
  }

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === uid && i.customId === "crash:out",
  });
  collector.on("collect", async (btn) => {
    if (cashedOut) return;
    const clickTime = Date.now();
    if (clickTime < MIN_CASHOUT_TIME) {
      await btn.reply({ content: `🔒 まだ ${MIN_CASHOUT.toFixed(2)}x に届いていない。`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (clickTime >= CRASH_TIME) {
      await btn.reply({ content: "💥 遅かった。通信の裏で既に崩壊していた。", flags: MessageFlags.Ephemeral });
      return;
    }
    cashedOut = true;
    cashOutMul = cashOutMultiplier(clickTime - START_TIME, crashPoint);
    collector.stop("cashout");
    await btn.deferUpdate();
  });

  // ── メインループ ──
  let lastEditTime = START_TIME;
  let unlockRendered = false;
  while (true) {
    await sleep(200);
    if (cashedOut) break;
    const now = Date.now();
    if (now >= CRASH_TIME) {
      currentMultiplier = crashPoint;
      break;
    }
    const forceUnlockRender = !unlockRendered && now >= MIN_CASHOUT_TIME;
    if (forceUnlockRender || now - lastEditTime >= UPDATE_INTERVAL_MS) {
      lastEditTime = now;
      // 表示も払戻と同じ上限で止める（画面が 100x を超えるのに払戻が 100x では嘘になる）
      currentMultiplier = Math.min(MAX_MULT_CAP, Math.floor(Math.exp(GROWTH_RATE * (now - START_TIME)) * 100) / 100);
      if (forceUnlockRender) unlockRendered = true;
      try {
        await reply.edit({ embeds: [makeEmbed(currentMultiplier)], components: [cashOutRow(currentMultiplier)] });
      } catch {
        break;
      }
    }
  }
  collector.stop();
  // ── 精算 ──
  let resultPayload: ReturnType<typeof buildSoloResult>;
  if (cashedOut && cashOutMul >= 1.0) {
    const rawPayout = Math.floor(bet * cashOutMul);
    // 連鎖ボーナスは無効化（1.5倍固定戦略 × 高勝率で 100% 超になる裁定を防ぐ・PR#6 レビュー指摘）。
    // 福の重みは維持（低残高帯では 0% なので影響なし・高残高帯ではプレイヤーから JP/救済へ流す）。
    // お守りの消費も賭け・配当と同じグループの中（settleSolo）
    const settled = services.casino.settleSolo(uid, "クラッシュ", bet, rawPayout, { chain: false, operationId: interaction.id, reservationKey });
    recordCasinoGameFinishBestEffort(services, {
      userId: uid,
      game: "クラッシュ",
      operationId: interaction.id,
      wager: bet,
      payout: settled.payout,
      net: settled.net,
      source: playContext.source,
    });
    const amulet = { note: settled.amuletNote };
    const netStr = `+${settled.net.toLocaleString("ja-JP")} Ld`;
    const bigWin = settled.net >= bet * 5;
    const bonusBits: string[] = [];
    if (settled.chainBonus > 0) bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  +${fmtEther(settled.chainBonus)}`);
    if (settled.fukuTax > 0) bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  −${fmtEther(settled.fukuTax)}`);
    if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);

    resultPayload = buildSoloResult({
      services,
      userId: uid,
      game: "クラッシュ",
      net: settled.net,
      wager: bet,
      retryBet: bet,
      titleOverride: bigWin ? "🔥 大勝ち" : "🟢 勝ち",
      colorOverride: bigWin ? 0x16a34a : C_WIN,
      description:
        [
          "```",
          `離脱  ${cashOutMul.toFixed(2)}x   （崩壊 ${crashPoint.toFixed(2)}x）`,
          "```",
        ].join("\n"),
      sections: bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : [],
    });
    await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
    broadcastBigWin(interaction.client, services, { userId: uid, game: "クラッシュ", bet, payout: settled.payout });
  } else {
    const lossSettled = services.casino.settleSolo(uid, "クラッシュ", bet, 0, {
      chain: false,
      operationId: interaction.id, reservationKey,
    });
    recordCasinoGameFinishBestEffort(services, {
      userId: uid,
      game: "クラッシュ",
      operationId: interaction.id,
      wager: bet,
      payout: lossSettled.payout,
      net: lossSettled.net,
      source: playContext.source,
    });
    const lossAmulet = { payout: lossSettled.payout, note: lossSettled.amuletNote };
    const savedByAmulet = lossAmulet.payout > 0;
    const netStr = savedByAmulet ? `±0 Ld` : `−${bet.toLocaleString("ja-JP")} Ld`;

    resultPayload = buildSoloResult({
      services,
      userId: uid,
      game: "クラッシュ",
      net: lossSettled.net,
      wager: bet,
      retryBet: bet,
      titleOverride: savedByAmulet ? "⚪ 引き分け" : "🔴 負け",
      colorOverride: savedByAmulet ? 0x78716c : 0x450a0a,
      description:
        [
          "```",
          `崩壊  ${crashPoint.toFixed(2)}x`,
          "```",
          savedByAmulet ? `✨ ${lossAmulet.note ?? "お守りで返金"}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
    });
    await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
  }

}
