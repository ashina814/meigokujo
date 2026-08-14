import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  Ledger,
  Settings,
  Shop,
  SubAccountError,
  SubAccounts,
  TREASURY,
  applySubAccountItemSetting,
  isEligibleMainRank,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

/**
 * サブ垢。
 *
 * - 申請でも承認でも **Land を動かさない**（旧仕様の先払いへ戻さない）
 * - main ↔ alt はこの表が正本。**購入履歴から推測しない**
 * - 自分自身・他人のサブ垢・本体は登録できない
 * - 資格判定は `souls.status`。**申請・承認・支払い直前のすべてで見る**
 */

registerDefaultTxTypes();
const MAIN = "111111111111111111";
const ALT = "222222222222222222";
const OTHER = "333333333333333333";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const subs = new SubAccounts(db, events);
  return { db, events, subs };
}

describe("資格（魔人以上）", () => {
  it("魔人・剣魔・魔族は持てる。亡霊・迷霊・待機・離脱は持てない", () => {
    expect(["majin", "kenma", "mazoku"].every((s) => isEligibleMainRank(s as never))).toBe(true);
    expect(["ghost", "meirei", "waiting", "departed"].some((s) => isEligibleMainRank(s as never))).toBe(false);
    expect(isEligibleMainRank(null)).toBe(false);
  });

  it("**迷霊は申請できない**", () => {
    const ctx = setup();
    expect(() => ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "meirei", actor: "t" })).toThrow(
      SubAccountError,
    );
    expect(ctx.subs.listByMain(MAIN)).toHaveLength(0);
    ctx.db.close();
  });

  it("**承認の時点でも階級を見る**（申請後に降格していたら承認できない）", () => {
    const ctx = setup();
    const row = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });

    expect(() => ctx.subs.approve(row.id, "staff", "meirei")).toThrow(SubAccountError);
    expect(ctx.subs.get(row.id)!.status).toBe("pending");
    ctx.db.close();
  });

  it("**支払い直前でも階級を見る**（承認後に降格していたら支払わせない）", () => {
    const ctx = setup();
    const row = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
    ctx.subs.approve(row.id, "staff", "majin");

    let code = "";
    try {
      ctx.subs.assertPayable(row.id, MAIN, "meirei");
    } catch (e) {
      code = (e as SubAccountError).code;
    }

    expect(code).toBe("ERR_RANK_TOO_LOW");
    expect(ctx.subs.get(row.id)!.status).toBe("approved"); // 状態は変えない
    ctx.db.close();
  });
});

describe("Discord階級操作のlease", () => {
  it("scheduler同期と運営解除を同時にclaimさせない", () => {
    const ctx = setup();
    const row = ctx.subs.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });

    expect(ctx.subs.claimRankOperation(row.id, "sync", "sync-1")).toBe(true);
    expect(ctx.subs.claimRankOperation(row.id, "deactivate", "deactivate-1")).toBe(false);
    expect(ctx.subs.releaseRankOperation(row.id, "deactivate-1")).toBe(false);
    expect(ctx.subs.releaseRankOperation(row.id, "sync-1")).toBe(true);
    expect(ctx.subs.claimRankOperation(row.id, "deactivate", "deactivate-1")).toBe(true);
    ctx.db.close();
  });

  it("期限切れleaseを別処理が取得したら、古いtokenは更新できない", () => {
    const ctx = setup();
    const row = ctx.subs.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });

    expect(ctx.subs.claimRankOperation(row.id, "sync", "stale", 0)).toBe(true);
    expect(ctx.subs.claimRankOperation(row.id, "deactivate", "current")).toBe(true);
    expect(ctx.subs.renewRankOperation(row.id, "stale")).toBe(false);
    expect(ctx.subs.renewRankOperation(row.id, "current")).toBe(true);
    ctx.db.close();
  });

  it("解除確定はdeactivate lease所有者だけが行い、purchase_idを残す", () => {
    const ctx = setup();
    const row = ctx.subs.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    ctx.db.prepare("UPDATE sub_accounts SET purchase_id=42 WHERE id=?").run(row.id);

    expect(ctx.subs.deactivate(row.id, "staff", "test", "not-owned")).toBe(false);
    expect(ctx.subs.get(row.id)!.status).toBe("active");
    expect(ctx.subs.claimRankOperation(row.id, "deactivate", "owned")).toBe(true);
    expect(ctx.subs.deactivate(row.id, "staff", "test", "owned")).toBe(true);
    expect(ctx.subs.get(row.id)!.status).toBe("cancelled");
    expect(ctx.subs.get(row.id)!.purchase_id).toBe(42);
    expect(ctx.subs.deactivate(row.id, "staff", "again", "owned")).toBe(false);
    ctx.db.close();
  });
});

