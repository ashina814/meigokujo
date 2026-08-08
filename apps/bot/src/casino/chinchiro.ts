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
  LedgerError,
  chinchiroCompare,
  chinchiroEvaluate,
  chinchiroIsTerminal,
  chinchiroMaxPayout,
  chinchiroMaxPlayerLoss,
  chinchiroPayout,
  chinchiroPlayerLoss,
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
  releaseSeat,
  sleep,
  validateBet,
  withHouseReservation,
} from "./common.js";
import { C_MAMMON, C_WIN, C_LOSE } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  recordCasinoGameAbandonBestEffort,
  recordCasinoGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";

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
 * - **開始時に最大損失 `2 × bet` を `escrow:session:<sid>` へ事前預託する**（PR11・正本 §11.4）。
 *   結果後の追加徴収・残高不足フォールバックはしない。通常負けは必要額だけ house へ、
 *   残額は利用者へ返す。倍付け負けは全額 house。勝ち・引分は預託全額が形を変えて戻る
 *   （配当 or 直接返還）。PR4 では倍率だけを直し、事前預託化は行っていなかった
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
 *
 * PR11: 残高不足フォールバックは廃止した（正本 §11.4）。開始時に最大損失
 * `2 × bet` を事前預託しているので、結果確定時点で残高が足りない事態は起きない。
 */
export interface ChinchiroRound {
  branch: "win" | "push" | "loss" | "double_loss";
  settled: import("@meigokujo/core").SoloRoundResult;
  amuletNote: string | null;
  /** 倍付け負けの追加損失額（それ以外は 0）。資金は開始時に事前預託済み。 */
  extra: number;
}

/** チンチロの事前預託セッションID。1ラウンド = 1セッション。 */
export function chinchiroPreholdSessionId(uid: string, operationId: string): string {
  return `chinchiro:prehold:${uid}:${operationId}`;
}

/**
 * 事前預託した最大損失 `2 × bet` を確定する。
 *
 * `bet` ぶんは `Casino.settleSolo()` の共有経路（連鎖・福の重み・お守り・戦績・
 * 予約解放）を通し、**徴収元だけ**を事前預託 holder へ差し替える（正本 I5・I8）。
 * 倍付け負けの追加損失・勝ち引分時の預託残額は、同じチップグループの中で
 * escrow から直接動かす。ラウンド全体が単一グループなので、途中で例外が
 * 起きればここまでの送金もすべて巻き戻る。
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
  const sessionId = chinchiroPreholdSessionId(uid, operationId);
  return services.chips.runGroup(
    { groupKey: `chinchiro:round:${uid}:${operationId}`, kind: "solo_game", actorId: uid },
    (): ChinchiroRound => {
      const holder = services.escrow.holderId(sessionId);
      const preheld = chinchiroMaxPlayerLoss(bet);
      const pool = services.escrow.poolOf(sessionId);
      if (pool !== preheld) {
        throw new Error(`チンチロ事前預託の帳簿不一致: 期待${preheld} 実際${pool}`);
      }

      const rawPayout = mul > 0 ? chinchiroPayout(bet, mul) : mul === 0 ? bet : 0;
      const settled = services.casino.settleSolo(uid, "チンチロ", bet, rawPayout, {
        operationId,
        reservationKey,
        // settle() 自身が session_id 単位で user・game・source・額・holder実残高を
        // 完全照合する（PR11 独立本監査2回目）。ここでの pool チェックは
        // チンチロ固有の分かりやすいメッセージを先に出すための軽い事前確認に過ぎない
        preheld: { sessionId, expectedAmount: preheld },
      });

      // settle() が holder から house へ bet ぶんを動かした。残りの精算:
      // 倍付け負けの追加損失は holder → house、勝ち・引分・通常負けの残額は holder → 利用者。
      //
      // `escrow.payout()` は holder の実残高だけを動かし、`casino_escrow` 台帳は
      // 更新しない（最後に `clear()` で一括削除する設計）。そのため「残額」は
      // `poolOf()`（台帳合計・ここでは動かない）ではなく **holder の実残高**で見る。
      const loss = mul < 0 ? chinchiroPlayerLoss(bet, mul) : 0;
      const extra = Math.max(0, loss - bet);
      if (extra > 0) {
        services.escrow.payout(sessionId, HOUSE_HOLDER, extra, operationId, "チンチロ倍付け負けの追加損失");
      }
      const remaining = services.chips.balanceOf(holder);
      if (remaining > 0) {
        services.escrow.payout(sessionId, uid, remaining, operationId, "チンチロ事前預託残額返還");
      }
      services.escrow.clear(sessionId);

      return {
        branch: mul > 0 ? "win" : mul === 0 ? "push" : loss >= preheld ? "double_loss" : "loss",
        settled,
        amuletNote: settled.amuletNote ?? null,
        extra,
      };
    },
  );
}

const isTerminal = chinchiroIsTerminal;
/** 壺の中に転がる三賽を等幅で並べる（原作準拠の見せ方より視認性重視） */
const diceDisplay = (d: Dice) => `╭─────╮  ╭─────╮  ╭─────╮\n│  ${DIE_FACES[d[0]]}  │  │  ${DIE_FACES[d[1]]}  │  │  ${DIE_FACES[d[2]]}  │\n╰─────╯  ╰─────╯  ╰─────╯`;

