import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import {
  ChipLedger as BaseChipLedger,
  EtherError,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  CASINO_DEPARTMENT_KEY,
  CASINO_DEPARTMENT,
  HOUSE_HOLDER,
  isPlayerHolder,
  type ChipLedgerOptions as BaseChipLedgerOptions,
  type ChipQuote,
  type ChipMoveInfo,
} from "./exchange.js";

const FORMAL_OPENING_VERSION = "opening_v1";
const OPENING_REQUIRED = "ERR_CASINO_OPENING_NOT_COMPLETE";

/**
 * 新しい賭場チップ API の公開入口。
 * productionでは共有ChipTxを使うため、opening_v1確定まで新規資金操作を拒否する。
 * テストではrequireOpeningV1を明示したケースだけ本番ロックを再現する。
 */
export interface ChipLedgerOptions extends BaseChipLedgerOptions {
  requireOpeningV1?: boolean;
}

export class ChipLedger extends BaseChipLedger {
  private readonly requireOpeningV1: boolean;

  constructor(db: Database.Database, ledger: Ledger, events: EventLog, options: ChipLedgerOptions = {}) {
    super(db, ledger, events, options);
    this.requireOpeningV1 = options.requireOpeningV1 ?? (options.chipTx !== undefined && process.env.NODE_ENV !== "test");
  }

  private assertOpeningReady(input: { groupKey: string; kind: string; actorId: string }): void {
    if (!this.requireOpeningV1 || this.chipTx.isMaintenance()) return;
    const version = this.chipTx.currentVersion();
    if (version === FORMAL_OPENING_VERSION) return;
    throw new EtherError(OPENING_REQUIRED as never, { version, requiredVersion: FORMAL_OPENING_VERSION, ...input });
  }

  override runGroup<T>(input: { groupKey: string; kind: string; actorId: string }, body: () => T): T {
    return super.runGroup(input, () => {
      this.assertOpeningReady(input);
      return body();
    });
  }
}

export interface EtherExchangeOptions extends ChipLedgerOptions { baseRate?: number | (() => number) }
/** @deprecated `ChipLedger` を使うこと。 */
export class EtherExchange extends ChipLedger {
  buy(userId: string, landIn: number, idempotencyKey: string): ChipQuote { return this.deposit(userId, landIn, idempotencyKey); }
  sell(userId: string, chipsIn: number, idempotencyKey: string): ChipQuote { return this.redeem(userId, chipsIn, idempotencyKey); }
  quoteBuy(landIn: number): ChipQuote { return this.quoteDeposit(landIn); }
  quoteSell(chipsIn: number): ChipQuote { return this.quoteRedeem(chipsIn); }
  rate(): number { return 1; }
}

export {
  EtherError as ChipLedgerError,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  CASINO_DEPARTMENT_KEY,
  CASINO_DEPARTMENT,
  HOUSE_HOLDER,
  isPlayerHolder,
  type ChipQuote,
  type ChipMoveInfo,
};
