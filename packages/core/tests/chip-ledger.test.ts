import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import {
  ChipLedger,
  ChipLedgerError,
  CHIP_ESCROW,
  ETHER_ESCROW,
  HOUSE_HOLDER,
  EtherExchange,
} from "../src/casino/chip-ledger.js";
import * as ExchangeModule from "../src/casino/exchange.js";
import * as ChipLedgerModule from "../src/casino/chip-ledger.js";
import { ChipLedger as RootChipLedger } from "../src/index.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import * as CoreIndex from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/** 正式開業まで済ませた台帳（1:1の通常動作を見るための前提） */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  for (const userId of ["a", "b"]) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 1_000_000, type: "initial", actor: "test", idempotencyKey: `fund:${userId}` });
  }
  // 正式開業ロックは外せない。1:1操作を見るテストは必ずここを通る（PR8監査・ブロッカーA）
  openFormally(chips.chipTx, ledger);
  return { db, ledger, chips, chipTx: chips.chipTx };
}

/** 正式開業**前**の台帳（ロックが効いていることを見るための前提） */
function setupLocked() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  ledger.ensureAccount("user:a", "user");
  ledger.transfer({ from: TREASURY, to: "user:a", amount: 1_000_000, type: "initial", actor: "test", idempotencyKey: "fund:a" });
  return { db, ledger, chips, chipTx: chips.chipTx };
}

const count = (ctx: { db: ReturnType<typeof openDb> }, table: string) =>
  (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("ChipLedger（opening_v1確定後の通常動作）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("預入・返還は常に1:1で、準備口座は発行済みチップを100%裏付ける", () => {
    expect(ctx.chips.deposit("a", 12_345, "deposit:a")).toEqual({ input: 12_345, output: 12_345, burned: 0 });
    expect(ctx.chips.balanceOf("a")).toBe(12_345);
    expect(ctx.chips.pool()).toBe(12_345);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(12_345);
    expect(ctx.chips.redeem("a", 2_345, "redeem:a")).toEqual({ input: 2_345, output: 2_345, burned: 0 });
    expect(ctx.chips.balanceOf("a")).toBe(10_000);
    expect(ctx.chips.pool()).toBe(10_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(990_000);
    // 旧準備口座は 1 Ld も使わない（新制度の資金は新準備口座だけを通る）
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
  });

  it("同じ預入・返還キーは一度だけ資金を動かす", () => {
    const first = ctx.chips.deposit("a", 10_000, "deposit:once");
    expect(ctx.chips.deposit("a", 10_000, "deposit:once")).toEqual(first);
    const returned = ctx.chips.redeem("a", 4_000, "redeem:once");
    expect(ctx.chips.redeem("a", 4_000, "redeem:once")).toEqual(returned);
    expect(ctx.chips.balanceOf("a")).toBe(6_000);
    expect(ctx.chips.pool()).toBe(6_000);
  });

  it("Land取引が重複した場合はチップ発行までロールバックする", () => {
    ctx.ledger.transfer({ from: "user:a", to: TREASURY, amount: 1, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "collision" });
    expect(() => ctx.chips.deposit("a", 10_000, "collision")).toThrow(/ERR_DUPLICATE/);
    expect(ctx.chips.balanceOf("a")).toBe(0);
    expect(ctx.chips.pool()).toBe(0);
  });
});

/**
 * PR8監査・ブロッカーA（再監査ブロッカー1）: **ロックの迂回経路が存在しない**こと。
 *
 * 以前は「ロックなしの `ChipLedgerCore` / `EtherExchangeCore` を export しているが、
 * production の call site は 0 件」というソース検査で担保していた。迂回経路が残っている
 * かぎり、新しいコードが 1 行足すだけでロックを外せてしまう。実装を一本化し、
 * ロックなし class もロック解除オプションも**削除**した。ここではそれを固定する。
 */
