import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { openDb } from "../src/db/bootstrap.js";

function setup() {
  registerDefaultTxTypes();
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  ledger.ensureAccount("user:user-1", "user");
  return { db, ledger };
}

function insertBoostEvent(
  db: ReturnType<typeof openDb>,
  messageId: string,
  monthKey = "2026-08",
  userId = "user-1",
): void {
  const eventAt = Math.floor(new Date(`${monthKey}-18T12:00:00+09:00`).getTime() / 1_000);
  db.prepare(
    `INSERT INTO boost_reward_events
       (message_id, user_id, outcome, reward, event_at, month_key, created_at)
     VALUES (?, ?, 'capped', 0, ?, ?, ?)`,
  ).run(messageId, userId, eventAt, monthKey, eventAt);
}

function pay(ledger: Ledger, messageId: string): void {
  ledger.transfer({
    from: TREASURY,
    to: "user:user-1",
    amount: 50_000,
    type: "reward_boost",
    actor: "test",
    reason: "boost test",
    refType: "discord_boost",
    refId: messageId,
    idempotencyKey: `boost:${messageId}`,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("reward_boost core guard", () => {
  it("Ledger生成時点でguardとevent tableが存在する", () => {
    const { db } = setup();
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='boost_reward_events'").get() as { name: string })
        .name,
    ).toBe("boost_reward_events");
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_reward_boost_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(triggers.map((r) => r.name)).toEqual([
      "trg_reward_boost_event_required_v3",
      "trg_reward_boost_monthly_limit_v3",
      "trg_reward_boost_pending_order_v1",
    ]);
  });

  it("Discord Boost eventへ結び付かない新規reward_boostを拒否する", () => {
    const { ledger } = setup();
    expect(() =>
      ledger.transfer({
        from: TREASURY,
        to: "user:user-1",
        amount: 50_000,
        type: "reward_boost",
        actor: "operator",
        reason: "manual boost",
        idempotencyKey: "manual:boost:1",
      }),
    ).toThrow(/ERR_BOOST_EVENT_REQUIRED/);
  });

  it("eventがあっても別message idempotency keyなら拒否する", () => {
    const { db, ledger } = setup();
    insertBoostEvent(db, "boost-1");
    expect(() =>
      ledger.transfer({
        from: TREASURY,
        to: "user:user-1",
        amount: 50_000,
        type: "reward_boost",
        actor: "operator",
        reason: "manual boost",
        refType: "discord_boost",
        refId: "boost-1",
        idempotencyKey: "manual:boost:1",
      }),
    ).toThrow(/ERR_BOOST_EVENT_REQUIRED/);
  });

  it("同一JST月の3回目をDB triggerで拒否する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const { db, ledger } = setup();
    insertBoostEvent(db, "boost-1");
    insertBoostEvent(db, "boost-2");
    insertBoostEvent(db, "boost-3");
    pay(ledger, "boost-1");
    pay(ledger, "boost-2");
    expect(() => pay(ledger, "boost-3")).toThrow(/ERR_BOOST_MONTHLY_LIMIT/);
    expect(ledger.balanceOf("user:user-1")).toBe(100_000);
  });

  it("旧来のevent無しreward_boost履歴は取引日時のJST月として上限に数える", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const { db } = setup();
    // 旧データはtrigger導入前に存在し得るので、履歴互換の状態をraw SQLで再現する。
    db.exec("DROP TRIGGER trg_reward_boost_event_required_v3; DROP TRIGGER trg_reward_boost_monthly_limit_v3;");
    db.prepare(
      `INSERT INTO transactions
         (idempotency_key, from_account, to_account, amount, type, reason,
          ref_type, ref_id, actor_id, approved_by, reversal_of, created_at)
       VALUES ('legacy:boost:1', ?, ?, 50000, 'reward_boost', 'legacy', NULL, NULL, 'operator', NULL, NULL, ?)`,
    ).run(TREASURY, "user:user-1", Math.floor(Date.now() / 1_000));
    // Ledgerを作り直すと現行guardが再導入される。
    const guarded = new Ledger(db);
    insertBoostEvent(db, "boost-2");
    insertBoostEvent(db, "boost-3");
    pay(guarded, "boost-2");
    expect(() => pay(guarded, "boost-3")).toThrow(/ERR_BOOST_MONTHLY_LIMIT/);
  });
});
