import { randomUUID } from "node:crypto";
import {
  ChipLedger,
  ChipLedgerError,
  Escrow,
  isPlayerHolder,
  type CasinoChipFlow,
  type Ledger,
} from "@meigokujo/core";

/**
 * Discord から見える「使える Land」を、通常 Land + 自由チップで統一する互換層。
 *
 * チップ台帳そのものの意味は変えない。`freeChips()` や system holder の `balanceOf()` は
 * 従来どおり実チップだけを返し、利用者本人の `balanceOf()` と支払い元になった
 * `transfer()` だけを formal opening 中に拡張する。
 */
function nextAutoFundOperationId(): string {
  // CasinoChipFlow.ensureFreeChips() の operationId は ':' 禁止。
  // outer group の replay 時は body 自体が再実行されないため、fresh 実行ごとに世界で一意な値でよい。
  // プロセス再起動で連番が巻き戻ると Ledger の冪等キーを再利用しうるので UUID を10進数化する。
  const hex = randomUUID().replaceAll("-", "");
  return `walletautofund${BigInt(`0x${hex}`).toString(10)}`;
}

function isFormal(chips: ChipLedger): boolean {
  return chips.chipTx.openingPhase() === "formal";
}

function spendableBalance(chips: ChipLedger, ledger: Ledger, holderId: string): number {
  const free = chips.balanceOf(holderId);
  if (!isFormal(chips) || !isPlayerHolder(holderId)) return free;

  const land = ledger.balanceOf(`user:${holderId}`);
  const total = free + land;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ChipLedgerError("ERR_CORRUPT_BALANCE", { holderId, free, land, total });
  }
  return total;
}

function fundPlayerIfNeeded(
  chips: ChipLedger,
  ledger: Ledger,
  chipFlow: CasinoChipFlow,
  userId: string,
  required: number,
): void {
  if (!isFormal(chips) || !isPlayerHolder(userId)) return;
  const free = chips.balanceOf(userId);
  if (free >= required) return;

  // 足りない総額なら deposit を試さず、既存の transfer/escrow 側の不足エラーに任せる。
  if (spendableBalance(chips, ledger, userId) < required) return;
  chipFlow.ensureFreeChips(userId, required, nextAutoFundOperationId());
}

/**
 * 利用者向けの `services.chips` と、Casino / Daily / VIP / Markets 等へ渡す ChipLedger。
 *
 * `transfer()` での自動預入は**既に chip group が開いている時だけ**行う。
 * 単独で Land→chip だけを確定させて後段が失敗する窓を作らないため。
 */
