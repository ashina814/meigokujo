import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import {
  ChipLedgerCore as BaseChipLedger,
  ChipLedgerError,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  HOUSE_HOLDER,
  POOL_SWEEP_REASON,
  isPlayerHolder,
  type ChipLedgerOptions as BaseChipLedgerOptions,
  type ChipLedgerErrorCode,
  type ChipQuote,
  type ChipMoveInfo,
} from "./exchange.js";
import { FORMAL_OPENING_VERSION } from "./chip-tx.js";

/**
 * クラスへprivate/protectedメンバーを増やすと、旧`exchange.ts`のEtherExchangeと
 * 構造互換でなくなる。段階移行中の既存コードを壊さずロック状態を持つため、外部WeakMapを使う。
 */
const OPENING_REQUIRED_BY_LEDGER = new WeakMap<BaseChipLedger, boolean>();

/**
 * 新しい賭場チップ API の公開入口。**これが唯一の正式実装**（PR8監査・ブロッカーA）。
 *
 * 正式開業初期化が`opening_v1`を確定するまで、新しい資金グループをcore層で拒否する。
 * 復旧・正式開業初期化の `runMaintenance()`区間だけは、このロック中でも実行できる。
 *
 * **secure default**: `requireOpeningV1` は既定で `true`。構築側が明示的に
 * `false` を渡さない限り、正式開業前の資金操作は必ず core 層で止まる
 * （オプション指定忘れで開業前チェックが素通りする、を構造的に防ぐ）。
 * テストで正式開業前の1:1資金操作そのものを検証したい場合だけ、明示的に
 * `requireOpeningV1: false` を渡すこと（何を無効化しているかがコード上に必ず残る）。
 */
export interface ChipLedgerOptions extends BaseChipLedgerOptions {
  requireOpeningV1?: boolean;
}

const OPENING_REQUIRED: ChipLedgerErrorCode = "ERR_CASINO_OPENING_NOT_COMPLETE";

function assertOpeningReady(
  ledger: BaseChipLedger,
  input: { groupKey: string; kind: string; actorId: string },
): void {
  if (!OPENING_REQUIRED_BY_LEDGER.get(ledger) || ledger.chipTx.isMaintenance()) return;
  const version = ledger.chipTx.currentVersion();
  if (version === FORMAL_OPENING_VERSION) return;
  throw new ChipLedgerError(OPENING_REQUIRED, {
    version,
    requiredVersion: FORMAL_OPENING_VERSION,
    ...input,
  });
}

export class ChipLedger extends BaseChipLedger {
  constructor(db: Database.Database, ledger: Ledger, events: EventLog, options: ChipLedgerOptions = {}) {
    super(db, ledger, events, options);
    OPENING_REQUIRED_BY_LEDGER.set(this, options.requireOpeningV1 ?? true);
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
  ChipLedgerError,
  CHIP_ESCROW,
  ETHER_ESCROW,
  ETHER_APPROVER,
  HOUSE_HOLDER,
  POOL_SWEEP_REASON,
  isPlayerHolder,
  type ChipLedgerErrorCode,
  type ChipQuote,
  type ChipMoveInfo,
};
