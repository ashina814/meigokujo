import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Departments,
  EventLog,
  Ledger,
  REEVAL_INVITE_COUNT,
  REEVAL_PRICE_LAND,
  Shop,
  Tickets,
  ShopError,
  TREASURY,
  deptAccount,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

const USER = "reeval-user";
const STAFF = "user:staff";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const departments = new Departments(db, ledger);
  // 予約状況（tickets.linked_purchase_id）はTicketsが持つ。本番と同じ形にしておく。
  new Tickets(db, events);
  let itemId: number | null = null;
  let intakeUnavailable: string | null = null;
  const shop = new Shop(db, ledger, events, {
    reevalItemId: () => itemId,
    departments,
    assertReevaluationIntakeAvailable: () => {
      if (intakeUnavailable !== null) {
        throw new ShopError("ERR_REEVAL_INTAKE_UNAVAILABLE", { reason: intakeUnavailable });
      }
    },
  });
  const item = shop.createItem(
    {
      name: "再評価チャレンジ",
      description: "人間による再評価面談を受ける権利",
      price_land: REEVAL_PRICE_LAND,
      price_alt_kind: "invite",
      price_alt_amount: REEVAL_INVITE_COUNT,
      kind: "one_shot",
      delivery: "manual",
    },
    STAFF,
  );
  itemId = item.id;
  db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?,?,1)").run(USER, "meirei");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "initial",
    actor: STAFF,
    idempotencyKey: "seed:user",
  });
  return {
    db, ledger, events, departments, shop, item,
    /** 運営が延長商品を作り直して `shop:reeval_item_id` をA→Bへ変えた状態を作る。 */
    replaceSaleItem(): { id: number } {
      const next = shop.createItem(
        {
          name: "再評価チャレンジ（再作成）",
          description: "人間による再評価面談を受ける権利",
          price_land: REEVAL_PRICE_LAND,
          price_alt_kind: "invite",
          price_alt_amount: REEVAL_INVITE_COUNT,
          kind: "one_shot",
          delivery: "manual",
        },
        STAFF,
      );
      itemId = next.id;
      return next;
    },
    /** 現在の販売設定を外す（新規販売だけ止まり、既存権は生きるべき）。 */
    clearSaleItem() { itemId = null; },
    setIntakeUnavailable(reason: string | null) { intakeUnavailable = reason; },
  };
}

function invite(ctx: ReturnType<typeof setup>, count: number, prefix = "guest") {
  const stmt = ctx.db.prepare("INSERT INTO invites (inviter_id,invitee_id,credited_at) VALUES (?,?,?)");
  for (let i = 0; i < count; i += 1) stmt.run(USER, `${prefix}-${i}`, 100 + i);
}

function buy(ctx: ReturnType<typeof setup>, mode: "land" | "invite", key = `buy:${mode}`, itemId = ctx.item.id) {
  return ctx.shop.purchaseReevaluation({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    mode,
    idempotencyKey: key,
  }).purchase;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ShopError ? error.code : String(error);
  }
}

