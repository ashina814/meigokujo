import { describe, expect, it } from "vitest";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { openDb } from "../src/db/bootstrap.js";
import { BOOST_REWARD_LD } from "../src/ledger/boost-guard.js";

function setup() {
  registerDefaultTxTypes();
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  ledger.ensureAccount("user:user-1", "user");
  return { db, ledger };
}

function insertBoostEvent(db: ReturnType<typeof openDb>, messageId: string): void {
  const eventAt = Math.floor(new Date("2026-08-18T12:00:00+09:00").getTime() / 1_000);
  db.prepare(
    `INSERT INTO boost_reward_events
       (message_id, user_id, outcome, reward, event_at, month_key, created_at)
     VALUES (?, 'user-1', 'capped', 0, ?, '2026-08', ?)`,
  ).run(messageId, eventAt, eventAt);
}

describe("reward_boost DB hardening", () => {
  it("50,000Ld以外のreward_boostを拒否する", () => {
    const { db, ledger } = setup();
    insertBoostEvent(db, "boost-wrong-amount");

    expect(() =>
      ledger.transfer({
        from: TREASURY,
        to: "user:user-1",
        amount: BOOST_REWARD_LD - 1,
        type: "reward_boost",
        actor: "test",
        refType: "discord_boost",
        refId: "boost-wrong-amount",
        idempotencyKey: "boost:boost-wrong-amount",
      }),
    ).toThrow(/ERR_BOOST_EVENT_REQUIRED/);
  });

  it("国庫以外のsystem口座からのreward_boostを拒否する", () => {
    const { db, ledger } = setup();
    insertBoostEvent(db, "boost-wrong-source");
    ledger.ensureAccount("sys:other", "system");
    db.prepare(
      "INSERT INTO balances(account_id, amount, updated_at) VALUES('sys:other', ?, ?) ON CONFLICT(account_id) DO UPDATE SET amount = excluded.amount",
    ).run(BOOST_REWARD_LD, Math.floor(Date.now() / 1_000));

    expect(() =>
      ledger.transfer({
        from: "sys:other",
        to: "user:user-1",
        amount: BOOST_REWARD_LD,
        type: "reward_boost",
        actor: "test",
        refType: "discord_boost",
        refId: "boost-wrong-source",
        idempotencyKey: "boost:boost-wrong-source",
      }),
    ).toThrow(/ERR_BOOST_EVENT_REQUIRED/);
  });

  it("event_atまたはmonth_keyが欠けたeventではreward_boostを通さない", () => {
    const { db, ledger } = setup();
    const now = Math.floor(Date.now() / 1_000);
    db.prepare(
      `INSERT INTO boost_reward_events
         (message_id, user_id, outcome, reward, event_at, month_key, created_at)
       VALUES ('boost-null-month', 'user-1', 'capped', 0, ?, NULL, ?)`,
    ).run(now, now);

    expect(() =>
      ledger.transfer({
        from: TREASURY,
        to: "user:user-1",
        amount: BOOST_REWARD_LD,
        type: "reward_boost",
        actor: "test",
        refType: "discord_boost",
        refId: "boost-null-month",
        idempotencyKey: "boost:boost-null-month",
      }),
    ).toThrow(/ERR_BOOST_EVENT_REQUIRED/);
  });

  it("triggerの現行versionだけが残る", () => {
    const { db } = setup();
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_reward_boost_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(triggers.map((row) => row.name)).toEqual([
      "trg_reward_boost_event_required_v3",
      "trg_reward_boost_monthly_limit_v3",
    ]);
  });
});
