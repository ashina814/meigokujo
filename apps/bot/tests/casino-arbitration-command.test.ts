import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    ownerId: "owner",
    casinoArbitratorRoleId: "arb-role",
  },
}));

vi.mock("../src/casino/ranked-table-ui.js", () => ({
  editBoundRankedTableMessage: vi.fn(async () => undefined),
}));

import { handleCasinoArbitrationCommand } from "../src/commands/casino-arbitration.js";

function interaction(subcommand: string, userId: string, values: Record<string, unknown> = {}) {
  const reply = vi.fn(async () => undefined);
  return {
    id: `interaction:${subcommand}:${userId}`,
    guild: { id: "guild" },
    client: {},
    user: { id: userId },
    member: { roles: { cache: new Map((values.roles as string[] | undefined)?.map((id) => [id, true]) ?? []) } },
    reply,
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => values[name] as string,
      getUser: (name: string) => values[name],
      getBoolean: (name: string) => values[name] as boolean,
    },
  } as any;
}

function services() {
  return {
    rankedDisputes: {
      assignArbitrator: vi.fn(),
      resolveRankedResult: vi.fn(),
      resolveCollateralRefund: vi.fn(),
      publicStatus: vi.fn(() => ({ assignedArbitratorId: "judge" })),
    },
  } as any;
}

describe("casino arbitration command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows only OWNER_ID to assign an arbitrator", async () => {
    const s = services();
    await handleCasinoArbitrationCommand(interaction("assign", "not-owner", { table_id: "t1", arbitrator: { id: "judge" } }), s);
    expect(s.rankedDisputes.assignArbitrator).not.toHaveBeenCalled();

    await handleCasinoArbitrationCommand(interaction("assign", "owner", { table_id: "t1", arbitrator: { id: "judge" } }), s);
    expect(s.rankedDisputes.assignArbitrator).toHaveBeenCalledWith({
      tableId: "t1",
      arbitratorId: "judge",
      assignedBy: "owner",
      operationId: "interaction:assign:owner",
    });
  });

  it("allows only the configured assigned arbitrator to resolve", async () => {
    const s = services();
    await handleCasinoArbitrationCommand(
      interaction("refund_collateral", "judge", { table_id: "t1", fee_outcome: "keep", public_summary: "neutral refund", roles: [] }),
      s,
    );
    expect(s.rankedDisputes.resolveCollateralRefund).not.toHaveBeenCalled();

    await handleCasinoArbitrationCommand(
      interaction("refund_collateral", "other", { table_id: "t1", fee_outcome: "keep", public_summary: "neutral refund", roles: ["arb-role"] }),
      s,
    );
    expect(s.rankedDisputes.resolveCollateralRefund).not.toHaveBeenCalled();

    await handleCasinoArbitrationCommand(
      interaction("refund_collateral", "judge", { table_id: "t1", fee_outcome: "keep", public_summary: "neutral refund", roles: ["arb-role"] }),
      s,
    );
    expect(s.rankedDisputes.resolveCollateralRefund).toHaveBeenCalledWith({
      tableId: "t1",
      actorId: "judge",
      feeOutcome: "keep",
      publicSummary: "neutral refund",
      operationId: "interaction:refund_collateral:judge",
    });
  });
});
