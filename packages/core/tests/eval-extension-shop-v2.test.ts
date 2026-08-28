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

function buy(ctx: Ctx, key: string, itemId = ctx.item.id) {
  const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId, userId: USER });
  return ctx.shop.purchaseEvaluationExtension({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expected: { ...quote, priceLand: EVAL_EXTENSION_PRICE_LAND },
    idempotencyKey: key,
  });
}

/** 運営が延長商品を「作り直した」ときにできる、別IDの正規な延長商品。 */
function replacementExtensionItem(ctx: Ctx, name: string) {
  return ctx.shop.createItem(
    {
      name,
      description: "審判の刻限を1日延長します。購入即時反映。",
      price_land: EVAL_EXTENSION_PRICE_LAND,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "extend_deadline",
      delivery_data: JSON.stringify({ days: 1 }),
    },
    STAFF,
  );
}

/**
 * 購入時snapshotを持つlegacy購入（V2台帳が無い時代の、実際の購入経路が残す形）。
 * `delivery_snapshot_json`は購入時点の商品定義を固定した不変記録で、これがあれば
 * 商品名や現在のitem設定に頼らず「延長を1日受け取った」と証明できる。
 */
function insertLegacyExtensionPurchase(ctx: Ctx, itemId: number, purchasedAt: number, snapshot: string | null) {
  ctx.db
    .prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,paid_land,status,delivered_at,delivery_state,delivery_updated_at,auto_renew,delivery_snapshot_json)
       VALUES (?,?,?,?,'active',?,'delivered',?,1,?)`,
    )
    .run(itemId, USER, purchasedAt, EVAL_EXTENSION_PRICE_LAND, purchasedAt, purchasedAt, snapshot);
}

/**
 * PR #131時代のwriterが残し得た状態を再現する。当時はsnapshotの有無に関係なく
 * 同一itemのdelivered購入をusedCountへ含めていたので、「snapshot無しのV1購入があり、
 * その後のV2購入が sequence=2 で発行されている」という履歴は旧実装でも成立し得た。
 */
function insertLedgerUse(ctx: Ctx, purchaseId: number, sequence: number, cycleStartedAt: number) {
  ctx.db
    .prepare(
      `INSERT INTO shop_eval_extension_uses
         (purchase_id,item_id,user_id,eval_started_at,previous_deadline_at,new_deadline_at,sequence,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(purchaseId, ctx.item.id, USER, cycleStartedAt, NOW, NOW + DAY, sequence, NOW);
}

function lastPurchaseId(ctx: Ctx): number {
  return (ctx.db.prepare("SELECT MAX(id) AS id FROM shop_purchases").get() as { id: number }).id;
}

