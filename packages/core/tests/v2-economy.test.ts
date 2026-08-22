import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes, registerTxType } from "../src/ledger/registry.js";
import { computeSafeEconomyPeerActions } from "../src/titles/v2-economy.js";

registerDefaultTxTypes();

/** JST 2026-08-20 00:00:00 を秒0とする、E2テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  return { db, ledger };
}

let seq = 0;

/** TREASURY以外の口座は非負残高が必須——testのfrom口座を先に十分な額で満たす。 */
function fundAccount(ledger: Ledger, accountId: string, amount = 10_000_000): void {
  if (accountId === TREASURY) return;
  const isSystem = accountId.startsWith("sys:");
  ledger.ensureAccount(accountId, isSystem ? "system" : "user");
  seq += 1;
  ledger.transfer({
    from: TREASURY,
    to: accountId,
    amount,
    // TREASURY→system口座はinitial(sysToUser限定)を使えないのでchip_fund(sysToSys)を使う。
    type: isSystem ? "chip_fund" : "initial",
    actor: "system:test-fixture",
    idempotencyKey: `fund:${accountId}:${seq}`,
  });
}

function makeTransfer(
  ledger: Ledger,
  opts: {
    from: string;
    to: string;
    type?: string;
    actor?: string;
    amount?: number;
    approvedBy?: string;
    reason?: string;
    refType?: string;
    /** falseにするとfrom口座への事前funding(initial型のtransaction)を挿入しない。 */
    fund?: boolean;
  },
) {
  ledger.ensureAccount(opts.from, opts.from.startsWith("sys:") ? "system" : "user");
  ledger.ensureAccount(opts.to, opts.to.startsWith("sys:") ? "system" : "user");
  if (opts.fund !== false) fundAccount(ledger, opts.from, (opts.amount ?? 100) * 100);
  seq += 1;
  return ledger.transfer({
    from: opts.from,
    to: opts.to,
    amount: opts.amount ?? 100,
    type: opts.type ?? "transfer",
    actor: opts.actor ?? opts.from,
    idempotencyKey: `test-tx:${seq}`,
    reason: opts.reason,
    refType: opts.refType,
    approvedBy: opts.approvedBy,
  });
}

/** [window.start, window.end) を「その日全体を確実に覆う」形で作る簡易ヘルパー。 */
const WIDE_WINDOW = { start: BASE - 10 * DAY, end: BASE + 10 * DAY };

describe("computeSafeEconomyPeerActions() — positive cases", () => {
  it("§41 positive transfer: alice→bob transfer(actor=alice) → alice fact 1、bobは0、counterpart非開示", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "transfer" });

    const aliceFacts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    const bobFacts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["bob"]);

    expect(aliceFacts).toHaveLength(1);
    expect(aliceFacts[0]).toMatchObject({ userId: "alice", kind: "transfer" });
    expect(bobFacts).toHaveLength(0);
    expect(JSON.stringify(aliceFacts)).not.toContain("bob");
  });

  it("§42 positive tip: alice→bob tip(actor=alice) → alice tip fact 1", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "tip" });

    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ userId: "alice", kind: "tip" });
  });
});

describe("computeSafeEconomyPeerActions() — dedupe semantics", () => {
  it("§43 same-day dedupe: 同日transfer×10 → fact 1、occurredAtは最初のcreated_at", () => {
    const { db, ledger } = setup();
    const firstTs = BASE + 100;
    vi.setSystemTime(new Date(firstTs * 1000));
    makeTransfer(ledger, { from: "user:alice", to: "user:bob" });
    for (let i = 1; i < 10; i++) {
      vi.setSystemTime(new Date((firstTs + i * 10) * 1000));
      makeTransfer(ledger, { from: "user:alice", to: "user:bob" });
    }

    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.occurredAt).toBe(firstTs);
  });

  it("§44 kind independence: 同日にtransfer+tip → facts 2", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "transfer" });
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "tip" });

    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    expect(facts.map((f) => f.kind).sort()).toEqual(["tip", "transfer"]);
  });

  it("§45 next-day: JST日を跨いでtransfer×2 → facts 2（UTC midnightで切らない）", () => {
    const { db, ledger } = setup();
    vi.setSystemTime(new Date(BASE * 1000));
    makeTransfer(ledger, { from: "user:alice", to: "user:bob" });
    vi.setSystemTime(new Date((BASE + DAY) * 1000));
    makeTransfer(ledger, { from: "user:alice", to: "user:bob" });

    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((f) => f.date)).size).toBe(2);
  });
});

describe("computeSafeEconomyPeerActions() — actor / direction binding", () => {
  it("§46 actor mismatch: from=alice だが actor=system:test → fact 0", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", actor: "system:test" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("§46 actor mismatch: from=alice だが actor=user:staff（第三者代行）→ fact 0", () => {
    const { db, ledger } = setup();
    ledger.ensureAccount("user:staff", "user");
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", actor: "user:staff" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("§34 high-value approved transfer: actor=元のfrom user、approved_byは無関係にfact 1", () => {
    const { db, ledger } = setup();
    ledger.ensureAccount("user:staff", "user");
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", actor: "user:alice", approvedBy: "user:staff" });
    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    expect(facts).toHaveLength(1);
  });

  it("§48 incoming exclusion: bob→alice transfer → aliceのfactは0、bobは1", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:bob", to: "user:alice" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["bob"])).toHaveLength(1);
  });
});

