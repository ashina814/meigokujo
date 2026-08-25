import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Departments } from "../src/departments/service.js";
import { Ledger } from "../src/ledger/service.js";
import {
  RoleFamilyTemporal,
  buildPublicDepartmentRoleFamilyManifest,
  type RoleFamilyManifest,
} from "../src/role-family/temporal.js";

const BASE = 2_000_000_000;
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifest(families: RoleFamilyManifest["families"]): RoleFamilyManifest {
  return { provenance: "explicit_manifest", families };
}

function member(userId: string, roleIds: readonly string[], bot = false) {
  return { userId, roleIds, bot };
}

function setup() {
  const db = openDb(":memory:");
  const temporal = new RoleFamilyTemporal(db);
  return { db, temporal };
}

describe("A-D canonical soul class history", () => {
  it("A. existing soul baselineはF3a導入を実際に観測した時刻で、joined_atへbackdateしない", () => {
    const dir = mkdtempSync(join(tmpdir(), "f3a-soul-baseline-"));
    tempDirs.push(dir);
    const path = join(dir, "db.sqlite");
    const initial = openDb(path);
    initial.exec(`
      DROP TRIGGER trg_soul_status_history_insert;
      DROP TRIGGER trg_soul_status_history_transition;
      DROP TRIGGER trg_soul_status_history_no_update;
      DROP TRIGGER trg_soul_status_history_no_delete;
      DELETE FROM soul_status_history;
    `);
    initial.prepare(
      `INSERT INTO souls (user_id, status, joined_at, updated_at) VALUES ('legacy', 'majin', 1, 1)`,
    ).run();
    initial.close();
    const before = Math.floor(Date.now() / 1000);
    const reopened = openDb(path);
    const after = Math.floor(Date.now() / 1000);
    const row = reopened.prepare(
      `SELECT status, observed_at, provenance FROM soul_status_history WHERE user_id = 'legacy'`,
    ).get() as { status: string; observed_at: number; provenance: string };
    expect(row).toMatchObject({ status: "majin", provenance: "f3a_baseline" });
    expect(row.observed_at).toBeGreaterThanOrEqual(before);
    expect(row.observed_at).toBeLessThanOrEqual(after);
    expect(row.observed_at).not.toBe(1);
    reopened.close();
  });

  it("B/C. insertと実status変化だけappendし、same-status UPDATEはduplicate semantic eventを作らない", () => {
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO souls (user_id, status, updated_at) VALUES ('alice', 'ghost', 1)`).run();
    db.prepare(`UPDATE souls SET status = 'majin', updated_at = 2 WHERE user_id = 'alice'`).run();
    db.prepare(`UPDATE souls SET status = 'majin', updated_at = 3 WHERE user_id = 'alice'`).run();
    expect(db.prepare(
      `SELECT status, provenance FROM soul_status_history WHERE user_id = 'alice' ORDER BY id`,
    ).all()).toEqual([
      { status: "ghost", provenance: "soul_insert" },
      { status: "majin", provenance: "status_transition" },
    ]);
  });

  it("D. status transaction rollbackではtrigger historyだけが残らない", () => {
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO souls (user_id, status, updated_at) VALUES ('alice', 'ghost', 1)`).run();
    db.exec("BEGIN");
    db.prepare(`UPDATE souls SET status = 'majin', updated_at = 2 WHERE user_id = 'alice'`).run();
    db.exec("ROLLBACK");
    expect(db.prepare(`SELECT status FROM souls WHERE user_id = 'alice'`).pluck().get()).toBe("ghost");
    expect(db.prepare(`SELECT COUNT(*) FROM soul_status_history WHERE user_id = 'alice'`).pluck().get()).toBe(1);
  });
});

