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
  EtherExchange as LockedEtherExchange,
} from "../src/casino/chip-ledger.js";
import { ChipLedger as RootChipLedger } from "../src/index.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import * as CoreIndex from "../src/index.js";

registerDefaultTxTypes();
function setup(options: { sharedChipTx?: boolean; requireOpeningV1?: boolean } = {}) {
  const db = openDb(":memory:"); const ledger = new Ledger(db); const chipTx = options.sharedChipTx ? new ChipTx(db) : undefined;
  const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx, requireOpeningV1: options.requireOpeningV1 });
  for (const userId of ["a", "b"]) { ledger.ensureAccount(`user:${userId}`, "user"); ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 1_000_000, type: "initial", actor: "test", idempotencyKey: `fund:${userId}` }); }
  return { db, ledger, chips, chipTx: chips.chipTx };
}
const count = (ctx: ReturnType<typeof setup>, table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
describe("ChipLedger", () => {
  // secure default（requireOpeningV1既定true）とは独立に1:1の基本動作を検証するための
  // 明示的なテスト専用解除。ここで何を無効化しているかがコード上に必ず残る（PR8監査）。
  let ctx: ReturnType<typeof setup>; beforeEach(() => { ctx = setup({ requireOpeningV1: false }); });
  it("預入・返還は常に1:1で、準備口座は発行済みチップを100%裏付ける", () => {
    expect(ctx.chips.deposit("a", 12_345, "deposit:a")).toEqual({ input: 12_345, output: 12_345, burned: 0 }); expect(ctx.chips.balanceOf("a")).toBe(12_345); expect(ctx.chips.pool()).toBe(12_345); expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(12_345);
    expect(ctx.chips.redeem("a", 2_345, "redeem:a")).toEqual({ input: 2_345, output: 2_345, burned: 0 }); expect(ctx.chips.balanceOf("a")).toBe(10_000); expect(ctx.chips.pool()).toBe(10_000); expect(ctx.ledger.balanceOf("user:a")).toBe(990_000); expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(0);
  });
  it("同じ預入・返還キーは一度だけ資金を動かす", () => { const first = ctx.chips.deposit("a", 10_000, "deposit:once"); expect(ctx.chips.deposit("a", 10_000, "deposit:once")).toEqual(first); const returned = ctx.chips.redeem("a", 4_000, "redeem:once"); expect(ctx.chips.redeem("a", 4_000, "redeem:once")).toEqual(returned); expect(ctx.chips.balanceOf("a")).toBe(6_000); expect(ctx.chips.pool()).toBe(6_000); });
  it("Land取引が重複した場合はチップ発行までロールバックする", () => { ctx.ledger.transfer({ from: "user:a", to: TREASURY, amount: 1, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "collision" }); expect(() => ctx.chips.deposit("a", 10_000, "collision")).toThrow(/ERR_DUPLICATE/); expect(ctx.chips.balanceOf("a")).toBe(0); expect(ctx.chips.pool()).toBe(0); });
  it("production構築ではopening_v1前の全資金操作を拒否し、旧残高と台帳を変えない", () => {
    const locked = setup({ sharedChipTx: true, requireOpeningV1: true }); const department = "sys:dept:賭博場"; locked.ledger.ensureAccount(department, "system");
    locked.ledger.transfer({ from: TREASURY, to: ETHER_ESCROW, amount: 10_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "legacy:reserve" }); locked.ledger.transfer({ from: TREASURY, to: department, amount: 1_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "legacy:department" });
    locked.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('legacy-user', 100000, 0)").run(); locked.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 1000, 0)").run(HOUSE_HOLDER);
    const before = { userLand: locked.ledger.balanceOf("user:a"), oldReserve: locked.ledger.balanceOf(ETHER_ESCROW), newReserve: locked.ledger.balanceOf(CHIP_ESCROW), department: locked.ledger.balanceOf(department), legacyChips: locked.chips.balanceOf("legacy-user"), houseChips: locked.chips.balanceOf(HOUSE_HOLDER), landTx: count(locked, "transactions"), groups: count(locked, "casino_tx_groups"), chipTx: count(locked, "casino_tx") };
    const operations: Array<() => unknown> = [() => locked.chips.deposit("a", 100, "locked:deposit"), () => locked.chips.redeem("legacy-user", 100, "locked:redeem"), () => locked.chips.fundFromAccount(department, 100, HOUSE_HOLDER, "locked:fund"), () => locked.chips.redeemToAccount("legacy-user", 100, department, "test", "locked:settle"), () => locked.chips.redeemFairToAccount(HOUSE_HOLDER, 100, department, "locked:fair-settle"), () => locked.chips.runGroup({ groupKey: "locked:game", kind: "solo_game", actorId: "a" }, () => locked.chips.transfer("legacy-user", HOUSE_HOLDER, 100, { reason: "賭け金" }))];
    for (const operation of operations) { let error: unknown; try { operation(); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(ChipLedgerError); expect((error as { code: string }).code).toBe("ERR_CASINO_OPENING_NOT_COMPLETE"); }
    expect({ userLand: locked.ledger.balanceOf("user:a"), oldReserve: locked.ledger.balanceOf(ETHER_ESCROW), newReserve: locked.ledger.balanceOf(CHIP_ESCROW), department: locked.ledger.balanceOf(department), legacyChips: locked.chips.balanceOf("legacy-user"), houseChips: locked.chips.balanceOf(HOUSE_HOLDER), landTx: count(locked, "transactions"), groups: count(locked, "casino_tx_groups"), chipTx: count(locked, "casino_tx") }).toEqual(before); locked.db.close();
  });
  it("opening_v1確定後だけproduction構築の1:1操作を解放する", () => { const opened = setup({ sharedChipTx: true, requireOpeningV1: true }); expect(() => opened.chips.deposit("a", 100, "before:opening")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/); opened.chipTx.captureOpening("opening_v1", [], { poolLand: opened.ledger.balanceOf(CHIP_ESCROW), fromLedgerTxId: opened.ledger.lastTransactionId() }); expect(opened.chips.deposit("a", 1_000, "after:deposit")).toEqual({ input: 1_000, output: 1_000, burned: 0 }); expect(opened.chips.redeem("a", 400, "after:redeem")).toEqual({ input: 400, output: 400, burned: 0 }); expect(opened.chips.balanceOf("a")).toBe(600); expect(opened.ledger.balanceOf(CHIP_ESCROW)).toBe(600); opened.db.close(); });
});

/**
 * PR8監査・ブロッカーA: secure default とロック迂回不可能性を固定する。
 *
 * `requireOpeningV1` は既定で true。オプションを一切渡さない・空オブジェクトで渡す・
 * package root からの import・deprecated `EtherExchange` のいずれでも、
 * 正式開業前の資金操作は必ず core 層で拒否されること。
 */
describe("secure default とロック迂回不可能性", () => {
  it("オプション未指定（optionsそのものを渡さない）でもopening_v1前は拒否する", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 10_000, type: "initial", actor: "test", idempotencyKey: "fund:a" });
    // 第4引数（options）そのものを省略する＝実装のデフォルト値だけに頼る
    const chips = new ChipLedger(db, ledger, new EventLog(db));
    expect(() => chips.deposit("a", 100, "unspecified:deposit")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    db.close();
  });

  it("空オブジェクト {} を渡してもopening_v1前は拒否する", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 10_000, type: "initial", actor: "test", idempotencyKey: "fund:a" });
    const chips = new ChipLedger(db, ledger, new EventLog(db), {});
    expect(() => chips.deposit("a", 100, "empty-options:deposit")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    db.close();
  });

  it("package root（@meigokujo/core相当）からのimportもsecure defaultでロックされる", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 10_000, type: "initial", actor: "test", idempotencyKey: "fund:a" });
    const chips = new RootChipLedger(db, ledger, new EventLog(db));
    expect(() => chips.deposit("a", 100, "root:deposit")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    db.close();
  });

  it("deprecated EtherExchange（chip-ledger.js）でも同じロックを通り、迂回できない", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 10_000, type: "initial", actor: "test", idempotencyKey: "fund:a" });
    const ether = new LockedEtherExchange(db, ledger, new EventLog(db));
    expect(() => ether.buy("a", 100, "legacy-api:buy")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    expect(() => ether.deposit("a", 100, "legacy-api:deposit")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    db.close();
  });

  it("package rootは旧EtherExchangeを一切公開しない", () => {
    expect((CoreIndex as Record<string, unknown>).EtherExchange).toBeUndefined();
  });

  it("../casino/exchange.js の直接importでは「ChipLedger」という名を取得できない（ロックなし実装は別名）", () => {
    const src = readFileSync(new URL("../src/casino/exchange.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/export class ChipLedger\b/);
    expect(src).not.toMatch(/export class EtherExchange\b/);
    expect(src).toContain("export class ChipLedgerCore");
    expect(src).toContain("export class EtherExchangeCore");
  });

  it("テスト専用の requireOpeningV1:false / ChipLedgerCore / EtherExchangeCore は production call site 0件", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const targets = [join(root, "apps", "bot", "src"), join(root, "packages", "core", "src")];
    // exchange.ts（定義元）と chip-ledger.ts（そこから正規に継承する唯一の場所）だけは
    // 「ChipLedgerCore」という名前が登場して当然なので除外する。それ以外の production
    // コードから見えたら、ロックなし実装への迂回経路が新設されたことになる。
    const allowedDefinitionFiles = [
      join(root, "packages", "core", "src", "casino", "exchange.ts"),
      join(root, "packages", "core", "src", "casino", "chip-ledger.ts"),
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts") || allowedDefinitionFiles.includes(full)) continue;
        const text = readFileSync(full, "utf8");
        if (/requireOpeningV1\s*:\s*false/.test(text) || /\bChipLedgerCore\b/.test(text) || /\bEtherExchangeCore\b/.test(text)) {
          offenders.push(full);
        }
      }
    };
    for (const t of targets) walk(t);
    expect(offenders).toEqual([]);
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
    // reserveHolder() 自体のfail-closed性を見たいので、開業ロック（ブロッカーA）は
    // 明示的に外す（何を無効化しているかがコード上に残る）
    const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx, requireOpeningV1: false });
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
    // pool読み取りもdeposit/redeemも同じ経路で拒否される
    expect(() => ctx.chips.pool()).toThrow(/ERR_UNKNOWN_OPENING_VERSION/);
    ctx.ledger.ensureAccount("user:a", "user");
    expect(() => ctx.chips.deposit("a", 100, "unknown-version:deposit")).toThrow(/ERR_UNKNOWN_OPENING_VERSION/);
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
    const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx, requireOpeningV1: false });
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
  it("productionでrunMaintenance()を呼ぶのはrecovery.tsだけ", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const targets = [join(root, "apps", "bot", "src"), join(root, "packages", "core", "src")];
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
    expect(callers.map((f) => f.replace(/\\/g, "/")).filter((f) => f.endsWith("casino/recovery.ts"))).toHaveLength(1);
    expect(callers).toHaveLength(1);
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
    const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx, requireOpeningV1: true });
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
