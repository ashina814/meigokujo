import { ChipLedgerError, type UserChipAssets } from "@meigokujo/core";
import type { Services } from "../services.js";
import { openingPhase } from "./opening.js";

/**
 * 財布の「利用可能額」判定結果（正本 §4.3・PR13監査）。
 *
 * `/案内` `/プロフィール` `/通行証` が別々に opening phase 判定と合算を実装すると
 * 表示がずれるため（実際に `/案内` は fail-closed だったが `/プロフィール` `/通行証` は
 * opening phase を見ずに常時合算していた）、判定・合算をこのモジュールへ一本化する。
 *
 * - `formal` のときだけ自由チップを利用可能額へ合算する。
 * - 卓・板への escrow は利用可能額へ含めない（`escrowed` は別枠で返す）。
 * - チップ帳簿が読めない・合算が safe integer を外れる場合は、破損値を0扱いにしたり
 *   捏造した合算値を出したりせず、確認できている通常Landだけを返す（fail-closed）。
 */
export type AvailableWalletStatus = "formal" | "pre_opening" | "unknown" | "ledger_error" | "overflow";

export interface AvailableWalletSnapshot {
  status: AvailableWalletStatus;
  /** 利用可能額。`status !== "formal"` のときは通常Landのみ */
  available: number;
  /** 通常Land（常に確認できている値） */
  land: number;
  /** `status === "formal"` のときだけ非null */
  freeChips: number | null;
  /** `status === "formal"` のときだけ非null。卓・板への預け中（利用可能額に含まない） */
  escrowed: number | null;
}

/**
 * 読み取り専用。台帳・status は一切変更しない。
 */
export function readAvailableWallet(services: Services, userId: string): AvailableWalletSnapshot {
  const land = services.ledger.balanceOf(`user:${userId}`);
  const phase = openingPhase(services);
  if (phase !== "formal") {
    return {
      status: phase === "unknown" ? "unknown" : "pre_opening",
      available: land,
      land,
      freeChips: null,
      escrowed: null,
    };
  }

  let assets: UserChipAssets;
  try {
    assets = services.chipAssets.forUser(userId);
  } catch (e) {
    if (!(e instanceof ChipLedgerError)) throw e;
    return { status: "ledger_error", available: land, land, freeChips: null, escrowed: null };
  }

  const total = land + assets.freeChips;
  if (!Number.isSafeInteger(total)) {
    return { status: "overflow", available: land, land, freeChips: null, escrowed: null };
  }

  return { status: "formal", available: total, land, freeChips: assets.freeChips, escrowed: assets.escrowed };
}
