import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSeatOccupied, acquireSeat, releaseSeat } from "../src/casino/common.js";

describe("PR10 process-local ownership gate", () => {
  it("tracks active solo-game ownership for refund and external-confirmation gates", () => {
    expect(isSeatOccupied("alice")).toBe(false);
    expect(acquireSeat("alice")).toBe(true);
    expect(isSeatOccupied("alice")).toBe(true);
    releaseSeat("alice");
    expect(isSeatOccupied("alice")).toBe(false);
  });

  it("keeps the persistent emergency refund draft/execute/cancel routes", () => {
    const source = readFileSync(new URL("../src/commands/admin-hub.ts", import.meta.url), "utf8");
    expect(source).toContain("mgmt:casino:refund-user");
    expect(source).toContain("mgmt:casino:refund-all");
    expect(source).toContain("mgmt:casino:refund-execute:");
    expect(source).toContain("mgmt:casino:refund-cancel:");
    expect(source).toContain("createRefundSaga");
    expect(source).toContain("executeRefundSaga");
  });
});
