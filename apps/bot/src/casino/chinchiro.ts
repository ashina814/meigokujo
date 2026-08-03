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
  chinchiroCompare,
  chinchiroEvaluate,
  chinchiroIsTerminal,
  chinchiroMaxPayout,
  chinchiroPlayerLoss,
  chinchiroPayout,
  chinchiroRoll,
  escrowHolderFor,
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
 * - ラウンド開始前に最大損失2倍を預託し、結果後の追加徴収・残高不足フォールバックは行わない
 * - 精算は他のソロゲームと同じ共通経路を通し、連鎖・福の重み・お守り・戦績を維持する
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
 * 分岐（勝ち／引分／通常負け／倍付け負け）も保存対象。
 */
export interface ChinchiroRound {
  branch: "win" | "push" | "loss" | "double_loss";
  settled: import("@meigokujo/core").SoloRoundResult;
  amuletNote: string | null;
  /** 倍付け負けの追加損失額（それ以外は 0）。資金は開始前に預託済み。 */
  extra: number;
}

const now = () => Math.floor(Date.now() / 1000);

function trackPrehold(services: Services, sessionId: string, userId: string, bet: number, amount: number): void {
  services.db.prepare(
    `INSERT INTO casino_chinchiro_preholds (session_id,user_id,bet,amount,status,created_at)
     VALUES (?,?,?,?, 'preheld', ?)
     ON CONFLICT(session_id) DO NOTHING`,
  ).run(sessionId, userId, bet, amount, now());
}

function markPrehold(services: Services, sessionId: string, status: "settled" | "refunded" | "frozen", failure?: string): void {
  const ts = now();
  services.db.prepare(
    `UPDATE casino_chinchiro_preholds
       SET status=?, settled_at=CASE WHEN ? IN ('settled','refunded') THEN ? ELSE settled_at END,
           frozen_at=CASE WHEN ?='frozen' THEN ? ELSE frozen_at END, failure=?
     WHERE session_id=?`,
  ).run(status, status, ts, status, ts, failure ?? null, sessionId);
}

/** 返還失敗時は帳簿を残して凍結する。再起動掃除に任せて黙って資金を動かさない。 */
export function refundChinchiroPrehold(services: Services, sessionId: string, reason: string): boolean {
  if (services.escrow.poolOf(sessionId) === 0) return true;
  try {
    services.escrow.refund(sessionId);
    markPrehold(services, sessionId, "refunded");
    services.events.log("casino_chinchiro_prehold_refunded", { actor: "system:chinchiro", payload: { sessionId, reason } });
    return true;
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    markPrehold(services, sessionId, "frozen", failure);
    services.events.log("casino_chinchiro_prehold_frozen", { actor: "system:chinchiro", payload: { sessionId, reason, failure } });
    return false;
  }
}

/** 返金失敗で凍結したものだけは、起動時の孤児返金から除外して帳簿を保持する。 */
export function frozenChinchiroPreholdHolders(services: Pick<Services, "db">): string[] {
  return (services.db.prepare("SELECT session_id FROM casino_chinchiro_preholds WHERE status='frozen'").all() as Array<{ session_id: string }>)
    .map((row) => escrowHolderFor(row.session_id));
}

/** 運営が帳簿を確認してから行う凍結preholdの手動返金。 */
export function recoverFrozenChinchiroPrehold(services: Services, sessionId: string, actorId: string): boolean {
  const row = services.db.prepare("SELECT status FROM casino_chinchiro_preholds WHERE session_id=?").get(sessionId) as { status: string } | undefined;
  if (!row || row.status !== "frozen") throw new Error("凍結中のチンチロ事前預託ではありません");
  const ok = refundChinchiroPrehold(services, sessionId, `手動復旧:${actorId}`);
  if (ok) services.events.log("casino_chinchiro_prehold_manual_recovery", { actor: actorId, payload: { sessionId } });
  return ok;
}

/**
 * 最大損失2倍を預託したラウンドを、他のソロゲームと同じ共通精算基盤で確定する。
 * 徴収元だけを利用者の自由残高からprehold holderへ差し替え、連鎖・福の重み・お守り・
 * 予約解放・戦績更新は `Casino.settleSolo()` に一任する。
 */