export function createSpendableChipLedger(
  chips: ChipLedger,
  ledger: Ledger,
  chipFlow: CasinoChipFlow,
): ChipLedger {
  const balanceOf = (holderId: string): number => spendableBalance(chips, ledger, holderId);

  const transfer = (...args: Parameters<ChipLedger["transfer"]>): ReturnType<ChipLedger["transfer"]> => {
    const [fromHolderId, toHolderId, amount, move] = args;
    if (chips.chipTx.isActive()) {
      fundPlayerIfNeeded(chips, ledger, chipFlow, fromHolderId, amount);
    }
    return chips.transfer(fromHolderId, toHolderId, amount, move);
  };

  return new Proxy(chips, {
    get(target, prop) {
      if (prop === "balanceOf") return balanceOf;
      if (prop === "transfer") return transfer;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

class WalletShortfall extends Error {
  constructor(readonly userId: string) {
    super(`wallet shortfall: ${userId}`);
    this.name = "WalletShortfall";
  }
}

interface FundedHoldStored {
  kind: "hold";
  sessionId: string;
  userId: string;
  amount: number;
  game: string;
  ok: true;
}

interface FundedHoldAllStored {
  kind: "holdAll";
  sessionId: string;
  participants: string[];
  amount: number;
  game: string;
  ok: true;
}

function sameParticipants(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertHoldReplay(stored: FundedHoldStored, requested: FundedHoldStored): void {
  if (
    stored.kind !== requested.kind ||
    stored.sessionId !== requested.sessionId ||
    stored.userId !== requested.userId ||
    stored.amount !== requested.amount ||
    stored.game !== requested.game ||
    stored.ok !== true
  ) {
    throw new Error(`funded escrow operation conflict: stored ${JSON.stringify(stored)} != requested ${JSON.stringify(requested)}`);
  }
}

function assertHoldAllReplay(stored: FundedHoldAllStored, requested: FundedHoldAllStored): void {
  if (
    stored.kind !== requested.kind ||
    stored.sessionId !== requested.sessionId ||
    stored.amount !== requested.amount ||
    stored.game !== requested.game ||
    stored.ok !== true ||
    !sameParticipants(stored.participants, requested.participants)
  ) {
    throw new Error(`funded escrow operation conflict: stored ${JSON.stringify(stored)} != requested ${JSON.stringify(requested)}`);
  }
}

function assertNoDuplicateParticipants(userIds: readonly string[], context: string): void {
  if (new Set(userIds).size !== userIds.length) {
    throw new Error(`${context}: duplicate userId in participant list`);
  }
}

/**
 * funding wrapper の outer group に、要求した預託だけが正しく記録されたことを確認する。
 * auto-deposit の `deposit` 行は許すが、`internal_transfer` は参加者1人につき厳密に1件。
 * fresh 実行では COMMIT 前に呼ぶので、不一致なら Land 預入を含めて全体を rollback できる。
 */
function assertFundedEscrowLedger(
  chips: ChipLedger,
  groupKey: string,
  holderId: string,
  sessionId: string,
  participants: readonly string[],
  amount: number,
  game: string,
): void {
  const internal = chips.chipTx.listByGroup(groupKey).filter((row) => row.tx_kind === "internal_transfer");
  if (internal.length !== participants.length) {
    throw new Error(`funded escrow ledger mismatch: ${groupKey} expected ${participants.length} transfers, got ${internal.length}`);
  }

  for (const userId of participants) {
    const matches = internal.filter(
      (row) =>
        row.from_holder === userId &&
        row.to_holder === holderId &&
        row.amount === amount &&
        row.game === game &&
        row.session_id === sessionId,
    );
    if (matches.length !== 1) {
      throw new Error(`funded escrow ledger mismatch: ${groupKey} participant ${userId} has ${matches.length} matching transfers`);
    }
  }
}

/**
 * Escrow の hold/holdAll だけに「不足分の Land を同一 transaction 内で預入」を足す。
 *
 * Escrow 本体を spendable ChipLedger で直接構築しないのは、Escrow の非 nested hold が
 * `casino_tx` を「internal_transfer がちょうど1件（holdAll は人数件）」と監査しているため。
 * auto-deposit の deposit 行まで同じ raw group に混ぜると、その監査を壊してしまう。
 *
 * そこで外側に funding group を作り、raw Escrow は nested として実行する。Land→chip、
 * 全員分の hold、casino_escrow 更新まで同じ SQLite transaction に入り、どこかで失敗すれば
 * 全部 rollback される。
 */
export function createFundedEscrow(
  escrow: Escrow,
  chips: ChipLedger,
  ledger: Ledger,
  chipFlow: CasinoChipFlow,
): Escrow {
  const hold = (
    sessionId: string,
    userId: string,
    amount: number,
    game: string,
    operationId: string,
  ): boolean => {
    if (!Number.isInteger(amount) || amount <= 0) return false;

    const legacyGroupKey = `escrow:hold:${sessionId}:${userId}:${operationId}`;
    if (chips.chipTx.hasGroup(legacyGroupKey)) {
      // 旧コードで既に確定した fingerprint / casino_tx の検証を raw Escrow に任せる。
      // active group 内で raw replay を呼ぶと ChipTx の nested 規則により body が再実行されるため拒否。
      if (chips.chipTx.isActive()) {
        throw new Error(`legacy escrow replay cannot run nested: ${legacyGroupKey}`);
      }
      return escrow.hold(sessionId, userId, amount, game, operationId);
    }

    const runFresh = (): boolean => {
      if (spendableBalance(chips, ledger, userId) < amount) return false;
      fundPlayerIfNeeded(chips, ledger, chipFlow, userId, amount);
      const ok = escrow.hold(sessionId, userId, amount, game, operationId);
      if (!ok) {
        // funding 後の false を成功 transaction として commit しない。
        throw new Error(`funded escrow invariant failed after funding: ${sessionId}:${userId}`);
      }
      return true;
    };

    if (chips.chipTx.isActive()) return runFresh();

    const requested: FundedHoldStored = { kind: "hold", sessionId, userId, amount, game, ok: true };
    const wrapperGroupKey = `wallet:escrow:hold:${sessionId}:${userId}:${operationId}`;
    try {
      const stored = chips.runGroup(
        { groupKey: wrapperGroupKey, kind: "table_hold", actorId: userId },
        (): FundedHoldStored => {
          if (!runFresh()) throw new WalletShortfall(userId);
          assertFundedEscrowLedger(
            chips,
            wrapperGroupKey,
            escrow.holderId(sessionId),
            sessionId,
            [userId],
            amount,
            game,
          );
          return requested;
        },
      );
      assertHoldReplay(stored, requested);
      // replay 時もDB上の実記録を照合し、result_json だけ正しい壊れ方をfail-closedする。
      assertFundedEscrowLedger(
        chips,
        wrapperGroupKey,
        escrow.holderId(sessionId),
        sessionId,
        [userId],
        amount,
        game,
      );
      return true;
    } catch (error) {
      if (error instanceof WalletShortfall) return false;
      throw error;
    }
  };

  const holdAll = (
    sessionId: string,
    userIds: readonly string[],
    amount: number,
    game: string,
    operationId: string,
  ): boolean => {
    assertNoDuplicateParticipants(userIds, `funded escrow holdAll ${sessionId}:${operationId}`);
    if (!Number.isInteger(amount) || amount <= 0) return false;

    const legacyGroupKey = `escrow:hold_all:${sessionId}:${operationId}`;
    if (chips.chipTx.hasGroup(legacyGroupKey)) {
      if (chips.chipTx.isActive()) {
        throw new Error(`legacy escrow replay cannot run nested: ${legacyGroupKey}`);
      }
      return escrow.holdAll(sessionId, userIds, amount, game, operationId);
    }

    const participants = [...userIds].sort();
    const runFresh = (): boolean => {
      // 誰か1人でも総所持額が足りないなら、誰にも auto-deposit しない。
      for (const userId of participants) {
        if (spendableBalance(chips, ledger, userId) < amount) return false;
      }
      for (const userId of participants) {
        fundPlayerIfNeeded(chips, ledger, chipFlow, userId, amount);
      }
      const ok = escrow.holdAll(sessionId, participants, amount, game, operationId);
      if (!ok) {
        throw new Error(`funded escrow invariant failed after funding: ${sessionId}`);
      }
      return true;
    };

    if (chips.chipTx.isActive()) return runFresh();

    const requested: FundedHoldAllStored = {
      kind: "holdAll",
      sessionId,
      participants,
      amount,
      game,
      ok: true,
    };
    const wrapperGroupKey = `wallet:escrow:hold_all:${sessionId}:${operationId}`;
    try {
      const stored = chips.runGroup(
        { groupKey: wrapperGroupKey, kind: "table_hold", actorId: "system:escrow" },
        (): FundedHoldAllStored => {
          if (!runFresh()) {
            // false を group result として保存すると、Land を得た後も永久に false replay される。
            throw new WalletShortfall(participants.find((u) => spendableBalance(chips, ledger, u) < amount) ?? "unknown");
          }
          assertFundedEscrowLedger(
            chips,
            wrapperGroupKey,
            escrow.holderId(sessionId),
            sessionId,
            participants,
            amount,
            game,
          );
          return requested;
        },
      );
      assertHoldAllReplay(stored, requested);
      assertFundedEscrowLedger(
        chips,
        wrapperGroupKey,
        escrow.holderId(sessionId),
        sessionId,
        participants,
        amount,
        game,
      );
      return true;
    } catch (error) {
      if (error instanceof WalletShortfall) return false;
      throw error;
    }
  };

  return new Proxy(escrow, {
    get(target, prop) {
      if (prop === "hold") return hold;
      if (prop === "holdAll") return holdAll;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
