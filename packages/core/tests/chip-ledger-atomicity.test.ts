import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedgerCore, ChipLedgerError, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { deptAccount } from "../src/departments/service.js";

registerDefaultTxTypes();

/**
 * PR8監査・項目14: 資金APIの原子性と冪等性。
 *
 * 「失敗したら例外が出る」だけでは不十分で、**失敗した時に何が残るか**が本題になる。
 * Land だけ動いてチップが出ていない／チップ明細だけ残ってグループが無い、といった
 * 半端な状態は、あとから帳簿を読んでも真相が復元できない。
 *
 * ここでは deposit / redeem / fundFromAccount / redeemToAccount の各段階
 * （Land 移動の前後・チップ残高更新の前後・チップ明細の記録前後・event 記録時）に
 * 例外を注入し、**どの段階で落ちても DB が操作前と1バイトも変わらない**ことを確かめる。
 */

const DEPT = deptAccount("賭博場");

/** 例外の注入位置。名前がそのまま「どこで落ちたか」の記録になる */
type InjectionPoint =
  | "before_land"
  | "after_land"
  | "before_chip_balance"
  | "after_chip_balance"
  | "before_chip_tx"
  | "after_chip_tx"
  | "on_event";

class Injected extends Error {
  constructor(readonly at: InjectionPoint) {
    super(`injected:${at}`);
    this.name = "Injected";
  }
}

const POINTS: InjectionPoint[] = [
  "before_land",
  "after_land",
  "before_chip_balance",
  "after_chip_balance",
  "before_chip_tx",
  "after_chip_tx",
  "on_event",
];

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedgerCore(db, ledger, events, { chipTx });
  ledger.ensureAccount(DEPT, "system");
  ledger.transfer({ from: TREASURY, to: DEPT, amount: 5_000_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
  ledger.ensureAccount("user:a", "user");
  ledger.transfer({ from: TREASURY, to: "user:a", amount: 1_000_000, type: "initial", actor: "t", idempotencyKey: "seed:a" });
  return { db, ledger, events, chipTx, chips };
}

type Ctx = ReturnType<typeof setup>;

/**
 * 実装の内部を書き換えずに例外を差し込む。
 *
 * `Ledger.transfer`（Land 移動）・`ChipLedgerCore` の残高更新・`ChipTx.record`・
 * `EventLog.log` を一時的に包んで、指定した位置で必ず例外にする。本番の呼び出し順に
 * 依存するので、順序が変わればこのテストが落ちる（＝実装の変更を検知できる）。
 */
function withInjection<T>(ctx: Ctx, at: InjectionPoint, body: () => T): T {
  const ledgerTransfer = ctx.ledger.transfer.bind(ctx.ledger);
  const chipRecord = ctx.chipTx.record.bind(ctx.chipTx);
  const eventLog = ctx.events.log.bind(ctx.events);
  // setBalance は private なので、公開経路である ether_balances の UPDATE を包む代わりに
  // 「チップ残高が変わる直前/直後」を balanceOf の呼び出し回数ではなく prepare 差し替えで捕まえる
  const dbPrepare = ctx.db.prepare.bind(ctx.db);

  const boom = () => {
    throw new Injected(at);
  };

  (ctx.ledger as { transfer: typeof ledgerTransfer }).transfer = (req) => {
    if (at === "before_land") boom();
    const r = ledgerTransfer(req);
    if (at === "after_land") boom();
    return r;
  };
  (ctx.chipTx as { record: typeof chipRecord }).record = (move) => {
    if (at === "before_chip_tx") boom();
    const r = chipRecord(move);
    if (at === "after_chip_tx") boom();
    return r;
  };
  (ctx.events as { log: typeof eventLog }).log = (type, payload) => {
    if (at === "on_event") boom();
    return eventLog(type, payload);
  };
  if (at === "before_chip_balance" || at === "after_chip_balance") {
    (ctx.db as { prepare: typeof dbPrepare }).prepare = ((sql: string) => {
      const stmt = dbPrepare(sql);
      if (!/UPDATE ether_balances SET amount = amount \+/.test(sql)) return stmt;
      const run = stmt.run.bind(stmt);
      return new Proxy(stmt, {
        get(target, prop, receiver) {
          if (prop !== "run") return Reflect.get(target, prop, receiver);
          return (...args: unknown[]) => {
            if (at === "before_chip_balance") boom();
            const r = run(...(args as never[]));
            if (at === "after_chip_balance") boom();
            return r;
          };
        },
      });
    }) as typeof dbPrepare;
  }

  try {
    return body();
  } finally {
    (ctx.ledger as { transfer: typeof ledgerTransfer }).transfer = ledgerTransfer;
    (ctx.chipTx as { record: typeof chipRecord }).record = chipRecord;
    (ctx.events as { log: typeof eventLog }).log = eventLog;
    (ctx.db as { prepare: typeof dbPrepare }).prepare = dbPrepare;
  }
}

/** DB 全体の「動いたかどうか」。Land・チップ・グループ・明細・event を一度に見る */
function snapshot(ctx: Ctx) {
  const all = (sql: string) => ctx.db.prepare(sql).all();
  return {
    land: all("SELECT account_id, amount FROM balances ORDER BY account_id"),
    landTx: all("SELECT id, from_account, to_account, amount, type, idempotency_key FROM transactions ORDER BY id"),
    chips: all("SELECT user_id, amount FROM ether_balances ORDER BY user_id"),
    groups: all("SELECT group_key, kind, actor_id, result_json FROM casino_tx_groups ORDER BY group_key"),
    chipTx: all("SELECT id, group_key, seq, tx_kind, from_holder, to_holder, amount FROM casino_tx ORDER BY id"),
    events: all("SELECT id, type FROM events ORDER BY id"),
  };
}

/**
 * 検証対象の4API。どれも Land とチップを同時に動かす。
 *
 * 冪等キーは API ごとに分ける。同じ鍵を種別違いで使い回すのは「別の操作が同じ鍵を
 * 名乗った」＝ `ERR_GROUP_CONFLICT` の対象で、それは別のテストで見る。
 */
function operations(ctx: Ctx, keyPrefix: string): Array<readonly [string, () => unknown]> {
  return [
    ["deposit", () => ctx.chips.deposit("a", 10_000, `${keyPrefix}:deposit`)],
    ["redeem", () => ctx.chips.redeem("a", 5_000, `${keyPrefix}:redeem`)],
    ["fundFromAccount", () => ctx.chips.fundFromAccount(DEPT, 10_000, HOUSE_HOLDER, `${keyPrefix}:fund`)],
    ["redeemToAccount", () => ctx.chips.redeemToAccount(HOUSE_HOLDER, 5_000, DEPT, "boss", `${keyPrefix}:settle`)],
  ];
}

describe("原子性: 例外注入（項目14）", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    // redeem / settle が動ける状態を先に作る
    ctx.chips.deposit("a", 200_000, "seed:deposit");
    ctx.chips.fundFromAccount(DEPT, 200_000, HOUSE_HOLDER, "seed:fund");
  });

  for (const at of POINTS) {
    it(`${at} で落ちても Land・chip・group・明細・event が半端に残らない`, () => {
      for (const [name, call] of operations(ctx, `inject:${at}:${Math.random()}`)) {
        const before = snapshot(ctx);
        let thrown: unknown;
        try {
          withInjection(ctx, at, call);
        } catch (e) {
          thrown = e;
        }
        expect(`${name}:${thrown instanceof Injected ? thrown.at : String(thrown)}`).toBe(`${name}:${at}`);
        expect({ [name]: snapshot(ctx) }).toEqual({ [name]: before });
      }
    });
  }

  it("注入を外せば同じ操作が普通に成立する（注入そのものが壊れていないことの確認）", () => {
    const before = ctx.chips.balanceOf("a");
    expect(ctx.chips.deposit("a", 10_000, "sanity:deposit")).toEqual({ input: 10_000, output: 10_000, burned: 0 });
    expect(ctx.chips.balanceOf("a")).toBe(before + 10_000);
  });
});

