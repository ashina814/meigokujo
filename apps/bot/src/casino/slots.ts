import { randomUUID } from "node:crypto";
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
  SLOT_SYMBOLS as SYMBOLS,
  TRIPLE_PAYOUTS,
  DOUBLE_PAYOUTS,
  SLOTS_JP_CONTRIBUTION as JP_CONTRIBUTION,
  SLOTS_JP_WIN_SHARE as JP_WIN_SHARE,
  SLOTS_SCATTER_TRIGGER_COUNT as SCATTER_TRIGGER_COUNT,
  slotsSpinReel as spinReel,
  slotsEvaluate as evaluate,
  type SlotSymbol,
} from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MIN_BET, SEAT_BUSY_REASON, acquireSeat, checkRetry, effectiveMaxBet, releaseSeat, sleep, validateBet } from "./common.js";
import { C_MAMMON } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🎰 スロット。casino-bot 準拠。数値モデルは core/casino/slots-model へ委譲。
 * - 3リール、シンボルは冥獄城テーマ
 * - リール1→2→3 と順に止まる演出（サイクル絵柄でぐるぐる感）
 * - 1+2 リールが同じ絵柄で止まったら「あと一つで…」ニアミス煽り
 * - JP は純😈³のみ。積立=賭金1%、当選でプール半分獲得
 * - 魂片✨3つでフリースピン1回（自動再スピン・賭金不要）
 * - 結果画面に「最低/前回/最大」の3ボタン + 📖配当表ボタン
 *
 * RTP 計算・回帰テストは packages/core/tests/casino-slots-rtp.test.ts を見る。
 */

const MAX_MULTIPLIER = 100; // マモン³=100倍。テーブルリミット判定用

const CYCLE = ["🦇", "👻", "🔥", "⚔️", "👑", "😈", "🌙", "✨"] as const;
const cycleAt = (n: number) => CYCLE[n % CYCLE.length]!;

const isScatter = (s: SlotSymbol) => s.kind === "scatter";

function paytableEmbed(): EmbedBuilder {
  const tripleLines = Object.entries(TRIPLE_PAYOUTS)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      const label = name === "マモン" ? `${sym.emoji} ${name} (純3つでJP)` : `${sym.emoji} ${name}`;
      return `　${label}: **${mul}倍**`;
    })
    .join("\n");
  const doubleLines = Object.entries(DOUBLE_PAYOUTS)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      return `　${sym.emoji} ${name}: **${mul}倍**`;
    })
    .join("\n");
  return new EmbedBuilder()
    .setTitle("📖 スロット — 配当表")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**🎯 3つ揃い** (3リール同じ絵柄)",
        tripleLines,
        "",
        "**🎯 2つ揃い** (2リール同じ絵柄・ワイルド代用不可)",
        doubleLines,
        "",
        "**🌙 月（ワイルド）**",
        "　他の絵柄を補って3つ揃いを成立させる（マモン純3はJP扱いだがワイルド代用は通常配当）",
        "",
        "**✨ 魂片（スキャッター）**",
        `　位置不問で${SCATTER_TRIGGER_COUNT}つ出現 → **賭金不要でもう1回スピン**`,
        "",
        "**🏆 ジャックポット**",
        `　純3つの 😈 マモン で発動`,
        `　 → 通常配当 + JPプールの **${JP_WIN_SHARE * 100}%** を獲得`,
        `　 (プールは賭金の ${JP_CONTRIBUTION * 100}% を毎回積立)`,
        "",
        "**⚖️ 福の重み**",
        "　残高が多いほど勝ち利益から累進奉納（0/5/10/20/30%）。半分は JP・半分は救済プールへ",
        "**🔥 連鎖**",
        "　2連勝目から倍率が乗る（最大 ×2.0）。連敗でリセット",
      ].join("\n"),
    );
}

/**
 * リール表示（枠線で囲む・二重枠で目立たせる）
 * ╔═══╦═══╦═══╗
 * ║ 🦇 ║ 👻 ║ 🔥 ║
 * ╚═══╩═══╩═══╝
 */
const face = (a: string, b: string, c: string) =>
  ["╔═════╦═════╦═════╗", `║  ${a}  ║  ${b}  ║  ${c}  ║`, "╚═════╩═════╩═════╝"].join("\n");

