import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { HouseReservations } from "../src/casino/reservations.js";
import { Settings } from "../src/settings/service.js";
import { CHIP_OPENING_VERSION_KEY, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { CasinoRemittance } from "../src/casino/remittance.js";

registerDefaultTxTypes();

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "remittance-runner.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-remittance-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const settings = new Settings(db);
  settings.set(CHIP_OPENING_VERSION_KEY, FORMAL_OPENING_VERSION, "test");
  writeCasinoOpeningConfig(settings, {
    openingCapital: 10_000,
    openingHouse: 10_000,
    openingJackpot: 0,
    openingRelief: 0,
    minWorkingCapital: 0,
    remitRateBps: 5_000,
  }, "operator");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holder) => holder === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  const remit = new CasinoRemittance(db, ledger, chips, reservations, settings, { fukuReserve: () => 0 });
  return { dbPath, db, settings, ledger, events, chips, reservations, remit };
}

function seedRemittance(c: ReturnType<typeof setupFileDb>): void {
  c.chips.fundFromAccount(TREASURY, 200, HOUSE_HOLDER, "seed:house");
  c.chips.fundFromAccount(TREASURY, 800, "u1", "seed:u1");
  c.chips.runGroup({ groupKey: "shop:profit", kind: "shop", actorId: "u1" }, () => {
    c.chips.transfer("u1", HOUSE_HOLDER, 800, { reason: "profit" });
  });
  expect(c.remit.draftRemittance("m1", "maker").amount).toBe(400);
}

interface RunnerResult {
  ok: boolean;
  status?: string;
  approvedBy?: string | null;
  executedBy?: string | null;
  code?: string;
  error?: string;
}

function runProcesses(
  dbPath: string,
  action: "approve" | "execute",
  key: string,
  actors: string[],
): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000;
  return Promise.all(actors.map((actor) => new Promise<RunnerResult>((resolve, reject) => {
    const input = JSON.stringify({ dbPath, action, key, actor, startAt });
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, input], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line) as RunnerResult);
    });
  })));
}

describe("PR14 cross-process concurrency", () => {
  it("同じdraftを別プロセスが同時approveしても承認者は1人だけ", async () => {
    const c = setupFileDb();
    c.chips.fundFromAccount(TREASURY, 1_000, HOUSE_HOLDER, "seed:house");
    c.remit.draftBailout("b1", 100, "shortage", "maker");
    c.db.close();

    const results = await runProcesses(c.dbPath, "approve", "b1", ["reviewer-a", "reviewer-b"]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const db = openDb(c.dbPath);
    const row = db.prepare("SELECT status, approved_by FROM casino_remittances WHERE key='b1'").get() as {
      status: string; approved_by: string;
    };
    expect(row.status).toBe("approved");
    expect(["reviewer-a", "reviewer-b"]).toContain(row.approved_by);
    db.close();
  }, 60_000);

  it("同じapproved remittanceを別プロセスが同時executeしても送金は1回だけ", async () => {
    const c = setupFileDb();
    seedRemittance(c);
    c.remit.approve("m1", "reviewer");
    c.db.close();

    const results = await runProcesses(c.dbPath, "execute", "m1", ["operator", "operator"]);
    expect(results.every((r) => r.ok)).toBe(true);

    const db = openDb(c.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='casino_remittance'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key='casino:remittance:m1'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT status FROM casino_remittances WHERE key='m1'").get() as { status: string }).status).toBe("executed");
    db.close();
  }, 60_000);

  it("同じapproved bailoutを別プロセスが同時executeしても補填は1回だけ", async () => {
    const c = setupFileDb();
    c.chips.fundFromAccount(TREASURY, 100, HOUSE_HOLDER, "seed:house");
    c.remit.draftBailout("b1", 250, "shortage", "maker");
    c.remit.approve("b1", "reviewer");
    c.db.close();

    const results = await runProcesses(c.dbPath, "execute", "b1", ["operator", "operator"]);
    expect(results.every((r) => r.ok)).toBe(true);

    const db = openDb(c.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='casino_bailout'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key='casino:bailout:b1'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(HOUSE_HOLDER) as { amount: number }).amount).toBe(350);
    db.close();
  }, 60_000);
});
