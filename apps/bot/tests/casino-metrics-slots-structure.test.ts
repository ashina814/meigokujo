import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Financial recovery behavior is covered by core casino-metrics.test.ts; this suite fixes bot call ordering.
const source = readFileSync(new URL("../src/casino/slots.ts", import.meta.url), "utf8");

function between(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("PR19 slots analytics finish ordering", () => {
  it("paid-only can close finish after financial settlement and before Discord rendering", () => {
    const body = between("async function runPaidSpin(", "async function renderSpin(");
    const paid = body.indexOf("const record = spinPaid(");
    const finish = body.indexOf("reconcileSlotsGameFinishBestEffort(", paid);
    const render = body.indexOf("await renderSpin(", paid);
    expect(paid).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(paid);
    expect(render).toBeGreaterThan(finish);
  });

  it("immediate free financially settles and closes the same aggregate finish before Discord rendering", () => {
    const body = between("async function runPaidSpin(", "async function renderSpin(");
    const free = body.indexOf("immediateFree = resolveFreeSpin(");
    const finish = body.indexOf("reconcileSlotsGameFinishBestEffort(", free);
    const render = body.indexOf("await renderSpin(", free);
    expect(free).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(free);
    expect(render).toBeGreaterThan(finish);
  });

  it("pending recovery reconciles finish without creating a new game_start", () => {
    const recovery = source.slice(source.indexOf("export function resumePendingFreeSpins("));
    expect(recovery).toContain("reconcileSlotsGameFinishBestEffort(services, row.userId, row.operationId)");
    expect(recovery).toContain("services.casinoMetrics?.reconcileSlotsFinishes()");
    expect(recovery).not.toContain("recordCasinoGameStartBestEffort(");
  });

  it("rendering no longer owns the direct game_finish write", () => {
    const render = source.slice(source.indexOf("async function renderSpin("));
    expect(render).not.toContain("recordCasinoGameFinishBestEffort(");
  });
});