export function paytableEmbed(): EmbedBuilder {
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
      .setFooter({ text: `第${rollNo}投 · 残り${remaining} · 賭け ${fmtEther(bet).replace(" Ld", "Ld")}` });
    await reply.edit({ embeds: [e], components: [] }).catch(() => undefined);
    await sleep(220);
  }
}

export async function playChinchiro(
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
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "チンチロ");
    if (!check.ok) return;
    await runRound(interaction, services, check.bet, context);
  } finally {
    releaseSeat(uid);
  }
}

/** `beginChinchiroPrehold` が資金を動かせなかったときに投げる、UI 側で捕まえる用の理由分け。 */
export class ChinchiroPreholdError extends Error {
  constructor(readonly reason: "insufficient_funds" | "hold_failed") {
    super(`chinchiro prehold failed: ${reason}`);
    this.name = "ChinchiroPreholdError";
  }
}

/**
 * 最大損失 `2 × bet` を、乱数・演出より前に事前預託する（PR11・正本 §11.4）。
 *
 * 自由チップの不足分はここで自動預入する。**"insufficient_funds" で失敗した場合は
 * 何も動いていない**（`ensureFreeChips` 自身が Land 不足で例外を投げ、その中では
 * 何も移していない）。
 *
 * 一方 **"hold_failed" は Land が既に自由チップへ移った後**の失敗（PR11 独立本監査・
 * 事実誤認の訂正）。`ensureFreeChips` が Land→自由チップの変換に成功した直後、
 * `escrow.hold()` だけが（残高の再チェック失敗など）落ちたケースで、その変換は
 * 巻き戻らない。ただし資金は消えても二重に預入されてもいない——利用者の自由チップに
 * 増えた額としてそのまま残り、同じ operationId での再試行では `ensureFreeChips` が
 * 保存済みの結果を返して二重預入せず、`escrow.hold()` だけをやり直す。
 *
 * 事前預託は `escrow.hold()`（既存の卓預託と同じ台帳・同じ復旧経路）を使うので、
 * 起動時復旧・active ownership 判定・資産検算はすべて既存の仕組みがそのまま拾う——
 * ここに専用のテーブルや状態機械を新設する必要はない。
 */
export function beginChinchiroPrehold(services: Services, uid: string, bet: number, operationId: string): string {
  const preheld = chinchiroMaxPlayerLoss(bet);
  const sessionId = chinchiroPreholdSessionId(uid, operationId);
  try {
    // ensureFreeChips の operationId は ":" を含められない（区切り文字の注入対策）。
    // validateBet 自身の自動預入（bare な interaction.id）とは別の鍵にする必要があるので、
    // ":" ではなくハイフンで区切る
    services.chipFlow.ensureFreeChips(uid, preheld, `${operationId}-chinchiro-prehold`);
  } catch (error) {
    // Land が本当に足りない場合だけ「insufficient_funds」にする（PR11 本監査）。
    // 賭場停止（opening lock/ERR_CASINO_CLOSED）・冪等キーの衝突・postcondition失敗・
    // 帳簿破損などを一律 insufficient_funds へ潰すと、利用者には的外れな「Landが足りない」
    // が出て、運営からは実際の原因（停止中・鍵衝突・破損）が見えなくなる。
    // それらは推測せずそのまま外へ出す（interactionCreate の共通catchがログと
    // 汎用エラー応答を行う）。
    if (error instanceof LedgerError && error.code === "ERR_INSUFFICIENT") {
      throw new ChinchiroPreholdError("insufficient_funds");
    }
    throw error;
  }
  if (!services.escrow.hold(sessionId, uid, preheld, "チンチロ", operationId)) {
    throw new ChinchiroPreholdError("hold_failed");
  }
  return sessionId;
}