describe("冪等性: 同じ鍵の再実行（項目14）", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.chips.deposit("a", 200_000, "seed:deposit");
    ctx.chips.fundFromAccount(DEPT, 200_000, HOUSE_HOLDER, "seed:fund");
  });

  it("同じ冪等キーの再実行は保存済み結果を返し、資金を二度動かさない", () => {
    for (const [name, call] of operations(ctx, `idem:${Math.random()}`)) {
      const first = call();
      const after = snapshot(ctx);
      const second = call();
      const third = call();
      expect({ [name]: second }).toEqual({ [name]: first });
      expect({ [name]: third }).toEqual({ [name]: first });
      // 2回目・3回目で Land も chip も group も明細も event も1つも増えない
      expect({ [name]: snapshot(ctx) }).toEqual({ [name]: after });
    }
  });

  it("失敗した操作の鍵は残らず、原因を直せば同じ鍵で成立する", () => {
    const key = "retry:after-failure";
    expect(() => withInjection(ctx, "after_chip_tx", () => ctx.chips.deposit("a", 10_000, key))).toThrow(Injected);
    // グループが残っていたら「処理済み」と誤認して資金を動かさずに返してしまう
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM casino_tx_groups WHERE group_key = ?").get(key)).toEqual({ c: 0 });
    const held = ctx.chips.balanceOf("a");
    expect(ctx.chips.deposit("a", 10_000, key)).toEqual({ input: 10_000, output: 10_000, burned: 0 });
    expect(ctx.chips.balanceOf("a")).toBe(held + 10_000);
  });

  it("別の操作が同じ Land 冪等キーを使ったら ERR_DUPLICATE で全ロールバックする", () => {
    // 先に同じ鍵で Land だけを動かしておく（＝チップ側から見れば「別の操作」）
    ctx.ledger.transfer({
      from: "user:a", to: TREASURY, amount: 1, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "land-collision",
    });
    const before = snapshot(ctx);
    let code: string | undefined;
    try {
      ctx.chips.deposit("a", 10_000, "land-collision");
    } catch (e) {
      code = (e as ChipLedgerError).code;
    }
    expect(code).toBe("ERR_DUPLICATE");
    // Land も chip も group も明細も残らない（「Land は動かさずチップだけ発行」を作らない）
    expect(snapshot(ctx)).toEqual(before);
  });

  it("同じ鍵を別種別・別実行者で使い回すと拒否される", () => {
    ctx.chips.deposit("a", 10_000, "shared-key");
    // deposit で使った鍵を redeem（kind も actor も違う）で再利用する
    expect(() => ctx.chips.redeem("a", 1_000, "shared-key")).toThrow();
    expect(ctx.chips.balanceOf("a")).toBe(210_000);
  });
});
