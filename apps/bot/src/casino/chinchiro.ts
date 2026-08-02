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
  CHINCHIRO_HOUSE_EDGE,
  CHINCHIRO_MAX_LOSS_MULT,
  CHINCHIRO_MAX_ROLLS,
  CHINCHIRO_WIN_MULT,
  HOUSE_HOLDER,
  chinchiroCompare,
  chinchiroEvaluate,
  chinchiroIsTerminal,
  chinchiroMaxPayout,
  chinchiroPayout,
  chinchiroRoll,
  type ChinchiroDice as Dice,
  type ChinchiroHand as Hand,
  type CasinoRng,
} from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import {
  MIN_BET,
  acquireSeat,
  effectiveMaxBet,
  handleRetryPress,
  releaseSeat,
  sleep,
  validateBet,
  withHouseReservation,
} from "./common.js";
import { C_MAMMON, C_WIN, C_LOSE } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";

/**
 * 🎲 チンチロ（対マモン・casino-bot 準拠の忠実移植）。
 *
 * **数値モデルは `packages/core/src/casino/chinchiro-model.ts` が単一の真実源**（PR4）。
 * 役判定・順位・勝ち倍率・負け倍率・払戻計算はすべてそこから読む。ここには演出と進行だけ置く。
 *
 * - 最大3投。終了役（ピンゾロ/ゾロ目/シゴロ/ヒフミ）即確定。メナシ自動再振り。目は選択
 * - 勝ち倍率: ピンゾロ5 / ゾロ目3 / シゴロ2 / 目1（変更なし）
 * - **負けは最大2倍**（PR4・正本 §1.5）。旧実装はマモンのピンゾロで 5倍払いだった
 * - 同点はマモン勝ち（-1倍）。勝ち利益のエッジは 5% → 15%（負け上限2化で上振れした RTP を戻す）
 * - 倍付け負けは追加徴収。残高不足なら通常負けにフォールバック
 *   （**この事前預託化とフォールバック削除は PR11**。PR4 では倍率だけを直す）
 * - シェイクアニメ 4フレーム、マモンのターンでも同じ演出
 * - 結果画面に「最低/前回/最大/配当表/退席」ボタン
 */
const MAX_ROLLS = CHINCHIRO_MAX_ROLLS;
const ROLL_BUTTON_TIMEOUT_MS = 30_000;
const DIE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;
/** テーブルリミット判定用の最大払戻倍率。core のモデルから逆算する（写さない） */
const MAX_MULT = chinchiroMaxPayout(1_000_000) / 1_000_000;

const rollDice = chinchiroRoll;
const evaluate = chinchiroEvaluate;
const compare = chinchiroCompare;

function describe(h: Hand): string {
  switch (h.type) {
    case "pinzoro": return `🌟 **ピンゾロ**！1-1-1（${CHINCHIRO_WIN_MULT.pinzoro}倍）`;
    case "zorome": return `🎯 **ゾロ目**！${h.value}-${h.value}-${h.value}（${CHINCHIRO_WIN_MULT.zorome}倍）`;
    case "shigoro": return `🔥 **シゴロ**！4-5-6（${CHINCHIRO_WIN_MULT.shigoro}倍）`;
    case "hifumi": return `💀 **ヒフミ**…1-2-3（${CHINCHIRO_MAX_LOSS_MULT}倍払い）`;
    case "me": return `🎲 **目** スコア **${h.score}**`;
    case "menashi": return "🌀 **メナシ**（役なし）";
  }
}

/**
 * 1ラウンドの確定結果。`result_json` に保存され、同じ操作の再試行はここから再生される。
 * 分岐（勝ち／引分／通常負け／倍付け負け／残高不足フォールバック）も保存対象。
 */
export interface ChinchiroRound {
  branch: "win" | "push" | "loss" | "double_loss" | "fallback_loss";
  settled: import("@meigokujo/core").SoloRoundResult;
  amuletNote: string | null;
  /** 倍付け負けの追加徴収額（それ以外は 0） */
  extra: number;
}

