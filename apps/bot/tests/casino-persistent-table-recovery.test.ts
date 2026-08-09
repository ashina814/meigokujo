import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import {
  Casino,
  CasinoMetrics,
  CHIP_ESCROW,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  HOUSE_HOLDER,
  Ledger,
  PersistentTables,
  RankedTables,
  RankedDisputes,
  HouseReservations,
  TREASURY,
  escrowHolderFor,
  openDb,
  registerDefaultTxTypes,
  type PersistentTableRow,
} from "@meigokujo/core";
import { restorePersistentTableMessages } from "../src/casino/persistent-table-recovery.js";
import type { Services } from "../src/services.js";

registerDefaultTxTypes();

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
  const markDisputedFromRecovery = overrides.markDisputedFromRecovery ?? vi.fn();
  const storageRow = {
    base_amount: null,
    fee_per_user: null,
    participant_count: null,
    rank_profile_json: null,
    result_json: null,
    result_hash: null,
    result_submitted_by: null,
    result_submitted_at: null,
    result_operation_id: null,
  };
  return {
    db: { prepare: vi.fn(() => ({ get: vi.fn(() => storageRow) })) },
    rankedTables: {
      snapshot: vi.fn(() => {
        throw new Error("not ranked");
      }),
    },
    rankedDisputes: {
      publicStatus: vi.fn(() => null),
      openForTable: vi.fn(),
      markDisputedFromRecovery,
    },
    persistentTables: {
      listLiveTables: vi.fn(() => [table]),
      bindMessage: vi.fn(),
      markDisputedFromRecovery,
      ...overrides,
    },
    events: { log: vi.fn() },
  } as unknown as Services;
}

function setupRankedRecoveryTable() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ledger.lastTransactionId(),
  });
  const casino = new Casino(db, chips, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holder) => holder === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => 1_700_000_000 });
  const metrics = new CasinoMetrics(db, chipTx, () => 1_700_000_000);
  const rankedDisputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, { now: () => 1_700_000_000, onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, { now: () => 1_700_000_000, reservations, disputes: rankedDisputes });
  const services = { db, persistentTables, rankedTables, rankedDisputes, events } as unknown as Services;

  rankedTables.create({
    tableId: "t1",
    gameKey: "gf",
    baseAmount: 5_000,
    creatorId: "alice",
    operatorId: "alice",
    guildId: "g",
    channelId: "c",
    messageId: "m",
    operationId: "create:t1",
  });
  for (const userId of ["alice", "bob"]) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 30_000, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
    chips.deposit(userId, 30_000, `deposit:${userId}`);
  }
  rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
  rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
  rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
  rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });

  return { db, chips, persistentTables, rankedTables, services };
}

