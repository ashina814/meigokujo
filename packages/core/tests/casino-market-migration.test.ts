import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange } from "../src/casino/exchange.js";
import { Markets } from "../src/casino/market.js";

registerDefaultTxTypes();

/**
 * 旧 casino_markets.status の CHECK 制約撤去マイグレーションの回帰テスト。
 *
 * 本番 DB で発見された問題: 初期スキーマの
 *   CHECK(status IN ('open','closed','reported','settled','void'))
 * は 'disputed'（既存コードで使用中）と 'frozen'（PR#6）を書き込めない。
 * Markets コンストラクタが冪等にテーブルを作り直して制約を外すことを検証する。
 */

function makeLegacyMarketsTable(db: ReturnType<typeof openDb>) {
  // 本番の旧スキーマを再現（frozen/disputed を含まない CHECK・後付け列も本番同様に付与）
  db.exec(`
    CREATE TABLE casino_markets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id       TEXT NOT NULL,
      creator_id     TEXT NOT NULL,
      title          TEXT NOT NULL,
      options_json   TEXT NOT NULL,
      deadline_at    INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','reported','settled','void')),
      result_option  INTEGER,
      channel_id     TEXT,
      message_id     TEXT,
      created_at     INTEGER NOT NULL,
      thread_id TEXT, payout_mode TEXT NOT NULL DEFAULT 'parimutuel', fee INTEGER NOT NULL DEFAULT 0,
      reported_at INTEGER, settled_at INTEGER
    );
    CREATE INDEX idx_casino_markets_open ON casino_markets(status, deadline_at);
    CREATE TABLE casino_market_bets (
      market_id INTEGER NOT NULL REFERENCES casino_markets(id),
      user_id TEXT NOT NULL, option_index INTEGER NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0), created_at INTEGER NOT NULL
    );
    CREATE TABLE casino_market_approvals (
      market_id INTEGER NOT NULL REFERENCES casino_markets(id),
      user_id TEXT NOT NULL, vote TEXT NOT NULL CHECK(vote IN ('approve','dispute')),
      created_at INTEGER NOT NULL, PRIMARY KEY (market_id, user_id)
    );
  `);
  // 既存データ（settled/void）+ 子テーブル参照を投入
  db.exec(`
    INSERT INTO casino_markets (id, guild_id, creator_id, title, options_json, deadline_at, status, created_at)
    VALUES (1,'g','u','T1','["A","B"]',100,'settled',10),
           (2,'g','u','T2','["A","B"]',100,'void',20);
    INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at)
    VALUES (1,'u',0,500,10);
  `);
}

describe("casino_markets status CHECK 制約撤去マイグレーション", () => {
  it("旧 CHECK 付きテーブルを作り直し、frozen/disputed を書き込めるようにする（データ保持）", () => {
    const db = openDb(":memory:");
    makeLegacyMarketsTable(db);
    // 事前確認: 旧スキーマでは 'frozen' を書けない
    expect(() => db.prepare("UPDATE casino_markets SET status='frozen' WHERE id=1").run()).toThrow();

    // Markets 構築 → マイグレーション実行
    const ledger = new Ledger(db);
    const ether = new EtherExchange(db, ledger, new EventLog(db));
    const markets = new Markets(db, ether, new EventLog(db));

    // CHECK が外れ、frozen/disputed を書ける
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='casino_markets'").get() as { sql: string }).sql;
    expect(/CHECK\s*\(\s*status/i.test(sql)).toBe(false);
    expect(() => db.prepare("UPDATE casino_markets SET status='frozen' WHERE id=1").run()).not.toThrow();
    expect(() => db.prepare("UPDATE casino_markets SET status='disputed' WHERE id=2").run()).not.toThrow();

    // データ保持（id・status・fund_mode デフォルト）
    const rows = db.prepare("SELECT id, fund_mode FROM casino_markets ORDER BY id").all() as Array<{ id: number; fund_mode: string }>;
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.every((r) => r.fund_mode === "legacy_house")).toBe(true);
    // 子テーブルの参照は有効なまま
    expect((db.prepare("SELECT COUNT(*) AS c FROM casino_market_bets WHERE market_id=1").get() as { c: number }).c).toBe(1);
    expect(db.pragma("foreign_key_check(casino_markets)")).toEqual([]);
    void markets;
  });

  it("冪等: 2回目の構築ではテーブルを作り直さない（新スキーマ or frozen 済みは no-op）", () => {
    const db = openDb(":memory:");
    makeLegacyMarketsTable(db);
    const ledger = new Ledger(db);
    const ether = new EtherExchange(db, ledger, new EventLog(db));
    new Markets(db, ether, new EventLog(db)); // 1回目: 作り直し
    const sql1 = (db.prepare("SELECT sql FROM sqlite_master WHERE name='casino_markets'").get() as { sql: string }).sql;
    new Markets(db, ether, new EventLog(db)); // 2回目: no-op のはず
    const sql2 = (db.prepare("SELECT sql FROM sqlite_master WHERE name='casino_markets'").get() as { sql: string }).sql;
    expect(sql1).toBe(sql2);
    expect(/CHECK\s*\(\s*status/i.test(sql2)).toBe(false);
  });

  it("frozen 状態を実際に永続化できる（マイグレーション後の end-to-end）", () => {
    const db = openDb(":memory:");
    makeLegacyMarketsTable(db);
    const ledger = new Ledger(db);
    // house に元手を用意
    ledger.ensureAccount("user:z", "user");
    ledger.transfer({ from: TREASURY, to: "user:z", amount: 10_000, type: "initial", actor: "t", idempotencyKey: "s:z" });
    const ether = new EtherExchange(db, ledger, new EventLog(db));
    ether.buy("z", 10_000, "buy:z");
    const markets = new Markets(db, ether, new EventLog(db));

    const m = markets.create({ guildId: "g", creatorId: "z", title: "F", options: ["A", "B"], durationMin: 60, fee: 0 });
    markets.bet(m.id, "z", 0, 3_000);
    // escrow を破損させて refundAllPending → frozen 化が **永続** することを確認
    const escHolder = `escrow:market:${m.id}`;
    ether.transfer(escHolder, "house", 1_000);
    const r = markets.refundAllPending("system:startup");
    expect(r.frozen).toBe(1);
    expect(markets.get(m.id)!.status).toBe("frozen"); // CHECK 撤去済みなので永続する
  });
});
