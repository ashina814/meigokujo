export type LedgerErrorCode =
  | "ERR_INSUFFICIENT"
  | "ERR_FROZEN"
  | "ERR_MINOR_BLOCKED"
  | "ERR_NEEDS_APPROVAL"
  | "ERR_UNKNOWN_TYPE"
  | "ERR_INVALID_AMOUNT"
  | "ERR_KIND_MISMATCH"
  | "ERR_ACCOUNT_NOT_FOUND"
  | "ERR_SELF_TRANSFER"
  | "ERR_TX_NOT_FOUND"
  | "ERR_ALREADY_REVERSED"
  | "ERR_REVERSAL_OF_REVERSAL";

/**
 * 台帳は型付きエラーだけを投げる。文言化（世界観テキスト）は packages/theme の仕事であり、
 * ここでは機械可読な code と details のみを持つ（経済設計.md §4 エラーモデル）。
 */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code} ${JSON.stringify(details)}`);
    this.name = "LedgerError";
  }
}
