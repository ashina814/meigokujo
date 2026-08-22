import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes, registerTxType } from "../src/ledger/registry.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

registerDefaultTxTypes();

/** JST 2026-08-20 00:00:00 を秒0とする、E2 v2 source層テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 100_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" }); // SYSTEM_EPOCH = BASE-100_000
  clock = BASE + 10_000_000;
  const ledger = new Ledger(db);
  return { db, store, ledger };
}

const COMMON_FIXTURE_FIELDS = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" as const },
};

const ECONOMY_SAFE_PEER_ACTIONS_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.economy-safe-peer-actions",
    name: "test",
    description: "テスト用fixture",
    sources: ["economy_safe_peer_actions"] as const,
    triggers: ["economy_activity"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

let seq = 0;
function fundAccount(ledger: Ledger, accountId: string, amount = 500_000): void {
  if (accountId === TREASURY) return;
  const isSystem = accountId.startsWith("sys:");
  ledger.ensureAccount(accountId, isSystem ? "system" : "user");
  seq += 1;
  ledger.transfer({
    from: TREASURY,
    to: accountId,
    amount,
    type: isSystem ? "chip_fund" : "initial",
    actor: "system:test-fixture",
    idempotencyKey: `fund:${accountId}:${seq}`,
  });
}

function makeTransfer(ledger: Ledger, opts: { from: string; to: string; type?: string; actor?: string; amount?: number }) {
  ledger.ensureAccount(opts.from, opts.from.startsWith("sys:") ? "system" : "user");
  ledger.ensureAccount(opts.to, opts.to.startsWith("sys:") ? "system" : "user");
  fundAccount(ledger, opts.from, (opts.amount ?? 100) * 100);
  seq += 1;
  return ledger.transfer({
    from: opts.from,
    to: opts.to,
    amount: opts.amount ?? 100,
    type: opts.type ?? "transfer",
    actor: opts.actor ?? opts.from,
    idempotencyKey: `test-tx:${seq}`,
  });
}

// ─────────────────────────────────────────────────────────────

describe("source contract（§58）", () => {
  it("ledger_transactions: persisted / restricted / titleUsable:false / orderable / point created_at / restrictedUse economy_safe_classification", () => {
    expect(TITLE_SOURCES.ledger_transactions).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      orderable: true,
      epochPolicy: { type: "point", at: "created_at" },
      restrictedUse: "economy_safe_classification",
    });
  });

  it("economy_safe_peer_actions: derived / safe / titleUsable:true / orderable / derivedFrom ledger_transactions / point occurredAt", () => {
    expect(TITLE_SOURCES.economy_safe_peer_actions).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      orderable: true,
      epochPolicy: { type: "point", at: "occurredAt" },
      derivedFrom: ["ledger_transactions"],
    });
  });
});

describe("generic raw rejection（§10, §57）", () => {
  it("readTitleSource(db, 'ledger_transactions', ...)はtitleUsable:falseでreject", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "ledger_transactions" as never, "alice", scope)).toThrow(
      /not usable by titles/,
    );
  });
});

describe("zero-result normalization（§30）", () => {
  it("0件userはfacts:[]を明示的に返す", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "economy_safe_peer_actions", "nobody", scope)).toEqual({ facts: [] });
  });
});

describe("payload shape（§13-14）", () => {
  it("kind/date/occurredAtだけを含む。amount・counterparty・reason等は含まない", () => {
    const { db, store, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "transfer" });
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "economy_safe_peer_actions", "alice", scope);
    expect(payload.facts).toHaveLength(1);
    expect(Object.keys(payload.facts[0]!).sort()).toEqual(["date", "kind", "occurredAt"]);
  });
});

describe("privacy leak test（§39）", () => {
  it("amount・counterpart・reason・ref_id・approved_byをtransactionに仕込んでも、payloadへ一切現れない", () => {
    const { db, store, ledger } = setup();
    ledger.ensureAccount("user:alice", "user");
    ledger.ensureAccount("user:LEAK_COUNTERPART_SECRET", "user");
    ledger.ensureAccount("user:staff", "user");
    fundAccount(ledger, "user:alice", 999_999);
    seq += 1;
    ledger.transfer({
      from: "user:alice",
      to: "user:LEAK_COUNTERPART_SECRET",
      amount: 987_654,
      type: "transfer",
      actor: "user:alice",
      reason: "LEAK_REASON_SECRET",
      refType: "test",
      refId: "LEAK_REF_SECRET",
      approvedBy: "user:staff",
      idempotencyKey: `leak-test:${seq}`,
    });

    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "economy_safe_peer_actions", "alice", scope);
    expect(payload.facts).toHaveLength(1);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("LEAK_COUNTERPART_SECRET");
    expect(serialized).not.toContain("LEAK_REASON_SECRET");
    expect(serialized).not.toContain("LEAK_REF_SECRET");
    expect(serialized).not.toContain("LEAK_APPROVER_SECRET");
    expect(serialized).not.toContain("staff");
    expect(serialized).not.toContain("987654");
  });
});

describe("SQL minimization test（§40）", () => {
  it("reader queryはfrom_account/type/created_atだけをSELECTする", () => {
    const { db, store, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "transfer" });
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);

    const prepareSpy = vi.spyOn(db, "prepare");
    readTitleSource(db, "economy_safe_peer_actions", "alice", scope);
    const economyQueries = prepareSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes("FROM transactions") && sql.includes("SELECT"));
    expect(economyQueries.length).toBeGreaterThan(0);
    for (const sql of economyQueries) {
      expect(sql).toMatch(/SELECT\s+from_account,\s*type,\s*created_at\s+FROM transactions/);
      expect(sql).not.toContain("amount");
      expect(sql).not.toContain("reason");
      expect(sql).not.toContain("approved_by");
      expect(sql).not.toContain("idempotency_key");
      expect(sql).not.toContain("to_account,"); // to_accountはWHEREだけ、SELECT対象ではない
    }
  });
});

describe("scope filtering: [start, end) exclusive end（§31, §54）", () => {
  it("scope開始前は除外・開始ちょうどは含む・終了ちょうどは除外", () => {
    const { db, store, ledger } = setup();
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);

    ledger.ensureAccount("user:alice", "user");
    ledger.ensureAccount("user:bob", "user");
    fundAccount(ledger, "user:alice", 500_000);

    // scope.startとOBSERVED_ATはJST上別日なので、境界近傍の2行(±1秒)が同dedupe keyへ
    // 畳まれない限り境界の効果はfact件数へ直接反映される。ただしend側の「effectiveEnd直前」
    // と「effectiveEndちょうど」は1秒差で同日になるため、同じkindだと境界が壊れていても
    // dedupeで1件に隠れてしまう——end側だけkindを変えて、"at-end"が万一漏れたときに
    // 独立した2件目のfactとして検出できるようにする。
    const insertAt = (ts: number, idKey: string, type: "transfer" | "tip") => {
      db.prepare(
        `INSERT INTO transactions (idempotency_key, from_account, to_account, amount, type, actor_id, created_at)
         VALUES (?, 'user:alice', 'user:bob', 100, ?, 'user:alice', ?)`,
      ).run(idKey, type, ts);
    };
    insertAt(scope.start - 1, "before-start", "tip"); // scope開始前 → 除外（>=フィルタ）
    insertAt(scope.start, "at-start", "transfer"); // 開始ちょうど → 含む(inclusive)
    insertAt(OBSERVED_AT - 1, "before-end", "tip"); // effectiveEnd直前 → 含む
    insertAt(OBSERVED_AT, "at-end", "transfer"); // effectiveEndちょうど → 除外(exclusive)。
    // at-startと同じkind/日付ではないので、万一漏れれば2件目のtransfer factとして検出できる。

    const payload = readTitleSource(db, "economy_safe_peer_actions", "alice", scope);
    const tipFacts = payload.facts.filter((f) => f.kind === "tip");
    const transferFacts = payload.facts.filter((f) => f.kind === "transfer");

    expect(tipFacts).toHaveLength(1); // before-startは除外、before-endだけ残る
    expect(tipFacts[0]!.occurredAt).toBe(OBSERVED_AT - 1);

    expect(transferFacts).toHaveLength(1); // at-endが漏れていれば2件になるはず
    expect(transferFacts[0]!.occurredAt).toBe(scope.start);
  });
});

describe("single-vs-bulk equivalence（D1と同じ方式）", () => {
  it("fresh single get == bulk prefetch → get（複数user）", () => {
    const { db, store, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "transfer" });
    makeTransfer(ledger, { from: "user:alice", to: "user:carol", type: "tip" });
    makeTransfer(ledger, { from: "user:dave", to: "user:bob", type: "transfer" });
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "economy_safe_peer_actions", ["alice", "dave"], scope);
    for (const userId of ["alice", "dave"]) {
      expect(bulk.get(db, "economy_safe_peer_actions", userId, scope)).toEqual(
        single.get(db, "economy_safe_peer_actions", userId, scope),
      );
    }
  });
});

describe("deep freeze（§56）", () => {
  it("payload/facts array/fact objectまでfreezeされる", () => {
    const { db, store, ledger } = setup();
    makeTransfer(ledger, { from: "user:alice", to: "user:bob", type: "transfer" });
    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "economy_safe_peer_actions", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.facts)).toBe(true);
    expect(Object.isFrozen(payload.facts[0])).toBe(true);
    expect(() => {
      (payload.facts as unknown[]).push({});
    }).toThrow();
  });
});

describe("forged scope rejection（既存provenance契約を維持）", () => {
  it("手書きscopeはfail-closed", () => {
    const { db } = setup();
    const forged = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "economy_safe_peer_actions", "alice", forged as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });
});

describe("future type auto-adoption禁止（§38）", () => {
  it("registryへpublicLog:true・user→userの新typeを追加しても、economy_safe_peer_actionsには自動で入らない", () => {
    const { db, store, ledger } = setup();
    registerTxType("future_public_action_source_test", { fromKinds: ["user"], toKinds: ["user"], publicLog: true });
    ledger.ensureAccount("user:alice", "user");
    ledger.ensureAccount("user:bob", "user");
    fundAccount(ledger, "user:alice", 500_000);
    seq += 1;
    ledger.transfer({
      from: "user:alice",
      to: "user:bob",
      amount: 100,
      type: "future_public_action_source_test",
      actor: "user:alice",
      idempotencyKey: `future-type:${seq}`,
    });

    const scope = resolveTitleScope(store, ECONOMY_SAFE_PEER_ACTIONS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "economy_safe_peer_actions", "alice", scope)).toEqual({ facts: [] });
  });
});
