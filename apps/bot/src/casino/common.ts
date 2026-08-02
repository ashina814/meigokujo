import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  SLOT_MAX_PAYOUT_MULT,
  blackjackNoDoubleLiability,
  liabilityModelFor,
  soloGroupKey,
  type GameLiabilityModel,
  type LiabilityContext,
} from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { C_BIGWIN, C_LOSE, C_MAMMON, C_PUSH, C_WIN, E, fmtBigDelta } from "./ui.js";

export const MIN_BET = 50;
export const MAX_BET = 1_000_000;

/** 設定上の賭け上限（VIP なら倍率を掛ける）。胴元の余力は見ない */
export function configuredMaxBet(services: Services, userId: string): number {
  if (services.vip.isVip(userId)) return Math.floor(MAX_BET * services.vip.betCapMult());
  return MAX_BET;
}

/**
 * その利用者・そのゲームで**いま表示してよい**賭け上限（正本 §11.3）。
 *
 * ```text
 * min( 設定上限（VIPなら×2）, gameModel.maxBetFor(house.available, ctx) )
 * ```
 *
 * `house.available` は「胴元残高 − 予約済み債務」。**上限表示・事前検証・予約 INSERT が
 * 同じ `GameLiabilityModel.maxHouseLiability` を通る**ので、「表示された上限では予約が取れない」
 * が起きない（PR5 レビュー指摘）。
 *
 * ゲーム名を渡さない呼び出しは設定上限しか返さないので、**結果画面や賭け受付では使わない**。
 * 残っているのは「ゲームが決まっていない場面」（賭場ホームの所持額表示など）だけ。
 */
export function effectiveMaxBet(services: Services, userId: string, game?: string): number {
  const cap = configuredMaxBet(services, userId);
  const model = game ? liabilityModelFor(game) : undefined;
  if (!model) return cap;
  return Math.min(cap, model.maxBetFor(services.casino.availableForLiability(), liabilityCtx(services, userId)));
}

/** 債務モデルへ渡す文脈（連勝数と装備中お守りの上限） */
export function liabilityCtx(services: Services, userId: string): Omit<LiabilityContext, "bet"> {
  return {
    playerState: { winStreak: services.casino.stats(userId).current_win_streak },
    activeEffects: { winBonusCap: services.items.armedWinBonusCap(userId) },
  };
}

/** 同時プレイ防止（1人1卓）。プロセス内ロックで足りる（bot は単一プロセス） */
const playing = new Set<string>();

export function acquireSeat(userId: string): boolean {
  if (playing.has(userId)) return false;
  playing.add(userId);
  return true;
}
export function releaseSeat(userId: string): void {
  playing.delete(userId);
}
/** PR10: 返還・域外確認は進行中ソロゲームの利用者には出さない。 */
export function isSeatOccupied(userId: string): boolean {
  return playing.has(userId);
}

export interface BetCheck {
  ok: boolean;
  bet: number;
}

/**
 * 賭けの共通前処理。座席確保はしない（呼び出し側で）。
 *
 * - bet の整数/範囲チェック
 * - 残高チェック（不足ならマモンが両替所へ誘導）
 * - テーブルリミット（胴元がこの賭けの**純債務**を予約できるか）
 *
 * NG のときは reply 済みで ok:false を返す。
 *
 * ## gross payout ではなく net liability で見る（PR5 レビュー指摘）
 *
 * 以前はここへ「払戻総額」を渡して `canAccept(maxPayout)` を呼んでいた。
 * ところが実際に予約するのは「最大払戻 − 回収する賭け金」の**純債務**なので、
 * 事前判定のほうが常に厳しく、予約できる安全な賭けまで断っていた。
 * 表示上限（`effectiveMaxBet`）とも一致しないので「下のボタンなら必ず通る」が保証できない。
 *
 * いまはここも `GameLiabilityModel.maxHouseLiability` を見る。
 * **最終的な可否は同一トランザクション内の `reserve` が真実源**で、ここはあくまで
 * 「明らかに無理な賭けを早く断って、押せる金額を提示する」ための前段。
 */
