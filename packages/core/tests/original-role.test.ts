import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  Ledger,
  OriginalRoleError,
  OriginalRoles,
  ORIGINAL_ROLE_TERM_DAYS,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

/**
 * オリジナルロール。
 *
 * - **支払いは承認のあとだけ**（申請では Land を動かさない）
 * - 1人で複数持てる
 * - 更新はスタッフを介さない
 * - 期限切れでロールを剥奪する
 * - 旧契約は**人が明示的に登録**する（購入履歴から推測しない）
 */

registerDefaultTxTypes();
const USER = "111111111111111111";
const OTHER = "222222222222222222";
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const roles = new OriginalRoles(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed",
  });
  return { db, ledger, events, roles };
}

const balance = (ctx: ReturnType<typeof setup>) => ctx.ledger.balanceOf(`user:${USER}`);

describe("申請と審査", () => {
  it("**申請では Land を動かさない**", () => {
    const ctx = setup();
    const before = balance(ctx);

    const row = ctx.roles.apply({ userId: USER, name: "冥き翼", color: 0xa855f7, actor: "t" });

    expect(row.status).toBe("pending");
    expect(row.role_id).toBeNull();
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("承認しても、まだ課金しない（支払いは本人の操作）", () => {
    const ctx = setup();
    const row = ctx.roles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    const before = balance(ctx);

    const approved = ctx.roles.approve(row.id, "staff");

    expect(approved.status).toBe("approved");
    expect(approved.approved_by).toBe("staff");
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("差し戻しと却下は理由を残す", () => {
    const ctx = setup();
    const a = ctx.roles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    const b = ctx.roles.apply({ userId: USER, name: "い", color: null, actor: "t" });

    expect(ctx.roles.decide(a.id, "returned", "名前を短くしてください", "staff").status).toBe("returned");
    expect(ctx.roles.decide(b.id, "rejected", "規約に反します", "staff").decide_reason).toBe("規約に反します");
    ctx.db.close();
  });

  it("同じ申請を二度承認できない", () => {
    const ctx = setup();
    const row = ctx.roles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    ctx.roles.approve(row.id, "staff");

    expect(() => ctx.roles.approve(row.id, "staff")).toThrow(OriginalRoleError);
    ctx.db.close();
  });

  it("承認済みでなければ支払えない／他人のものは払えない", () => {
    const ctx = setup();
    const row = ctx.roles.apply({ userId: USER, name: "あ", color: null, actor: "t" });

    expect(() => ctx.roles.assertPayable(row.id, USER)).toThrow(OriginalRoleError); // まだ pending
    ctx.roles.approve(row.id, "staff");
    expect(() => ctx.roles.assertPayable(row.id, OTHER)).toThrow(OriginalRoleError); // 他人
    expect(ctx.roles.assertPayable(row.id, USER).id).toBe(row.id);
    ctx.db.close();
  });
});

describe("契約の開始", () => {
  it("ロールを作り終えてから契約が始まる（30日）", () => {
    const ctx = setup();
    const row = ctx.roles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.roles.approve(row.id, "staff");

    expect(ctx.roles.activate({ id: row.id, roleId: "r-1", purchaseId: 99, actor: "t" })).toBe(true);

    const after = ctx.roles.get(row.id)!;
    expect(after.status).toBe("active");
    expect(after.role_id).toBe("r-1");
    expect(after.purchase_id).toBe(99);
    expect(after.expires_at! - Math.floor(Date.now() / 1000)).toBeGreaterThan((ORIGINAL_ROLE_TERM_DAYS - 1) * DAY);
    ctx.db.close();
  });

  it("**同じ申請から2つの契約は始まらない**（再実行しても1回だけ）", () => {
    const ctx = setup();
    const row = ctx.roles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    ctx.roles.approve(row.id, "staff");

    expect(ctx.roles.activate({ id: row.id, roleId: "r-1", purchaseId: 1, actor: "t" })).toBe(true);
    expect(ctx.roles.activate({ id: row.id, roleId: "r-2", purchaseId: 2, actor: "t" })).toBe(false);

    expect(ctx.roles.get(row.id)!.role_id).toBe("r-1");
    ctx.db.close();
  });

  it("1人で複数のオリジナルロールを持てる", () => {
    const ctx = setup();
    for (const name of ["いち", "に", "さん"]) {
      const r = ctx.roles.apply({ userId: USER, name, color: null, actor: "t" });
      ctx.roles.approve(r.id, "staff");
      ctx.roles.activate({ id: r.id, roleId: `role-${name}`, purchaseId: r.id, actor: "t" });
    }

    expect(ctx.roles.listByUser(USER)).toHaveLength(3);
    ctx.db.close();
  });
});

describe("更新", () => {
  function activated(ctx: ReturnType<typeof setup>) {
    const row = ctx.roles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.roles.approve(row.id, "staff");
    ctx.roles.activate({ id: row.id, roleId: "r-1", purchaseId: 1, actor: "t" });
    return ctx.roles.get(row.id)!;
  }

  it("**課金と期限延長が同じ取引で決まる**（払ったのに伸びていない、が起きない）", () => {
    const ctx = setup();
    const row = activated(ctx);
    const before = balance(ctx);

    const renewed = ctx.roles.renew({ id: row.id, userId: USER, price: 250_000, actor: "t" });

    expect(balance(ctx)).toBe(before - 250_000);
    expect(renewed.expires_at! - row.expires_at!).toBe(ORIGINAL_ROLE_TERM_DAYS * DAY);
    ctx.db.close();
  });

  it("残り期間を損しない（期限前に更新しても切り捨てない）", () => {
    const ctx = setup();
    const row = activated(ctx);

    ctx.roles.renew({ id: row.id, userId: USER, price: 250_000, actor: "t" });
    const twice = ctx.roles.renew({ id: row.id, userId: USER, price: 250_000, actor: "t" });

    expect(twice.expires_at! - row.expires_at!).toBe(2 * ORIGINAL_ROLE_TERM_DAYS * DAY);
    ctx.db.close();
  });

  it("他人の契約は更新できない", () => {
    const ctx = setup();
    const row = activated(ctx);
    const before = balance(ctx);

    expect(() => ctx.roles.renew({ id: row.id, userId: OTHER, price: 250_000, actor: "t" })).toThrow(OriginalRoleError);
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("残高が足りなければ期限も伸びない", () => {
    const ctx = setup();
    const row = activated(ctx);
    const before = ctx.roles.get(row.id)!.expires_at;

    expect(() => ctx.roles.renew({ id: row.id, userId: USER, price: 99_000_000, actor: "t" })).toThrow();

    expect(ctx.roles.get(row.id)!.expires_at).toBe(before);
    ctx.db.close();
  });

  it("期限切れからでも更新して戻せる", () => {
    const ctx = setup();
    const row = activated(ctx);
    ctx.db.prepare("UPDATE original_roles SET status='expired', expires_at=? WHERE id=?").run(
      Math.floor(Date.now() / 1000) - DAY,
      row.id,
    );

    const renewed = ctx.roles.renew({ id: row.id, userId: USER, price: 250_000, actor: "t" });

    expect(renewed.status).toBe("active");
    expect(renewed.expires_at!).toBeGreaterThan(Math.floor(Date.now() / 1000));
    ctx.db.close();
  });
});

describe("期限まわり", () => {
  function activeWithExpiry(ctx: ReturnType<typeof setup>, expiresAt: number) {
    const row = ctx.roles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    ctx.roles.approve(row.id, "staff");
    ctx.roles.activate({ id: row.id, roleId: "r-1", purchaseId: 1, actor: "t" });
    ctx.db.prepare("UPDATE original_roles SET expires_at=? WHERE id=?").run(expiresAt, row.id);
    return row.id;
  }

  it("3日前の予告は一度だけ出す", () => {
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) + 2 * DAY);

    expect(ctx.roles.listExpiringSoon().map((r) => r.id)).toEqual([id]);
    ctx.roles.markExpiryNotified(id);
    expect(ctx.roles.listExpiringSoon()).toHaveLength(0);
    ctx.db.close();
  });

  it("まだ先の期限は予告しない", () => {
    const ctx = setup();
    activeWithExpiry(ctx, Math.floor(Date.now() / 1000) + 10 * DAY);
    expect(ctx.roles.listExpiringSoon()).toHaveLength(0);
    ctx.db.close();
  });

  it("期限切れは剥奪の対象になり、剥奪できるまで拾い直す", () => {
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) - DAY);

    expect(ctx.roles.listExpired().map((r) => r.id)).toEqual([id]);
    ctx.roles.markExpired(id, "t", false); // 剥奪に失敗した
    expect(ctx.roles.listExpired().map((r) => r.id)).toEqual([id]); // 次の巡回でも出る
    ctx.roles.markExpired(id, "t", true);
    expect(ctx.roles.listExpired()).toHaveLength(0);
    expect(ctx.roles.get(id)!.status).toBe("expired");
    ctx.db.close();
  });

  it("更新すると予告と剥奪の記録が消える（次の期限で改めて知らせる）", () => {
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) + DAY);
    ctx.roles.markExpiryNotified(id);

    ctx.roles.renew({ id, userId: USER, price: 250_000, actor: "t" });

    expect(ctx.roles.get(id)!.notified_expiry_at).toBeNull();
    ctx.db.close();
  });

  it("承認から7日で支払いが無ければ畳む", () => {
    const ctx = setup();
    const row = ctx.roles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    ctx.roles.approve(row.id, "staff");
    expect(ctx.roles.listUnpaidApprovals()).toHaveLength(0);

    ctx.db.prepare("UPDATE original_roles SET approved_at=? WHERE id=?").run(
      Math.floor(Date.now() / 1000) - 8 * DAY,
      row.id,
    );

    expect(ctx.roles.listUnpaidApprovals().map((r) => r.id)).toEqual([row.id]);
    expect(ctx.roles.cancelUnpaid(row.id, "system")).toBe(true);
    expect(ctx.roles.get(row.id)!.status).toBe("cancelled");
    expect(ctx.roles.cancelUnpaid(row.id, "system")).toBe(false); // 二度は畳まない
    ctx.db.close();
  });
});

