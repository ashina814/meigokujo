import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCasinoRecoveryBeforeRoleFamilyTracking } from "../src/startup-safety.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ClientReady safety-critical ordering", () => {
  it("AP. role-family startup member fetchがpendingでもcasino recoveryは同期実行済み", async () => {
    const productionEntry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(productionEntry).toContain("await runCasinoRecoveryBeforeRoleFamilyTracking(");

    const memberFetch = deferred();
    const calls: string[] = [];

    const startup = runCasinoRecoveryBeforeRoleFamilyTracking(
      () => { calls.push("casino-recovery"); },
      async () => {
        calls.push("role-member-fetch-start");
        await memberFetch.promise;
        calls.push("role-member-fetch-complete");
      },
    );

    expect(calls).toEqual(["casino-recovery", "role-member-fetch-start"]);
    memberFetch.resolve();
    await startup;
    expect(calls).toEqual(["casino-recovery", "role-member-fetch-start", "role-member-fetch-complete"]);
  });
});
