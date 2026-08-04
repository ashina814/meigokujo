import { MessageFlags, type RepliableInteraction } from "discord.js";
import { ChipLedgerError, type OpeningPhase } from "@meigokujo/core";
import { fmtEther, fmtLd } from "../format.js";
import type { Services } from "../services.js";

/**
 * 正式開業（`opening_v1`）の前後で、UI の言うことを実態に合わせる（PR8監査・項目8・項目11）。
 *
 * PR8 の時点では 1:1 の預入・返還は**まだ始まっていない**。`CasinoStatus` が `open` でも、
 * 版が `legacy_pre_reset` のままなら資金は一切動かせない。稼働状態だけを見て「営業中」
 * 「1 Ld = 1 chip」と出すと、押しても必ず失敗するボタンを案内することになるので、
 * 表示と操作の判断はこのモジュールに集約する。
 */

/** 正式開業前・未知版のときに全画面で使う定型文（表示のゆらぎを作らない） */
export const PRE_OPENING_LINES = [
  "**正式開業準備中**",
  "預入・返還・賭け・資金投入・売上精算は停止中",
  "既存残高は保持されています",
  "1:1交換は opening_v1 確定後に開始します",
] as const;

export const PRE_OPENING_NOTICE = PRE_OPENING_LINES.join("\n");

/**
 * 未知版（`legacy_pre_reset` でも `opening_v1` でもない）。
 *
 * 準備口座そのものが決まらないので、残高すら正しく読めない。異常であることを
 * 隠さずに出し、操作は一切通さない。
 */
export const UNKNOWN_OPENING_NOTICE = [
  "**⚠️ 賭場の版が異常です**",
  "開業版の記録が想定外の値になっています（`legacy_pre_reset` / `opening_v1` のどちらでもない）。",
  "準備口座を特定できないため、預入・返還・賭け・資金投入・売上精算をすべて停止しています。",
  "支配人へ連絡してください。",
].join("\n");

/** 正式開業後だけ出してよい 1:1 の案内 */
export const FORMAL_OPENING_NOTICE = ["**1 Ld ＝ 1 chip（固定）**", "預入・返還ともに可能です"].join("\n");

export function openingPhase(services: Services): OpeningPhase {
  return services.chipTx.openingPhase();
}

/** 正式開業が終わっているか（＝チップの資金操作を通してよいか） */
export function isFormallyOpen(services: Services): boolean {
  return openingPhase(services) === "formal";
}

/**
 * 版に応じた案内文。正式開業前・未知版では null ではなく**必ず文面を返す**ので、
 * 呼び出し側は「注記が要るかどうか」を自分で判断しなくてよい。
 */
export function openingNotice(services: Services): string {
  const phase = openingPhase(services);
  if (phase === "formal") return FORMAL_OPENING_NOTICE;
  if (phase === "unknown") return UNKNOWN_OPENING_NOTICE;
  return PRE_OPENING_NOTICE;
}

/** 画面の見出しへ添える短い状態表示（`CasinoStatus` の「営業中」と併記しない） */
export function openingBadge(services: Services): string {
  const phase = openingPhase(services);
  if (phase === "formal") return "🟢 正式開業（1 Ld = 1 chip）";
  if (phase === "unknown") return "⚠️ 版が異常（全操作停止）";
  return "🚧 正式開業準備中（資金操作は停止中）";
}

/**
 * 稼働状態の表示文。**`open` でも正式開業前なら「営業中」と言わない**（項目8）。
 * 稼働状態が `open` 以外なら、そちらの理由の方が利用者に近いので優先する。
 */
export function operatingLabel(services: Services): string {
  const status = services.casinoStatus.current().status;
  if (status !== "open") return `⛔ ${status}`;
  return openingBadge(services);
}

/**
 * 正式開業前・未知版なら専用の ephemeral を返して true（＝呼び出し側は処理を中止）。
 *
 * `denyIfCasinoClosed` と同じ形にしてあるので、入口で並べて呼べる。
 * generic な「処理に失敗しました」ではなく、**なぜ今できないか**を必ず出す。
 */
export async function denyIfOpeningIncomplete(interaction: unknown, services: Services): Promise<boolean> {
  if (isFormallyOpen(services)) return false;
  await replyEphemeral(interaction, openingNotice(services));
  return true;
}

/** 応答できない状況（期限切れ・非 repliable）でも「通さない」ことが目的なので握り潰す */
async function replyEphemeral(interaction: unknown, content: string): Promise<void> {
  const repliable = interaction as RepliableInteraction;
  if (!repliable || typeof repliable.reply !== "function") return;
  try {
    if (repliable.replied || repliable.deferred) {
      await repliable.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await repliable.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    /* 応答期限切れ等。処理を通さないことは既に達成できている */
  }
}

/**
 * `ChipLedgerError` を利用者向けの文言へ変換する（PR8監査・項目11）。
 *
 * `switch` を**網羅**させ、`as never` も既定の握り潰しも置かない。コードを増やしたときに
 * 「文言を書き忘れたまま generic メッセージへ落ちる」のをコンパイル時に検出させる。
 */
export function describeChipLedgerError(e: ChipLedgerError, services: Services, holderId?: string): string {
  switch (e.code) {
    case "ERR_BAD_AMOUNT":
      return "金額が正しくない。1 以上の整数で、桁が大きすぎない額を入れてくれ。";
    case "ERR_BAD_IDENTIFIER":
      return "宛先か操作の識別子が空だ。もう一度やり直してくれ。";
    case "ERR_INSUFFICIENT_CHIPS": {
      const held = typeof e.meta.held === "number" ? e.meta.held : holderId ? services.chips.balanceOf(holderId) : 0;
      return `チップが足りない（所持 ${fmtEther(held)}）。`;
    }
    case "ERR_DUPLICATE":
      return "この操作はすでに処理済みだ。二重には受け付けない。";
    case "ERR_RESERVED_FUNDS": {
      const settleable = typeof e.meta.settleable === "number" ? e.meta.settleable : 0;
      const reserved = typeof e.meta.reserved === "number" ? e.meta.reserved : 0;
      return `進行中ゲームの予約 ${fmtEther(reserved)} は精算できない（いま精算できるのは ${fmtEther(settleable)} まで）。`;
    }
    case "ERR_SELF_TRANSFER":
      return "同じ相手へは移せない。";
    case "ERR_CASINO_OPENING_NOT_COMPLETE":
      return PRE_OPENING_NOTICE;
    case "ERR_UNKNOWN_OPENING_VERSION":
      return UNKNOWN_OPENING_NOTICE;
    case "ERR_CORRUPT_BALANCE":
      return "帳簿の値が壊れている。安全のため操作を止めた。支配人へ連絡してくれ。";
  }
}

/** Land 不足など、賭場の外側の理由も含めた最終文言をまとめたい呼び出し口用 */
export function landShortfallMessage(services: Services, userId: string): string {
  return `Land が足りない（所持 ${fmtLd(services.ledger.balanceOf(`user:${userId}`))}）。`;
}