describe("旧契約の引き継ぎ", () => {
  it("人が明示的に登録すれば、本人が更新できるようになる", () => {
    const ctx = setup();
    const expiresAt = Math.floor(Date.now() / 1000) + 10 * DAY;

    const row = ctx.roles.importExisting({ userId: USER, roleId: "r-old", name: "旧ロール", expiresAt, actor: "staff" });

    expect(row.status).toBe("active");
    expect(row.expires_at).toBe(expiresAt);
    expect(ctx.roles.renew({ id: row.id, userId: USER, price: 250_000, actor: "t" }).expires_at).toBe(
      expiresAt + ORIGINAL_ROLE_TERM_DAYS * DAY,
    );
    ctx.db.close();
  });

  it("**同じロールを二度登録できない**（引き継ぎの二重実行を止める）", () => {
    const ctx = setup();
    const expiresAt = Math.floor(Date.now() / 1000) + DAY;
    ctx.roles.importExisting({ userId: USER, roleId: "r-old", name: "旧", expiresAt, actor: "staff" });

    expect(() =>
      ctx.roles.importExisting({ userId: OTHER, roleId: "r-old", name: "旧", expiresAt, actor: "staff" }),
    ).toThrow(OriginalRoleError);
    ctx.db.close();
  });
});

describe("旧スキーマからの移行", () => {
  it("original_roles が無いDBでも openDb が通る", () => {
    const path = join(mkdtempSync(join(tmpdir(), "orig-")), "old.db");
    const old = new Database(path);
    // 旧本番相当（この機能のテーブルがまだ無い）
    old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO settings VALUES ('guild:main','g1',0)").run();
    old.close();

    const db = openDb(path);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(tables).toContain("original_roles");
    expect((db.prepare("SELECT COUNT(*) c FROM settings").get() as { c: number }).c).toBe(1); // 既存行は残る
    db.close();
  });
});
