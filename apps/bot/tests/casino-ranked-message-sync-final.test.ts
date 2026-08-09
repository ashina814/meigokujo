import { describe, expect, it, vi } from "vitest";
import type { RankedDisputePublicStatus, RankedTableSnapshot } from "@meigokujo/core";
import {
  editBoundRankedTableMessage,
  renderRankedTable,
  retryPendingRankedTableMessages,
} from "../src/casino/ranked-table-ui.js";

function snapshot(state: RankedTableSnapshot["table"]["state"], result = true): RankedTableSnapshot {
  return {
    table: {
      tableId: "t1",
      state,
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
      revision: 8,
      operationId: "create",
      requestFingerprint: "{}",
      failureReason: null,
      disputeReason: "disputed",
      recoveryError: null,
    },
    config: {
      baseAmount: 5_000,
      feePerUser: 150,
      participantCount: 2,
      profile: { key: "gf", participantCount: 2, rankDeltaBps: [10_000, -10_000] },
    },
    participants: [
      { tableId: "t1", userId: "alice", seat: 1, joinedAt: 1, operationId: "j:a", requestFingerprint: "{}", readyState: "ready", approvalState: "disputed", participantState: "active", readyOperationId: null, readyFingerprint: null, approvalOperationId: null, approvalFingerprint: null, declinedAt: null },
      { tableId: "t1", userId: "bob", seat: 2, joinedAt: 1, operationId: "j:b", requestFingerprint: "{}", readyState: "ready", approvalState: null, participantState: "active", readyOperationId: null, readyFingerprint: null, approvalOperationId: null, approvalFingerprint: null, declinedAt: null },
    ],
    result: result ? { orderedUserIds: ["alice", "bob"], hash: "abcdef0123456789", submittedBy: "judge", submittedAt: 3 } : null,
  };
}

function status(patch: Partial<RankedDisputePublicStatus> = {}): RankedDisputePublicStatus {
  return {
    tableId: "t1",
    evidenceDeadlineAt: 1_700_259_200,
    evidenceClosedAt: 1_700_259_200,
    preStart: false,
    refundAmounts: null,
    assignedArbitratorId: "judge",
    resolutionKind: "ranked_result",
    feeOutcome: "keep",
    recordStats: true,
    publicSummary: "短い公開理由",
    resolvedBy: "123456789",
    resolvedAt: 1_700_259_201,
    ...patch,
  };
}

function services(snap: RankedTableSnapshot, dispute: RankedDisputePublicStatus) {
  return {
    rankedTables: { snapshot: vi.fn(() => snap) },
    rankedDisputes: {
      publicStatus: vi.fn(() => dispute),
      listMessageSyncPending: vi.fn(() => [{ tableId: "t1", requestedAt: 1, attempts: 0, lastAttemptAt: null, lastError: null }]),
      markMessageSyncSucceeded: vi.fn(),
      markMessageSyncFailed: vi.fn(),
    },
    events: { log: vi.fn() },
  } as any;
}

describe("PR22 final review public receipts and durable Discord sync", () => {
  it("public ranked_result derives the final distribution from the canonical rank profile", () => {
    const payload = renderRankedTable(snapshot("settled"), status());
    const text = payload.embeds[0]!.data.description!;
    expect(text).toContain("1位 <@alice> — 10,000 Ld");
    expect(text).toContain("2位 <@bob> — 0 Ld");
    expect(text).toContain("場代: 保持（keep）");
    expect(text).toContain("理由: 短い公開理由");
    expect(text).toContain("裁定者: <@123456789>");
    expect(text).toContain("日時: <t:1700259201:f>");
  });

  it("public collateral refund contains per-participant actual refund amounts and Japanese fee outcome", () => {
    const payload = renderRankedTable(snapshot("cancelled", false), status({
      resolutionKind: "refund_collateral",
      feeOutcome: "keep",
      preStart: true,
      refundAmounts: [
        { userId: "alice", amount: 5_150 },
        { userId: "bob", amount: 5_150 },
      ],
    }));
    const text = payload.embeds[0]!.data.description!;
    expect(text).toContain("<@alice> — 5,150 Ld");
    expect(text).toContain("<@bob> — 5,150 Ld");
    expect(text).toContain("場代: 対局開始前のため未確定（預託分を全額返金）");
  });

  it("renderer never emits raw evidence fields", () => {
    const dispute = status() as RankedDisputePublicStatus & { privateChannelId: string; privateMessageId: string; payloadDigest: string; evidenceUrl: string };
    dispute.privateChannelId = "secret-channel";
    dispute.privateMessageId = "secret-message";
    dispute.payloadDigest = "secret-digest";
    dispute.evidenceUrl = "https://example.invalid/raw-evidence";
    const raw = JSON.stringify(renderRankedTable(snapshot("settled"), dispute));
    expect(raw).not.toContain("secret-channel");
    expect(raw).not.toContain("secret-message");
    expect(raw).not.toContain("secret-digest");
    expect(raw).not.toContain("example.invalid");
  });

  it("successful Discord edit clears pending only after edit succeeds", async () => {
    const snap = snapshot("settled");
    const dispute = status();
    const svc = services(snap, dispute);
    const edit = vi.fn(async () => undefined);
    const client = { channels: { cache: new Map([["channel", { messages: { fetch: vi.fn(async () => ({ edit })) } }]]), fetch: vi.fn() } } as any;

    await expect(editBoundRankedTableMessage(client, svc, "t1")).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(svc.rankedDisputes.markMessageSyncSucceeded).toHaveBeenCalledWith("t1");
    expect(svc.rankedDisputes.markMessageSyncFailed).not.toHaveBeenCalled();
  });

  it("failed Discord edit preserves pending and never rolls back the committed state", async () => {
    const snap = snapshot("settled");
    const dispute = status();
    const svc = services(snap, dispute);
    const error = new Error("transient Discord failure");
    const edit = vi.fn(async () => { throw error; });
    const client = { channels: { cache: new Map([["channel", { messages: { fetch: vi.fn(async () => ({ edit })) } }]]), fetch: vi.fn() } } as any;

    await expect(editBoundRankedTableMessage(client, svc, "t1")).resolves.toBe(false);
    expect(svc.rankedDisputes.markMessageSyncSucceeded).not.toHaveBeenCalled();
    expect(svc.rankedDisputes.markMessageSyncFailed).toHaveBeenCalledWith("t1", error);
    expect(svc.rankedTables.snapshot("t1").table.state).toBe("settled");
  });

  it("pending retry includes terminal tables without listLiveTables", async () => {
    const snap = snapshot("cancelled", false);
    const dispute = status({
      resolutionKind: "insufficient_evidence",
      refundAmounts: [
        { userId: "alice", amount: 5_000 },
        { userId: "bob", amount: 5_000 },
      ],
    });
    const svc = services(snap, dispute);
    const edit = vi.fn(async () => undefined);
    const client = { channels: { cache: new Map([["channel", { messages: { fetch: vi.fn(async () => ({ edit })) } }]]), fetch: vi.fn() } } as any;

    await expect(retryPendingRankedTableMessages(client, svc)).resolves.toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(svc.rankedDisputes.markMessageSyncSucceeded).toHaveBeenCalledWith("t1");
  });
});
