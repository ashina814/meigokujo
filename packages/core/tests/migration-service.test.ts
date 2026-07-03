import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { parseBalanceDump } from "../src/migration/parse.js";
import { Migration, type MemberNameInfo } from "../src/migration/service.js";

registerDefaultTxTypes();

const DUMP = `
04 | Belphegor: 7648595 Ld (手:50000 / 預:613595 / 業:6985000)
08 | 橋本: 3115933 Ld (手:459800 / 預:253133 / 業:2403000)
32 | 橋本: 325000 Ld (手:325000 / 預:0 / 業:0)
43 | 江戸川乱歩: 196719 Ld (手:169005 / 預:27714 / 業:0)
57 | よる: 80000 Ld (手:80000 / 預:0 / 業:0)
99 | 退去済みの人: 50000 Ld (手:50000 / 預:0 / 業:0)
`;

const MEMBERS: MemberNameInfo[] = [
  { userId: "100", names: ["Belphegor", "belphegor_x"] },
  { userId: "201", names: ["橋本", "hashimoto1"] },
  { userId: "202", names: ["橋本", "hashimoto2"] },
  { userId: "300", names: ["江戸川乱歩", "ranpo"] },
  { userId: "400", names: ["よる", "yoru"] },
  // 「退去済みの人」に該当するメンバーはいない
];

const CAP = 1_000_000;
const STAFF = "user:staff";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const migration = new Migration(db, ledger);
  const summary = migration.import(parseBalanceDump(DUMP), MEMBERS, CAP);
  return { db, ledger, migration, summary };
}

describe("移行ステージング", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("取込で auto / ambiguous / over_cap / unmatched に振り分けられる", () => {
    expect(ctx.summary).toMatchObject({ staged: 6, auto: 2, ambiguous: 2, overCap: 1, unmatched: 1 });
    const counts = ctx.migration.counts();
    expect(counts.auto).toBe(2); // 江戸川乱歩・よる
    expect(counts.over_cap).toBe(1); // Belphegor 764万 > 100万
    expect(counts.ambiguous).toBe(2); // 橋本×2
    expect(counts.unmatched).toBe(1); // 退去済みの人
  });

  it("実行は auto と ready だけを opening 発行し、未処理の残りを報告する", () => {
    const report = ctx.migration.execute(STAFF);
    expect(report.succeeded).toBe(2);
    expect(report.totalIssued).toBe(196_719 + 80_000);
    expect(report.remaining).toBe(4); // 橋本×2 + Belphegor + 退去済み
    expect(ctx.ledger.balanceOf("user:300")).toBe(196_719);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("同名衝突は割当で解決でき、再実行で支給される（既支給はスキップ）", () => {
    ctx.migration.execute(STAFF);
    ctx.migration.assign(8, "201", STAFF); // 8位の橋本 = 201
    ctx.migration.assign(32, "202", STAFF); // 32位の橋本 = 202
    const report = ctx.migration.execute(STAFF);
    expect(report.succeeded).toBe(2);
    expect(report.skippedAsPaid).toBe(0); // 支給済み行は done になっており対象外（冪等スキップは再取込テストで検証）
    expect(ctx.ledger.balanceOf("user:201")).toBe(3_115_933);
    expect(ctx.ledger.balanceOf("user:202")).toBe(325_000);
  });

  it("キャップ超過は承認しない限り実行されない", () => {
    ctx.migration.execute(STAFF);
    expect(ctx.ledger.balanceOf("user:100")).toBe(0);
    ctx.migration.approve(4, STAFF);
    const report = ctx.migration.execute(STAFF);
    expect(report.succeeded).toBe(1);
    expect(ctx.ledger.balanceOf("user:100")).toBe(7_648_595);
  });

  it("除外した行は実行されず、auto行の除外も可能", () => {
    ctx.migration.exclude(99, STAFF, "退去済み");
    ctx.migration.exclude(57, STAFF);
    const report = ctx.migration.execute(STAFF);
    expect(report.succeeded).toBe(1); // 江戸川乱歩のみ
    expect(ctx.ledger.balanceOf("user:400")).toBe(0);
  });

  it("再取込してもステージングが作り直されるだけで、二重支給は冪等キーが防ぐ", () => {
    ctx.migration.execute(STAFF);
    ctx.migration.import(parseBalanceDump(DUMP), MEMBERS, CAP); // 再取込（statusはリセット）
    const report = ctx.migration.execute(STAFF);
    expect(report.succeeded).toBe(0);
    expect(report.skippedAsPaid).toBe(2);
    expect(ctx.ledger.balanceOf("user:300")).toBe(196_719); // 増えていない
  });
});