/**
 * 1ラウンドの精算。勝ち・引分・通常負け・倍付け負け・残高不足フォールバックを
 * **すべて同じグループ**で処理する。
 *
 * 分岐ごとに別の鍵を使うと、倍付け負けの後の再試行が通常負け側へ回り、
 * 別グループでもう一度徴収できてしまう。残高判定もグループの中に置いて、
 * 最初に確定した分岐と結果を `result_json` から再生する。
 *
 * @param mul 勝敗倍率（>0 勝ち / 0 引分 / -1 通常負け / ≤-2 倍付け負け）
 */
export function settleChinchiroRound(
  services: Services,
  uid: string,
  bet: number,
  mul: number,
  operationId: string,
  /** 胴元債務予約の鍵（PR5）。精算が通った時点で同じトランザクション内で解放される */
  reservationKey?: string,
): ChinchiroRound {
  return services.ether.runGroup(
    { groupKey: `chinchiro:round:${uid}:${operationId}`, kind: "solo_game", actorId: uid },
    (): ChinchiroRound => {
      const held = services.ether.balanceOf(uid);
      if (mul > 0) {
        // 勝ち: profit = bet * mul * (1 - edge)、payout = bet + profit
        const rawPayout = chinchiroPayout(bet, mul);
        const settled = services.casino.settleSolo(uid, "チンチロ", bet, rawPayout, { operationId, reservationKey });
        return { branch: "win", settled, amuletNote: settled.amuletNote ?? null, extra: 0 };
      }
      if (mul === 0) {
        // プッシュ（両方ヒフミ）: 返金
        const settled = services.casino.settleSolo(uid, "チンチロ", bet, bet, { operationId, reservationKey });
        return { branch: "push", settled, amuletNote: settled.amuletNote ?? null, extra: 0 };
      }
      const extraNeeded = mul <= -2 ? (Math.abs(mul) - 1) * bet : 0;
      // 倍付け負けは追加徴収まで払えるときだけ。払えなければ通常負けへフォールバック
      const doubleLoss = extraNeeded > 0 && held >= bet + extraNeeded;
      const settled = services.casino.settleSolo(uid, "チンチロ", bet, 0, { operationId, reservationKey });
      if (doubleLoss) {
        services.ether.transfer(uid, HOUSE_HOLDER, extraNeeded, { reason: "倍付け負けの追加徴収", game: "チンチロ" });
        return { branch: "double_loss", settled, amuletNote: settled.amuletNote ?? null, extra: extraNeeded };
      }
      return {
        branch: extraNeeded > 0 ? "fallback_loss" : "loss",
        settled,
        amuletNote: settled.amuletNote ?? null,
        extra: 0,
      };
    },
  );
}

const isTerminal = chinchiroIsTerminal;
/** 壺の中に転がる三賽を等幅で並べる（原作準拠の見せ方より視認性重視） */
const diceDisplay = (d: Dice) => `╭─────╮  ╭─────╮  ╭─────╮\n│  ${DIE_FACES[d[0]]}  │  │  ${DIE_FACES[d[1]]}  │  │  ${DIE_FACES[d[2]]}  │\n╰─────╯  ╰─────╯  ╰─────╯`;

function paytableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📖 チンチロ — ルール")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**勝ったときの倍率（対マモン）**",
        `・🌟 ピンゾロ 1-1-1 → **${CHINCHIRO_WIN_MULT.pinzoro}倍**`,
        `・🎯 ゾロ目 → **${CHINCHIRO_WIN_MULT.zorome}倍**`,
        `・🔥 シゴロ 4-5-6 → **${CHINCHIRO_WIN_MULT.shigoro}倍**`,
        `・🎲 目（一組ペア）→ **${CHINCHIRO_WIN_MULT.plain}倍**`,
        "・🌀 メナシ → 目より弱い（自動再振り）",
        `・💀 ヒフミ 1-2-3 → **出した側が${CHINCHIRO_MAX_LOSS_MULT}倍払う**（自爆役）`,
        "",
        "**負けたときの支払い**",
        `・どんな役に負けても **最大 ${CHINCHIRO_MAX_LOSS_MULT}倍**（賭け ${(1000).toLocaleString()} なら最大 ${(1000 * CHINCHIRO_MAX_LOSS_MULT).toLocaleString()} まで）`,
        "・目・メナシに負け／同点は **1倍**（賭け額だけ）",
        "",
        "**振りルール**",
        `・最大${MAX_ROLLS}投。終了役（ピンゾロ/ゾロ目/シゴロ/ヒフミ）で即確定`,
        "・目が出たら「止める/もう一度」を選択",
        `・メナシは自動で振り直し（${MAX_ROLLS}投目でメナシなら確定）`,
        "",
        `**同点はマモン勝ち**（-1倍）。勝ち利益にエッジ${(CHINCHIRO_HOUSE_EDGE * 100).toFixed(0)}%`,
      ].join("\n"),
    );
}