export async function validateBet(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
  /** 債務モデルを持つゲーム名。上限表示・事前検証・予約がこの1つのモデルを共有する */
  game: string,
): Promise<BetCheck> {
  const bet = Math.floor(betRaw);
  const uid = interaction.user.id;
  const cap = configuredMaxBet(services, uid);
  // 保留中の無料スピンを先に通知した場合、ここは2通目になる。
  // 未応答 interaction には reply、応答済み／defer 済みなら followUp を使う。
  const respond = (payload: Parameters<typeof interaction.reply>[0]) =>
    interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload);
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > cap) {
    await respond({
      content: `賭け額は ${MIN_BET.toLocaleString()}〜${cap.toLocaleString()} ◈ で。${cap > MAX_BET ? "（💎 VIP 賭け上限拡張中）" : ""}`,
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  // PR10: 両替パネルへ追い返さず、ゲーム開始の同一業務操作で不足分**だけ**を
  // 1:1預入する。余剰購入はしない。Land不足などで預入が失敗すれば group 全体が戻る。
  try {
    services.chipFlow.ensureFreeChips(uid, bet, interaction.id);
  } catch {
    // 下の残高判定で、既存と同じ利用者向け不足通知へ落とす。
  }
  const held = services.ether.balanceOf(uid);
  if (held < bet) {
    await respond({
      content: `${Mammon.broke()}（所持 ${fmtEther(held)}）\n→ 両替所パネルで Land をエテルに替えてこい。`,
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  const model = liabilityModelFor(game);
  if (model) {
    const needed = model.maxHouseLiability({ ...liabilityCtx(services, uid), bet });
    if (needed > services.casino.availableForLiability()) {
      // 胴元がこの賭けの最悪ケースを引き受けられない。
      // **押し直せば必ず通る金額**を提示して戻す（正本 §5.4 ③）。
      // 提示額は同じモデルの逆算なので、その額なら予約が取れる
      await respond({
        ...capacityRecoveryPayload(services, effectiveMaxBet(services, uid, game), game),
        flags: MessageFlags.Ephemeral,
      });
      return { ok: false, bet };
    }
  }
  return { ok: true, bet };
}

/**
 * 「いま受けられる額」を提示する画面（正本 §5.4 ③）。
 *
 * 「卓が閉じている」で終わらせない。押せば必ず通る額のボタンを出して、次の一手を必ず提示する。
 * ボタンは `casino:play:<ゲーム>:<額>` で、コレクタではなく**全体のボタン経路**が拾う
 * （コレクタだと、この返信が別メッセージなので誰も拾えない）。
 */
export function capacityRecoveryPayload(
  services: Services,
  maxAcceptable: number,
  game?: string,
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  if (maxAcceptable < MIN_BET) {
    return {
      content: [Mammon.tableClosed(), "（胴元の資金が尽きている。運営: /管理 → 賭場 → 資金投入）"].join("\n"),
      components: [],
    };
  }
  const content = [
    `⚠️ いまこの卓で受けられるのは **${maxAcceptable.toLocaleString()} ◈** まで。`,
    "（他の客が大きく張っている。下のどれかなら必ず通る）",
  ].join("\n");
  if (!game) return { content, components: [] };

  // 上限・半分・最低。重複と MIN_BET 未満は落とす
  const candidates = [maxAcceptable, Math.floor(maxAcceptable / 2), MIN_BET]
    .map((v) => Math.floor(v))
    .filter((v) => v >= MIN_BET);
  const amounts = [...new Set(candidates)].slice(0, 3);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...amounts.map((amount, i) =>
      new ButtonBuilder()
        .setCustomId(`casino:play:${game}:${amount}`)
        .setLabel(`${amount.toLocaleString()} で遊ぶ`)
        .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  return { content, components: [row] };
}

/** 予約が取れなかったときに投げる（グループごと巻き戻して金を1 Ld も動かさない） */
export class HouseCapacityError extends Error {
  constructor(
    readonly game: string,
    readonly needed: number,
    readonly available: number,
  ) {
    super(`ERR_HOUSE_CAPACITY: ${game} に必要な ${needed} に対して余力 ${available}`);
    this.name = "HouseCapacityError";
  }
}

/** ソロゲーム1回ぶんの予約鍵。精算の業務グループ鍵と同じ文字列を使う */
export function reservationKeyFor(game: string, userId: string, operationId: string): string {
  return soloGroupKey(game, userId, operationId);
}

/**
 * ゲーム開始時に最悪ケースの債務を予約する（正本 §11.2）。
 *
 * 予約と `available()` の再確認は同一トランザクション。取れなければ
 * {@link HouseCapacityError} を投げ、呼び出し側が「押せる金額」を出す。
 * 精算が通れば `Casino.settle` が**同じトランザクションの中で**解放し、
 * 中止・例外の場合は呼び出し側の `finally` が解放する。
 */
export function reserveHouseLiability(
  services: Services,
  game: string,
  userId: string,
  bet: number,
  operationId: string,
): { key: string; amount: number } {
  const model: GameLiabilityModel | undefined = liabilityModelFor(game);
  const key = reservationKeyFor(game, userId, operationId);
  if (!model) return { key, amount: 0 };
  const amount = model.maxHouseLiability({ ...liabilityCtx(services, userId), bet });
  const r = services.reservations.reserve(key, amount, game, userId);
  if (!r.ok) throw new HouseCapacityError(game, amount, r.available);
  return { key, amount };
}

/**
 * スロット1セットぶんの予約（有料スピン + 最大1回のフリースピン）。
 *
 * 額は core の `slotsLiability`（＝`liabilityModelFor("スロット")`）そのもの。
 * 以前はここで `paid + (paid + bet)` と**予約側だけが**セット全体を計算しており、
 * 上限表示・事前検証は有料1回ぶんしか見ていなかった（PR5 レビュー指摘）。
 * いまは表示・検証・予約・復帰ボタンがすべて同じモデルを読む。
 *
 * 鍵は精算グループ鍵と別にしてある。精算グループ鍵にすると、有料スピンの精算時に
 * 解放されてフリースピンが裸になる。
 */
export function reserveSlotsLiability(
  services: Services,
  userId: string,
  bet: number,
  interactionId: string,
): { key: string; amount: number } {
  const model = liabilityModelFor("スロット");
  const key = slotsReservationKey(userId, interactionId);
  if (!model) return { key, amount: 0 };
  const amount = model.maxHouseLiability({ ...liabilityCtx(services, userId), bet });
  const r = services.reservations.reserve(key, amount, "スロット", userId);
  if (!r.ok) throw new HouseCapacityError("スロット", amount, r.available);
  return { key, amount };
}

/** スロット1セットの予約鍵。`spinPaid` が自己予約を参照するのに同じ関数を使う */
export function slotsReservationKey(userId: string, interactionId: string): string {
  return `slots:reserve:${userId}:${interactionId}`;
}

/**
 * 保留中のフリースピンを**再開するとき**の予約（PR5 レビュー指摘）。
 *
 * 元の予約はプロセスの再起動で解放されている（正本 §8.2 S9）。
 * 権利のほうは DB に残っているので、払う直前に**取り直す**。
 * 賭け金の回収が無いぶん、必要額は「最大払戻 + お守り上限」まるごと。
 *
 * 取れなければ {@link HouseCapacityError} を投げる。呼び出し側は権利を pending のまま残す。
 */
export function reserveFreeSpinLiability(
  services: Services,
  row: { id: number; userId: string; payout: number },
): { key: string; amount: number } {
  const key = `slots:freespin:${row.id}`;
  // 保留権利は獲得時点で配当・お守り効果を固定済み。現在の装備状態から
  // 最大額を組み立て直すと、権利と無関係の装備変更で予約可否が揺れてしまう。
  const amount = row.payout;
  const r = services.reservations.reserve(key, amount, "スロット", row.userId);
  if (!r.ok) throw new HouseCapacityError("スロット", amount, r.available);
  return { key, amount };
}

/**
 * ブラックジャックの段階予約（PR5 受入条件）。
 *
 * まずダブル込みの最悪ケースで取りにいき、余力が足りなければ**ダブル無しの額**で取り直す。
 * こうすると「胴元が細っているときはダブルボタンだけ無効になり、手そのものは続けられる」。
 * 手ごと断ると、ダブルするつもりのなかった客まで遊べなくなる。
 *
 * ## 再実行では「実際に保存されている額」から復元する（レビュー指摘）
 *
 * 同じ操作をもう一度実行したとき、要求額ではなく**保存済みの予約額**を見て
 * `doubleAllowed` を決める。要求だけを見ていると
 * 「1回目はダブル無し 15,000 で予約 → 再実行でダブル込み 20,000 を要求 →
 * 鍵が同じなので成功扱い → doubleAllowed=true」となり、裏付けの無いダブルを許してしまう。
 */
export function reserveBlackjackLiability(
  services: Services,
  userId: string,
  bet: number,
  operationId: string,
): { key: string; amount: number; doubleAllowed: boolean } {
  const key = reservationKeyFor("ブラックジャック", userId, operationId);
  const ctx = liabilityCtx(services, userId);
  const withDouble = liabilityModelFor("ブラックジャック")?.maxHouseLiability({ ...ctx, bet }) ?? 0;
  const noDouble = blackjackNoDoubleLiability.maxHouseLiability({ ...ctx, bet });

  // 同じ操作の再実行なら、保存済みの額がそのまま答え
  const existing = services.reservations.get(key);
  if (existing) {
    return { key, amount: existing.amount, doubleAllowed: existing.amount >= withDouble };
  }

  const full = services.reservations.reserve(key, withDouble, "ブラックジャック", userId);
  if (full.ok) return { key, amount: withDouble, doubleAllowed: true };

  const fallback = services.reservations.reserve(key, noDouble, "ブラックジャック", userId);
  if (fallback.ok) return { key, amount: noDouble, doubleAllowed: false };
  throw new HouseCapacityError("ブラックジャック", noDouble, fallback.available);
}

/** 予約を解放する（中止・例外の後始末。精算が通っていれば既に消えている） */
export function releaseHouseLiability(services: Services, key: string): void {
  services.reservations.release(key);
}

/**
 * 「開始時に予約 → 本体 → 必ず解放」を1箇所にまとめる（正本 §11.2 のライフサイクル）。
 *
 * 予約が取れなければ本体を**一度も呼ばず**、押せる金額を提示して `undefined` を返す。
 * 金は1 Ld も動かない（本体に入っていないので当然）。
 * 精算が通れば `Casino.settle` が同じトランザクションで解放し、
 * 中止・例外でもここの `finally` が解放する。
 */
export async function withHouseReservation<T>(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  game: string,
  bet: number,
  operationId: string,
  body: (reservationKey: string) => Promise<T>,
): Promise<T | undefined> {
  return withExplicitHouseReservation(
    interaction,
    services,
    game,
    (uid) => reserveHouseLiability(services, game, uid, bet, operationId),
    body,
  );
}

/**
 * 予約額と鍵を呼び出し側が決める版。
 *
 * スロットのように「1回の操作で複数スピンぶんの債務を負う」ゲームで使う。
 * 鍵を精算グループ鍵と別にしておくと `Casino.settle` が途中で解放しないので、
 * フリースピンまで含めた区間を1つの予約で押さえられる。
 */
export async function withExplicitHouseReservation<T>(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  game: string,
  take: (userId: string) => { key: string; amount: number },
  body: (reservationKey: string) => Promise<T>,
): Promise<T | undefined> {
  let reserved: { key: string; amount: number };
  try {
    reserved = take(interaction.user.id);
  } catch (e) {
    if (!(e instanceof HouseCapacityError)) throw e;
    const payload = {
      ...capacityRecoveryPayload(services, effectiveMaxBet(services, interaction.user.id, game), game),
      flags: MessageFlags.Ephemeral as const,
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
    return undefined;
  }
  try {
    return await body(reserved.key);
  } finally {
    releaseHouseLiability(services, reserved.key);
  }
}

/** リトライ操作を受け付けなかった理由（`checkRetry` の返り値） */
export type RetryDenial =
  | { ok: true; bet: number }
  | { ok: false; reason: string };

/**
 * 「もう一回」ボタンの受付判定（PR3）。
 *
 * 以前は各ゲームが `if (retryBet < MIN_BET || retryBet > MAX_BET) return;` と
 * **何も言わずに return** していた。コレクタは既に停止しているので、押した側からは
 * ボタンが死んだようにしか見えない。断るなら理由を出す。
 *
 * 上限は `MAX_BET` ではなく `effectiveMaxBet`（VIPなら×2）で見る。
 * ここを固定値にしていると、VIP が上限いっぱいで遊んだ直後の「もう一回」だけが弾かれる。
 *
 * `game` を渡すと**胴元の余力も反映**する（PR5 レビュー指摘）。ゲーム名なしだと
 * VIP 設定上限しか見ないので、他の客が大きく張っている最中の「もう一回」が
 * 予約段階まで進んでから落ちていた。全ゲームの結果画面はゲーム名を渡す。
 */
export function checkRetry(services: Services, userId: string, betRaw: number, game?: string): RetryDenial {
  const bet = Number(betRaw);
  const cap = effectiveMaxBet(services, userId, game);
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > cap) {
    const configured = configuredMaxBet(services, userId);
    const capped = cap < configured; // 胴元の余力で絞られている
    return {
      ok: false,
      reason: capped
        ? `いまこの卓で受けられるのは ${MIN_BET.toLocaleString()}〜${cap.toLocaleString()} ◈ まで。（他の客が大きく張っている）`
        : `賭け額は ${MIN_BET.toLocaleString()}〜${cap.toLocaleString()} ◈ で。${cap > MAX_BET ? "（💎 VIP 賭け上限拡張中）" : ""}`,
    };
  }
  const held = services.ether.balanceOf(userId);
  if (held < bet) {
    return { ok: false, reason: `${Mammon.broke()}（所持 ${fmtEther(held)} / 必要 ${fmtEther(bet)}）` };
  }
  return { ok: true, bet };
}

/** 席が取れなかったときの理由文（同時プレイ防止に弾かれたことを黙らせない） */
export const SEAT_BUSY_REASON = "まだ前の勝負が終わっていない。少し待ってからもう一度。";

/**
 * 「もう一回」ボタンを押されたときの本体（PR3）。
 *
 * **collector を止めるのは受付が確定してから**。以前は各ゲームが
 *
 * ```ts
 * collector.stop("retry");        // ← 先に止めていた
 * const retry = checkRetry(...);
 * if (!retry.ok) return;          // ← 断ると、ボタンは残っているのに二度と反応しない
 * ```
 *
 * という順で書いていた。理由を出すようにしても、collector が死んでいるので
 * 「もう一度押す」ができない。断ったなら**押し直せる状態のまま**返す。
 *
 * 受付が通ったときだけ collector を止め、座席を取り直して本体を回す。
 * 全ゲームがこの1本を通るので、順序を各ゲームで書き間違えようがない。
 */
export interface RetryCollector {
  stop(reason?: string): void;
}

export async function handleRetryPress(opts: {
  services: Services;
  btn: ButtonInteraction;
  collector: RetryCollector;
  /**
   * ゲーム名（PR5）。**必須**。渡さないと VIP 設定上限しか見ず、胴元の余力を反映しない。
   * 全7ゲームの結果画面がここを通るので、渡し忘れは型で防がれる。
   */
  game: string;
  betRaw: number;
  /** 受付が通ったあとに回す本体（座席は取得済み） */
  run: (bet: number) => Promise<void>;
}): Promise<void> {
  const { services, btn, collector, run } = opts;
  const uid = btn.user.id;

  const retry = checkRetry(services, uid, opts.betRaw, opts.game);
  if (!retry.ok) {
    // ここで collector を止めない。断ったのにボタンを殺すと、次に押したとき無応答になる
    await btn.reply({ content: `❌ ${retry.reason}`, flags: MessageFlags.Ephemeral });
    return;
  }

  // ここから先は受け付ける。この時点で初めてコレクタを閉じる
  collector.stop("retry");
  await btn.deferUpdate();

  // 座席は「前の1回」を回している親が握っている。いったん返して取り直す
  releaseSeat(uid);
  if (!acquireSeat(uid)) {
    await btn.followUp({ content: SEAT_BUSY_REASON, flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    await run(retry.bet);
  } finally {
    releaseSeat(uid);
  }
}

/**
 * 勝敗リザルトの共通embed（洗練版）。
 * - Author: 「マモンの賭場 · {ゲーム名}」
 * - Title: 勝ち/負けタグ + 大きな純損益（±付き）
 * - Description: 状態詳細のライン
 * - Footer: 所持 + 連勝バッジ
 */
export function resultEmbed(opts: {
  title: string; // ゲーム名（"スロット" 等・タグと組み合わせる）
  lines: string[];
  net: number;
  balance: number;
  bet?: number;
  isJackpot?: boolean;
  streak?: number; // 現在の連勝数（設定なら Footer に出す）
}): EmbedBuilder {
  const won = opts.net > 0;
  const push = opts.net === 0;
  const bigWin = won && opts.bet && opts.net >= opts.bet * 5;
  const color = opts.isJackpot ? 0xf0b429 : bigWin ? C_BIGWIN : won ? C_WIN : push ? C_PUSH : C_LOSE;

  const tag = opts.isJackpot
    ? `${E.jp} JACKPOT!`
    : bigWin
      ? `${E.fire} 大勝ち`
      : won
        ? `${E.win} 勝ち`
        : push
          ? `${E.push} 引き分け`
          : `${E.lose} 負け`;

  const mammonLine = opts.isJackpot ? Mammon.jackpot() : bigWin ? Mammon.bigWin() : won ? Mammon.win() : push ? Mammon.push() : Mammon.lose();

  const footerBits = [`所持 ${fmtEther(opts.balance).replace(" ◈", "◈")}`];
  if (opts.bet) footerBits.push(`賭け ${fmtEther(opts.bet).replace(" ◈", "◈")}`);
  if (opts.streak && opts.streak >= 2) footerBits.push(`${E.fire} ${opts.streak}連勝`);

  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.title.replace(/^[🎰🎲🎡🃏📈🌟💥🏆]\s?/, "").split(" ")[0] ?? "賭場"}` })
    .setTitle(`${tag}  ${fmtBigDelta(opts.net)}`)
    .setColor(color)
    .setDescription([...opts.lines, "", `*「${mammonLine}」*`].join("\n"))
    .setFooter({ text: footerBits.join(" · ") });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * お守りの適用は `services.casino.settleSolo()`（core 側）に移した。
 *
 * 以前はここに `applyAmulets()` があり、各ゲームが精算より**前**に呼んでいた。
 * お守りの消費は DB 上の装備を消す副作用なので、精算が落ちると
 * 「お守りだけ消えて配当も返金も無い」状態が残る。
 * いまは消費・賭け・配当・戦績が同じ業務グループに入っており、途中で落ちれば全部戻る。
 */
