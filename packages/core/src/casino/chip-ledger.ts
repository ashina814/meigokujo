/**
 * 賭場チップ API の互換入口（PR8監査・ブロッカーA）。
 *
 * 実装は `./exchange.js` の `ChipLedger` **一つだけ**で、正式開業ロックはそのクラスに
 * 組み込まれている。ここは既存の import パスを壊さないための再export に徹する。
 *
 * かつてはこのファイルがロックを掛け、`exchange.ts` 側にロックなしの派生クラスが
 * 残っていた。「production の call site が 0 件であること」を
 * ソース検査で担保していたが、迂回経路が存在するかぎり新しいコードが 1 行足すだけで
 * ロックを外せる。実装を一本化し、迂回経路そのものを削除してある。
 *
 * どの経路（package root / `./chip-ledger.js` / `./exchange.js`）から import しても
 * 同じ `ChipLedger` を得る。正式開業前に資金を動かせるのは
 * chipTx の runMaintenance 区間だけ。
 */
export {
  ChipLedger,
  ChipLedgerError,
  EtherExchange,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  HOUSE_HOLDER,
  POOL_SWEEP_REASON,
  isPlayerHolder,
  type ChipLedgerOptions,
  type ChipLedgerErrorCode,
  type EtherExchangeOptions,
  type EtherErrorCode,
  type ChipQuote,
  type ChipMoveInfo,
} from "./exchange.js";
