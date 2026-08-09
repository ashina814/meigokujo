import { describe, expect, it, vi } from "vitest";
import type { RankedDisputePublicStatus, RankedTableSnapshot } from "@meigokujo/core";

const recoveryMocks = vi.hoisted(() => ({
  recoverCasinoAsync: vi.fn(),
}));

vi.mock("@meigokujo/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meigokujo/core")>();
  return {
    ...actual,
    recoverCasinoAsync: recoveryMocks.recoverCasinoAsync,
  };
});

import { recoverCasinoWithPersistentTables } from "../src/casino/persistent-table-recovery.js";

function terminalSnapshot(): RankedTableSnapshot {
  return {
    table: {
      tableId: "terminal-t1",
      state: "cancelled",
      gameKey: "gf",
      creatorId: "operator",
      operatorId: "operator",
      guildId: "guild",
      channelId: "channel",
      messageId: "message",
      createdAt: 1,
      updatedAt: 2,
      stateChangedAt: 2,
      startedAt: 2,
      deadlineAt: null,
      expiresAt: null,
      revision: 9,
      operationId: "create",
      requestFingerprint: "{}",
      failureReason: null,
      disputeReason: "insufficient evidence",
      recoveryError: null,
    },
    config: {
      baseAmount: 5_000,
      feePerUser: 150,
      participantCount: 2,
      profile: { key: "gf", participantCount: 2, rankDeltaBps: [10_000, -10_000] },
    },
    participants: [
      {
        tableId: "terminal-t1",
        userId: "alice",
        seat: 1,
        joinedAt: 1,
        operationId: "join:alice",
        requestFingerprint: "{}",
        readyState: "ready",
        approvalState: "disputed",
        participantState: "active",
        readyOperationId: null,
        readyFingerprint: null,
        approvalOperationId: null,
        approvalFingerprint: null,
        declinedAt: null,
      },
      {
        tableId: "terminal-t1",
        userId: "bob",
        seat: 2,
        joinedAt: 1,
        operationId: "join:bob",
        requestFingerprint: "{}",
        readyState: "ready",
        approvalState: null,
        participantState: "active",
        readyOperationId: null,
        readyFingerprint: null,
        approvalOperationId: null,
        approvalFingerprint: null,
        declinedAt: null,
      },
    ],
    result: null,
  };
}

function terminalDispute(): RankedDisputePublicStatus {
  return {
    tableId: "terminal-t1",
    evidenceDeadlineAt: 1_700_259_200,
    evidenceClosedAt: 1_700_259_200,
    preStart: false,
    refundAmounts: [
      { userId: "alice", amount: 5_000 },
      { userId: "bob", amount: 5_000 },
    ],
    assignedArbitratorId: null,
    resolutionKind: "insufficient_evidence",
    feeOutcome: "keep",
    recordStats: false,
    publicSummary: "証拠不足",
    resolvedBy: "system:ranked-evidence-timeout",
    resolvedAt: 1_700_259_201,
  };
}

describe("PR22 startup durable ranked message sync", () => {
  it("restart retries a terminal pending canonical message even though S11 live-table restore does not list it", async () => {
    const listLiveTables = vi.fn(() => []);
    const markMessageSyncSucceeded = vi.fn();
    const markMessageSyncFailed = vi.fn();
    const edit = vi.fn(async () => undefined);
    const messageFetch = vi.fn(async () => ({ edit }));
    const client = {
      channels: {
        cache: new Map([["channel", { messages: { fetch: messageFetch } }]]),
        fetch: vi.fn(),
      },
    } as any;
    const services = {
      db: {},
      casinoStatus: {},
      casinoIntegrity: {},
      chipTx: {},
      escrow: {},
      reservations: {},
      recoveryRegistry: {},
      events: { log: vi.fn() },
      chipFlow: {},
      persistentTables: { listLiveTables },
      rankedTables: { snapshot: vi.fn(() => terminalSnapshot()) },
      rankedDisputes: {
        publicStatus: vi.fn(() => terminalDispute()),
        openForTable: vi.fn(),
        listMessageSyncPending: vi.fn(() => [
          { tableId: "terminal-t1", requestedAt: 1, attempts: 1, lastAttemptAt: 1, lastError: "transient Discord failure" },
        ]),
        markMessageSyncSucceeded,
        markMessageSyncFailed,
      },
    } as any;

    recoveryMocks.recoverCasinoAsync.mockImplementationOnce(async (input: { persistentTableRestore: () => Promise<unknown> }) => {
      await input.persistentTableRestore();
      return {
        outcome: "opened",
        reason: "ok",
        keptHolders: 0,
        refundedSessions: 0,
        refundedTotal: 0,
        quarantined: 0,
        mismatched: [],
        failedSessions: [],
        releasedReservations: { released: false, count: 0, total: 0 },
      } as any;
    });

    await recoverCasinoWithPersistentTables(client, services);

    expect(listLiveTables).toHaveBeenCalledTimes(1);
    expect(services.rankedDisputes.listMessageSyncPending).toHaveBeenCalledTimes(1);
    expect(services.rankedTables.snapshot).toHaveBeenCalledWith("terminal-t1");
    expect(messageFetch).toHaveBeenCalledWith("message");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(markMessageSyncSucceeded).toHaveBeenCalledWith("terminal-t1");
    expect(markMessageSyncFailed).not.toHaveBeenCalled();
  });
});