describe("申請と審査", () => {
  it("**申請でも承認でも Land を動かさない**", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const ledger = new Ledger(db);
    const subs = new SubAccounts(db, events);
    ledger.ensureAccount(`user:${MAIN}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${MAIN}`,
      amount: 500_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed",
    });
    const before = ledger.balanceOf(`user:${MAIN}`);

    const row = subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
    subs.approve(row.id, "staff", "majin");

    expect(ledger.balanceOf(`user:${MAIN}`)).toBe(before);
    expect(subs.get(row.id)!.status).toBe("approved");
    expect(subs.get(row.id)!.purchase_id).toBeNull();
    db.close();
  });

  it("差し戻し・却下は理由を残す", () => {
    const ctx = setup();
    const row = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });

    const decided = ctx.subs.decide(row.id, "returned", "サブ垢の本人確認が取れませんでした", "staff");

    expect(decided.status).toBe("returned");
    expect(decided.decide_reason).toContain("本人確認");
    ctx.db.close();
  });

  it("有効化は承認からの1回だけ（同じ承認から二重に有効化しない）", () => {
    const ctx = setup();
    const row = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
    ctx.subs.approve(row.id, "staff", "majin");

    expect(ctx.subs.activate({ id: row.id, purchaseId: 1, actor: "t" })).toBe(true);
    expect(ctx.subs.activate({ id: row.id, purchaseId: 2, actor: "t" })).toBe(false);
    expect(ctx.subs.get(row.id)!.purchase_id).toBe(1);
    ctx.db.close();
  });

  it("承認から7日で支払いが無ければ畳む", () => {
    const ctx = setup();
    const row = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
    ctx.subs.approve(row.id, "staff", "majin");
    expect(ctx.subs.listUnpaidApprovals()).toHaveLength(0);

    ctx.db.prepare("UPDATE sub_accounts SET approved_at=? WHERE id=?").run(Math.floor(Date.now() / 1000) - 8 * 86_400, row.id);

    expect(ctx.subs.listUnpaidApprovals().map((r) => r.id)).toEqual([row.id]);
    expect(ctx.subs.cancelUnpaid(row.id, "system")).toBe(true);
    expect(ctx.subs.cancelUnpaid(row.id, "system")).toBe(false);
    ctx.db.close();
  });
});

describe("組み合わせの制限", () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
      return "";
    } catch (e) {
      return (e as SubAccountError).code;
    }
  };

  it("**自分自身をサブ垢にはできない**", () => {
    const ctx = setup();
    expect(codeOf(() => ctx.subs.apply({ mainUserId: MAIN, altUserId: MAIN, mainStatus: "majin", actor: "t" }))).toBe(
      "ERR_SELF",
    );
    ctx.db.close();
  });

  it("**同じサブ垢を複数の本体へ紐付けない**", () => {
    const ctx = setup();
    ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });

    expect(codeOf(() => ctx.subs.apply({ mainUserId: OTHER, altUserId: ALT, mainStatus: "majin", actor: "t" }))).toBe(
      "ERR_ALT_TAKEN",
    );
    ctx.db.close();
  });

  it("本体として登録されている人はサブ垢にできない／サブ垢は本体になれない", () => {
    const ctx = setup();
    ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });

    expect(codeOf(() => ctx.subs.apply({ mainUserId: OTHER, altUserId: MAIN, mainStatus: "majin", actor: "t" }))).toBe(
      "ERR_ALT_IS_MAIN",
    );
    expect(codeOf(() => ctx.subs.apply({ mainUserId: ALT, altUserId: OTHER, mainStatus: "majin", actor: "t" }))).toBe(
      "ERR_MAIN_IS_ALT",
    );
    ctx.db.close();
  });

  it("却下・解除された古い組み合わせは、同じ相手の再登録を邪魔しない", () => {
    const ctx = setup();
    const row = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
    ctx.subs.decide(row.id, "rejected", "本人確認できず", "staff");

    const again = ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });

    expect(again.status).toBe("pending");
    ctx.db.close();
  });

  it("DBの一意制約でも二重紐付けを止める（アプリの判定を飛ばしても入らない）", () => {
    const ctx = setup();
    ctx.subs.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
    const ts = Math.floor(Date.now() / 1000);

    expect(() =>
      ctx.db
        .prepare("INSERT INTO sub_accounts (main_user_id,alt_user_id,status,created_at,updated_at) VALUES (?,?,'pending',?,?)")
        .run(OTHER, ALT, ts, ts),
    ).toThrow(/UNIQUE/);
    ctx.db.close();
  });
});

