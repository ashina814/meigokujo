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
 *
 * production は全サービスで共有する `ChipTx` を渡す。その場合、正式開業初期化が
 * `opening_v1` を確定するまで、新しい資金グループを core 層で拒否する。
 * 復旧・正式開業初期化の `runMaintenance()` 区間だけは、このロック中でも実行できる。
 */
export interface ChipLedgerOptions extends BaseChipLedgerOptions {
  requireOpeningV1?: boolean;
}

export class ChipLedger extends BaseChipLedger {
  private readonly requireOpeningV1: boolean;

  constructor(
    db: Database.Database,
    ledger: Ledger,
    events: EventLog,
    options: ChipLedgerOptions = {},
  ) {
    super(db, ledger, events, options);
    this.requireOpeningV1 = options.requireOpeningV1 ?? options.chipTx !== undefined;
  }

  private assertOpeningReady(input: { groupKey: string; kind: string; actorId: string }): void {
    if (!this.requireOpeningV1) return;
    if (this.chipTx.isMaintenance()) return;
    const version = this.chipTx.currentVersion();
    if (version === FORMAL_OPENING_VERSION) return;
    throw new EtherError(OPENING_REQUIRED as never, {
      version,
      requiredVersion: FORMAL_OPENING_VERSION,
      groupKey: input.groupKey,
      kind: input.kind,
      actorId: input.actorId,
    });
  }

  override runGroup<T>(input: { groupKey: string; kind: string; actorId: string }, body: () => T): T {
    return super.runGroup(input, () => {
      this.assertOpeningReady(input);
      return body();
    });
  }
}

/** @deprecated `ChipLedger` を使うこと。変動レートの振る舞いは復活させない。 */
export interface EtherExchangeOptions extends ChipLedgerOptions {
  baseRate?: number | (() => number);
}

/** @deprecated 旧プラグイン向けの互換名。新規コードでは使用しない。 */
export class EtherExchange extends ChipLedger {
  constructor(db: Database.Database, ledger: Ledger, events: EventLog, options: EtherExchangeOptions = {}) {
    super(db, ledger, events, options);
  }

  buy(userId: string, landIn: number, idempotencyKey: string): ChipQuote {
    return this.deposit(userId, landIn, idempotencyKey);
  }

  sell(userId: string, chipsIn: number, idempotencyKey: string): ChipQuote {
    return this.redeem(userId, chipsIn, idempotencyKey);
  }

  quoteBuy(landIn: number): ChipQuote {
    return this.quoteDeposit(landIn);
  }

  quoteSell(chipsIn: number): ChipQuote {
    return this.quoteRedeem(chipsIn);
  }

  rate(): number {
    return 1;
  }
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