describe("正式開業ロックは外せない", () => {
  /** 正式開業前に届きうる資金操作。どの経路で構築しても、全部が同じコードで断られること */
  function allFundOperations(chips: ChipLedger): Array<[string, () => unknown]> {
    return [
      ["deposit", () => chips.deposit("a", 100, "locked:deposit")],
      ["redeem", () => chips.redeem("a", 100, "locked:redeem")],
      ["fundFromAccount", () => chips.fundFromAccount("sys:dept:賭博場", 100, HOUSE_HOLDER, "locked:fund")],
      ["redeemToAccount", () => chips.redeemToAccount(HOUSE_HOLDER, 100, "sys:dept:賭博場", "test", "locked:settle")],
      ["redeemFairToAccount", () => chips.redeemFairToAccount(HOUSE_HOLDER, 100, "sys:dept:賭博場", "locked:fair")],
      [
        "runGroup/transfer",
        () =>
          chips.runGroup({ groupKey: "locked:game", kind: "solo_game", actorId: "a" }, () =>
            chips.transfer("a", HOUSE_HOLDER, 100, { reason: "賭け金" }),
          ),
      ],
    ];
  }

  function expectAllLocked(chips: ChipLedger): void {
    for (const [name, op] of allFundOperations(chips)) {
      let error: unknown;
      try {
        op();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ChipLedgerError);
      expect(`${name}:${(error as ChipLedgerError).code}`).toBe(`${name}:ERR_CASINO_OPENING_NOT_COMPLETE`);
    }
  }

  function lockedDb() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 10_000, type: "initial", actor: "test", idempotencyKey: "fund:a" });
    return { db, ledger };
  }

  it("package root（@meigokujo/core相当）からのimportでlegacy操作を拒否する", () => {
    const { db, ledger } = lockedDb();
    expectAllLocked(new RootChipLedger(db, ledger, new EventLog(db)));
    db.close();
  });

  it("./chip-ledger.js の直接importでも拒否する", () => {
    const { db, ledger } = lockedDb();
    expectAllLocked(new ChipLedgerModule.ChipLedger(db, ledger, new EventLog(db)));
    db.close();
  });

  it("./exchange.js の直接importでも拒否する（実装元を直接掴んでも同じ）", () => {
    const { db, ledger } = lockedDb();
    expectAllLocked(new ExchangeModule.ChipLedger(db, ledger, new EventLog(db)));
    db.close();
  });

  it("3経路が同じclassを指しており、ロックの緩い版が存在しない", () => {
    expect(ChipLedgerModule.ChipLedger).toBe(ExchangeModule.ChipLedger);
    expect(RootChipLedger).toBe(ExchangeModule.ChipLedger);
    expect(Object.getPrototypeOf(ExchangeModule.EtherExchange)).toBe(ExchangeModule.ChipLedger);
  });

  it("deprecated EtherExchange でも同じロックを通る", () => {
    const { db, ledger } = lockedDb();
    const ether = new EtherExchange(db, ledger, new EventLog(db));
    expectAllLocked(ether);
    // 旧APIの入口（buy/sell）からも迂回できない
    expect(() => ether.buy("a", 100, "legacy-api:buy")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    expect(() => ether.sell("a", 100, "legacy-api:sell")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    db.close();
  });

  it("どの経路のexport一覧にもロックなしclassが存在しない", () => {
    for (const mod of [ExchangeModule, ChipLedgerModule, CoreIndex] as unknown as Array<Record<string, unknown>>) {
      expect(mod.ChipLedgerCore).toBeUndefined();
      expect(mod.EtherExchangeCore).toBeUndefined();
    }
    // ソース上も「ロックなし」を名乗る class 定義が無い
    for (const file of ["../src/casino/exchange.ts", "../src/casino/chip-ledger.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src).not.toMatch(/^export class ChipLedgerCore\b/m);
      expect(src).not.toMatch(/^export class EtherExchangeCore\b/m);
    }
  });

  it("公開constructorにロック解除optionが存在しない", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const targets = [join(root, "apps", "bot"), join(root, "packages", "core")];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        // 解除オプションもロックなし実装も、テストを含めて1箇所も残っていないこと
        if (/requireOpeningV1/.test(text) || /\bChipLedgerCore\b/.test(text) || /\bEtherExchangeCore\b/.test(text)) {
          offenders.push(full);
        }
      }
    };
    for (const t of targets) walk(t);
    // このテスト自身は「無いこと」を書くために名前を文字列として持つので、そこだけ除く
    expect(offenders.filter((f) => !f.endsWith("chip-ledger.test.ts"))).toEqual([]);
  });

  it("opening_v1確定後だけ通常操作が通り、確定前は同じ操作が断られる", () => {
    const locked = setupLocked();
    expect(() => locked.chips.deposit("a", 100, "before:opening")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    openFormally(locked.chipTx, locked.ledger);
    expect(locked.chips.deposit("a", 1_000, "after:deposit")).toEqual({ input: 1_000, output: 1_000, burned: 0 });
    expect(locked.chips.redeem("a", 400, "after:redeem")).toEqual({ input: 400, output: 400, burned: 0 });
    expect(locked.chips.balanceOf("a")).toBe(600);
    expect(locked.ledger.balanceOf(CHIP_ESCROW)).toBe(600);
    locked.db.close();
  });

  it("正式開業前の拒否では、旧残高も台帳も1行も変わらない", () => {
    const locked = setupLocked();
    const department = "sys:dept:賭博場";
    locked.ledger.ensureAccount(department, "system");
    locked.ledger.transfer({ from: TREASURY, to: ETHER_ESCROW, amount: 10_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "legacy:reserve" });
    locked.ledger.transfer({ from: TREASURY, to: department, amount: 1_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "legacy:department" });
    locked.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('legacy-user', 100000, 0)").run();
    locked.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 1000, 0)").run(HOUSE_HOLDER);
    const snapshot = () => ({
      userLand: locked.ledger.balanceOf("user:a"),
      oldReserve: locked.ledger.balanceOf(ETHER_ESCROW),
      newReserve: locked.ledger.balanceOf(CHIP_ESCROW),
      department: locked.ledger.balanceOf(department),
      legacyChips: locked.chips.balanceOf("legacy-user"),
      houseChips: locked.chips.balanceOf(HOUSE_HOLDER),
      landTx: count(locked, "transactions"),
      groups: count(locked, "casino_tx_groups"),
      chipTx: count(locked, "casino_tx"),
    });
    const before = snapshot();
    expectAllLocked(locked.chips);
    expect(snapshot()).toEqual(before);
    locked.db.close();
  });

  it("package rootは旧EtherExchangeを一切公開しない", () => {
    expect((CoreIndex as Record<string, unknown>).EtherExchange).toBeUndefined();
  });
});