describe("旧契約の引き継ぎ", () => {
  it("人が明示的に登録すれば、その場で有効になる", () => {
    const ctx = setup();

    const row = ctx.subs.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });

    expect(row.status).toBe("active");
    expect(ctx.subs.findByAlt(ALT)?.main_user_id).toBe(MAIN);
    ctx.db.close();
  });

  it("引き継ぎでも同じ組み合わせ判定を通す", () => {
    const ctx = setup();
    ctx.subs.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });

    expect(() => ctx.subs.importExisting({ mainUserId: OTHER, altUserId: ALT, actor: "staff" })).toThrow(SubAccountError);
    ctx.db.close();
  });
});

describe("純粋な迷霊は魔人以上の商品を買えない", () => {
  it("**購入処理そのもので止まる**（要件が設定されていれば）", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const ledger = new Ledger(db);
    const settings = new Settings(db);
    settings.set("role:ghost", "role-ghost", "t");
    settings.set("role:majin", "role-majin", "t");
    settings.set("role:kenma", "role-kenma", "t");
    settings.set("role:mazoku", "role-mazoku", "t");
    settings.set("role:meirei", "role-meirei", "t");
    // 本番と同じ判定（階級序列で「以上」を見る）を差し込む
    const order = ["role-ghost", "role-majin", "role-kenma", "role-mazoku"];
    const shop = new Shop(db, ledger, events, {
      roleCheck: (ids, req) => {
        const idx = order.indexOf(req);
        if (idx === -1) return ids.includes(req);
        const ok = new Set(order.slice(idx));
        return ids.some((r) => ok.has(r));
      },
    });
    const item = shop.createItem(
      { name: "サブ垢追加", price_land: 80_000, kind: "one_shot", delivery: "manual", require_role_id: "role-majin" },
      "staff",
    );
    ledger.ensureAccount(`user:${MAIN}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${MAIN}`,
      amount: 500_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed",
    });
    const before = ledger.balanceOf(`user:${MAIN}`);

    // 迷霊ロールだけを持つ人
    expect(() =>
      shop.purchase({ userId: MAIN, itemId: item.id, actor: "t", memberRoleIds: ["role-meirei"] }),
    ).toThrow(/ERR_ROLE_REQUIRED/);
    expect(ledger.balanceOf(`user:${MAIN}`)).toBe(before);

    // 魔人なら通る（要件そのものは正しく効いている）
    expect(shop.purchase({ userId: MAIN, itemId: item.id, actor: "t", memberRoleIds: ["role-majin"] }).purchase.id).toBeGreaterThan(0);
    db.close();
  });
});

/**
 * 旧production相当のDBから起動できることを確かめる。
 * `sub_accounts` が無い状態から `openDb()` が通り、表と索引が作られること。
 */
