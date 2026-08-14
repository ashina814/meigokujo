import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_EXTENSION_MAX_USES,
  EVAL_EXTENSION_PRICE_LAND,
  EventLog,
  Ledger,
  Shop,
  ShopError,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

const USER = "eval-extension-user";
const STAFF = "user:staff";
const NOW = 1_800_000_000;
const DAY = 86_400;
const tempDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1_000));
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(path = ":memory:") {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const item = shop.createItem(
    {
      name: "評価期間1日延長",
      description: "審判の刻限を1日延長します。購入即時反映。",
      price_land: EVAL_EXTENSION_PRICE_LAND,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "extend_deadline",
      delivery_data: JSON.stringify({ days: 1 }),
    },
    STAFF,
  );
  db.prepare(
    `INSERT INTO souls (user_id,status,ghost_at,eval_started_at,eval_deadline_at,updated_at)
     VALUES (?, 'ghost', ?, ?, ?, ?)`,
  ).run(USER, NOW - DAY, NOW - DAY, NOW + 14 * DAY, NOW);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "initial",
    actor: STAFF,
    idempotencyKey: "seed:eval-extension",
  });
  return { db, ledger, events, shop, item };
}

type Ctx = ReturnType<typeof setup>;

function buy(ctx: Ctx, key: string) {
  const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
  return ctx.shop.purchaseEvaluationExtension({
    itemId: ctx.item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expected: { ...quote, priceLand: EVAL_EXTENSION_PRICE_LAND },
    idempotencyKey: key,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ShopError ? error.code : String(error);
  }
}

describe("評価期間+1日 V2", () => {
  it("亡霊の現在サイクルへ50,000Ldで即時に1日追加し、購入と使用台帳を監査できる", () => {
    const ctx = setup();
    const beforeBalance = ctx.ledger.balanceOf(`user:${USER}`);
    const beforeDeadline = NOW + 14 * DAY;

    const result = buy(ctx, "eval-extension:1");

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeBalance - EVAL_EXTENSION_PRICE_LAND);
    expect(ctx.db.prepare("SELECT eval_deadline_at FROM souls WHERE user_id=?").get(USER)).toEqual({
      eval_deadline_at: beforeDeadline + DAY,
    });
    expect(result.purchase).toMatchObject({
      paid_land: EVAL_EXTENSION_PRICE_LAND,
      delivery_state: "delivered",
      delivered_at: NOW,
    });
    expect(result.extension).toMatchObject({
      purchase_id: result.purchase.id,
      eval_started_at: NOW - DAY,
      previous_deadline_at: beforeDeadline,
      new_deadline_at: beforeDeadline + DAY,
      sequence: 1,
    });
    const request = JSON.parse(result.purchase.request_json ?? "{}") as Record<string, unknown>;
    expect(request).toHaveProperty("evaluationExtension");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='shop_eval_extension_purchased'").get()).toEqual({ n: 1 });
  });

  it.each(["meirei", "majin", "departed"])("status=%s はLandを動かす前に拒否", (status) => {
    const ctx = setup();
    ctx.db.prepare("UPDATE souls SET status=? WHERE user_id=?").run(status, USER);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    expect(codeOf(() => buy(ctx, `status:${status}`))).toBe("ERR_EVAL_EXTENSION_STATUS");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
  });

  it("評価サイクル無しと期限切れをLand 0で拒否", () => {
    const noCycle = setup();
    noCycle.db.prepare("UPDATE souls SET eval_started_at=NULL WHERE user_id=?").run(USER);
    const beforeNoCycle = noCycle.ledger.balanceOf(`user:${USER}`);
    expect(codeOf(() => buy(noCycle, "no-cycle"))).toBe("ERR_EVAL_EXTENSION_CYCLE");
    expect(noCycle.ledger.balanceOf(`user:${USER}`)).toBe(beforeNoCycle);

    const expired = setup();
    expired.db.prepare("UPDATE souls SET eval_deadline_at=? WHERE user_id=?").run(NOW, USER);
    const beforeExpired = expired.ledger.balanceOf(`user:${USER}`);
    expect(codeOf(() => buy(expired, "expired"))).toBe("ERR_EVAL_EXTENSION_EXPIRED");
    expect(expired.ledger.balanceOf(`user:${USER}`)).toBe(beforeExpired);
  });

  it("同じ評価サイクルは5回までで、6回目は購入も課金も0", () => {
    const ctx = setup();
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    for (let i = 1; i <= EVAL_EXTENSION_MAX_USES; i += 1) {
      expect(buy(ctx, `limit:${i}`).extension.sequence).toBe(i);
    }
    const afterFive = ctx.ledger.balanceOf(`user:${USER}`);

    expect(codeOf(() => buy(ctx, "limit:6"))).toBe("ERR_EVAL_EXTENSION_LIMIT");
    expect(afterFive).toBe(before - EVAL_EXTENSION_MAX_USES * EVAL_EXTENSION_PRICE_LAND);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(afterFive);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(EVAL_EXTENSION_MAX_USES);
  });

  it("購入画面後の資格変更raceは期限もLandも動かさない", () => {
    const ctx = setup();
    const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    const beforeBalance = ctx.ledger.balanceOf(`user:${USER}`);
    const beforeDeadline = quote.currentDeadlineAt;
    ctx.db.prepare("UPDATE souls SET status='majin' WHERE user_id=?").run(USER);

    expect(
      codeOf(() => ctx.shop.purchaseEvaluationExtension({
        itemId: ctx.item.id,
        userId: USER,
        actor: USER,
        memberRoleIds: [],
        expected: { ...quote, priceLand: EVAL_EXTENSION_PRICE_LAND },
        idempotencyKey: "race:status",
      })),
    ).toBe("ERR_EVAL_EXTENSION_STATUS");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeBalance);
    expect(ctx.db.prepare("SELECT eval_deadline_at FROM souls WHERE user_id=?").get(USER)).toEqual({ eval_deadline_at: beforeDeadline });
  });

  it("同じ古い確認内容の二度押しは1回だけ成立し、2回目は無課金", () => {
    const ctx = setup();
    const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    const expected = { ...quote, priceLand: EVAL_EXTENSION_PRICE_LAND };
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const purchase = (key: string) => ctx.shop.purchaseEvaluationExtension({
      itemId: ctx.item.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      expected,
      idempotencyKey: key,
    });

    purchase("double:1");
    expect(codeOf(() => purchase("double:2"))).toBe("ERR_TERMS_CHANGED");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - EVAL_EXTENSION_PRICE_LAND);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
  });

  it("新しいeval_started_atなら使用回数がリセットされる", () => {
    const ctx = setup();
    for (let i = 1; i <= EVAL_EXTENSION_MAX_USES; i += 1) buy(ctx, `cycle1:${i}`);
    vi.setSystemTime(new Date((NOW + 100) * 1_000));
    ctx.db.prepare("UPDATE souls SET eval_started_at=?, eval_deadline_at=? WHERE user_id=?").run(NOW + 100, NOW + 14 * DAY, USER);

    const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    expect(quote.usedCount).toBe(0);
    expect(buy(ctx, "cycle2:1").extension).toMatchObject({ eval_started_at: NOW + 100, sequence: 1 });
  });

  it("現在サイクル中のV1 delivered購入を上限へ含め、過去サイクル分は含めない", () => {
    const ctx = setup();
    const insert = ctx.db.prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,paid_land,status,delivered_at,delivery_state,delivery_updated_at,auto_renew)
       VALUES (?,?,?,?,'active',?,'delivered',?,1)`,
    );
    insert.run(ctx.item.id, USER, NOW - 2 * DAY, EVAL_EXTENSION_PRICE_LAND, NOW - 2 * DAY, NOW - 2 * DAY);
    for (let i = 0; i < 4; i += 1) {
      insert.run(ctx.item.id, USER, NOW - 100 + i, EVAL_EXTENSION_PRICE_LAND, NOW - 100 + i, NOW - 100 + i);
    }

    const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    expect(quote.usedCount).toBe(4);
    expect(buy(ctx, "legacy:fifth").extension.sequence).toBe(5);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses").get()).toEqual({ n: 1 });
  });

  it("汎用purchase経路と壊れた商品設定は無課金でfail-closed", () => {
    const ctx = setup();
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    expect(codeOf(() => ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: USER, memberRoleIds: [] })))
      .toBe("ERR_EVAL_EXTENSION_SPECIAL_PURCHASE_REQUIRED");
    ctx.shop.updateItem(ctx.item.id, { price_land: 49_999, delivery_data: JSON.stringify({ days: 2 }) }, STAFF);
    expect(codeOf(() => buy(ctx, "bad-config"))).toBe("ERR_EVAL_EXTENSION_ITEM_CONFIG");
    expect(codeOf(() => ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: USER, memberRoleIds: [] })))
      .toBe("ERR_EVAL_EXTENSION_SPECIAL_PURCHASE_REQUIRED");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
  });

  it("旧DB相当でもopenDbで台帳を冪等作成し、既存購入をbackfillしない", () => {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-eval-extension-migration-"));
    tempDirs.push(dir);
    const path = join(dir, "bot.db");
    const first = setup(path);
    first.db.prepare("DROP TABLE shop_eval_extension_uses").run();
    first.db.prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew)
       VALUES (?,?,?,?,'active',1)`,
    ).run(first.item.id, "legacy", NOW - 10, EVAL_EXTENSION_PRICE_LAND);
    first.db.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses").get()).toEqual({ n: 0 });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM shop_purchases WHERE user_id='legacy'").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
