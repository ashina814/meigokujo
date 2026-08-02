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
 * `house.available` は「胴元残高 − 予約済み債務」。ゲームを指定しない呼び出しでは
 * 設定上限だけを返す（リトライ判定など、ゲーム固有の倍率を持たない場所）。
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

export interface BetCheck {
  ok: boolean;
  bet: number;
}

/**
 * 賭けの共通前処理。座席確保はしない（呼び出し側で）。
 * - bet の整数/範囲チェック
 * - 残高チェック（不足ならマモンが両替所へ誘導）
 * - テーブルリミット（胴元が最悪配当を払えるか）
 * NG のときは reply 済みで ok:false を返す。
 */
export async function validateBet(
  interaction: ChatInputCommandInteraction,
  services: Services,
  betRaw: number,
  maxPayout: number,
  /** 債務モデルを持つゲーム名。渡すと上限提示が予約込みの余力から出る */
  game?: string,
): Promise<BetCheck> {
  const bet = Math.floor(betRaw);
  const cap = configuredMaxBet(services, interaction.user.id);
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
  const held = services.ether.balanceOf(interaction.user.id);
  if (held < bet) {
    await respond({
      content: `${Mammon.broke()}（所持 ${fmtEther(held)}）\n→ 両替所パネルで Land をエテルに替えてこい。`,
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  if (!services.casino.canAccept(maxPayout)) {
    // 胴元が最悪ケースの配当を払えない。**押し直せば必ず通る金額**を提示して戻す（正本 §5.4 ③）
    const multiplier = maxPayout / bet;
    const maxAcceptable = game
      ? effectiveMaxBet(services, interaction.user.id, game)
      : Math.floor(services.casino.availableForLiability() / multiplier);
    await respond({ ...capacityRecoveryPayload(services, maxAcceptable, game), flags: MessageFlags.Ephemeral });
    return { ok: false, bet };
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
 * スロット1回ぶんの予約（有料スピン + 最大1回のフリースピン）。
 *
 * フリースピンは賭け金を取らないので、胴元は配当を丸ごと持ち出す（賭け額の回収が無い）。
 * 有料ぶんの債務に `bet` を足すとちょうどフリースピン1回ぶんの最悪ケースになる。
 * 原作準拠でフリースピン中はさらなるフリースピンが出ないので、多くても1回。
 */
export function reserveSlotsLiability(
  services: Services,
  userId: string,
  bet: number,
  interactionId: string,
): { key: string; amount: number } {
  const model = liabilityModelFor("スロット");
  const key = `slots:reserve:${userId}:${interactionId}`;
  if (!model) return { key, amount: 0 };
  const paid = model.maxHouseLiability({ ...liabilityCtx(services, userId), bet });
  const amount = paid + (paid + bet);
  const r = services.reservations.reserve(key, amount, "スロット", userId);
  if (!r.ok) throw new HouseCapacityError("スロット", amount, r.available);
  return { key, amount };
}

/**
 * ブラックジャックの段階予約（PR5 受入条件）。
 *
 * まずダブル込みの最悪ケースで取りにいき、余力が足りなければ**ダブル無しの額**で取り直す。
 * こうすると「胴元が細っているときはダブルボタンだけ無効になり、手そのものは続けられる」。
 * 手ごと断ると、ダブルするつもりのなかった客まで遊べなくなる。
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
  const full = services.reservations.reserve(key, withDouble, "ブラックジャック", userId);
  if (full.ok) return { key, amount: withDouble, doubleAllowed: true };

  const noDouble = blackjackNoDoubleLiability.maxHouseLiability({ ...ctx, bet });
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
 */
export function checkRetry(services: Services, userId: string, betRaw: number): RetryDenial {
  const bet = Number(betRaw);
  const cap = effectiveMaxBet(services, userId);
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > cap) {
    return {
      ok: false,
      reason: `賭け額は ${MIN_BET.toLocaleString()}〜${cap.toLocaleString()} ◈ で。${cap > MAX_BET ? "（💎 VIP 賭け上限拡張中）" : ""}`,
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
  betRaw: number;
  /** 受付が通ったあとに回す本体（座席は取得済み） */
  run: (bet: number) => Promise<void>;
}): Promise<void> {
  const { services, btn, collector, run } = opts;
  const uid = btn.user.id;

  const retry = checkRetry(services, uid, opts.betRaw);
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
