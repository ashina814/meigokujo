/**
 * 新しい賭場チップ API の公開入口。
 *
 * 実装ファイル名 exchange.ts は移行済みデータを読むために残している。新規コードは必ず
 * この入口から `ChipLedger` を利用し、旧 EtherExchange 名を導入しない。
 */
export {
  ChipLedger,
  EtherError as ChipLedgerError,
  EtherExchange,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  HOUSE_HOLDER,
  isPlayerHolder,
  type ChipLedgerOptions,
  type ChipQuote,
  type ChipMoveInfo,
} from "./exchange.js";