export function settleChinchiroRound(
  services: Services,
  uid: string,
  bet: number,
  mul: number,
  operationId: string,
  reservationKey?: string,
): ChinchiroRound {
  const sessionId = `chinchiro:prehold:${uid}:${operationId}`;
  return services.ether.runGroup(
    { groupKey: `chinchiro:round:${uid}:${operationId}`, kind: "solo_game", actorId: uid },
    (): ChinchiroRound => {
      const preheld = bet * CHINCHIRO_MAX_LOSS_MULT;
      const holder = services.escrow.holderId(sessionId);
      if (services.escrow.poolOf(sessionId) !== preheld || services.ether.balanceOf(holder) !== preheld) {
        throw new Error("チンチロ事前預託の帳簿不一致");
      }
      const loss = mul < 0 ? chinchiroPlayerLoss(bet, mul) : 0;
      const charged = loss > 0 ? loss : bet;
      const rawPayout = mul > 0 ? chinchiroPayout(bet, mul) : mul === 0 ? bet : 0;
      const settled = services.casino.settleSolo(uid, "チンチロ", bet, rawPayout, {
        operationId,
        reservationKey,
        preheld: {
          holderId: holder,
          heldAmount: preheld,
          chargedAmount: charged,
          sessionId,
        },
      });
      services.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sessionId);
      markPrehold(services, sessionId, "settled");
      return {
        branch: mul > 0 ? "win" : mul === 0 ? "push" : loss === preheld ? "double_loss" : "loss",
        settled,
        amuletNote: settled.amuletNote ?? null,
        extra: Math.max(0, loss - bet),
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
    await reply.edit({ embeds: [e], components: [] });
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

async function runRound(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
): Promise<void> {
  await withHouseReservation(interaction, services, "チンチロ", bet, interaction.id, async (reservationKey) => {
    const uid = interaction.user.id;
    const preheld = bet * CHINCHIRO_MAX_LOSS_MULT;
    try {
      services.chipFlow.ensureFreeChips(uid, preheld, `${interaction.id}:chinchiro-prehold`);
    } catch {
      const payload = { content: `チンチロは最大 ${fmtEther(preheld)} を事前に預ける必要がある。Land が足りない。`, flags: MessageFlags.Ephemeral as const };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
      return;
    }
    const sessionId = `chinchiro:prehold:${uid}:${interaction.id}`;
    try {
      const held = services.escrow.hold(sessionId, uid, preheld, "チンチロ", interaction.id);
      if (!held) throw new Error("チンチロ事前預託に失敗しました");
      trackPrehold(services, sessionId, uid, bet, preheld);
      await runRoundInner(interaction, services, bet, reservationKey);
    } catch (error) {
      const refunded = refundChinchiroPrehold(services, sessionId, "結果確定前の失敗");
      if (!refunded) {
        throw new Error(`チンチロの事前預託返還に失敗し凍結しました: ${sessionId}`);
      }
      throw error;
    }
  });
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

  let playerDice: Dice = [1, 1, 1] as const;
  let playerHand: Hand = { type: "menashi" };
  let playerLocked = false;
  const rerollGranted = services.items.consumeReroll(uid);
  const playerMaxRolls = MAX_ROLLS + (rerollGranted ? 1 : 0);

  for (let rollNo = 1; rollNo <= playerMaxRolls && !playerLocked; rollNo++) {
    const remaining = playerMaxRolls - rollNo + 1;
    await shakeAnimation(reply, [], bet, rollNo, remaining, services.rng);
    playerDice = rollDice(services.rng);
    playerHand = evaluate(playerDice);

    if (isTerminal(playerHand)) break;

    if (playerHand.type === "menashi") {
      if (rollNo < playerMaxRolls) {
        await reply.edit({
          embeds: [
            new EmbedBuilder()
              .setTitle("🎲 チンチロ")
              .setColor(C_MAMMON)
              .setDescription([describe(playerHand), "", diceDisplay(playerDice), "", `第${rollNo}投 → 自動で再振り…（残り${playerMaxRolls - rollNo}）`].join("\n")),
          ],
          components: [],
        });
        await sleep(1500);
        continue;
      }
      break;
    }

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
        new ButtonBuilder()
          .setCustomId("chinchiro:cancel")
          .setLabel("中止して全額返還")
          .setStyle(ButtonStyle.Secondary),
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
      await reply.edit({ embeds: [e], components: [row] });

      const choice = await new Promise<"stop" | "reroll" | "cancel" | "timeout">((resolve) => {
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
          } else if (btn.customId === "chinchiro:cancel") {
            collector.stop("cancel");
            resolve("cancel");
          } else {
            collector.stop("reroll");
            resolve("reroll");
          }
        });
        collector.on("end", (_collection, reason) => {
          if (reason !== "stop" && reason !== "reroll" && reason !== "cancel") resolve("timeout");
        });
      });
      if (choice === "cancel" || choice === "timeout") {
        throw new Error(choice === "timeout" ? "チンチロ操作が時間切れになりました" : "利用者がチンチロを中止しました");
      }
      if (choice === "stop") {
        playerLocked = true;
        break;
      }
    }
  }

  await reply.edit({
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
  });
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
      await reply.edit({ embeds: [e], components: [] });
      await sleep(220);
    }
    dealerDice = rollDice(services.rng);
    dealerHand = evaluate(dealerDice);
    const willStop = isTerminal(dealerHand) || (dealerHand.type === "me" && dealerHand.score >= 5) || rollNo >= MAX_ROLLS;
    await reply.edit({
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
    });
    await sleep(willStop ? 1400 : 1000);
    if (willStop) break;
  }

  const cmp = compare(playerHand, dealerHand);
  const mul = cmp.mul;
  const round = settleChinchiroRound(services, uid, bet, mul, interaction.id, reservationKey);

  let payoutText = "";
  const title = "🎲 チンチロ — 対 マモン";
  let color = C_LOSE;
  const amuletNote = round.amuletNote ? `✨ ${round.amuletNote}` : "";
  const settled = round.settled;

  if (round.branch === "win") {
    color = C_WIN;
    const chainLine = settled.chainBonus > 0
      ? `\n${settled.chainLabel} 連鎖 **${settled.chainStreak}連勝** ×${settled.chainMult.toFixed(2)} → **+${fmtEther(settled.chainBonus)}**`
      : "";
    const fukuLine = settled.fukuTax > 0
      ? `\n⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 奉納`
      : "";
    payoutText = `💰 配当 ${fmtEther(settled.payout)}（利益 ${settled.net >= 0 ? "+" : ""}${fmtEther(settled.net)}）${chainLine}${fukuLine}`;
    broadcastBigWin(interaction.client, services, { userId: uid, game: "チンチロ", bet, payout: settled.payout });
  } else if (round.branch === "push") {
    color = C_MAMMON;
    payoutText = settled.net === 0
      ? `🌀 プッシュ：${fmtEther(settled.payout)} を返金`
      : `🛡 お守り適用後 ${fmtEther(settled.payout)}（損益 ${fmtEther(settled.net)}）`;
  } else if (round.branch === "double_loss") {
    const actualLoss = Math.max(0, -settled.net);
    payoutText = settled.net < 0
      ? `💀 -${fmtEther(actualLoss)}（${Math.abs(mul)}倍負け・お守り反映後）`
      : `🛡 お守りで損失を相殺：${fmtEther(settled.payout)}`;
  } else {
    const actualLoss = Math.max(0, -settled.net);
    payoutText = settled.net < 0
      ? `💸 -${fmtEther(actualLoss)}`
      : settled.net > 0
        ? `🛡 お守り適用後 +${fmtEther(settled.net)}`
        : `🛡 ${fmtEther(settled.payout)} を返金`;
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
    .setDescription([comparison, "", payoutText, amuletNote].filter(Boolean).join("\n"))
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
  collector.on("end", async (_collection, reason) => {
    if (reason !== "retry" && reason !== "quit") await reply.edit({ components: [] }).catch(() => undefined);
  });
}