/**
 * PR8監査・ブロッカーC: opening_version の fail-closed 化。
 *
 * `reserveHolder()`（延いては pool/deposit/redeem/fund/settle 全て）は、
 * legacy_pre_reset / opening_v1 の**厳密一致**でしか準備口座を決めない。
 * 空文字・typo・DB破損・opening_v2・将来未対応版・__proto__ を
 * 「旧制度」として fail-open せず、必ず ERR_UNKNOWN_OPENING_VERSION にする。
 */
describe("opening versionのfail-closed化", () => {
  function setVersion(db: ReturnType<typeof openDb>, version: string): void {
    const ts = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('casino:opening_version', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(version, ts);
  }

  function ctxWithVersion(version: string) {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    setVersion(db, version);
    // ChipTx はバージョンをキャッシュするので、設定後に新しいインスタンスで読み直す
    const chipTx = new ChipTx(db);
    const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx });
    return { db, ledger, chipTx, chips };
  }

  it.each([
    ["legacy_pre_reset", ETHER_ESCROW],
    ["opening_v1", CHIP_ESCROW],
  ] as const)("既知の版 %s は正しい準備口座 %s を返す", (version, expectedHolder) => {
    const ctx = ctxWithVersion(version);
    expect(ctx.chips.reserveHolder()).toBe(expectedHolder);
    ctx.db.close();
  });

  it.each([
    ["空文字", ""],
    ["空白のみ", "   "],
    ["typo", "opening_v1 "],
    ["opening_v2", "opening_v2"],
    ["__proto__", "__proto__"],
    ["未対応の将来版", "opening_v99"],
  ])("未知版（%s）はERR_UNKNOWN_OPENING_VERSIONでfail-closedになる", (_label, version) => {
    const ctx = ctxWithVersion(version);
    let error: unknown;
    try {
      ctx.chips.reserveHolder();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ChipLedgerError);
    expect((error as { code: string }).code).toBe("ERR_UNKNOWN_OPENING_VERSION");
    // pool 読み取りも同じ経路で拒否される
    expect(() => ctx.chips.pool()).toThrow(/ERR_UNKNOWN_OPENING_VERSION/);
    ctx.ledger.ensureAccount("user:a", "user");
    // 資金操作は、まず正式開業ロックが止める（未知版は opening_v1 ではないので当然通らない）
    expect(() => ctx.chips.deposit("a", 100, "unknown-version:deposit")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    // 復旧・初期化の maintenance 区間でロックを通り抜けても、版のfail-closedが最後の砦になる
    expect(() =>
      ctx.chipTx.runMaintenance("未知版のテスト", () => ctx.chips.deposit("a", 100, "unknown-version:maintenance")),
    ).toThrow(/ERR_UNKNOWN_OPENING_VERSION/);
    ctx.db.close();
  });

  it("DBを閉じて再読込した後も未知版はfail-closedのまま残る", () => {
    const first = ctxWithVersion("opening_v1");
    first.db.close();

    // 同じ内容を新しいDB接続で再現する（DB再読込を模す）
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    setVersion(db, "corrupted-by-something");
    const chipTx = new ChipTx(db);
    const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx });
    expect(() => chips.reserveHolder()).toThrow(/ERR_UNKNOWN_OPENING_VERSION/);
    db.close();
  });
});