function buildSpinEmbed(
  services: Services,
  bet: number,
  isFreeSpin: boolean,
  label: string,
  slots: [string, string, string],
): EmbedBuilder {
  const jp = services.casino.jackpotPool();
  const jpHigh = jp >= 100_000;
  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · スロット${isFreeSpin ? " · フリースピン" : ""}` })
    .setColor(jpHigh ? 0xf0b429 : C_MAMMON)
    .setTitle(`🎰  ${label}`)
    .setDescription(face(slots[0], slots[1], slots[2]))
    .setFooter({
      text: [
        isFreeSpin ? "ベット: 無料" : `ベット ${fmtEther(bet).replace(" ◈", "◈")}`,
        `JP ${fmtEther(jp).replace(" ◈", "◈")}${jpHigh ? " 🔥" : ""}`,
      ].join(" · "),
    });
}

function retryButtons(uid: string, bet: number, services: Services): ActionRowBuilder<ButtonBuilder> {
  const held = services.ether.balanceOf(uid);
  const min = MIN_BET;
  const max = Math.min(effectiveMaxBet(services, uid), held);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`slots:retry:${min}`)
      .setLabel(`最低 ${min.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(held < min),
    new ButtonBuilder()
      .setCustomId(`slots:retry:${bet}`)
      .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(held < bet),
    new ButtonBuilder()
      .setCustomId(`slots:retry:${max}`)
      .setLabel(`最大 ${max.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(max < min),
    new ButtonBuilder().setCustomId("slots:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
  );
}

export async function playSlots(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, betRaw * MAX_MULTIPLIER);
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
    await runOne(interaction, services, check.bet, 0);
  } finally {
    releaseSeat(uid);
  }
}

/**
 * 1スピンぶんの確定結果。**すべて `result_json` に保存できる形**にしてある。
 * 同じスピンをもう一度実行しても、表示（リール・役・フリースピン獲得）と
 * 資金結果（配当・JP・お守り）が保存済みの値からそのまま再生される。
 */
export interface SpinRecord {
  /** リールの絵柄名（SLOT_SYMBOLS から引き直す） */
  reels: [string, string, string];
  kind: import("@meigokujo/core").SlotSpinKind;
  matched: string | null;
  freeSpin: boolean;
  /** お守り適用前の払戻 */
  rawPayout: number;
  /** お守り適用後の払戻（実際に動いた額） */
  payout: number;
  amuletNote: string | null;
  settled: import("@meigokujo/core").SoloRoundResult | null;
  jpWon: number;
  /**
   * フリースピンの配当のうち、胴元の資金が尽きていて**払えなかった**額（PR3）。
   *
   * 以前は `canAccept` が false のとき transfer を黙って飛ばしていたので、
   * 結果画面には配当が出ているのに残高が増えない状態になっていた。
   * いまは払えないなら `payout` を 0 にし、この額と理由を利用者と監査へ出す。
   */
  unpaid: number;
}

const symbolByName = (name: string): SlotSymbol => SYMBOLS.find((s) => s.name === name) ?? SYMBOLS[0]!;

/**
 * 1スピンぶんの資金処理（抽選・お守り・賭け・配当・JP積立・JP当選）を**ひとつの業務グループ**で行う。
 * 分かれていると、精算だけ通ってJP当選が落ちる／お守りだけ消える中途半端な状態が残る。
 *
 * @param spinNo 0 = 賭け金を払う通常スピン / 1以上 = その interaction 内の n 回目のフリースピン。
 *   フリースピンは同じ interaction で再帰するので、**1スピンごとに別の安定した鍵**が要る。
 *   同じ鍵を使い回すと、フリースピンが通常スピンの保存結果を再生してしまい、
 *   無料スピンの配当が加算されない。
 */
export function spinOnce(services: Services, uid: string, bet: number, interactionId: string, spinNo: number): SpinRecord {
  const rng = services.rng;
  const isFreeSpin = spinNo > 0;
  const spinTag = isFreeSpin ? `free:${spinNo}` : "paid";
  return services.ether.runGroup(
    { groupKey: `slots:spin:${uid}:${interactionId}:${spinTag}`, kind: "solo_game", actorId: uid },
    (): SpinRecord => {
      const reelsRaw: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
      const spin = evaluate(reelsRaw, bet);
      const jpCut = isFreeSpin ? 0 : Math.max(1, Math.floor(bet * JP_CONTRIBUTION));
      let settledInGroup: import("@meigokujo/core").SoloRoundResult | null = null;
      let payout = spin.payout;
      let amuletNote: string | null = null;
      let unpaid = 0;
      if (isFreeSpin) {
        // フリースピンは配当のみ（賭けなし）。settle は使わず胴元→プレイヤーの直接転送。
        // お守りの消費もこのグループの中で行う（外で消すと落ちたときお守りだけ消える）
        const amulet = services.casino.consumeAmulets(uid, bet, spin.payout);
        amuletNote = amulet.note ?? null;
        const wanted = amulet.payout;
        if (wanted > 0 && !services.casino.canAccept(wanted)) {
          // 胴元が払えない。部分払いはしない（見えない規則を作らない）。
          // 払えなかったことを結果画面と監査の両方に出す（正本 §16.4「自動補填しない」）
          payout = 0;
          unpaid = wanted;
          services.events.log("casino_house_insufficient", {
            actor: uid,
            payload: { game: "スロット", kind: "free_spin", wanted, houseBalance: services.casino.houseBalance() },
          });
        } else {
          payout = wanted;
          if (payout > 0) {
            services.ether.transfer("house", uid, payout, { reason: "フリースピンの配当", game: "スロット" });
          }
        }
      } else {
        settledInGroup = services.casino.settleSolo(uid, "スロット", bet, spin.payout, {
          operationId: `${interactionId}:${spinTag}`,
          jackpotCut: jpCut,
        });
        payout = settledInGroup.payout - settledInGroup.chainBonus + settledInGroup.fukuTax;
        amuletNote = settledInGroup.amuletNote ?? null;
      }
      // JP はフリースピンでも当選する（原作準拠）
      const jpWon =
        spin.kind === "jackpot"
          ? services.casino.seizeJackpot(uid, "slots", `${interactionId}:${spinTag}`, JP_WIN_SHARE)
          : 0;
      return {
        reels: [reelsRaw[0].name, reelsRaw[1].name, reelsRaw[2].name],
        kind: spin.kind,
        matched: spin.matched ?? null,
        freeSpin: spin.freeSpin,
        rawPayout: spin.payout,
        payout,
        amuletNote,
        settled: settledInGroup,
        jpWon,
        unpaid,
      };
    },
  );
}

async function runOne(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  spinNo: number,
): Promise<void> {
  const uid = interaction.user.id;
  const isFreeSpin = spinNo > 0;
  const record = spinOnce(services, uid, bet, interaction.id, spinNo);

  const reelsRaw: [SlotSymbol, SlotSymbol, SlotSymbol] = [
    symbolByName(record.reels[0]),
    symbolByName(record.reels[1]),
    symbolByName(record.reels[2]),
  ];
  const spin = { kind: record.kind, matched: record.matched ?? undefined, freeSpin: record.freeSpin };
  const adjustedPayout = record.payout;
  const amulet = { note: record.amuletNote ?? undefined };
  const settled = record.settled;
  const jpWon = record.jpWon;

  // ── Phase 1: スピンアニメ ──
  const initialEmbed = buildSpinEmbed(services, bet, isFreeSpin, "壺の中で運命が転がる……", ["❓", "❓", "❓"]);
  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [initialEmbed] })) as Message;
  } else {
    await interaction.reply({ embeds: [initialEmbed] });
    reply = (await interaction.fetchReply()) as Message;
  }

  const edit = async (embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = []) => {
    try {
      await reply.edit({ embeds: [embed], components });
    } catch {
      /* ignore */
    }
  };

  // リール1: サイクル→確定
  for (let t = 0; t < 3; t++) {
    await sleep(160);
    await edit(buildSpinEmbed(services, bet, isFreeSpin, "ぐるぐる……", [cycleAt(t * 3), cycleAt(t * 3 + 1), cycleAt(t * 3 + 2)]));
  }
  await sleep(160);
  await edit(buildSpinEmbed(services, bet, isFreeSpin, "ふむ……", [reelsRaw[0].emoji, cycleAt(99), cycleAt(98)]));

  // リール2: サイクル→確定
  for (let t = 0; t < 3; t++) {
    await sleep(160);
    await edit(buildSpinEmbed(services, bet, isFreeSpin, "おぉ……", [reelsRaw[0].emoji, cycleAt(t * 5), cycleAt(t * 5 + 1)]));
  }
  await sleep(160);

  // リール1+2 のニアミス煽り
  const isNearMiss =
    !isScatter(reelsRaw[0]) &&
    !isScatter(reelsRaw[1]) &&
    reelsRaw[0].kind === "normal" &&
    reelsRaw[1].kind === "normal" &&
    reelsRaw[0].name === reelsRaw[1].name;
  const teaseLabel = isNearMiss ? `あと一つで **${reelsRaw[0].name}** が揃う……！` : "むむ……";
  await edit(buildSpinEmbed(services, bet, isFreeSpin, teaseLabel, [reelsRaw[0].emoji, reelsRaw[1].emoji, "❓"]));
  await sleep(isNearMiss ? 1900 : 1100);

  // ── Phase 2: 結果 ──
  const payoutLabel = (() => {
    switch (spin.kind) {
      case "jackpot": return `🎉 **JACKPOT！** 純3マモン揃い`;
      case "triple": return `3つ揃い (${spin.matched})`;
      case "wild_triple": return `🌙 ワイルド3つ揃い (${spin.matched})`;
      case "double": return `2つ揃い (${spin.matched})`;
      default: return "";
    }
  })();
  const reelDisplay = face(reelsRaw[0].emoji, reelsRaw[1].emoji, reelsRaw[2].emoji);

  const won = adjustedPayout > 0;
  const totalPayout = adjustedPayout + jpWon + (settled?.chainBonus ?? 0) - (settled?.fukuTax ?? 0);
  const net = totalPayout - (isFreeSpin ? 0 : bet);
  const stats = services.casino.stats(uid);
  const winStreak = won ? stats.current_win_streak : 0;

  // 結果 embed（Fields でセクション化）
  const isJp = spin.kind === "jackpot";
  const bigWin = won && totalPayout >= bet * 5;
  const color = isJp ? 0xf0b429 : bigWin ? 0x16a34a : won ? 0x22c55e : 0x991b1b;

  const tag = isJp ? "💎 JACKPOT!" : bigWin ? "🔥 大勝ち" : won ? "🟢 勝ち" : "🔴 ハズレ";
  const netStr = net === 0 ? "±0 ◈" : `${net > 0 ? "+" : "−"}${Math.abs(net).toLocaleString("ja-JP")} ◈`;

  const bonusBits: string[] = [];
  if (settled && settled.chainBonus > 0) {
    bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  +${fmtEther(settled.chainBonus)}`);
  }
  if (settled && settled.fukuTax > 0) {
    bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  −${fmtEther(settled.fukuTax)}`);
  }
  if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);
  if (jpWon > 0) bonusBits.push(`💎 JP獲得  +${fmtEther(jpWon)}（残 ${fmtEther(services.casino.jackpotPool())}）`);
  // 胴元が払えなかったフリースピン配当は黙って消さない（PR3）
  if (record.unpaid > 0) {
    bonusBits.push(`⚠️ 胴元の資金が尽きており、フリースピンの配当 ${fmtEther(record.unpaid)} を支払えなかった（運営へ記録済み）`);
  }

  const resultEmbed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · スロット${isFreeSpin ? " · フリースピン" : ""}` })
    .setColor(color)
    .setTitle(`${tag}  **${netStr}**`)
    .setDescription(reelDisplay + (payoutLabel ? `\n\n${payoutLabel}` : "") + (spin.freeSpin && !isFreeSpin ? `\n\n✨ **魂片3つ！フリースピン獲得！** ✨` : ""))
    .addFields(
      ...(bonusBits.length > 0
        ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }]
        : []),
    )
    .setFooter({
      text: [
        `所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}`,
        !isFreeSpin ? `賭け ${fmtEther(bet).replace(" ◈", "◈")}` : "無料",
        winStreak >= 2 ? `🔥 ${winStreak}連勝` : "",
        `JP ${fmtEther(services.casino.jackpotPool()).replace(" ◈", "◈")}`,
      ].filter(Boolean).join(" · "),
    });
  // 大勝ち速報
  if (won) {
    broadcastBigWin(interaction.client, services, {
      userId: uid,
      game: "スロット",
      bet: isFreeSpin ? 0 : bet,
      payout: totalPayout,
      isJackpot: spin.kind === "jackpot",
    });
  }

  // フリースピンなら結果表示後に自動で再スピン（原作準拠）
  if (spin.freeSpin && !isFreeSpin) {
    await edit(resultEmbed, []);
    await sleep(2500);
    await runOne(interaction, services, bet, spinNo + 1);
    return;
  }

  await edit(resultEmbed, [retryButtons(uid, bet, services)]);

  // ── 「もう一回」/配当表 コレクタ ──
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "slots:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId.startsWith("slots:retry:")) {
      collector.stop("retry");
      // 断るなら理由を出す。黙って return するとボタンが死んだようにしか見えない（PR3）
      const retry = checkRetry(services, uid, Number(btn.customId.split(":")[2]));
      if (!retry.ok) {
        await btn.reply({ content: `❌ ${retry.reason}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await btn.deferUpdate();
      // acquireSeat のためこの playSlots は releaseSeat 後に呼ぶ必要があるが、
      // 現在の座席は runOne の親（playSlots）が持っている。ここで一旦解放して再取得する。
      releaseSeat(uid);
      if (!acquireSeat(uid)) {
        await btn.followUp({ content: SEAT_BUSY_REASON, flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        await runOne(btn, services, retry.bet, 0);
      } finally {
        releaseSeat(uid);
      }
    }
  });
  collector.on("end", async (_col, reason) => {
    if (reason !== "retry") await edit(resultEmbed, []).catch(() => undefined);
  });
}
