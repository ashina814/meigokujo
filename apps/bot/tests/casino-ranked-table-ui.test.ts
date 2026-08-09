import { describe, expect, it } from "vitest";
import type { RankedTableSnapshot } from "@meigokujo/core";
import { vi } from "vitest";
import { handleRankedTableModal, isRankedTableButton, isRankedTableModal, renderRankedTable } from "../src/casino/ranked-table-ui.js";

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

  it("edits the canonical table message to pending approval after modal result submit", async () => {
    const edit = vi.fn(async () => undefined);
    const channel = { messages: { fetch: vi.fn(async () => ({ edit })) } };
    const services = {
      rankedTables: {
        submitResult: vi.fn(),
        snapshot: vi.fn(() => snapshot("pending_approval")),
      },
      events: { log: vi.fn() },
    };
    const interaction = {
      customId: "rtbl:result-modal:t1",
      id: "modal-1",
      user: { id: "alice" },
      fields: { getTextInputValue: vi.fn(() => "<@alice> bob") },
      client: { channels: { cache: new Map([["c", channel]]), fetch: vi.fn() } },
      isModalSubmit: () => true,
      reply: vi.fn(async () => undefined),
    };

    await handleRankedTableModal(interaction as any, services as any);

    expect(services.rankedTables.submitResult).toHaveBeenCalledWith({
      tableId: "t1",
      userId: "alice",
      orderedUserIds: ["alice", "bob"],
      operationId: "modal-1",
    });
    expect(edit).toHaveBeenCalledTimes(1);
    const payload = edit.mock.calls[0]![0] as ReturnType<typeof renderRankedTable>;
    expect(payload.components[0]!.components.map((button) => button.data.custom_id)).toEqual(["rtbl:approve:t1", "rtbl:dispute:t1"]);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("keeps the submitted result when canonical message edit fails", async () => {
    const edit = vi.fn(async () => { throw new Error("Discord edit failed"); });
    const channel = { messages: { fetch: vi.fn(async () => ({ edit })) } };
    const services = {
      rankedTables: {
        submitResult: vi.fn(),
        snapshot: vi.fn(() => snapshot("pending_approval")),
      },
      events: { log: vi.fn() },
    };
    const interaction = {
      customId: "rtbl:result-modal:t1",
      id: "modal-2",
      user: { id: "alice" },
      fields: { getTextInputValue: vi.fn(() => "alice bob") },
      client: { channels: { cache: new Map([["c", channel]]), fetch: vi.fn() } },
      isModalSubmit: () => true,
      reply: vi.fn(async () => undefined),
    };

    await handleRankedTableModal(interaction as any, services as any);

    expect(services.rankedTables.submitResult).toHaveBeenCalledTimes(1);
    expect(services.events.log).toHaveBeenCalledWith("casino_ranked_message_edit_failed", expect.objectContaining({ target: "t1" }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});
