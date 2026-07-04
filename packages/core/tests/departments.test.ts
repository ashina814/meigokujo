import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Departments, DepartmentError, deptAccount } from "../src/departments/service.js";
import { LedgerError } from "../src/ledger/errors.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const departments = new Departments(db, ledger);
  const fund = (userId: string, amount: number) =>
    ledger.transfer({
      from: TREASURY,
      to: `user:${userId}`,
      amount,
      type: "initial",
      actor: "test",
      idempotencyKey: `fund:${userId}:${Math.random()}`,
      approvedBy: amount > 1_000_000 ? "test" : undefined,
    });
  for (const u of ["staff", "guest"]) {
    ledger.ensureAccount(`user:${u}`, "user");
    fund(u, 500_000);
  }
  return { db, ledger, departments };
}

const tx = (key: string, id: string) => `t:${key}:${id}`;

describe("部署口座", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("作成で system 勘定が用意され、残高0で始まる", () => {
    const d = ctx.departments.upsert("賭博場", "賭博場", "role:casino");
    expect(d.key).toBe("賭博場");
    expect(d.role_id).toBe("role:casino");
    expect(ctx.ledger.getAccount(deptAccount("賭博場"))?.kind).toBe("system");
    expect(ctx.departments.balanceOf("賭博場")).toBe(0);
  });

  it("同じキーで作り直すと名前・ロールが更新される（口座はそのまま）", () => {
    ctx.departments.upsert("賭博場", "賭博場", "role:old");
    ctx.departments.deposit("staff", { key: "賭博場", amount: 10_000, actor: "user:staff", idempotencyKey: tx("賭博場", "1") });
    ctx.departments.upsert("賭博場", "賭博場", "role:new"); // 担当替え
    expect(ctx.departments.get("賭博場")?.role_id).toBe("role:new");
    expect(ctx.departments.balanceOf("賭博場")).toBe(10_000); // 資金は保持
  });

  it("キーに ':' を含むと弾く", () => {
    expect(() => ctx.departments.upsert("a:b", "x", null)).toThrow(DepartmentError);
  });

  it("入金: 住人→部署 で資金が移る", () => {
    ctx.departments.upsert("商館", "商館", "role:shop");
    ctx.departments.deposit("staff", { key: "商館", amount: 120_000, actor: "user:staff", idempotencyKey: tx("商館", "in") });
    expect(ctx.departments.balanceOf("商館")).toBe(120_000);
    expect(ctx.ledger.balanceOf("user:staff")).toBe(500_000 - 120_000);
  });

  it("出金: 部署→住人。残高不足は ERR_INSUFFICIENT", () => {
    ctx.departments.upsert("商館", "商館", "role:shop");
    ctx.departments.deposit("staff", { key: "商館", amount: 100_000, actor: "user:staff", idempotencyKey: tx("商館", "in") });

    ctx.departments.withdraw("guest", { key: "商館", amount: 30_000, actor: "user:staff", idempotencyKey: tx("商館", "out") });
    expect(ctx.departments.balanceOf("商館")).toBe(70_000);
    expect(ctx.ledger.balanceOf("user:guest")).toBe(500_000 + 30_000);

    expect(() =>
      ctx.departments.withdraw("guest", { key: "商館", amount: 999_999, actor: "user:staff", idempotencyKey: tx("商館", "out2") }),
    ).toThrow(LedgerError);
  });

  it("歩合: 部署→従業員 に type=commission で記帳される", () => {
    ctx.departments.upsert("賭博場", "賭博場", "role:casino");
    ctx.departments.deposit("guest", { key: "賭博場", amount: 200_000, actor: "user:guest", idempotencyKey: tx("賭博場", "in") });
    const r = ctx.departments.payCommission("staff", { key: "賭博場", amount: 50_000, actor: "user:staff", idempotencyKey: tx("賭博場", "comm") });
    expect(r.tx.type).toBe("commission");
    expect(ctx.ledger.balanceOf("user:staff")).toBe(500_000 + 50_000);
    expect(ctx.departments.balanceOf("賭博場")).toBe(150_000);
  });

  it("canOperate: 担当ロール保持者だけ true", () => {
    ctx.departments.upsert("宿屋", "宿屋", "role:inn");
    expect(ctx.departments.canOperate("宿屋", ["role:inn", "role:x"])).toBe(true);
    expect(ctx.departments.canOperate("宿屋", ["role:x"])).toBe(false);
  });

  it("削除は残高0のときだけ。残っていると弾く", () => {
    ctx.departments.upsert("門番", "門番", "role:gate");
    ctx.departments.deposit("staff", { key: "門番", amount: 5_000, actor: "user:staff", idempotencyKey: tx("門番", "in") });
    expect(() => ctx.departments.remove("門番")).toThrow(DepartmentError);

    ctx.departments.withdraw("staff", { key: "門番", amount: 5_000, actor: "user:staff", idempotencyKey: tx("門番", "out") });
    ctx.departments.remove("門番");
    expect(ctx.departments.get("門番")).toBeUndefined();
  });

  it("一連の入出金後も台帳の検算（Σ=0）が保たれる", () => {
    ctx.departments.upsert("賭博場", "賭博場", "role:casino");
    ctx.departments.deposit("staff", { key: "賭博場", amount: 100_000, actor: "user:staff", idempotencyKey: tx("賭博場", "a") });
    ctx.departments.payCommission("guest", { key: "賭博場", amount: 40_000, actor: "user:staff", idempotencyKey: tx("賭博場", "b") });
    ctx.departments.withdraw("staff", { key: "賭博場", amount: 20_000, actor: "user:staff", idempotencyKey: tx("賭博場", "c") });
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });
});
