import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import {
  ChipLedger as BaseChipLedger,
  EtherError,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  HOUSE_HOLDER,
  isPlayerHolder,
  type ChipLedgerOptions as BaseChipLedgerOptions,
  type ChipQuote,
  type ChipMoveInfo,
} from "./exchange.js";

const FORMAL_OPENING_VERSION = "opening_v1";
const OPENING_REQUIRED = "ERR_CASINO_OPENING_NOT_COMPLETE";
/**
 * クラスへprivate/protectedメンバーを増やすと、旧`exchange.ts`のEtherExchangeと
 * 構造互換でなくなる。段階移行中の既存コードを壊さずロック状態を持つため、外部WeakMapを使う。
 */
const OPENING_REQUIRED_BY_LEDGER = new WeakMap<BaseChipLedger, boolean>();

/**
 * 新しい賭場チップ API の公開入口。
 *
 * production は `requireOpeningV1: true` を明示する。正式開業初期化が`opening_v1`を
 * 確定するまで、新しい資金グループをcore層で拒否する。復旧・正式開業初期化の
 * `runMaintenance()`区間だけは、このロック中でも実行できる。
 */
export interface ChipLedgerOptions extends BaseChipLedgerOptions {
  requireOpeningV1?: boolean;
}

function assertOpeningReady(
  ledger: BaseChipLedger,
  input: { groupKey: string; kind: string; actorId: string },
): void {
  if (!OPENING_REQUIRED_BY_LEDGER.get(ledger) || ledger.chipTx.isMaintenance()) return;
  const version = ledger.chipTx.currentVersion();
  if (version === FORMAL_OPENING_VERSION) return;
  throw new EtherError(OPENING_REQUIRED as never, {
    version,
    requiredVersion: FORMAL_OPENING_VERSION,
    ...input,
  });
}

export class ChipLedger extends BaseChipLedger {
  constructor(db: Database.Database, ledger: Ledger, events: EventLog, options: ChipLedgerOptions = {}) {
    super(db, ledger, events, options);
    OPENING_REQUIRED_BY_LEDGER.set(this, options.requireOpeningV1 ?? false);
  }

  override runGroup<T>(input: { groupKey: string; kind: string; actorId: string }, body: () => T): T {
    return super.runGroup(input, () => {
      assertOpeningReady(this, input);
      return body();
    });
  }
}

export interface EtherExchangeOptions extends ChipLedgerOptions {
  /** @deprecated 1:1固定のため無視される。 */
  baseRate?: number | (() => number);
}

/** @deprecated `ChipLedger` を使うこと。 */
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
  HOUSE_HOLDER,
  isPlayerHolder,
  type ChipQuote,
  type ChipMoveInfo,
};