describe("再評価チャレンジV2決済", () => {
  it("迷霊だけがLandで購入でき、500,000Ldと未消費権を記録する", () => {
    const ctx = setup();
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const purchase = buy(ctx, "land");

    expect(purchase.paid_land).toBe(REEVAL_PRICE_LAND);
    expect(purchase.paid_alt_kind).toBeNull();
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - REEVAL_PRICE_LAND);
    expect(ctx.shop.listReevalInviteUses(purchase.id)).toHaveLength(0);
    expect(codeOf(() => buy(ctx, "land", "buy:land:again"))).toBe("ERR_REEVAL_RIGHT_EXISTS");
  });

  it.each(["ghost", "majin", "departed"])("%s は支払い直前の資格再検査で0Ld拒否", (status) => {
    const ctx = setup();
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    ctx.db.prepare("UPDATE souls SET status=? WHERE user_id=?").run(status, USER);

    expect(codeOf(() => buy(ctx, "land"))).toBe("ERR_REEVAL_STATUS");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
  });

  it("画面表示後に迷霊でなくなったraceでも課金しない", () => {
    const ctx = setup();
    expect(ctx.shop.checkReevaluationPurchase({ itemId: ctx.item.id, userId: USER, mode: "land" })).toEqual({
      availableInvites: 0,
    });
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    ctx.db.prepare("UPDATE souls SET status='ghost' WHERE user_id=?").run(USER);

    expect(codeOf(() => buy(ctx, "land"))).toBe("ERR_REEVAL_STATUS");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
  });

  it("確定招待5件を歴史から消さず使用台帳へ原子的に記録する", () => {
    const ctx = setup();
    invite(ctx, 5);
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const purchase = buy(ctx, "invite");

    expect(purchase.paid_land).toBeNull();
    expect(purchase.paid_alt_kind).toBe("invite");
    expect(purchase.paid_alt_amount).toBe(5);
    expect(ctx.shop.listReevalInviteUses(purchase.id)).toHaveLength(5);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 5 });
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
  });

  it.each([0, 1, 4])("未使用招待が%d件なら購入も招待使用も0件", (count) => {
    const ctx = setup();
    invite(ctx, count);
    expect(codeOf(() => buy(ctx, "invite"))).toBe("ERR_REEVAL_INVITES_INSUFFICIENT");
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 0 });
  });

  it("一度使用した招待は権利消費後も再利用できない", () => {
    const ctx = setup();
    invite(ctx, 5);
    const first = buy(ctx, "invite");
    ctx.shop.consumePurchaseForService(first.id, STAFF);

    expect(codeOf(() => buy(ctx, "invite", "buy:invite:second"))).toBe("ERR_REEVAL_INVITES_INSUFFICIENT");
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    expect(ctx.shop.listReevalInviteUses(first.id)).toHaveLength(5);
  });

  it("汎用payAlt経路では設定済み再評価商品を購入できない", () => {
    const ctx = setup();
    invite(ctx, 5);
    expect(
      codeOf(() =>
        ctx.shop.purchase({
          itemId: ctx.item.id,
          userId: USER,
          actor: USER,
          memberRoleIds: [],
          payAlt: true,
        }),
      ),
    ).toBe("ERR_REEVAL_SPECIAL_PURCHASE_REQUIRED");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 0 });
  });

  it("旧invite:5購入は使用台帳を捏造せず未消費権として互換維持する", () => {
    const ctx = setup();
    // 旧購入経路が実際に残していた形。当時の再評価商品は delivery=auto /
    // delivery_kind=revoke_meirei だったため、購入時snapshotがその意味を凍結している
    // （本番の未消費権もこの形で残っている）。金額やinvite数ではなく、この不変記録が正本。
    ctx.db
      .prepare(
        `INSERT INTO shop_purchases
          (item_id,user_id,purchased_at,paid_alt_kind,paid_alt_amount,status,auto_renew,delivery_snapshot_json)
         VALUES (?,?,1,'invite',5,'active',1,?)`,
      )
      .run(ctx.item.id, USER, JSON.stringify({ delivery: "auto", delivery_kind: "revoke_meirei", delivery_data: null, captured_at: 1 }));
    invite(ctx, 1, "legacy-real");

    expect(codeOf(() => buy(ctx, "land"))).toBe("ERR_REEVAL_RIGHT_EXISTS");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 1 });
  });
});