/**
 * PR8監査・項目9: `runMaintenance()` によるロック迂回の棚卸し。
 *
 * production で `runMaintenance()` を呼ぶのは PR7 の起動復旧（`recoverCasino`）だけであること、
 * その区間だけロックが外れ、区間を抜けたら必ず再ロックされること、
 * body が例外を投げても深さが正しく戻ることを固定する。
 */
describe("runMaintenanceによるロック迂回の棚卸し", () => {
  it("productionでrunMaintenance()を呼ぶのはrecovery.tsとopening-reset.tsだけ", () => {
    // exchange.ts のコメントが明示する唯一の許可経路は「起動時の復旧・正式開業初期化」の2つ。
    // PR12(opening-reset.ts)がここに正式な2件目の呼び出し元として加わる。
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const targets = [join(root, "apps", "bot", "src"), join(root, "packages", "core", "src")];
    const ALLOWED_CALLERS = ["casino/recovery.ts", "casino/opening-reset.ts"];
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/\.runMaintenance\(/.test(text)) callers.push(full);
      }
    };
    for (const t of targets) walk(t);
    const normalized = callers.map((f) => f.replace(/\\/g, "/"));
    for (const allowed of ALLOWED_CALLERS) {
      expect(normalized.filter((f) => f.endsWith(allowed))).toHaveLength(1);
    }
    expect(callers).toHaveLength(ALLOWED_CALLERS.length);
  });

  it("recovery.tsは deposit/redeem/fundFromAccount/redeemToAccount を直接呼ばない", () => {
    const src = readFileSync(new URL("../src/casino/recovery.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.deposit\(/);
    expect(src).not.toMatch(/\.redeem\(/);
    expect(src).not.toMatch(/\.fundFromAccount\(/);
    expect(src).not.toMatch(/\.redeemToAccount\(/);
    expect(src).not.toMatch(/\.redeemFairToAccount\(/);
  });

  it("runMaintenance区間だけ開業ロック中でも資金移動でき、区間の外では再びロックされる", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const chipTx = new ChipTx(db);
    const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx });
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 1_000, type: "initial", actor: "t", idempotencyKey: "fund:a" });

    // 区間の外: ロックされている
    expect(() =>
      chips.runGroup({ groupKey: "outside", kind: "table_refund", actorId: "system:recovery" }, () =>
        chips.transfer(HOUSE_HOLDER, "a", 1, { reason: "区間の外" }),
      ),
    ).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);

    // recovery相当: runMaintenance区間の中では同じtransferが通る（孤児返金の実体と同じ形）
    ledger.ensureAccount(HOUSE_HOLDER, "system");
    chips.ensureHolder(HOUSE_HOLDER);
    db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 100, 0) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount").run(HOUSE_HOLDER);
    expect(chipTx.isMaintenance()).toBe(false);
    chipTx.runMaintenance("起動時の復旧（テスト）", () => {
      expect(chipTx.isMaintenance()).toBe(true);
      chips.runGroup({ groupKey: "inside", kind: "table_refund", actorId: "system:recovery" }, () =>
        chips.transfer(HOUSE_HOLDER, "a", 10, { reason: "孤児返金" }),
      );
    });
    expect(chipTx.isMaintenance()).toBe(false);
    expect(chips.balanceOf("a")).toBe(10);

    // 区間を抜けたら、また同じ操作がロックされる
    expect(() =>
      chips.runGroup({ groupKey: "after", kind: "table_refund", actorId: "system:recovery" }, () =>
        chips.transfer(HOUSE_HOLDER, "a", 1, { reason: "区間の後" }),
      ),
    ).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    db.close();
  });

  it("runMaintenanceのbodyが例外を投げても深さは正しく戻る", () => {
    const db = openDb(":memory:");
    const chipTx = new ChipTx(db);
    expect(chipTx.isMaintenance()).toBe(false);
    expect(() =>
      chipTx.runMaintenance("失敗するテスト", () => {
        expect(chipTx.isMaintenance()).toBe(true);
        throw new Error("わざと失敗させる");
      }),
    ).toThrow("わざと失敗させる");
    expect(chipTx.isMaintenance()).toBe(false);
    db.close();
  });

  it("入れ子のrunMaintenanceでも深さが正しく管理される", () => {
    const db = openDb(":memory:");
    const chipTx = new ChipTx(db);
    chipTx.runMaintenance("外側", () => {
      expect(chipTx.isMaintenance()).toBe(true);
      chipTx.runMaintenance("内側", () => {
        expect(chipTx.isMaintenance()).toBe(true);
      });
      // 内側を抜けても外側の区間はまだ続いている
      expect(chipTx.isMaintenance()).toBe(true);
    });
    expect(chipTx.isMaintenance()).toBe(false);
    db.close();
  });
});
