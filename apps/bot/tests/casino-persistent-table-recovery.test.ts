import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { PersistentTableRow } from "@meigokujo/core";
import { restorePersistentTableMessages } from "../src/casino/persistent-table-recovery.js";
import type { Services } from "../src/services.js";

function row(patch: Partial<PersistentTableRow> = {}): PersistentTableRow {
  return {
    tableId: "t1",
    state: "playing",
    gameKey: "poker",
    creatorId: "alice",
    operatorId: "alice",
    guildId: "g",
    channelId: "c",
    messageId: "m",
    createdAt: 1,
    updatedAt: 1,
    stateChangedAt: 1,
    startedAt: 1,
    deadlineAt: null,
    expiresAt: null,
    revision: 3,
    operationId: "op",
    requestFingerprint: "{}",
    failureReason: null,
    disputeReason: null,
    recoveryError: null,
    ...patch,
  };
}

function servicesFor(table: PersistentTableRow, overrides: Partial<Services["persistentTables"]> = {}): Services {
  return {
    persistentTables: {
      listLiveTables: vi.fn(() => [table]),
      bindMessage: vi.fn(),
      markDisputedFromRecovery: vi.fn(),
      ...overrides,
    },
    events: { log: vi.fn() },
  } as unknown as Services;
}

function clientFor(channel: unknown): Client {
  return {
    channels: {
      cache: new Map([["c", channel]]),
      fetch: vi.fn(async () => channel),
    },
  } as unknown as Client;
}

describe("restorePersistentTableMessages", () => {
  it("edits an existing table message", async () => {
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result).toEqual({ restored: 1, replaced: 0, disputed: 0, failed: [] });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(services.persistentTables.bindMessage).not.toHaveBeenCalled();
    expect(services.persistentTables.markDisputedFromRecovery).not.toHaveBeenCalled();
  });

  it("recreates a missing message and persists the replacement id", async () => {
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); }) },
      send: vi.fn(async () => ({ id: "m2" })),
    };
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result).toEqual({ restored: 0, replaced: 1, disputed: 0, failed: [] });
    expect(services.persistentTables.bindMessage).toHaveBeenCalledWith("t1", { guildId: "g", channelId: "c", messageId: "m2" }, 3);
    expect(services.persistentTables.markDisputedFromRecovery).not.toHaveBeenCalled();
  });

  it("marks the table disputed when the channel is permanently unavailable", async () => {
    const client = {
      channels: {
        cache: new Map(),
        fetch: vi.fn(async () => { throw Object.assign(new Error("Missing Access"), { code: 50001 }); }),
      },
    } as unknown as Client;
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(client, services);
    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith("t1", 3, expect.stringContaining("50001"));
  });

  it("reports transient Discord failures so recovery can halt before S12", async () => {
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => { throw new Error("network timeout"); }) },
      send: vi.fn(),
    };
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result.restored).toBe(0);
    expect(result.failed).toEqual([{ tableId: "t1", error: "network timeout" }]);
    expect(services.persistentTables.markDisputedFromRecovery).not.toHaveBeenCalled();
  });
});