async function shakeAnimation(reply: Message, header: string[], bet: number, rollNo: number, remaining: number, rng: CasinoRng): Promise<void> {
  for (let f = 0; f < 4; f++) {
    const shake: Dice = [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)] as const;
    const e = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · チンチロ" })
      .setColor(C_MAMMON)
      .setTitle(`🎲  壺を振る……  ${"・".repeat(f + 1)}`)
      .setDescription(
        [
          ...header,
          "```",
          diceDisplay(shake),
          "```",
        ].join("\n"),
      )
      .setFooter({ text: `第${rollNo}投 · 残り${remaining} · 賭け ${fmtEther(bet).replace(" ◈", "◈")}` });
    await reply.edit({ embeds: [e], components: [] }).catch(() => undefined);
    await sleep(220);
  }
}

export async function playChinchiro(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
): Promise<void> {
  const uid = interaction.user.id;
  const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "チンチロ");
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

/**
 * 1回ぶんの入口。**先に最悪ケースの債務を予約**してから本体へ入る（PR5・正本 §11.2）。
 * 予約が取れなければ本体を一度も呼ばず、押せる金額を提示して戻る（金は1 Ld も動かない）。
 */
async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
): Promise<void> {
  await withHouseReservation(interaction, services, "チンチロ", bet, interaction.id, (reservationKey) =>
    runRoundInner(interaction, services, bet, reservationKey),
  );
}