/**
 * 精算前に中断したラウンドの事前預託を返す（PR11）。
 *
 * 精算後（`casino_escrow` は既に空）に呼ばれても `escrow.refund()` は返す対象が
 * 無いので何もしない（idempotent no-op・資金は動かない）——これで
 * 「表示失敗で精算済み資金を再び動かす」を構造的に防ぐ。
 *
 * 返金そのものが失敗したら、帳簿を残したまま凍結する（原因を消さず、次回起動時の
 * 登録型復旧に委ねる。正本 I6「不明時は動かさない」）。
 */
export function refundChinchiroPreholdOnFailure(services: Services, sessionId: string, causeError: unknown): never {
  try {
    services.escrow.refund(sessionId);
  } catch {
    throw new Error(
      `チンチロの事前預託返還に失敗し凍結しました: ${sessionId}（元エラー: ${causeError instanceof Error ? causeError.message : String(causeError)}）`,
    );
  }
  throw causeError;
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
  await withHouseReservation(interaction, services, "チンチロ", bet, interaction.id, async (reservationKey) => {
    const uid = interaction.user.id;
    const operationId = interaction.id;
    const respond = (content: string) =>
      interaction.replied || interaction.deferred
        ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral });

    let sessionId: string;
    try {
      sessionId = beginChinchiroPrehold(services, uid, bet, operationId);
    } catch (error) {
      if (error instanceof ChinchiroPreholdError && error.reason === "insufficient_funds") {
        await respond(
          `チンチロは最大損失ぶん ${fmtEther(chinchiroMaxPlayerLoss(bet))}（賭け ${fmtEther(bet)} の${CHINCHIRO_MAX_LOSS_MULT}倍）を先に預ける必要がある。Land が足りない。`,
        );
        return;
      }
      if (error instanceof ChinchiroPreholdError) {
        await respond("チンチロの事前預託に失敗した。もう一度試してほしい。");
        return;
      }
      throw error;
    }

    // ここから先の例外（Discordの表示失敗・collectorタイムアウト・利用者の中止）は、
    // 精算が確定する前なら事前預託をそのまま返す。精算後の例外では refund は no-op。
    try {
      await runRoundInner(interaction, services, bet, reservationKey, context);
    } catch (error) {
      refundChinchiroPreholdOnFailure(services, sessionId, error);
    }
  });
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
    game: "チンチロ",
    operationId: interaction.id,
    wager: bet,
    source: playContext.source,
  });
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

      const choice = await new Promise<"stop" | "reroll">((resolve, reject) => {
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
          if (reason === "stop" || reason === "reroll") return;
          if (reason === "time") {
            recordCasinoGameAbandonBestEffort(services, {
              userId: uid,
              game: "チンチロ",
              operationId: interaction.id,
              wager: bet,
              source: playContext.source,
              reason: "reroll_timeout",
            });
            resolve("stop"); // 真正timeoutだけ保守的に止める
            return;
          }
          reject(new Error(`chinchiro collector ended without timeout: ${reason}`));
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
      ? `\n⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}% → ${fmtEther(settled.fukuTax)} 福分け積立`
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
  } else {
    netForDisplay = settled.payout - bet;
    payoutText = settled.payout > 0 ? `🛡 返金 ${fmtEther(settled.payout)}` : `💸 -${fmtEther(bet)}`;
  }
  recordCasinoGameFinishBestEffort(services, {
    userId: uid,
    game: "チンチロ",
    operationId: interaction.id,
    wager: bet,
    payout: settled.payout,
    net: netForDisplay,
    source: playContext.source,
  });

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

  const resultPayload = buildSoloResult({
    services,
    userId: uid,
    game: "チンチロ",
    net: netForDisplay,
    wager: bet,
    retryBet: bet,
    titleOverride: netForDisplay > 0 ? "🟢 勝ち" : netForDisplay === 0 ? "⚪ 引き分け" : "🔴 負け",
    colorOverride: color,
    description: [comparison, "", payoutText, amuletNote].filter(Boolean).join("\n"),
  });

  await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
}