describe("J-U role-family manifest and trusted observation coverage", () => {
  it("canonical departments mappingをsnapshotし、actual /商館 authorization keyだけshop tagへ接続する", () => {
    const db = openDb(":memory:");
    const departments = new Departments(db, new Ledger(db));
    departments.upsert("冥界商館", "商館っぽい名前", "role-shop");
    departments.upsert("役割なし", "賭場という名前だけ", null);
    expect(buildPublicDepartmentRoleFamilyManifest(db)).toEqual({
      provenance: "departments_snapshot",
      families: [{
        familyKey: "department:冥界商館",
        roleIds: ["role-shop"],
        tags: ["public_department", "shop"],
      }],
    });
  });

  it("J/K/O/P/Q/R. startup snapshot、clean add/remove、leave/rejoinを境界どおり記録しbot/other guildを混ぜない", () => {
    const { db, temporal } = setup();
    const v1 = manifest([{ familyKey: "dept:a", roleIds: ["a1", "a2"], tags: ["public_department"] }]);
    temporal.startObservationSession("main", v1, [member("alice", ["a1"]), member("bot", ["a1"], true)], BASE);
    temporal.observeMemberSnapshot("other", member("outsider", ["a1"]), BASE + 2);
    temporal.observeMemberSnapshot("main", member("alice", []), BASE + 10);
    temporal.observeMemberSnapshot("main", member("alice", ["a2"]), BASE + 20);
    temporal.removeMember("main", "alice", BASE + 30);
    temporal.observeMemberSnapshot("main", member("alice", ["a1"]), BASE + 40);
    const rows = db.prepare(
      `SELECT user_id, family_key, started_at, ended_at, end_reason
         FROM role_family_member_presence ORDER BY id`,
    ).all();
    expect(rows).toEqual([
      { user_id: "alice", family_key: "dept:a", started_at: BASE, ended_at: BASE + 10, end_reason: "role_removed" },
      { user_id: "alice", family_key: "dept:a", started_at: BASE + 20, ended_at: BASE + 30, end_reason: "member_left" },
      { user_id: "alice", family_key: "dept:a", started_at: BASE + 40, ended_at: null, end_reason: null },
    ]);
  });

  it("S. role A→Bが同じsemantic familyならpresenceを切らずfamily breadthを増やさない", () => {
    const { db, temporal } = setup();
    const v1 = manifest([{ familyKey: "dept:a", roleIds: ["a1", "a2"], tags: ["public_department"] }]);
    temporal.startObservationSession("main", v1, [member("alice", ["a1"])], BASE);
    temporal.observeMemberSnapshot("main", member("alice", ["a2"]), BASE + 10);
    expect(db.prepare(`SELECT COUNT(*) FROM role_family_member_presence`).pluck().get()).toBe(1);
    expect(db.prepare(`SELECT ended_at FROM role_family_member_presence`).pluck().get()).toBeNull();
  });

  it("L. crash recoveryは前processのlast checkpointで閉じ、restart時刻まで延長しない", () => {
    const { db, temporal } = setup();
    const v1 = manifest([{ familyKey: "dept:a", roleIds: ["a"], tags: ["public_department"] }]);
    temporal.startObservationSession("main", v1, [member("alice", ["a"])], BASE);
    temporal.checkpoint("main", BASE + 30);
    expect(new RoleFamilyTemporal(db).recoverDangling("main")).toBe(1);
    expect(db.prepare(
      `SELECT ended_at, end_reason FROM role_family_member_presence WHERE user_id = 'alice'`,
    ).get()).toEqual({ ended_at: BASE + 30, end_reason: "crash_recovered" });
  });

  it("M. disconnect→fresh resumeはgapを埋めず、fetch後相当の新sessionから開始する", () => {
    const { db, temporal } = setup();
    const v1 = manifest([{ familyKey: "dept:a", roleIds: ["a"], tags: ["public_department"] }]);
    temporal.startObservationSession("main", v1, [member("alice", ["a"])], BASE);
    temporal.suspendGuild("main", BASE + 10, "disconnect");
    temporal.startObservationSession("main", v1, [member("alice", ["a"])], BASE + 40);
    expect(db.prepare(
      `SELECT started_at, ended_at FROM role_family_member_presence WHERE user_id = 'alice' ORDER BY id`,
    ).all()).toEqual([
      { started_at: BASE, ended_at: BASE + 10 },
      { started_at: BASE + 40, ended_at: null },
    ]);
  });

  it("N. unknown old snapshotはprior presenceをcloseし、fresh snapshot時刻からだけre-anchorする", () => {
    const { db, temporal } = setup();
    const v1 = manifest([{ familyKey: "dept:a", roleIds: ["a"], tags: ["public_department"] }]);
    temporal.startObservationSession("main", v1, [member("alice", ["a"])], BASE);
    temporal.markMemberUnknown("main", "alice", BASE + 10);
    temporal.observeMemberSnapshot("main", member("alice", ["a"]), BASE + 20);
    expect(db.prepare(
      `SELECT started_at, ended_at, end_reason FROM role_family_member_presence ORDER BY id`,
    ).all()).toEqual([
      { started_at: BASE, ended_at: BASE + 10, end_reason: "member_unknown" },
      { started_at: BASE + 20, ended_at: null, end_reason: null },
    ]);
  });

  it("T/U. manifest revision変更はold mapping/historyを書き換えず、current departments変更時はcoverageを即closeする", () => {
    const db = openDb(":memory:");
    const temporal = new RoleFamilyTemporal(db);
    const departments = new Departments(db, new Ledger(db));
    departments.upsert("a", "A", "role-a");
    const first = buildPublicDepartmentRoleFamilyManifest(db);
    temporal.startObservationSession("main", first, [member("alice", ["role-a"])], BASE);
    departments.upsert("a", "A", "role-b");
    const closed = db.prepare(
      `SELECT ended_at, end_reason FROM role_family_member_presence WHERE user_id = 'alice'`,
    ).get() as { ended_at: number; end_reason: string };
    expect(closed.end_reason).toBe("manifest_change");
    const second = buildPublicDepartmentRoleFamilyManifest(db);
    temporal.startObservationSession("main", second, [member("alice", ["role-b"])], closed.ended_at + 10);
    const revisions = db.prepare(
      `SELECT r.id, mr.role_id FROM role_family_manifest_revisions r
       JOIN role_family_manifest_roles mr ON mr.revision_id = r.id ORDER BY r.id`,
    ).all();
    expect(revisions).toEqual([
      { id: 1, role_id: "role-a" },
      { id: 2, role_id: "role-b" },
    ]);
  });

  it("duplicate role→multiple family manifestはbreadthを捏造するためfail closed", () => {
    const { temporal } = setup();
    expect(() => temporal.activateManifest("main", manifest([
      { familyKey: "a", roleIds: ["same"], tags: ["public_department"] },
      { familyKey: "b", roleIds: ["same"], tags: ["public_department"] },
    ]), BASE)).toThrow(/multiple semantic families/);
  });
});
