import { describe, expect, it } from "vitest";
import type { RankedTableSnapshot } from "@meigokujo/core";
import { isRankedTableButton, isRankedTableModal, renderRankedTable } from "../src/casino/ranked-table-ui.js";

function snapshot(state: RankedTableSnapshot["table"]["state"]): RankedTableSnapshot {
  return {
    table: {
      tableId: "t1",
      state,
      gameKey: "gf",
      creatorId: "op",
      operatorId: "op",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      createdAt: 1,
      updatedAt: 1,
      stateChangedAt: 1,
      startedAt: state === "playing" ? 2 : null,
      deadlineAt: null,
      expiresAt: null,
      revision: 3,
      operationId: "create",
      requestFingerprint: "{}",
      failureReason: null,
      disputeReason: null,
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
        tableId: "t1",
        userId: "alice",
        seat: 1,
        joinedAt: 1,
        operationId: "join:a",
        requestFingerprint: "{}",
        readyState: state === "ready_check" ? "ready" : null,
        approvalState: state === "pending_approval" ? "approved" : null,
        participantState: "active",
        readyOperationId: null,
        readyFingerprint: null,
        approvalOperationId: null,
        approvalFingerprint: null,
        declinedAt: null,
      },
    ],
    result: state === "pending_approval" ? { orderedUserIds: ["alice", "bob"], hash: "abcdef0123456789", submittedBy: "alice", submittedAt: 2 } : null,
  };
}

describe("ranked table UI", () => {
  it("renders canonical controls for each participant state", () => {
    expect(renderRankedTable(snapshot("recruiting")).components[0]!.components[0]!.data.custom_id).toBe("rtbl:join:t1:2");
    expect(renderRankedTable(snapshot("ready_check")).components[0]!.components.map((b) => b.data.custom_id)).toEqual(["rtbl:ready:t1", "rtbl:decline:t1"]);
    expect(renderRankedTable(snapshot("playing")).components[0]!.components[0]!.data.custom_id).toBe("rtbl:result:t1");
    expect(renderRankedTable(snapshot("pending_approval")).components[0]!.components.map((b) => b.data.custom_id)).toEqual(["rtbl:approve:t1", "rtbl:dispute:t1"]);
    expect(renderRankedTable(snapshot("disputed")).components).toEqual([]);
  });

  it("claims only ranked table button and modal prefixes", () => {
    expect(isRankedTableButton("rtbl:ready:t1")).toBe(true);
    expect(isRankedTableButton("casino:home:open")).toBe(false);
    expect(isRankedTableModal("rtbl:result-modal:t1")).toBe(true);
    expect(isRankedTableModal("rtbl:result:t1")).toBe(false);
  });
});
