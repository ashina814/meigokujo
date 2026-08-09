import { join } from "node:path";
import { ChannelType, MessageFlags, RESTJSONErrorCodes, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import {
  CASINO_OPENING_SETTING_KEYS,
  FORMAL_OPENING_VERSION,
  LEGACY_OPENING_VERSION,
  Settings,
  openDb,
  readCasinoOpeningConfig,
  type OpeningPreflightResult,
} from "@meigokujo/core";
import { describe, expect, it, vi } from "vitest";
import type { Services } from "../src/services.js";

process.env.DISCORD_TOKEN ??= "test-token";
process.env.CLIENT_ID ??= "test-client";
process.env.OWNER_ID ??= "test-owner";
process.env.CASINO_OPENING_BACKUP_DIR ??= join(process.cwd(), "pr195-opening-backups");

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

const { handleOpeningOpsButton, handleOpeningOpsModal } = await import("../src/casino/opening-ops.js");
const { config } = await import("../src/config.js");

function preflight(planHash = "abcdef1234567890", blockers: OpeningPreflightResult["blockers"] = []): OpeningPreflightResult {
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
      casinoStatus: "opening_reset",
      schemaFingerprint: "schema",
      tables: [],
      playerLand: { totalLand: 0, accounts: [] } as any,
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
    legacyLedgerAudit: { ok: true, checkA: {} as any, checkB: {} as any, checkC: {} as any, checkD: {} as any },
    tableAudits: [],
    unknownTables: [],
  };
}

function makeServices(opts: {
  plan?: OpeningPreflightResult;
  dryRuns?: OpeningPreflightResult[];
  apply?: ReturnType<typeof vi.fn>;
  takutateRows?: Array<{ channel_id: string; guild_id: string; owner_id: string; table_type: string; created_at: number }>;
} = {}) {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  const dryRun = vi.fn(() => opts.dryRuns?.shift() ?? opts.plan ?? preflight());
  const apply = opts.apply ?? vi.fn();
  const untrack = vi.fn();
  const services = {
    db,
    settings,
    chipTx: {
      openingPhase: () => "pre_reset",
      currentVersion: () => LEGACY_OPENING_VERSION,
    },
    casinoStatus: {
      current: () => ({ status: "opening_reset", reason: "test", changedBy: "test", changedAt: 1 }),
    },
    openingPlanner: { dryRun },
    openingReset: { apply },
    takutate: {
      list: () => opts.takutateRows ?? [],
      untrack,
    },
  } as unknown as Services;
  return { services, db, settings, dryRun, apply, untrack };
}

function button(customId: string, userId = config.ownerId, client: any = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const showModal = vi.fn().mockResolvedValue(undefined);
  return {
    i: { customId, user: { id: userId }, client, reply, deferReply, editReply, showModal } as unknown as ButtonInteraction,
    reply,
    deferReply,
    editReply,
    showModal,
  };
}

function modal(customId: string, values: Record<string, string>, userId = config.ownerId, client: any = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    i: {
      customId,
      user: { id: userId },
      client,
      fields: { getTextInputValue: (key: string) => values[key] ?? "" },
      reply,
      deferReply,
      editReply,
    } as unknown as ModalSubmitInteraction,
    reply,
    deferReply,
    editReply,
  };
}

function replyContent(fn: ReturnType<typeof vi.fn>): string {
  return String(fn.mock.calls[0]?.[0]?.content ?? fn.mock.calls[0]?.[0] ?? "");
}

function componentCustomIds(payload: any): string[] {
  return (payload.components ?? []).flatMap((row: any) => row.toJSON().components.map((component: any) => component.custom_id));
}