describe("再評価権のidentityは商品IDではない", () => {
  it("A→B差し替え後もAはsemanticな未消費権として見つかる", () => {
    const ctx = setup();
    const a = buy(ctx, "land", "A:1");
    const b = ctx.replaceSaleItem();
    expect(b.id).not.toBe(ctx.item.id);

    expect(ctx.shop.isReevaluationPurchase(a.id)).toBe(true);
    expect(ctx.shop.findUnconsumedReevaluationRight(USER)).toEqual({ id: a.id });
    expect(ctx.shop.findUnreservedReevaluationRight(USER)).toEqual({ id: a.id });
  });

  it("A未消費のままBは買えない（0 charge・invite消費0・購入追加0）", () => {
    const ctx = setup();
    buy(ctx, "land", "A:1");
    const b = ctx.replaceSaleItem();
    invite(ctx, REEVAL_INVITE_COUNT, "for-b");
    const beforeLand = ctx.ledger.balanceOf(`user:${USER}`);
    const beforePurchases = ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get() as { n: number };

    expect(codeOf(() => buy(ctx, "land", "B:land", b.id))).toBe("ERR_REEVAL_RIGHT_EXISTS");
    expect(codeOf(() => buy(ctx, "invite", "B:invite", b.id))).toBe("ERR_REEVAL_RIGHT_EXISTS");

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeLand);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual(beforePurchases);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 0 });
  });

  it("販売設定が消えても既存権は生きる。新規販売だけ0 chargeで止まる", () => {
    const ctx = setup();
    const a = buy(ctx, "land", "A:1");
    ctx.clearSaleItem();

    // 既存権は見つかるし、再評価権として認識される
    expect(ctx.shop.isReevaluationPurchase(a.id)).toBe(true);
    expect(ctx.shop.findUnconsumedReevaluationRight(USER)).toEqual({ id: a.id });
    // 新規販売だけ止まる
    const beforeLand = ctx.ledger.balanceOf(`user:${USER}`);
    expect(codeOf(() => buy(ctx, "land", "new:after-clear"))).toBe("ERR_REEVAL_ITEM_CONFIG");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeLand);
  });

  it("旧商品Aはgeneric storefrontからは買えない（A→B後・A有効のままでも）", () => {
    const ctx = setup();
    buy(ctx, "land", "A:1");
    ctx.shop.consumePurchaseForService(
      ctx.shop.findUnconsumedReevaluationRight(USER)!.id, STAFF, { result: "rejected" },
    );
    ctx.replaceSaleItem(); // 販売設定はBへ。Aはenabledのまま

    const beforeLand = ctx.ledger.balanceOf(`user:${USER}`);
    expect(codeOf(() => ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: STAFF, memberRoleIds: [] })))
      .toBe("ERR_REEVAL_SPECIAL_PURCHASE_REQUIRED");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeLand);
  });

  it("面談受付が使えないときは売らない（Land・招待実績を1も動かさない）", () => {
    for (const reason of ["panel_missing", "panel_disabled", "panel_archived", "panel_not_posted"]) {
      const ctx = setup();
      invite(ctx, REEVAL_INVITE_COUNT, `inv-${reason}`);
      ctx.setIntakeUnavailable(reason);
      const beforeLand = ctx.ledger.balanceOf(`user:${USER}`);

      expect(codeOf(() => buy(ctx, "land", `land:${reason}`))).toBe("ERR_REEVAL_INTAKE_UNAVAILABLE");
      expect(codeOf(() => buy(ctx, "invite", `invite:${reason}`))).toBe("ERR_REEVAL_INTAKE_UNAVAILABLE");
      // 表示前のpreflightと同じ前提条件を通るので、確認画面の段階でも止まる
      expect(codeOf(() => ctx.shop.checkReevaluationPurchase({ itemId: ctx.item.id, userId: USER, mode: "land" })))
        .toBe("ERR_REEVAL_INTAKE_UNAVAILABLE");

      expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeLand);
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 0 });
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 0 });
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ?").get(USER)).toEqual({
        n: REEVAL_INVITE_COUNT,
      });
    }
  });

  it("A→B後・設定未設定でも、消費済みAは補償候補として出る", () => {
    const ctx = setup();
    const a = buy(ctx, "land", "A:1");
    ctx.shop.consumePurchaseForService(a.id, STAFF, { result: "rejected" });

    ctx.replaceSaleItem();
    expect(ctx.shop.countCompensableReevaluationPurchases()).toBe(1);
    expect(ctx.shop.listCompensableReevaluationPurchases().map((r) => r.id)).toEqual([a.id]);

    ctx.clearSaleItem();
    expect(ctx.shop.countCompensableReevaluationPurchases()).toBe(1);
    expect(ctx.shop.listCompensableReevaluationPurchases().map((r) => r.id)).toEqual([a.id]);
  });

  it("A→B後の未消費Aは商館の手動配送キューへ出ない（list/count両方）", () => {
    const ctx = setup();
    buy(ctx, "land", "A:1");
    ctx.replaceSaleItem();
    // 現在の設定（B）だけを除外しても、旧Aが残ってはいけない。
    const exclude = [ctx.shop.getItem(ctx.item.id)!.id + 1_000_000]; // 無関係なID
    expect(ctx.shop.countPendingManual({ excludeItemIds: exclude })).toBe(0);
    expect(ctx.shop.listPendingManual({ excludeItemIds: exclude })).toEqual([]);
  });

  it("普通の手動配送商品はキューへ出る（除外が広すぎない）", () => {
    const ctx = setup();
    const normal = ctx.shop.createItem(
      { name: "手動配送の普通の商品", price_land: 10, kind: "one_shot", delivery: "manual" },
      STAFF,
    );
    ctx.shop.purchase({ itemId: normal.id, userId: USER, actor: STAFF, memberRoleIds: [] });
    expect(ctx.shop.countPendingManual()).toBe(1);
    expect(ctx.shop.listPendingManual().map((r) => r.item_id)).toEqual([normal.id]);
  });
});

