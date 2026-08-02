import {
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { C_BIGWIN, C_LOSE, C_MAMMON, C_PUSH, C_WIN, E, fmtBigDelta } from "./ui.js";

export const MIN_BET = 50;
export const MAX_BET = 1_000_000;

/** VIP なら賭け上限倍率を掛ける。ゲーム側は effectiveMaxBet(services, userId) で判定 */
export function effectiveMaxBet(services: Services, userId: string): number {
  if (services.vip.isVip(userId)) return MAX_BET * services.vip.betCapMult();
  return MAX_BET;
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
): Promise<BetCheck> {
  const bet = Math.floor(betRaw);
  const cap = effectiveMaxBet(services, interaction.user.id);
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
    // 胴元が最悪ケースの配当を払えない。今の胴元残高で受けられる上限を教える
    const multiplier = maxPayout / bet;
    const maxAcceptable = Math.floor(services.casino.houseBalance() / multiplier);
    await respond({
      content: [
        Mammon.tableClosed(),
        maxAcceptable >= MIN_BET
          ? `（この卓で今受けられるのは **${maxAcceptable.toLocaleString()} ◈** まで）`
          : "（胴元の資金が尽きている。運営: /管理 → 賭場 → 資金投入）",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return { ok: false, bet };
  }
  return { ok: true, bet };
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
