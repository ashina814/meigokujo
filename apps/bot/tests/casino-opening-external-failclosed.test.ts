import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, RESTJSONErrorCodes } from "discord.js";
import {
  Casino,
  CasinoChipAssets,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  Departments,
  ETHER_ESCROW,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  LEGACY_OPENING_VERSION,
  Ledger,
  OpeningPlanner,
  OpeningReset,
  ProductionOpeningBackupAdapter,
  Settings,
  Takutate,
  TREASURY,
  deptAccount,
  openDb,
  registerDefaultTxTypes,
  writeCasinoOpeningConfig,
} from "@meigokujo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordTrackedTempVcOpeningExternalAdapter } from "../src/casino/opening-ops.js";
import type { Services } from "../src/services.js";

registerDefaultTxTypes();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

function discordApiError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { name: "DiscordAPIError", code });
}

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const chipAssets = new CasinoChipAssets(db, chips);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const settings = new Settings(db);
  const departments = new Departments(db, ledger);
  const takutate = new Takutate(db, events);
  new Casino(db, chips, events);

  ledger.ensureAccount(deptAccount("賭博場"), "system");
  ledger.transfer({
    from: TREASURY,
    to: deptAccount("賭博場"),
    amount: 100_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "seed:dept",
  });
  ledger.transfer({
    from: deptAccount("賭博場"),
    to: ETHER_ESCROW,
    amount: 30_000,
    type: "ether_house_fund",
    actor: "system:ether",
    approvedBy: "system:ether",
    idempotencyKey: "seed:legacy-house",
  });
  db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, 30_000);
  chipTx.captureLegacyOpening({ poolLand: ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
  departments.upsert("賭博場", "賭博場", null);
  writeCasinoOpeningConfig(settings, VALID_CONFIG, "test-owner");
  takutate.track("vc-1", "guild-1", "test-owner", "sashi");

  const deps = { db, ledger, chips, chipAssets, integrity, status, settings, departments };
  const planner = new OpeningPlanner(deps);
  const reset = new OpeningReset(deps);
  const services = {
    db,
    settings,
    chipTx,
    casinoStatus: status,
    openingPlanner: planner,
    openingReset: reset,
    takutate,
  } as unknown as Services;
  return { db, chipTx, status, takutate, planner, reset, services };
}

function adapterFor(ctx: ReturnType<typeof setup>, fetch: ReturnType<typeof vi.fn>) {
  return new DiscordTrackedTempVcOpeningExternalAdapter({ channels: { fetch } } as any, ctx.services);
}

function totalChanges(ctx: ReturnType<typeof setup>): number {
  return (ctx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

describe("PR105 R3 Discord adapter fail-closed", () => {
  it("A/G: fetch Unknown Channel 10003だけalready-missing successにし、force:trueで実API確認し、registryとDBを変更しない", async () => {
    const ctx = setup();
    const beforeHash = ctx.planner.dryRun().planHash;
    const beforeChanges = totalChanges(ctx);
    const fetch = vi.fn().mockRejectedValue(discordApiError(RESTJSONErrorCodes.UnknownChannel, "Unknown Channel"));

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: beforeHash, idempotencyKey: "r3-a" })).resolves.toMatchObject({
      idempotencyKey: "r3-a",
      disabledChannelIds: ["vc-1"],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("vc-1", { force: true });
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
    expect(ctx.planner.dryRun().planHash).toBe(beforeHash);
    expect(totalChanges(ctx)).toBe(beforeChanges);
  });

  it("B: fetch generic/network errorはrethrowし成功扱いせずregistryを保持する", async () => {
    const ctx = setup();
    const error = new Error("network down");
    const fetch = vi.fn().mockRejectedValue(error);

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-b" })).rejects.toBe(error);
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("C: fetch Missing Access DiscordAPIErrorはrethrowしregistryを保持する", async () => {
    const ctx = setup();
    const error = discordApiError(50_001, "Missing Access");
    const fetch = vi.fn().mockRejectedValue(error);

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-c" })).rejects.toBe(error);
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("明示的10003ではないfetch nullもalready-missingにせずfail-closedする", async () => {
    const ctx = setup();
    const fetch = vi.fn().mockResolvedValue(null);

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-null" })).rejects.toThrow(
      "fetch returned null without Unknown Channel error",
    );
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("D: fetch成功→delete成功はsuccess、registryはR3で保持する", async () => {
    const ctx = setup();
    const deleteVc = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildVoice, guildId: "guild-1", delete: deleteVc });

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-d" })).resolves.toMatchObject({
      disabledChannelIds: ["vc-1"],
    });
    expect(deleteVc).toHaveBeenCalledWith("formal opening r3-d");
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("E: fetch成功後deleteがUnknown Channel 10003ならrace already-missingとしてsuccess", async () => {
    const ctx = setup();
    const deleteVc = vi.fn().mockRejectedValue(discordApiError(RESTJSONErrorCodes.UnknownChannel, "Unknown Channel"));
    const fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildVoice, guildId: "guild-1", delete: deleteVc });

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-e" })).resolves.toMatchObject({
      disabledChannelIds: ["vc-1"],
    });
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("F1: fetch成功後delete generic errorはrethrowする", async () => {
    const ctx = setup();
    const error = new Error("delete network failure");
    const deleteVc = vi.fn().mockRejectedValue(error);
    const fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildVoice, guildId: "guild-1", delete: deleteVc });

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-f1" })).rejects.toBe(error);
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("F2: fetch成功後delete Missing Permissions DiscordAPIErrorはrethrowする", async () => {
    const ctx = setup();
    const error = discordApiError(50_013, "Missing Permissions");
    const deleteVc = vi.fn().mockRejectedValue(error);
    const fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildVoice, guildId: "guild-1", delete: deleteVc });

    await expect(adapterFor(ctx, fetch).disableLegacyCasino({ planHash: "p", idempotencyKey: "r3-f2" })).rejects.toBe(error);
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });

  it("H: external fetch failure後OpeningResetはfailed/externalで止まり、external_completed/R6へ進まない", async () => {
    const ctx = setup();
    const root = mkdtempSync(join(process.cwd(), "pr105-r3-failclosed-"));
    roots.push(root);
    const error = new Error("network down during R3 fetch");
    const fetch = vi.fn().mockRejectedValue(error);
    const adapter = adapterFor(ctx, fetch);

    await expect(
      ctx.reset.apply({
        actorId: "test-owner",
        backup: new ProductionOpeningBackupAdapter(root),
        external: adapter,
      }),
    ).rejects.toBe(error);

    const execution = ctx.db
      .prepare(
        "SELECT status, failure_stage AS failureStage, external_operation_id AS externalOperationId, funds_applied AS fundsApplied FROM casino_opening_executions ORDER BY started_at DESC LIMIT 1",
      )
      .get() as { status: string; failureStage: string | null; externalOperationId: string | null; fundsApplied: number };

    expect(execution).toEqual({ status: "failed", failureStage: "external", externalOperationId: null, fundsApplied: 0 });
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_temp_vcs").get() as { n: number }).n).toBe(1);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect(ctx.status.current().status).toBe("opening_reset");
  });
});