describe("computeSafeEconomyPeerActions() — reversal semantics", () => {
  it("§47 reversal row自体は新しいfactを作らない。同日なら元action factは1のまま", () => {
    const { db, ledger } = setup();
    const result = makeTransfer(ledger, { from: "user:alice", to: "user:bob" });
    // reverseのfrom=元のto(bob)になる——actor=bobにして「actor===from_account」を
    // reversal行自身にも満たさせ、reversal_of guardだけを孤立させて検証する。
    ledger.reverse(result.tx.id, "user:bob", "test reversal");

    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"]);
    expect(facts).toHaveLength(1); // 元のtransfer行だけ
    expect(facts[0]!.kind).toBe("transfer");
  });

  it("reversalの受け手側(bob)にもreversal行由来のfactは作られない", () => {
    const { db, ledger } = setup();
    const result = makeTransfer(ledger, { from: "user:alice", to: "user:bob" });
    ledger.reverse(result.tx.id, "user:bob", "test reversal");
    // reversal行はfrom=bobだが、reversal_of IS NOT NULLなのでbob側にもfactを作らない。
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["bob"])).toHaveLength(0);
  });
});

describe("computeSafeEconomyPeerActions() — excluded types（§4-5, §49-53）", () => {
  it("§49 adverse types(fine/tax/bet/prize/adjust) → facts 0", () => {
    const { db, ledger } = setup();
    ledger.ensureAccount("user:alice", "user");
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "fine" });
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "tax" });
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "bet" });
    makeTransfer(ledger, { from: TREASURY, to: "user:alice", type: "prize" });
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "adjust" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("§50 role/administrative types(salary/pension/commission/dept_in/dept_out) → facts 0", () => {
    const { db, ledger } = setup();
    ledger.ensureAccount("sys:dept:test", "system");
    makeTransfer(ledger, { from: TREASURY, to: "user:alice", type: "salary" });
    makeTransfer(ledger, { from: TREASURY, to: "user:alice", type: "pension" });
    makeTransfer(ledger, { from: "sys:dept:test", to: "user:alice", type: "commission" });
    makeTransfer(ledger, { from: "user:alice", to: "sys:dept:test", type: "dept_in" });
    makeTransfer(ledger, { from: "sys:dept:test", to: "user:alice", type: "dept_out" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("§51 casino types(chip_deposit/chip_redeem/bet/prize) → facts 0（E4を先取りしない）", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "chip_deposit" });
    makeTransfer(ledger, { from: TREASURY, to: "user:alice", type: "chip_redeem" });
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "bet" });
    makeTransfer(ledger, { from: TREASURY, to: "user:alice", type: "prize" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("§52 tip_burn overloaded regression: Bot宛/shop/shop_extend相当いずれもfacts 0（to_accountがuser:%ではないため）", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "tip_burn", reason: "Bot宛投げ銭" });
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "tip_burn", refType: "shop" });
    makeTransfer(ledger, { from: "user:alice", to: TREASURY, type: "tip_burn", refType: "shop_extend" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("shop_personal/fanclub/inheritance（user→userだが exact allowlist外）→ facts 0", () => {
    const { db, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "shop_personal" });
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "fanclub" });
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "inheritance" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });

  it("§53 unknown/new type（registerTxTypeで新規追加、publicLog:true・user→userでも）→ facts 0", () => {
    const { db, ledger } = setup();
    registerTxType("future_public_action", { fromKinds: ["user"], toKinds: ["user"], publicLog: true });
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "future_public_action" });
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["alice"])).toHaveLength(0);
  });
});

describe("computeSafeEconomyPeerActions() — userId extraction fail-closed（§26）", () => {
  it("from_accountがuser:prefixを持たない/空idの不正rowはfail-closedでignoreされる", () => {
    const { db } = setup();
    // 正規のLedger APIを迂回してcorruptなfrom_accountを直接挿入する
    // (transactions.from_account/to_accountはaccounts(id)への外部キーなので、
    // 参照先のaccounts行も先に用意する)。
    for (const id of ["weird-account", "user:", "user:bob"]) {
      db.prepare(`INSERT INTO accounts (id, kind, status, created_at) VALUES (?, 'user', 'active', ?)`).run(id, BASE);
    }
    db.prepare(
      `INSERT INTO transactions
         (idempotency_key, from_account, to_account, amount, type, actor_id, created_at)
       VALUES ('corrupt-1', 'weird-account', 'user:bob', 100, 'transfer', 'weird-account', ?)`,
    ).run(BASE);
    db.prepare(
      `INSERT INTO transactions
         (idempotency_key, from_account, to_account, amount, type, actor_id, created_at)
       VALUES ('corrupt-2', 'user:', 'user:bob', 100, 'transfer', 'user:', ?)`,
    ).run(BASE);

    // "weird-account"/"user:"はどちらもuserIds=["weird-account"]等で明示的に要求しても、
    // extractUserId()がnullを返しfactを作らない(全rowsをスキャンするため、どのuserId
    // requestでも影響しない=空集合になることを別途確認する)。
    const facts = computeSafeEconomyPeerActions(db, WIDE_WINDOW, ["weird-account", "bob"]);
    expect(facts).toHaveLength(0);
  });
});

describe("computeSafeEconomyPeerActions() — window / userIds handling", () => {
  it("userIds=[]なら即座に空配列(query発行なし)", () => {
    const { db } = setup();
    expect(computeSafeEconomyPeerActions(db, WIDE_WINDOW, [])).toEqual([]);
  });

  it("windowの外のtransactionは含まれない([start, end)厳守)", () => {
    const { db, ledger } = setup();
    vi.setSystemTime(new Date((BASE - 100) * 1000));
    makeTransfer(ledger, { from: "user:alice", to: "user:bob" }); // window外(前)
    vi.setSystemTime(new Date(BASE * 1000));
    makeTransfer(ledger, { from: "user:alice", to: "user:carol" }); // window内

    const facts = computeSafeEconomyPeerActions(db, { start: BASE, end: BASE + 1000 }, ["alice"]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.occurredAt).toBe(BASE);
  });
});
