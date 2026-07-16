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
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, acquireSeat, applyAmulets, releaseSeat, sleep, validateBet } from "./common.js";
import { C_MAMMON, C_WIN } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 📈 クラッシュ。casino-bot 準拠の忠実移植。
 * - 崩壊点は事前決定: E[payout] = 1 - houseEdge を満たす逆CDF
 * - 実時間で滑らかに指数成長: M = exp(0.00015 * ms)
 * - 最低降車ライン 1.5x（それ以下は降りられない = 各ラウンドで真の敗北リスク）
 * - 押した瞬間の**実時間**で倍率を再計算。CRASH_TIME 超なら「遅かった」
 * - 結果画面に「最低/前回/最大/配当表/退席」ボタン
 */
const HOUSE_EDGE = 0.04;
const GROWTH_RATE = 0.00015; // per ms
const MIN_CASHOUT = 1.5;
const MAX_MULT_CAP = 100; // テーブルリミット判定に使う（実際の崩壊はもっと低い）
const UPDATE_INTERVAL_MS = 1500;

function generateCrashPoint(): number {
  const e = 1 - HOUSE_EDGE;
  const r = Math.random();
  if (r < 0.01) return 1.0; // 1% は即崩壊
  const crash = e / (1 - r);
  return Math.max(1.0, Math.round(crash * 100) / 100);
}

function progressBar(mult: number): string {
  const steps = 15;
  const progress = Math.min(1, Math.log10(mult) / 1.5);
  const filled = Math.floor(progress * steps);
  return "▰".repeat(filled) + "😈" + "・".repeat(Math.max(0, steps - filled));
}

function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 クラッシュ — ルール")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**遊び方**",
        "・倍率がじわじわ上昇。**崩壊する前に「降りる」** を押した瞬間の倍率で払戻し",
        `・最低降車ラインは **${MIN_CASHOUT.toFixed(2)}x**。それ未満では降りられない`,
        `・崩壊点は分布的にランダム（1%は即崩壊）。数学的 RTP は **${((1 - HOUSE_EDGE) * 100).toFixed(0)}%**`,
        "",
        "**⚡ 遅かった**",
        "　押した瞬間の実時間が崩壊時刻を超えていたら、通信の裏で墜ちている",
        "",
        "**⚖️ 福の重み / 🔥 連鎖チェーン**",
        "　勝ちで発動（残高が多いほど奉納・連勝で倍率）",
      ].join("\n"),
    );
}

export async function playCrash(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, betRaw * MAX_MULT_CAP);
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
  const crashPoint = generateCrashPoint();

  const START_TIME = Date.now();
  const t_crash_ms = Math.log(crashPoint) / GROWTH_RATE;
  const CRASH_TIME = START_TIME + t_crash_ms;
  const MIN_CASHOUT_TIME = START_TIME + Math.log(MIN_CASHOUT) / GROWTH_RATE;

  let currentMultiplier = 1.0;
  let cashedOut = false;
  let cashOutMultiplier = 0;

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
      .setFooter({ text: `賭け ${fmtEther(bet).replace(" ◈", "◈")}` });
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
    const rawMul = Math.exp(GROWTH_RATE * (clickTime - START_TIME));
    const cappedMul = Math.min(rawMul, crashPoint);
    cashOutMultiplier = Math.max(1.0, Math.floor(cappedMul * 100) / 100);
    if (!Number.isFinite(cashOutMultiplier)) cashOutMultiplier = 1.0;
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
      currentMultiplier = Math.floor(Math.exp(GROWTH_RATE * (now - START_TIME)) * 100) / 100;
      if (forceUnlockRender) unlockRendered = true;
      try {
        await reply.edit({ embeds: [makeEmbed(currentMultiplier)], components: [cashOutRow(currentMultiplier)] });
      } catch {
        break;
      }
    }
  }
  collector.stop();

  const buildRetryRow = () => {
    const held = services.ether.balanceOf(uid);
    const min = MIN_BET;
    const max = Math.min(MAX_BET, held);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash:retry:${min}`)
        .setLabel(`最低 ${min.toLocaleString()}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(held < min),
      new ButtonBuilder()
        .setCustomId(`crash:retry:${bet}`)
        .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(held < bet),
      new ButtonBuilder()
        .setCustomId(`crash:retry:${max}`)
        .setLabel(`最大 ${max.toLocaleString()}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(max < min),
      new ButtonBuilder().setCustomId("crash:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("crash:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
    );
  };

  // ── 精算 ──
  if (cashedOut && cashOutMultiplier >= 1.0) {
    const rawPayout = Math.floor(bet * cashOutMultiplier);
    const amulet = applyAmulets(services, uid, bet, rawPayout);
    const settled = services.casino.settle(uid, "クラッシュ", bet, amulet.payout);
    const netStr = `+${settled.net.toLocaleString("ja-JP")} ◈`;
    const bigWin = settled.net >= bet * 5;
    const bonusBits: string[] = [];
    if (settled.chainBonus > 0) bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  +${fmtEther(settled.chainBonus)}`);
    if (settled.fukuTax > 0) bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  −${fmtEther(settled.fukuTax)}`);
    if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);

    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · クラッシュ" })
      .setColor(bigWin ? 0x16a34a : C_WIN)
      .setTitle(`${bigWin ? "🔥 大勝ち" : "🪂 離脱成功"}  **${netStr}**`)
      .setDescription(
        [
          "```",
          `離脱  ${cashOutMultiplier.toFixed(2)}x   （崩壊 ${crashPoint.toFixed(2)}x）`,
          "```",
        ].join("\n"),
      )
      .addFields(...(bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : []))
      .setFooter({
        text: [`所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}`, `賭け ${fmtEther(bet).replace(" ◈", "◈")}`].join(" · "),
      });
    await reply.edit({ embeds: [embed], components: [buildRetryRow()] }).catch(() => undefined);
    broadcastBigWin(interaction.client, services, { userId: uid, game: "クラッシュ", bet, payout: settled.payout });
  } else {
    const lossAmulet = applyAmulets(services, uid, bet, 0);
    services.casino.settle(uid, "クラッシュ", bet, lossAmulet.payout);
    const savedByAmulet = lossAmulet.payout > 0;
    const netStr = savedByAmulet ? `±0 ◈` : `−${bet.toLocaleString("ja-JP")} ◈`;

    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · クラッシュ" })
      .setColor(savedByAmulet ? 0x78716c : 0x450a0a)
      .setTitle(`${savedByAmulet ? "🛡 敗北無効" : "💥 崩壊"}  **${netStr}**`)
      .setDescription(
        [
          "```",
          `崩壊  ${crashPoint.toFixed(2)}x`,
          "```",
          savedByAmulet ? `✨ ${lossAmulet.note ?? "お守りで返金"}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setFooter({
        text: [`所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}`, `賭け ${fmtEther(bet).replace(" ◈", "◈")}`].join(" · "),
      });
    await reply.edit({ embeds: [embed], components: [buildRetryRow()] }).catch(() => undefined);
  }

  // ── リトライ/配当表/退席 コレクタ ──
  const retryCollector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  retryCollector.on("collect", async (btn) => {
    if (btn.customId === "crash:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId === "crash:quit") {
      retryCollector.stop("quit");
      await btn.deferUpdate();
      await reply.edit({ components: [] }).catch(() => undefined);
      return;
    }
    if (btn.customId.startsWith("crash:retry:")) {
      retryCollector.stop("retry");
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
  retryCollector.on("end", async (_c, reason) => {
    if (reason !== "retry" && reason !== "quit") await reply.edit({ components: [] }).catch(() => undefined);
  });
}