async function runRoundInner(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  reservationKey: string,
): Promise<void> {
  const uid = interaction.user.id;
  const startEmbed = new EmbedBuilder()
    .setTitle("🎲 チンチロ")
    .setColor(C_MAMMON)
    .setDescription(
      ["さあ、振れ。", "", "┃ ❓ ┃ ❓ ❓ ❓ ┃", "", `ベット: ${fmtEther(bet)} ／ 最大3投`].join("\n"),
    );
  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [startEmbed] })) as Message;
  } else {
    await interaction.reply({ embeds: [startEmbed] });
    reply = (await interaction.fetchReply()) as Message;
  }
  await sleep(700);

  // ── プレイヤーの振り ──
  let playerDice: Dice = [1, 1, 1] as const;
  let playerHand: Hand = { type: "menashi" };
  let playerLocked = false;
  // 二度振りの権: 装備してればプレイヤーの投数を +1
  const rerollGranted = services.items.consumeReroll(uid);
  const playerMaxRolls = MAX_ROLLS + (rerollGranted ? 1 : 0);

  for (let rollNo = 1; rollNo <= playerMaxRolls && !playerLocked; rollNo++) {
    const remaining = playerMaxRolls - rollNo + 1;
    await shakeAnimation(reply, [], bet, rollNo, remaining, services.rng);
    playerDice = rollDice(services.rng);
    playerHand = evaluate(playerDice);

    if (isTerminal(playerHand)) {
      // 終了役 → 即確定
      break;
    }

    if (playerHand.type === "menashi") {
      if (rollNo < playerMaxRolls) {
        // 自動再振り
        await reply
          .edit({
            embeds: [
              new EmbedBuilder()
                .setTitle("🎲 チンチロ")
                .setColor(C_MAMMON)
                .setDescription([describe(playerHand), "", diceDisplay(playerDice), "", `第${rollNo}投 → 自動で再振り…（残り${playerMaxRolls - rollNo}）`].join("\n")),
            ],
            components: [],
          })
          .catch(() => undefined);
        await sleep(1500);
        continue;
      }
      break; // 最終投メナシ → 確定
    }

    // 目 → 選択
    if (playerHand.type === "me") {
      if (rollNo >= playerMaxRolls) break;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("chinchiro:stop")
          .setLabel(`✋ 止める（${playerHand.score}）`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("chinchiro:reroll")
          .setLabel(`🎲 もう一度振る（残り${playerMaxRolls - rollNo}）`)
          .setStyle(ButtonStyle.Danger),
      );
      const e = new EmbedBuilder()
        .setTitle("🎲 チンチロ")
        .setColor(C_MAMMON)
        .setDescription(
          [
            describe(playerHand),
            "",
            diceDisplay(playerDice),
            "",
            `**止めるか、もう一度振るか…**（残り ${playerMaxRolls - rollNo}回）`,
            rerollGranted ? "✨ 二度振りの権が効いている（+1投）" : "",
            "・**止める** → 今の目で決着",
            "・**もう一度振る** → 上書き。ヒフミやメナシ続きのリスクあり",
          ].filter(Boolean).join("\n"),
        );
      await reply.edit({ embeds: [e], components: [row] }).catch(() => undefined);

      const choice = await new Promise<"stop" | "reroll">((resolve) => {
        const collector = reply.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: ROLL_BUTTON_TIMEOUT_MS,
          filter: (i) => i.user.id === uid && i.customId.startsWith("chinchiro:"),
        });
        collector.on("collect", async (btn) => {
          await btn.deferUpdate();
          if (btn.customId === "chinchiro:stop") {
            collector.stop("stop");
            resolve("stop");
          } else {
            collector.stop("reroll");
            resolve("reroll");
          }
        });
        collector.on("end", (_c, reason) => {
          if (reason !== "stop" && reason !== "reroll") resolve("stop"); // 時間切れは保守的に止める
        });
      });
      if (choice === "stop") {
        playerLocked = true;
        break;
      }
    }
  }

  // ── マモンの振り（同じシェイクアニメ） ──
  await reply
    .edit({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎲 チンチロ — マモンの番")
          .setColor(C_MAMMON)
          .setDescription(
            [
              `あなた: ${diceDisplay(playerDice)}`,
              `　└ ${describe(playerHand)}`,
              "",
              "マモン: ┃ ❓ ┃ ❓ ❓ ❓ ┃",
            ].join("\n"),
          ),
      ],
      components: [],
    })
    .catch(() => undefined);
  await sleep(1200);

  let dealerDice: Dice = [1, 1, 1] as const;
  let dealerHand: Hand = { type: "menashi" };
  for (let rollNo = 1; rollNo <= MAX_ROLLS; rollNo++) {
    for (let f = 0; f < 4; f++) {
      const shake: Dice = [services.rng.int(1, 6), services.rng.int(1, 6), services.rng.int(1, 6)] as const;
      const e = new EmbedBuilder()
        .setTitle("🎲 チンチロ — マモンの番")
        .setColor(C_MAMMON)
        .setDescription(
          [
            `あなた: ${diceDisplay(playerDice)}`,
            `　└ ${describe(playerHand)}`,
            "",
            `マモン: ${diceDisplay(shake)}`,
            `第${rollNo}投（残り${MAX_ROLLS - rollNo + 1}）`,
          ].join("\n"),
        );
      await reply.edit({ embeds: [e], components: [] }).catch(() => undefined);
      await sleep(220);
    }
    dealerDice = rollDice(services.rng);
    dealerHand = evaluate(dealerDice);
    const willStop = isTerminal(dealerHand) || (dealerHand.type === "me" && dealerHand.score >= 5) || rollNo >= MAX_ROLLS;
    await reply
      .edit({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎲 チンチロ — マモンの番")
            .setColor(C_MAMMON)
            .setDescription(
              [
                `あなた: ${diceDisplay(playerDice)}`,
                `　└ ${describe(playerHand)}`,
                "",
                `マモン: ${diceDisplay(dealerDice)}`,
                `　└ ${describe(dealerHand)}`,
              ].join("\n"),
            ),
        ],
        components: [],
      })
      .catch(() => undefined);
    await sleep(willStop ? 1400 : 1000);
    if (willStop) break;
  }

  // ── 精算 ──
  const cmp = compare(playerHand, dealerHand);
  const mul = cmp.mul;
  const round = settleChinchiroRound(services, uid, bet, mul, interaction.id, reservationKey);

  let payoutText = "";
  const title = "🎲 チンチロ — 対 マモン";
  let color = C_LOSE;
  let extraNote = "";
  let netForDisplay = 0;
  const amuletNote = round.amuletNote ? `✨ ${round.amuletNote}` : "";
  const settled = round.settled;

  if (round.branch === "win") {
    color = C_WIN;
    netForDisplay = settled.net;
    const chainLine = settled.chainBonus > 0
      ? `\n${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
    const fukuLine = settled.fukuTax > 0
      ? `\n⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納`
      : "";
    payoutText = `💰 配当 ${fmtEther(settled.payout)}（利益 +${fmtEther(settled.net)}）${chainLine}${fukuLine}`;
    broadcastBigWin(interaction.client, services, { userId: uid, game: "チンチロ", bet, payout: settled.payout });
  } else if (round.branch === "push") {
    color = C_MAMMON;
    payoutText = `🌀 プッシュ：${fmtEther(bet)} を返金`;
  } else if (round.branch === "double_loss") {
    const totalLoss = bet + round.extra;
    netForDisplay = -totalLoss;
    payoutText = `💀 -${fmtEther(totalLoss)}（${Math.abs(mul)}倍負け）`;
  } else if (round.branch === "fallback_loss") {
    netForDisplay = -bet;
    payoutText = `💸 -${fmtEther(bet)}（残高不足で追加徴収なし）`;
    extraNote = "\n*※本来は倍付け負けだったが、残高不足のため通常負けにフォールバック*";
  } else {
    netForDisplay = settled.payout - bet;
    payoutText = settled.payout > 0 ? `🛡 返金 ${fmtEther(settled.payout)}` : `💸 -${fmtEther(bet)}`;
  }

  const resultLabel =
    cmp.result === "player_win" ? "✨ **お前の勝ち！**" : cmp.result === "push" ? "🌀 **プッシュ**" : "😈 **マモンの勝ち**";
  const comparison = [
    "┌─ お前 ────────────┐",
    `│ ${diceDisplay(playerDice)}`,
    `│ ${describe(playerHand)}`,
    "└──────────────────┘",
    "┌─ マモン ──────────┐",
    `│ ${diceDisplay(dealerDice)}`,
    `│ ${describe(dealerHand)}`,
    "└──────────────────┘",
    "",
    resultLabel,
  ].join("\n");

  const resultEmbed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription([comparison, "", payoutText + extraNote, amuletNote].filter(Boolean).join("\n"))
    .setFooter({ text: `所持: ${fmtEther(services.ether.balanceOf(uid))}` });

  const heldAfter = services.ether.balanceOf(uid);
  const min = MIN_BET;
  const max = Math.min(effectiveMaxBet(services, uid, "チンチロ"), heldAfter);
  const nextRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`chinchiro:retry:${min}`)
      .setLabel(`最低 ${min.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(heldAfter < min),
    new ButtonBuilder()
      .setCustomId(`chinchiro:retry:${bet}`)
      .setLabel(`🎰 もう一回 ${bet.toLocaleString()}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(heldAfter < bet),
    new ButtonBuilder()
      .setCustomId(`chinchiro:retry:${max}`)
      .setLabel(`最大 ${max.toLocaleString()}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(max < min),
    new ButtonBuilder().setCustomId("chinchiro:paytable").setLabel("📖 配当表").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("chinchiro:quit").setLabel("🚪 退席").setStyle(ButtonStyle.Secondary),
  );

  await reply.edit({ embeds: [resultEmbed], components: [nextRow] }).catch(() => undefined);

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
    filter: (i) => i.user.id === uid,
  });
  collector.on("collect", async (btn) => {
    if (btn.customId === "chinchiro:paytable") {
      await btn.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }
    if (btn.customId === "chinchiro:quit") {
      collector.stop("quit");
      await btn.deferUpdate();
      await reply.edit({ components: [] }).catch(() => undefined);
      return;
    }
    if (btn.customId.startsWith("chinchiro:retry:")) {
      // 受付・collector停止・座席の取り直しは共通処理へ（PR3）。
      // 断るなら collector を止めない ＝ 押し直せる
      await handleRetryPress({
        services,
        btn,
        collector,
        game: "チンチロ",
        betRaw: Number(btn.customId.split(":")[2]),
        run: (bet) => runRound(btn, services, bet),
      });
    }
  });
  collector.on("end", async (_c, reason) => {
    if (reason !== "retry" && reason !== "quit") await reply.edit({ components: [] }).catch(() => undefined);
  });
}