describe("既存DB（sub_accounts が無い）からの移行", () => {
  it("openDb が通り、表と一意索引が作られ、既存データが残る", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sub-mig-")), "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE shop_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      purchased_at INTEGER NOT NULL, expires_at INTEGER, paid_land INTEGER, paid_alt_kind TEXT,
      paid_alt_amount INTEGER, status TEXT NOT NULL DEFAULT 'active', delivered_at INTEGER, auto_renew INTEGER NOT NULL DEFAULT 0);`);
    old.prepare("INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land) VALUES (4,'u1',0,80000)").run();
    old.close();

    const db = openDb(path);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(tables).toContain("sub_accounts");
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sub_accounts'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(idx).toContain("idx_sub_accounts_alt_open");
    expect((db.prepare("SELECT COUNT(*) c FROM shop_purchases WHERE item_id=4").get() as { c: number }).c).toBe(1);

    const cols = (db.prepare("PRAGMA table_info(sub_accounts)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("activation_rank_baseline");
    expect(cols).toContain("activation_rank_settled_at");
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sub_account_rank_operations'").get(),
    ).toBeTruthy();

    // 移行後のDBで、そのまま登録できる
    const subs = new SubAccounts(db, new EventLog(db));
    expect(subs.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" }).status).toBe("active");
    db.close();
  });
});

/**
 * 旧事故は「商品#4の要件設定漏れ」だった。運用ルールを人の記憶に置かず、
 * 開業の手続きそのものに要件の設定を組み込む。
 */
describe("開業時に魔人要件を固定する", () => {
  function shopDb() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const settings = new Settings(db);
    const shop = new Shop(db, ledger, new EventLog(db));
    const item = shop.createItem({ name: "サブ垢追加", price_land: 80_000, kind: "one_shot", delivery: "manual" }, "staff");
    return { db, settings, shop, item };
  }

  it("**開業すると require_role_id に魔人ロールが入る**", () => {
    const ctx = shopDb();
    ctx.settings.set("role:majin", "role-majin", "staff");
    ctx.settings.set("shop:sub_account_item_id", String(ctx.item.id), "staff");

    applySubAccountItemSetting(ctx.db);

    const after = ctx.shop.getItem(ctx.item.id)!;
    expect(after.require_role_id).toBe("role-majin");
    expect(after.delivery).toBe("auto");
    expect(after.delivery_kind).toBe("activate_sub_account");
    ctx.db.close();
  });

  it("**`role:majin` が未設定なら何もしない**（要件を付けられないまま自動化しない）", () => {
    const ctx = shopDb();
    ctx.settings.set("shop:sub_account_item_id", String(ctx.item.id), "staff");

    applySubAccountItemSetting(ctx.db);

    const after = ctx.shop.getItem(ctx.item.id)!;
    expect(after.require_role_id).toBeNull();
    expect(after.delivery).toBe("manual"); // 自動化も進めない
    ctx.db.close();
  });

  it("商品IDが未設定なら何も触らない", () => {
    const ctx = shopDb();
    ctx.settings.set("role:majin", "role-majin", "staff");

    applySubAccountItemSetting(ctx.db);

    expect(ctx.shop.getItem(ctx.item.id)!.delivery).toBe("manual");
    ctx.db.close();
  });

  it("要件が後から消されても、起動のたびに入れ直す", () => {
    const ctx = shopDb();
    ctx.settings.set("role:majin", "role-majin", "staff");
    ctx.settings.set("shop:sub_account_item_id", String(ctx.item.id), "staff");
    applySubAccountItemSetting(ctx.db);
    ctx.db.prepare("UPDATE shop_items SET require_role_id=NULL WHERE id=?").run(ctx.item.id);

    applySubAccountItemSetting(ctx.db);

    expect(ctx.shop.getItem(ctx.item.id)!.require_role_id).toBe("role-majin");
    ctx.db.close();
  });
});

/** 列を足す前の `sub_accounts` がある本番から起動できること */
describe("既存DB（activation_rank_baseline 列が無い）からの移行", () => {
  it("openDb が通り、列が足され、既存行が残る", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sub-mig2-")), "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE sub_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, main_user_id TEXT NOT NULL, alt_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', purchase_id INTEGER,
      approved_by TEXT, approved_at INTEGER, decided_by TEXT, decided_at INTEGER, decide_reason TEXT,
      activated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    old.prepare("INSERT INTO sub_accounts (main_user_id,alt_user_id,status,created_at,updated_at) VALUES (?,?,'active',0,0)")
      .run(MAIN, ALT);
    old.close();

    const db = openDb(path);

    const cols = (db.prepare("PRAGMA table_info(sub_accounts)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("activation_rank_baseline");
    expect(cols).toContain("activation_rank_settled_at");
    expect((db.prepare("SELECT COUNT(*) c FROM sub_accounts").get() as { c: number }).c).toBe(1);
    // **既存行に推測で基準を生やさない**
    const subs = new SubAccounts(db, new EventLog(db));
    expect(subs.activationBaseline(1)).toBeNull();
    db.close();
  });
});