describe("再評価チャレンジ例外補償", () => {
  it("部署経費として1回だけ支出し、購入結果と招待使用を維持する", () => {
    const ctx = setup();
    invite(ctx, 5);
    const purchase = buy(ctx, "invite");
    ctx.shop.consumePurchaseForService(purchase.id, STAFF, { result: "rejected" });
    ctx.departments.upsert("商館", "商館", "role:shop");
    ctx.ledger.transfer({
      from: TREASURY,
      to: deptAccount("商館"),
      amount: 500_000,
      type: "adjust",
      actor: STAFF,
      idempotencyKey: "seed:dept",
    });
    const beforeUser = ctx.ledger.balanceOf(`user:${USER}`);
    const beforeDept = ctx.departments.balanceOf("商館");

    const compensation = ctx.shop.compensateReevaluation({
      itemId: ctx.item.id,
      purchaseId: purchase.id,
      departmentKey: "商館",
      amount: 500_000,
      reason: "運営判断による例外補償",
      actor: STAFF,
      approvedBy: STAFF,
      idempotencyKey: `reeval:compensation:${purchase.id}`,
    });

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeUser + 500_000);
    expect(ctx.departments.balanceOf("商館")).toBe(beforeDept - 500_000);
    expect(compensation.purchase_id).toBe(purchase.id);
    const tx = ctx.ledger.getTx(compensation.ledger_transaction_id)!;
    expect(tx.type).toBe("dept_out");
    expect(tx.ref_type).toBe("shop_reeval_compensation");
    expect(tx.ref_id).toBe(String(purchase.id));
    expect(tx.actor_id).toBe(STAFF);
    expect(tx.approved_by).toBe(STAFF);
    expect(compensation.department_key).toBe("商館");
    expect(compensation.actor_id).toBe(STAFF);
    const compensationEvent = ctx.db
      .prepare("SELECT actor_id,payload_json FROM events WHERE type='shop_reeval_compensated'")
      .get() as { actor_id: string; payload_json: string };
    expect(compensationEvent.actor_id).toBe(STAFF);
    expect(JSON.parse(compensationEvent.payload_json)).toMatchObject({
      purchaseId: purchase.id,
      departmentKey: "商館",
      amount: 500_000,
    });
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.listReevalInviteUses(purchase.id)).toHaveLength(5);

    expect(
      codeOf(() =>
        ctx.shop.compensateReevaluation({
          itemId: ctx.item.id,
          purchaseId: purchase.id,
          departmentKey: "商館",
          amount: 500_000,
          reason: "二回目",
          actor: STAFF,
          idempotencyKey: `reeval:compensation:${purchase.id}:again`,
        }),
      ),
    ).toBe("ERR_REEVAL_ALREADY_COMPENSATED");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeUser + 500_000);

    expect(ctx.departments.balanceOf("商館")).toBe(0);
    ctx.departments.remove("商館");
    expect(ctx.departments.get("商館")).toBeUndefined();
    expect(ctx.shop.getReevalCompensation(purchase.id)).toMatchObject({
      department_key: "商館",
      actor_id: STAFF,
    });
  });

  it("未消費権には補償を実行しない", () => {
    const ctx = setup();
    const purchase = buy(ctx, "land");
    ctx.departments.upsert("商館", "商館", null);
    expect(
      codeOf(() =>
        ctx.shop.compensateReevaluation({
          itemId: ctx.item.id,
          purchaseId: purchase.id,
          departmentKey: "商館",
          amount: 1,
          reason: "不可",
          actor: STAFF,
          idempotencyKey: "comp:not-consumed",
        }),
      ),
    ).toBe("ERR_REEVAL_NOT_CONSUMED");
  });
});

describe("再評価V2 migration", () => {
  it("新台帳が無い旧DBを既存購入に触れずopenできる", () => {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-reeval-migration-"));
    tempDirs.push(dir);
    const path = join(dir, "bot.db");
    const before = openDb(path);
    before.exec("DROP TABLE shop_reeval_compensations; DROP TABLE shop_reeval_invite_uses;");
    before.prepare("INSERT INTO shop_items (name,price_land,kind,delivery,enabled,created_at,updated_at) VALUES ('旧#5',500000,'one_shot','manual',1,1,1)").run();
    before.prepare("INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_alt_kind,paid_alt_amount,status,auto_renew) VALUES (1,'legacy',1,'invite',5,'active',1)").run();
    before.close();

    const after = openDb(path);
    expect(after.prepare("SELECT status,paid_alt_kind,paid_alt_amount FROM shop_purchases WHERE id=1").get()).toEqual({
      status: "active",
      paid_alt_kind: "invite",
      paid_alt_amount: 5,
    });
    expect(after.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 0 });
    expect(after.prepare("SELECT COUNT(*) AS n FROM shop_reeval_compensations").get()).toEqual({ n: 0 });
    const compensationFks = after.prepare("PRAGMA foreign_key_list(shop_reeval_compensations)").all() as Array<{
      table: string;
      from: string;
    }>;
    expect(compensationFks).not.toContainEqual(expect.objectContaining({ table: "departments", from: "department_key" }));
    after.close();
  });
});