describe("casino opening ops settings", () => {
  it("rejects invalid capital settings without writing partial values", async () => {
    const { services, settings } = makeServices();
    const i = modal("mgmt:casino:opening:capital", {
      openingCapital: "1000",
      openingHouse: "900",
      openingJackpot: "200",
      openingRelief: "0",
    });

    await handleOpeningOpsModal(i.i, services);

    expect(replyContent(i.reply)).toContain("must equal opening capital");
    expect(settings.getString(CASINO_OPENING_SETTING_KEYS.capital)).toBeUndefined();
  });

  it("writes configured=true only after operational settings validate", async () => {
    const { services, settings } = makeServices();
    await handleOpeningOpsModal(
      modal("mgmt:casino:opening:capital", {
        openingCapital: "1000",
        openingHouse: "800",
        openingJackpot: "150",
        openingRelief: "50",
      }).i,
      services,
    );
    expect(readCasinoOpeningConfig(settings)).toEqual({ ok: false, configured: false, reason: "not_configured" });

    const badOps = modal("mgmt:casino:opening:ops", { minWorkingCapital: "100", remitRateBps: "10001" });
    await handleOpeningOpsModal(badOps.i, services);
    expect(replyContent(badOps.reply)).toContain("remitRateBps");
    expect(readCasinoOpeningConfig(settings)).toEqual({ ok: false, configured: false, reason: "not_configured" });

    await handleOpeningOpsModal(modal("mgmt:casino:opening:ops", { minWorkingCapital: "100", remitRateBps: "250" }).i, services);
    const configResult = readCasinoOpeningConfig(settings);
    expect(configResult.ok).toBe(true);
    expect(configResult.ok ? configResult.config.remitRateBps : 0).toBe(250);
  });

  it("allows correcting a valid configured value before execution and clears configured until full read-back succeeds again", async () => {
    const { services, settings } = makeServices();
    await handleOpeningOpsModal(
      modal("mgmt:casino:opening:capital", {
        openingCapital: "1000",
        openingHouse: "800",
        openingJackpot: "150",
        openingRelief: "50",
      }).i,
      services,
    );
    await handleOpeningOpsModal(modal("mgmt:casino:opening:ops", { minWorkingCapital: "100", remitRateBps: "250" }).i, services);
    expect(readCasinoOpeningConfig(settings).ok).toBe(true);

    await handleOpeningOpsModal(
      modal("mgmt:casino:opening:capital", {
        openingCapital: "1000",
        openingHouse: "700",
        openingJackpot: "200",
        openingRelief: "100",
      }).i,
      services,
    );
    expect(readCasinoOpeningConfig(settings)).toEqual({ ok: false, configured: false, reason: "not_configured" });

    await handleOpeningOpsModal(modal("mgmt:casino:opening:ops", { minWorkingCapital: "120", remitRateBps: "300" }).i, services);
    const reread = readCasinoOpeningConfig(settings);
    expect(reread.ok).toBe(true);
    expect(reread.ok ? reread.config.openingHouse : 0).toBe(700);
    expect(reread.ok ? reread.config.remitRateBps : 0).toBe(300);
  });

  it("requires OWNER_ID for opening operation controls", async () => {
    const { services } = makeServices();
    const i = button("mgmt:casino:opening:capital", "not-owner");
    await handleOpeningOpsButton(i.i, services);

    expect(i.showModal).not.toHaveBeenCalled();
    expect(replyContent(i.reply)).toContain("OWNER_ID");
    expect(i.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
  });
});

describe("casino opening ops preflight and apply", () => {
  it("renders preflight read-only and only exposes confirmation to the owner", async () => {
    const { services, apply } = makeServices({ plan: preflight("hash-owner") });
    const owner = button("mgmt:casino:opening:preflight");

    await handleOpeningOpsButton(owner.i, services);

    expect(owner.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(apply).not.toHaveBeenCalled();
    expect(componentCustomIds(owner.editReply.mock.calls[0][0])).toContain("mgmt:casino:opening:confirm:hash-owner");

    const nonOwner = button("mgmt:casino:opening:preflight", "not-owner");
    await handleOpeningOpsButton(nonOwner.i, services);
    expect(componentCustomIds(nonOwner.editReply.mock.calls[0][0])).toEqual([]);
  });

  it("fails closed when the plan hash changes before the confirmation modal", async () => {
    const { services } = makeServices({ dryRuns: [preflight("new-hash")] });
    const i = button("mgmt:casino:opening:confirm:old-hash");

    await handleOpeningOpsButton(i.i, services);

    expect(i.showModal).not.toHaveBeenCalled();
    expect(replyContent(i.reply)).toContain("stale");
  });

  it("wires apply with a persistent backup adapter and registry-only temp VC external adapter", async () => {
    const deleteChannel = vi.fn().mockResolvedValue(undefined);
    const liveChannel = {
      type: ChannelType.GuildVoice,
      guildId: "guild-1",
      delete: deleteChannel,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(liveChannel)
      .mockRejectedValueOnce({ code: RESTJSONErrorCodes.UnknownChannel });
    const client = { channels: { fetch } };
    const apply = vi.fn(async (input: any) => {
      expect(input.actorId).toBe(config.ownerId);
      expect(input.backup.durability).toBe("persistent");

      const first = await input.external.disableLegacyCasino({ planHash: "apply-hash", idempotencyKey: "external-1" });
      const second = await input.external.disableLegacyCasino({ planHash: "apply-hash", idempotencyKey: "external-1" });
      expect(first).toMatchObject({ idempotencyKey: "external-1", disabledChannelIds: ["vc-1"] });
      expect(second).toMatchObject({ idempotencyKey: "external-1", disabledChannelIds: ["vc-1"] });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(1, "vc-1", { force: true });
      expect(fetch).toHaveBeenNthCalledWith(2, "vc-1", { force: true });
      expect(deleteChannel).toHaveBeenCalledTimes(1);

      return {
        executionId: "execution-1",
        planHash: "apply-hash",
        status: "completed",
        fundsApplied: true,
        oldSettlementLandTxId: null,
        newInvestmentLandTxId: 1,
        openingVersion: FORMAL_OPENING_VERSION,
        postflight: { ok: true },
        manifest: { planHash: "apply-hash" },
        externalOperationId: "external-1",
        casinoReopened: true,
        notifierStatus: "sent",
      };
    });
    const { services, untrack } = makeServices({
      plan: preflight("apply-hash"),
      apply,
      takutateRows: [{ channel_id: "vc-1", guild_id: "guild-1", owner_id: "owner", table_type: "roulette", created_at: 1 }],
    });
    const i = modal("mgmt:casino:opening:apply:apply-hash", { confirm: "FORMAL-OPENING apply-ha" }, config.ownerId, client);

    await handleOpeningOpsModal(i.i, services);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(untrack).not.toHaveBeenCalled();
    expect(replyContent(i.editReply)).toContain("Formal opening apply finished");
  });

  it("does not call apply when confirmation is stale", async () => {
    const { services, apply } = makeServices({ dryRuns: [preflight("fresh-hash")] });
    const i = modal("mgmt:casino:opening:apply:old-hash", { confirm: "FORMAL-OPENING old-hash" });

    await handleOpeningOpsModal(i.i, services);

    expect(apply).not.toHaveBeenCalled();
    expect(replyContent(i.editReply)).toContain("Plan hash changed");
  });
});
