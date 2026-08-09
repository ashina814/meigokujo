import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
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
  FORMAL_OPENING_VERSION,
  HOUSE_HOLDER,
  LEGACY_OPENING_VERSION,
  Ledger,
  OpeningPlanner,
  OpeningReset,
  Settings,
  Takutate,
  TREASURY,
  deptAccount,
  openDb,
  registerDefaultTxTypes,
  writeCasinoOpeningConfig,
  type OpeningBlocker,
  type OpeningPreflightResult,
} from "@meigokujo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../src/services.js";
import {
  DiscordTrackedTempVcOpeningExternalAdapter,
  handleOpeningOpsButton,
  handleOpeningOpsModal,
  isApplyEligiblePreflight,
} from "../src/casino/opening-ops.js";

registerDefaultTxTypes();
process.env.OWNER_ID = "test-owner";

const backupRoots: string[] = [];
afterEach(() => {
  for (const root of backupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persistentBackupRoot(): string {
  const root = mkdtempSync(join(process.cwd(), "pr105-opening-integration-"));
  backupRoots.push(root);
  process.env.CASINO_OPENING_BACKUP_DIR = root;
  return root;
}

function blocker(code: string): OpeningBlocker {
  return { category: "opening_version", code, message: code };
}

function mockPlan(
  casinoStatus: "open" | "opening_reset",
  blockers: OpeningBlocker[],
  planHash = "mock-plan",
): OpeningPreflightResult {
  return {
    planHash,
    snapshot: {
      mode: "dry-run",
      configuration: {
        configured: true,
        openingCapital: 1000,
        openingHouse: 800,
        openingJackpot: 150,
        openingRelief: 50,
        minWorkingCapital: 100,
        remitRateBps: 0,
      },
      currentOpeningVersion: LEGACY_OPENING_VERSION,
      casinoStatus,
      schemaFingerprint: "schema",
      tables: [],
      playerLand: { totalLand: 0, accounts: [] } as never,
      oldReserveLand: 0,
      departmentLandBefore: 1000,
      openingSourceLand: 1000,
      chipHolderBalances: [],
      legacyLedgerOk: true,
      escrowInspectionOk: true,
      protectedFindingCount: 0,
      compensationRequiredLand: 0,
      departmentExists: true,
    },
    blockers,
    protectedFindings: [],
    compensation: { candidates: [], requiredLand: 0, unknownCount: 0 },
    legacyLedgerAudit: { ok: true, checkA: {} as never, checkB: {} as never, checkC: {} as never, checkD: {} as never },
    tableAudits: [],
    unknownTables: [],
  };
}

function mockServices(plan: OpeningPreflightResult, apply = vi.fn()) {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  return {
    services: {
      db,
      settings,
      chipTx: { openingPhase: () => "pre_reset", currentVersion: () => LEGACY_OPENING_VERSION },
      casinoStatus: { current: () => ({ status: plan.snapshot.casinoStatus, reason: "test", changedBy: "test", changedAt: 1 }) },
      openingPlanner: { dryRun: vi.fn(() => plan) },
      openingReset: { apply },
      takutate: { list: () => [], untrack: vi.fn() },
    } as unknown as Services,
    apply,
  };
}

function button(customId: string, client: any = {}, userId = "test-owner") {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const showModal = vi.fn().mockResolvedValue(undefined);
  return {
    interaction: { customId, user: { id: userId }, client, reply, deferReply, editReply, showModal } as unknown as ButtonInteraction,
    reply,
    deferReply,
    editReply,
    showModal,
  };
}

function modal(customId: string, confirm: string, client: any = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    interaction: {
      customId,
      user: { id: "test-owner" },
      client,
      fields: { getTextInputValue: () => confirm },
      reply,
      deferReply,
      editReply,
    } as unknown as ModalSubmitInteraction,
    editReply,
  };
}

function componentIds(payload: any): string[] {
  return (payload.components ?? []).flatMap((row: any) => row.toJSON().components.map((component: any) => component.custom_id));
}

describe("PR105 blocker 1: initial status=open apply eligibility", () => {
  it("status=open + status_not_opening_resetだけならConfirmを表示する", async () => {
    const plan = mockPlan("open", [blocker("status_not_opening_reset")], "open-only-status");
    expect(isApplyEligiblePreflight(plan)).toBe(true);
    const { services } = mockServices(plan);
    const preview = button("mgmt:casino:opening:preflight");
    await handleOpeningOpsButton(preview.interaction, services);
    expect(componentIds(preview.editReply.mock.calls[0]![0])).toContain("mgmt:casino:opening:confirm:open-only-status");
  });

  it("同条件のfresh preflightで最終確認後applyを1回だけ呼ぶ", async () => {
    persistentBackupRoot();
    const plan = mockPlan("open", [blocker("status_not_opening_reset")], "apply-open-status");
    const apply = vi.fn().mockResolvedValue({
      executionId: "e",
      planHash: "apply-open-status",
      status: "completed",
      fundsApplied: true,
      oldSettlementLandTxId: null,
      newInvestmentLandTxId: 1,
      openingVersion: FORMAL_OPENING_VERSION,
      postflight: { ok: true, checks: [] },
      manifest: { planHash: "apply-open-status" },
      externalOperationId: "x",
      casinoReopened: true,
      notifierStatus: "pending",
    });
    const { services } = mockServices(plan, apply);
    const submit = modal("mgmt:casino:opening:apply:apply-open-status", "FORMAL-OPENING apply-op");
    await handleOpeningOpsModal(submit.interaction, services);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("status=open + 別blockerはConfirmを出さない", async () => {
    const plan = mockPlan("open", [blocker("other_blocker")]);
    expect(isApplyEligiblePreflight(plan)).toBe(false);
    const { services } = mockServices(plan);
    const preview = button("mgmt:casino:opening:preflight");
    await handleOpeningOpsButton(preview.interaction, services);
    expect(componentIds(preview.editReply.mock.calls[0]![0])).toEqual([]);
  });

  it("status=open + status_not_opening_reset + 別blockerは拒否する", async () => {
    persistentBackupRoot();
    const plan = mockPlan("open", [blocker("status_not_opening_reset"), blocker("other_blocker")], "blocked-plan");
    expect(isApplyEligiblePreflight(plan)).toBe(false);
    const { services, apply } = mockServices(plan);
    const submit = modal("mgmt:casino:opening:apply:blocked-plan", "FORMAL-OPENING blocked-");
    await handleOpeningOpsModal(submit.interaction, services);
    expect(apply).not.toHaveBeenCalled();
    expect(String(submit.editReply.mock.calls[0]?.[0] ?? "")).toContain("blocked");
  });

  it("opening_reset + blocker 0は従来通り実行可能", () => {
    expect(isApplyEligiblePreflight(mockPlan("opening_reset", []))).toBe(true);
  });

  it("UIはbeginOpeningResetを直接呼ばない", () => {
    const source = readFileSync(new URL("../src/casino/opening-ops.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".beginOpeningReset(");
  });
});

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

function realSetup() {
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
  return { db, ledger, chipTx, status, takutate, planner, reset, services };
}

describe("PR105 blocker 2: R3 leaves registry to R6", () => {
  it("tracked VCはDiscordだけ1回削除し、registryを残し、同key replayで二重deleteせずplanHashも不変", async () => {
    const ctx = realSetup();
    const before = ctx.planner.dryRun().planHash;
    const deleteVc = vi.fn().mockResolvedValue(undefined);
    const liveChannel = { type: ChannelType.GuildVoice, guildId: "guild-1", delete: deleteVc };
    const fetch = vi.fn().mockResolvedValueOnce(liveChannel).mockResolvedValueOnce(null);
    const adapter = new DiscordTrackedTempVcOpeningExternalAdapter({ channels: { fetch } } as any, ctx.services);

    const first = await adapter.disableLegacyCasino({ planHash: before, idempotencyKey: "r3-key" });
    const second = await adapter.disableLegacyCasino({ planHash: before, idempotencyKey: "r3-key" });

    expect(first).toMatchObject({ idempotencyKey: "r3-key", disabledChannelIds: ["vc-1"] });
    expect(second).toMatchObject({ idempotencyKey: "r3-key", disabledChannelIds: ["vc-1"] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, "vc-1");
    expect(fetch).toHaveBeenNthCalledWith(2, "vc-1");
    expect(deleteVc).toHaveBeenCalledTimes(1);
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
    expect(ctx.planner.dryRun().planHash).toBe(before);
  });

  it("tracked VCがDiscord上ですでに無くても成功扱いしregistryをR3で残す", async () => {
    const ctx = realSetup();
    const fetch = vi.fn().mockResolvedValue(null);
    const adapter = new DiscordTrackedTempVcOpeningExternalAdapter({ channels: { fetch } } as any, ctx.services);

    await expect(adapter.disableLegacyCasino({ planHash: "missing-vc", idempotencyKey: "missing-key" })).resolves.toMatchObject({
      disabledChannelIds: ["vc-1"],
    });
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);
  });
});

describe("PR105 real integration: owner confirm through OpeningReset", () => {
  it("open/R0 -> persistent backup -> R3 -> fresh plan -> R6 registry clear -> opening_v1/open/completed", async () => {
    const root = persistentBackupRoot();
    const ctx = realSetup();
    const initial = ctx.planner.dryRun();

    expect(ctx.status.current().status).toBe("open");
    expect(initial.blockers.map((b) => b.code)).toEqual(["status_not_opening_reset"]);
    expect(ctx.takutate.isTracked("vc-1")).toBe(true);

    const deleteVc = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildVoice, guildId: "guild-1", delete: deleteVc });
    const client = { channels: { fetch } };
    const applySpy = vi.spyOn(ctx.reset, "apply");

    const preview = button("mgmt:casino:opening:preflight", client);
    await handleOpeningOpsButton(preview.interaction, ctx.services);
    expect(componentIds(preview.editReply.mock.calls[0]![0])).toContain(`mgmt:casino:opening:confirm:${initial.planHash}`);

    const confirm = button(`mgmt:casino:opening:confirm:${initial.planHash}`, client);
    await handleOpeningOpsButton(confirm.interaction, ctx.services);
    expect(confirm.showModal).toHaveBeenCalledTimes(1);

    const submit = modal(
      `mgmt:casino:opening:apply:${initial.planHash}`,
      `FORMAL-OPENING ${initial.planHash.slice(0, 8)}`,
      client,
    );
    await handleOpeningOpsModal(submit.interaction, ctx.services);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(deleteVc).toHaveBeenCalledTimes(1);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_temp_vcs").get() as { n: number }).n).toBe(0);
    expect(ctx.chipTx.currentVersion()).toBe(FORMAL_OPENING_VERSION);
    expect(ctx.status.current().status).toBe("open");
    const execution = ctx.db
      .prepare("SELECT id, plan_hash AS planHash, status, funds_applied AS fundsApplied FROM casino_opening_executions ORDER BY started_at DESC LIMIT 1")
      .get() as { id: string; planHash: string; status: string; fundsApplied: number };
    expect(execution.status).toBe("completed");
    expect(execution.fundsApplied).toBe(1);
    expect(execution.planHash).toBe(initial.planHash);
    expect(existsSync(join(root, `casino-opening-${initial.planHash}`, "manifest.json"))).toBe(true);
    expect(String(submit.editReply.mock.calls[0]?.[0] ?? "")).toContain("Formal opening apply finished");
  });
});