function balances(ctx: ReturnType<typeof setupRankedRecoveryTable>) {
  return {
    alice: ctx.chips.balanceOf("alice"),
    bob: ctx.chips.balanceOf("bob"),
    house: ctx.chips.balanceOf(HOUSE_HOLDER),
    escrow: ctx.chips.balanceOf(escrowHolderFor("t1")),
  };
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
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith({
      tableId: "t1",
      expectedRevision: 3,
      reason: expect.stringContaining("50001"),
    });
  });

  it("marks the table disputed on Unknown Channel", async () => {
    const client = {
      channels: {
        cache: new Map(),
        fetch: vi.fn(async () => { throw Object.assign(new Error("Unknown Channel"), { code: 10003 }); }),
      },
    } as unknown as Client;
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(client, services);
    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith({
      tableId: "t1",
      expectedRevision: 3,
      reason: expect.stringContaining("10003"),
    });
  });

  it("marks the table disputed on transient message fetch failures", async () => {
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
    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith({
      tableId: "t1",
      expectedRevision: 3,
      reason: "network timeout",
    });
  });

  it("marks wrong-guild channels disputed", async () => {
    const channel = {
      guildId: "other-guild",
      isTextBased: () => true,
      messages: { fetch: vi.fn() },
      send: vi.fn(),
    };
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith({
      tableId: "t1",
      expectedRevision: 3,
      reason: expect.stringContaining("different guild"),
    });
  });

  it("marks replacement-send failures disputed after Unknown Message", async () => {
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); }) },
      send: vi.fn(async () => { throw new Error("network timeout while sending"); }),
    };
    const table = row();
    const services = servicesFor(table);
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith({
      tableId: "t1",
      expectedRevision: 3,
      reason: "network timeout while sending",
    });
    expect(services.persistentTables.bindMessage).not.toHaveBeenCalled();
  });

  it("reports disputed CAS failures so recovery can halt before S12", async () => {
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => { throw new Error("network timeout"); }) },
      send: vi.fn(),
    };
    const table = row();
    const services = servicesFor(table, {
      markDisputedFromRecovery: vi.fn(() => {
        throw new Error("stale revision");
      }),
    });
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result.restored).toBe(0);
    expect(result.disputed).toBe(0);
    expect(result.failed).toEqual([{ tableId: "t1", error: "stale revision" }]);
  });

  it("keeps pure PR20 generic tables on the generic recovery card", async () => {
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };
    const services = servicesFor(row({ gameKey: "poker" }));
    const result = await restorePersistentTableMessages(clientFor(channel), services);
    expect(result).toEqual({ restored: 1, replaced: 0, disputed: 0, failed: [] });
    expect(services.persistentTables.markDisputedFromRecovery).not.toHaveBeenCalled();
    expect((edit.mock.calls[0]![0] as { embeds: Array<{ data: { title?: string } }> }).embeds[0]!.data.title).toBe("Casino Table");
  });

  it("marks partial ranked result disputed before Discord edit and leaves funds unchanged", async () => {
    const ctx = setupRankedRecoveryTable();
    ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.db.prepare("UPDATE casino_tables SET result_submitted_at=NULL WHERE table_id='t1'").run();
    const before = balances(ctx);
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };
    const snapshot = vi.spyOn(ctx.rankedTables, "snapshot");

    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(edit).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(balances(ctx)).toEqual(before);
    ctx.db.close();
  });

  it("marks result_json-only ranked storage disputed", async () => {
    const ctx = setupRankedRecoveryTable();
    ctx.db.prepare("UPDATE casino_tables SET result_json=? WHERE table_id='t1'").run(JSON.stringify({ orderedUserIds: ["alice", "bob"] }));
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit: vi.fn() })) },
      send: vi.fn(),
    };

    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    ctx.db.close();
  });

  it("marks complete ranked result with a bad hash disputed", async () => {
    const ctx = setupRankedRecoveryTable();
    ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.db.prepare("UPDATE casino_tables SET result_hash='bad' WHERE table_id='t1'").run();
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };

    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(edit).not.toHaveBeenCalled();
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    ctx.db.close();
  });

  it("marks pending approval ranked tables without a stored result disputed", async () => {
    const ctx = setupRankedRecoveryTable();
    ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.db
      .prepare(
        `UPDATE casino_tables
            SET result_json=NULL, result_hash=NULL, result_submitted_by=NULL, result_submitted_at=NULL, result_operation_id=NULL
          WHERE table_id='t1'`,
      )
      .run();
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };

    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(edit).not.toHaveBeenCalled();
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    ctx.db.close();
  });

  it("restores pure ranked playing tables without a stored result", async () => {
    const ctx = setupRankedRecoveryTable();
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };

    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 1, replaced: 0, disputed: 0, failed: [] });
    expect(edit).toHaveBeenCalledTimes(1);
    expect((edit.mock.calls[0]![0] as { embeds: Array<{ data: { title?: string } }> }).embeds[0]!.data.title).not.toBe("Casino Table");
    expect(ctx.persistentTables.get("t1")?.state).toBe("playing");
    ctx.db.close();
  });

  it("repairs crash residue where a ranked table is disputed without dispute metadata before restoring", async () => {
    const ctx = setupRankedRecoveryTable();
    ctx.db
      .prepare("UPDATE casino_tables SET state='disputed', dispute_reason='message restore crashed', recovery_error='message restore crashed' WHERE table_id='t1'")
      .run();
    const before = balances(ctx);
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };

    expect(ctx.services.rankedDisputes.publicStatus("t1")).toBeNull();
    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 1, replaced: 0, disputed: 0, failed: [] });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(ctx.services.rankedDisputes.publicStatus("t1")?.evidenceDeadlineAt).toBe(1_700_259_200);
    expect(ctx.services.rankedDisputes.listMessageSyncPending().map((row) => row.tableId)).toContain("t1");
    expect(balances(ctx)).toEqual(before);
    ctx.db.close();
  });

  it("restores an already well-formed ranked disputed table idempotently", async () => {
    const ctx = setupRankedRecoveryTable();
    const current = ctx.persistentTables.get("t1")!;
    ctx.services.rankedDisputes.markDisputedFromRecovery({
      tableId: "t1",
      expectedRevision: current.revision,
      reason: "existing recovery dispute",
    });
    const deadline = ctx.services.rankedDisputes.publicStatus("t1")!.evidenceDeadlineAt;
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };

    const result = await restorePersistentTableMessages(clientFor(channel), ctx.services);

    expect(result).toEqual({ restored: 1, replaced: 0, disputed: 0, failed: [] });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(ctx.services.rankedDisputes.publicStatus("t1")?.evidenceDeadlineAt).toBe(deadline);
    ctx.db.close();
  });

  it("marks partial ranked storage disputed instead of falling back to the generic card", async () => {
    const edit = vi.fn(async () => undefined);
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: vi.fn(),
    };
    const services = servicesFor(row(), {
      markDisputedFromRecovery: vi.fn(),
    });
    (services.db.prepare as any).mockReturnValueOnce({
      get: vi.fn(() => ({
        base_amount: 5_000,
        fee_per_user: null,
        participant_count: 2,
        rank_profile_json: null,
        result_json: null,
        result_hash: null,
        result_submitted_by: null,
        result_submitted_at: null,
        result_operation_id: null,
      })),
    });

    const result = await restorePersistentTableMessages(clientFor(channel), services);

    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 1, failed: [] });
    expect(edit).not.toHaveBeenCalled();
    expect(services.persistentTables.markDisputedFromRecovery).toHaveBeenCalledWith({
      tableId: "t1",
      expectedRevision: 3,
      reason: "ranked table storage is partial",
    });
  });

  it("reports partial ranked disputed CAS failures as recovery failures", async () => {
    const channel = {
      guildId: "g",
      isTextBased: () => true,
      messages: { fetch: vi.fn() },
      send: vi.fn(),
    };
    const services = servicesFor(row(), {
      markDisputedFromRecovery: vi.fn(() => {
        throw new Error("stale revision");
      }),
    });
    (services.db.prepare as any).mockReturnValueOnce({
      get: vi.fn(() => ({
        base_amount: 5_000,
        fee_per_user: null,
        participant_count: 2,
        rank_profile_json: null,
        result_json: null,
        result_hash: null,
        result_submitted_by: null,
        result_submitted_at: null,
        result_operation_id: null,
      })),
    });

    const result = await restorePersistentTableMessages(clientFor(channel), services);

    expect(result).toEqual({ restored: 0, replaced: 0, disputed: 0, failed: [{ tableId: "t1", error: "stale revision" }] });
  });
});