const EXTENSION_SNAPSHOT = JSON.stringify({
  delivery: "auto",
  delivery_kind: "extend_deadline",
  delivery_data: JSON.stringify({ days: 1 }),
  captured_at: NOW - 200,
});

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

  it("別operationが同じ古い確認内容を使った場合は1回だけ成立し、2回目は無課金", () => {
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
    // 過去サイクル分（cycle開始前）は数えない。
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 2 * DAY, EXTENSION_SNAPSHOT);
    for (let i = 0; i < 4; i += 1) {
      insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 100 + i, EXTENSION_SNAPSHOT);
    }

    const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    expect(quote.usedCount).toBe(4); // PR #131契約: V2化で0へ戻らない
    expect(buy(ctx, "legacy:fifth").extension.sequence).toBe(5);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses").get()).toEqual({ n: 1 });
  });

  it("legacy compatibility boundary: 購入時snapshotが無く延長だと証明できない行は数えない", () => {
    const ctx = setup();
    // `delivery_kind`は`updateItem()`で後から変更できるので、「今この商品が延長商品だから」
    // を根拠に過去行を延長扱いすると、商品を作り直した運営操作で無関係な購入が遡って
    // 5回枠を食い潰しうる。よってsnapshotが無い行からは推測しない。
    // （数えないこと自体は上限に対して緩い側なので「fail-closed」ではない。発行済み
    //  sequenceを下限として採る別テストが、緩くなりすぎる側を塞いでいる。）
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 100, null);
    expect(ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER }).usedCount).toBe(0);
    // 壊れたsnapshotも「現在の商品定義で代用」しない。
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 99, "{not json");
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 98, JSON.stringify({ delivery: "manual", delivery_kind: "extend_deadline" }));
    expect(ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER }).usedCount).toBe(0);
  });

  it("発行済みsequenceは使用回数の保守的な下限——表示・上限・書き込みが1つの数で一致する", () => {
    const ctx = setup();
    // 旧実装が残し得た履歴: snapshot無しV1購入 + その後のV2購入が sequence=2。
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 200, null);
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 150, EXTENSION_SNAPSHOT);
    insertLedgerUse(ctx, lastPurchaseId(ctx), 2, NOW - DAY);

    // 直接証明できるのは台帳1件だけ（snapshot無しV1は推測しない）。しかし sequence=2 が
    // 発行済みなので「少なくとも2件使われた」を採る。
    const quote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    expect(quote.usedCount).toBe(2);
    expect(quote.remainingCount).toBe(3);
    expect(quote.nextSequence).toBe(3);

    // 購入前 2/5 → 購入後 3/5。DBのsequenceも3。表示と実体が食い違わない。
    const bought = buy(ctx, "lower-bound:next");
    expect(bought.extension.sequence).toBe(3);
    const after = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    expect(after.usedCount).toBe(3);
    expect(after.remainingCount).toBe(2);
  });

  it("sequence=5が発行済みなら、直接証明できる数が少なくても0 chargeで上限", () => {
    const ctx = setup();
    insertLegacyExtensionPurchase(ctx, ctx.item.id, NOW - 150, EXTENSION_SNAPSHOT);
    insertLedgerUse(ctx, lastPurchaseId(ctx), 5, NOW - DAY);

    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const deadlineBefore = ctx.db.prepare("SELECT eval_deadline_at AS d FROM souls WHERE user_id=?").get(USER);
    // 直接証明できるのは1件だが、sequence 5 が既に発行されている以上、枠は使い切っている。
    expect(codeOf(() => ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER })))
      .toBe("ERR_EVAL_EXTENSION_LIMIT");
    expect(codeOf(() => buy(ctx, "lower-bound:limit"))).toBe("ERR_EVAL_EXTENSION_LIMIT");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.db.prepare("SELECT eval_deadline_at AS d FROM souls WHERE user_id=?").get(USER)).toEqual(deadlineBefore);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses").get()).toEqual({ n: 1 });
  });

  it("legacy購入とV2台帳で同じpurchaseを二重に数えない", () => {
    const ctx = setup();
    buy(ctx, "dedupe:1");
    buy(ctx, "dedupe:2");
    // 実購入経路はsnapshotも書くので、legacy側の条件にも合致する行になる。
    const withSnapshot = (ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM shop_purchases
          WHERE user_id = ? AND delivery_snapshot_json IS NOT NULL`,
      )
      .get(USER) as { n: number }).n;
    expect(withSnapshot).toBe(2);
    // それでもusedCountは2——台帳にあるpurchaseはlegacy側から除外される。
    expect(ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER }).usedCount).toBe(2);
  });

  // ── 商品IDから切り離されたcycle identity（task #198） ──────────────────────────────
  it("商品A→Bへ差し替えても同じ評価サイクルなら回数を引き継ぐ", () => {
    const ctx = setup();
    buy(ctx, "A:1");
    buy(ctx, "A:2");
    const itemB = replacementExtensionItem(ctx, "評価期間1日延長（再作成）");
    expect(itemB.id).not.toBe(ctx.item.id);

    // 利用者が見ているのは「このサイクルで最大5回」——商品が変わっても 2 / 5 のまま。
    const quoteB = ctx.shop.checkEvaluationExtensionPurchase({ itemId: itemB.id, userId: USER });
    expect(quoteB.usedCount).toBe(2);
    expect(quoteB.remainingCount).toBe(EVAL_EXTENSION_MAX_USES - 2);
    expect(buy(ctx, "B:3", itemB.id).extension).toMatchObject({ sequence: 3, item_id: itemB.id });
  });

  it("A+Bを合わせて5回まで、6回目は0 chargeで拒否", () => {
    const ctx = setup();
    buy(ctx, "mix:1");
    buy(ctx, "mix:2");
    const itemB = replacementExtensionItem(ctx, "延長B");
    expect(buy(ctx, "mix:3", itemB.id).extension.sequence).toBe(3);
    expect(buy(ctx, "mix:4", itemB.id).extension.sequence).toBe(4);
    expect(buy(ctx, "mix:5", itemB.id).extension.sequence).toBe(5);

    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const deadlineBefore = ctx.db.prepare("SELECT eval_deadline_at AS d FROM souls WHERE user_id=?").get(USER);
    // A側から6回目を試しても、商品が違うことを理由に枠が復活したりしない。
    expect(codeOf(() => buy(ctx, "mix:6", ctx.item.id))).toBe("ERR_EVAL_EXTENSION_LIMIT");
    expect(codeOf(() => buy(ctx, "mix:6b", itemB.id))).toBe("ERR_EVAL_EXTENSION_LIMIT");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.db.prepare("SELECT eval_deadline_at AS d FROM souls WHERE user_id=?").get(USER)).toEqual(deadlineBefore);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses").get()).toEqual({ n: 5 });
  });

  it("新しい評価サイクルなら、A/Bの購入履歴が残っていても0へ戻る", () => {
    const ctx = setup();
    buy(ctx, "cycle:A1");
    const itemB = replacementExtensionItem(ctx, "延長B");
    buy(ctx, "cycle:B2", itemB.id);
    expect(ctx.shop.checkEvaluationExtensionPurchase({ itemId: itemB.id, userId: USER }).usedCount).toBe(2);

    // サイクルが変わったときだけ新しい5回枠になる（商品IDの変化はresetではない）。
    ctx.db
      .prepare("UPDATE souls SET eval_started_at = ?, eval_deadline_at = ?, updated_at = ? WHERE user_id = ?")
      .run(NOW + 100, NOW + 100 + 14 * DAY, NOW, USER);
    expect(ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER }).usedCount).toBe(0);
    expect(ctx.shop.checkEvaluationExtensionPurchase({ itemId: itemB.id, userId: USER }).usedCount).toBe(0);
    expect(buy(ctx, "cycle:new1", itemB.id).extension).toMatchObject({ eval_started_at: NOW + 100, sequence: 1 });
  });

  it("stale quote: 表示後に別商品で購入されたら、古い確認はLandを引かずに拒否", () => {
    const ctx = setup();
    const staleQuote = ctx.shop.checkEvaluationExtensionPurchase({ itemId: ctx.item.id, userId: USER });
    const itemB = replacementExtensionItem(ctx, "延長B");
    buy(ctx, "stale:other", itemB.id); // 別商品でusedCount/deadlineが動く

    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const code = codeOf(() =>
      ctx.shop.purchaseEvaluationExtension({
        itemId: ctx.item.id,
        userId: USER,
        actor: `user:${USER}`,
        memberRoleIds: [],
        expected: { ...staleQuote, priceLand: EVAL_EXTENSION_PRICE_LAND },
        idempotencyKey: "stale:confirm",
      }),
    );
    expect(code).toBe("ERR_TERMS_CHANGED");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
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
