import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, ChipLedgerError, HOUSE_HOLDER, type ChipLedgerErrorCode } from "../src/casino/exchange.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { deptAccount } from "../src/departments/service.js";

import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR8監査・項目10/項目11: 資金APIの入力検証とエラー型。
 *
 * 「壊れた入力でも例外にはなる」では足りない。**どのコードで断ったか**が安定していないと、
 * bot 側は generic な「処理に失敗しました」しか出せず、利用者は何を直せばいいか分からない。
 * ここでは全資金APIについて、拒否理由のコードと**資金が1単位も動いていないこと**を固定する。
 *
 * 正式開業ロック（ブロッカーA）そのものは `chip-ledger.test.ts` が見ているので、
 * ここでは入力検証だけを見るために `ChipLedger`（ロックなし実装）を使う。
 */

const DEPT = deptAccount("賭博場");

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  // 正式開業ロックは外せない（PR8監査・ブロッカーA）。資金を動かす前に opening_v1 を確定させる
  openFormally(chips.chipTx, ledger);
  for (const userId of ["a", "b"]) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 1_000_000, type: "initial", actor: "test", idempotencyKey: `fund:${userId}` });
  }
  ledger.ensureAccount(DEPT, "system");
  ledger.transfer({ from: TREASURY, to: DEPT, amount: 1_000_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "fund:dept" });
  return { db, ledger, events, chipTx, chips };
}

type Ctx = ReturnType<typeof setup>;

/** 資金が動いていないことの照合材料。1つでもズレたら「拒否したのに副作用が残った」 */
function snapshot(ctx: Ctx) {
  const n = (table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  return {
    balances: ctx.db.prepare("SELECT user_id, amount FROM ether_balances ORDER BY user_id").all(),
    pool: ctx.chips.pool(),
    landTx: n("transactions"),
    groups: n("casino_tx_groups"),
    chipTx: n("casino_tx"),
    events: n("events"),
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ChipLedgerError);
    expect((e as Error).name).toBe("ChipLedgerError");
    return (e as ChipLedgerError).code;
  }
  throw new Error("例外が投げられなかった（拒否されるべき入力が通っている）");
}

/**
 * 拒否されるべき金額の全網羅。`Number.isInteger` だけの検証はここの
 * `MAX_SAFE_INTEGER + 1` を通してしまう（2^53 は浮動小数点では整数に見える）。
 */
const BAD_AMOUNTS: Array<[string, number]> = [
  ["0", 0],
  ["負数", -1],
  ["小数", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["MAX_SAFE_INTEGER+1", Number.MAX_SAFE_INTEGER + 1],
  ["さらに大きい値", 1e30],
];

/** 拒否されるべき識別子。`__proto__` は**通す**ので、ここには入れない（別テストで確認） */
const BAD_IDENTIFIERS: Array<[string, unknown]> = [
  ["空文字", ""],
  ["空白のみ", "   "],
  ["タブと改行のみ", "\t\n"],
  ["number", 123],
  ["null", null],
  ["undefined", undefined],
  ["オブジェクト", {}],
];

describe("資金APIの金額検証（項目10）", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.chips.deposit("a", 100_000, "seed:a");
    ctx.chips.fundFromAccount(DEPT, 100_000, HOUSE_HOLDER, "seed:house");
  });

  it.each(BAD_AMOUNTS)("全資金APIが %s を ERR_BAD_AMOUNT で拒否し、何も動かさない", (_label, amount) => {
    const before = snapshot(ctx);
    const calls: Array<[string, () => unknown]> = [
      ["quoteDeposit", () => ctx.chips.quoteDeposit(amount)],
      ["quoteRedeem", () => ctx.chips.quoteRedeem(amount)],
      ["deposit", () => ctx.chips.deposit("a", amount, `bad:deposit:${amount}`)],
      ["redeem", () => ctx.chips.redeem("a", amount, `bad:redeem:${amount}`)],
      ["fundFromAccount", () => ctx.chips.fundFromAccount(DEPT, amount, HOUSE_HOLDER, `bad:fund:${amount}`)],
      ["redeemToAccount", () => ctx.chips.redeemToAccount(HOUSE_HOLDER, amount, DEPT, "test", `bad:settle:${amount}`)],
      ["redeemFairToAccount", () => ctx.chips.redeemFairToAccount(HOUSE_HOLDER, amount, DEPT, `bad:fair:${amount}`)],
      [
        "transfer",
        () =>
          ctx.chips.runGroup({ groupKey: `bad:transfer:${amount}`, kind: "solo_game", actorId: "a" }, () =>
            ctx.chips.transfer("a", HOUSE_HOLDER, amount, { reason: "不正額の賭け" }),
          ),
      ],
    ];
    for (const [name, call] of calls) expect(`${name}:${codeOf(call)}`).toBe(`${name}:ERR_BAD_AMOUNT`);
    expect(snapshot(ctx)).toEqual(before);
  });

  it("演算後に safe integer を超える預入・投入・移動は成立させない", () => {
    // 残高だけ safe 上限近くまで積み上げる（個々の入力は正しい safe integer）
    const huge = Number.MAX_SAFE_INTEGER - 1_000;
    ctx.db.prepare("UPDATE ether_balances SET amount = ? WHERE user_id = ?").run(huge, "a");
    const before = snapshot(ctx);
    // 預入・胴元投入・内部移動のいずれも「合計が 2^53 を超える」時点で断る
    expect(codeOf(() => ctx.chips.deposit("a", 10_000, "overflow:deposit"))).toBe("ERR_BAD_AMOUNT");
    expect(codeOf(() => ctx.chips.fundFromAccount(DEPT, 10_000, "a", "overflow:fund"))).toBe("ERR_BAD_AMOUNT");
    expect(
      codeOf(() =>
        ctx.chips.runGroup({ groupKey: "overflow:transfer", kind: "solo_game", actorId: "h" }, () =>
          ctx.chips.transfer(HOUSE_HOLDER, "a", 10_000, { reason: "配当" }),
        ),
      ),
    ).toBe("ERR_BAD_AMOUNT");
    expect(snapshot(ctx)).toEqual(before);
  });

  it("quote系は不正入力をそのまま返さない（UIが嘘の見積りを出さない）", () => {
    for (const [, amount] of BAD_AMOUNTS) {
      expect(() => ctx.chips.quoteDeposit(amount)).toThrow(ChipLedgerError);
      expect(() => ctx.chips.quoteRedeem(amount)).toThrow(ChipLedgerError);
    }
    // 正しい入力は 1:1 のまま
    expect(ctx.chips.quoteDeposit(10_000)).toEqual({ input: 10_000, output: 10_000, burned: 0 });
    expect(ctx.chips.quoteRedeem(10_000)).toEqual({ input: 10_000, output: 10_000, burned: 0 });
  });
});

describe("資金APIの識別子検証（項目10）", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.chips.deposit("a", 100_000, "seed:a");
    ctx.chips.fundFromAccount(DEPT, 100_000, HOUSE_HOLDER, "seed:house");
  });

  it.each(BAD_IDENTIFIERS)("必要な文字列引数の %s を ERR_BAD_IDENTIFIER で拒否し、何も動かさない", (_label, bad) => {
    const before = snapshot(ctx);
    const s = bad as string;
    const calls: Array<[string, () => unknown]> = [
      ["deposit:userId", () => ctx.chips.deposit(s, 100, "ident:deposit:user")],
      ["deposit:key", () => ctx.chips.deposit("a", 100, s)],
      ["redeem:userId", () => ctx.chips.redeem(s, 100, "ident:redeem:user")],
      ["redeem:key", () => ctx.chips.redeem("a", 100, s)],
      ["fund:src", () => ctx.chips.fundFromAccount(s, 100, HOUSE_HOLDER, "ident:fund:src")],
      ["fund:holder", () => ctx.chips.fundFromAccount(DEPT, 100, s, "ident:fund:holder")],
      ["fund:key", () => ctx.chips.fundFromAccount(DEPT, 100, HOUSE_HOLDER, s)],
      ["settle:holder", () => ctx.chips.redeemToAccount(s, 100, DEPT, "test", "ident:settle:holder")],
      ["settle:dest", () => ctx.chips.redeemToAccount(HOUSE_HOLDER, 100, s, "test", "ident:settle:dest")],
      ["settle:actor", () => ctx.chips.redeemToAccount(HOUSE_HOLDER, 100, DEPT, s, "ident:settle:actor")],
      ["settle:key", () => ctx.chips.redeemToAccount(HOUSE_HOLDER, 100, DEPT, "test", s)],
      ["fair:holder", () => ctx.chips.redeemFairToAccount(s, 100, DEPT, "ident:fair:holder")],
      ["balanceOf", () => ctx.chips.balanceOf(s)],
      ["settleableBalance", () => ctx.chips.settleableBalance(s)],
      ["ensureHolder", () => ctx.chips.ensureHolder(s)],
      [
        "transfer:from",
        () =>
          ctx.chips.runGroup({ groupKey: "ident:transfer:from", kind: "solo_game", actorId: "a" }, () =>
            ctx.chips.transfer(s, HOUSE_HOLDER, 100, { reason: "賭け金" }),
          ),
      ],
      [
        "transfer:to",
        () =>
          ctx.chips.runGroup({ groupKey: "ident:transfer:to", kind: "solo_game", actorId: "a" }, () =>
            ctx.chips.transfer("a", s, 100, { reason: "配当" }),
          ),
      ],
    ];
    for (const [name, call] of calls) expect(`${name}:${codeOf(call)}`).toBe(`${name}:ERR_BAD_IDENTIFIER`);
    expect(snapshot(ctx)).toEqual(before);
  });

  it('"__proto__" などの特殊な文字列は、通常の保有者IDとして安全に扱える', () => {
    // 保有者IDは SQLite の bind パラメータにしかならず、JSオブジェクトのキーにはしない。
    // ここで拒否すると「そのIDの利用者だけ資金操作できない」不具合になるので、通す方が正しい。
    for (const holder of ["__proto__", "constructor", "prototype", "toString"]) {
      ctx.chips.runGroup({ groupKey: `proto:${holder}`, kind: "solo_game", actorId: "a" }, () =>
        ctx.chips.transfer("a", holder, 1_000, { reason: "特殊名の保有者への配当" }),
      );
      expect(ctx.chips.balanceOf(holder)).toBe(1_000);
    }
    // プロトタイプ汚染が起きていないこと（Object.prototype が汚れていない）
    expect(({} as Record<string, unknown>).amount).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    // 発行総量にもちゃんと数えられている（特別扱いされていない）
    expect(ctx.chips.balanceOf("__proto__")).toBe(1_000);
  });
});

describe("DBから読んだ値の健全性検査（項目10）", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.chips.deposit("a", 100_000, "seed:a");
  });

  /** CHECK 制約を一時的に外して、DB破損そのものを作る */
  function corrupt(userId: string, amount: number): void {
    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE ether_balances SET amount = ? WHERE user_id = ?").run(amount, userId);
    ctx.db.pragma("ignore_check_constraints = OFF");
  }

  it.each([
    ["負数", -5],
    ["非整数", 1.5],
    ["safe integer 範囲外", 2 ** 53],
  ])("残高が %s ならERR_CORRUPT_BALANCEでfail-closedになる", (_label, bad) => {
    corrupt("a", bad);
    expect(codeOf(() => ctx.chips.balanceOf("a"))).toBe("ERR_CORRUPT_BALANCE");
    // 破損値を土台にした資金移動も成立させない
    expect(codeOf(() => ctx.chips.redeem("a", 100, "corrupt:redeem"))).toBe("ERR_CORRUPT_BALANCE");
    expect(codeOf(() => ctx.chips.settleableBalance("a"))).toBe("ERR_CORRUPT_BALANCE");
    // 発行総量（SUM）も同じ理由で信じない
    expect(codeOf(() => ctx.chips.outstanding())).toBe("ERR_CORRUPT_BALANCE");
  });

  it("準備プールの Land が破損していれば pool() が fail-closed になる", () => {
    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE balances SET amount = ? WHERE account_id = ?").run(-1, ctx.chips.reserveHolder());
    ctx.db.pragma("ignore_check_constraints = OFF");
    expect(codeOf(() => ctx.chips.pool())).toBe("ERR_CORRUPT_BALANCE");
  });

  it("予約額が壊れていても『予約0』へ丸めず、精算可能額を fail-closed にする", () => {
    // 丸めてしまうと、破損時に予約済み資金まで全額精算できてしまう（fail-open）
    ctx.chips.setReservedProvider(() => Number.NaN);
    expect(codeOf(() => ctx.chips.settleableBalance(HOUSE_HOLDER))).toBe("ERR_CORRUPT_BALANCE");
  });
});

describe("transfer の自己送金と部分更新（項目10）", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.chips.deposit("a", 50_000, "seed:a");
    ctx.chips.fundFromAccount(DEPT, 50_000, HOUSE_HOLDER, "seed:house");
  });

  it("from === to は ERR_SELF_TRANSFER で拒否し、残高・chip tx・group・eventを一切変えない", () => {
    const before = snapshot(ctx);
    expect(
      codeOf(() =>
        ctx.chips.runGroup({ groupKey: "self:transfer", kind: "solo_game", actorId: "a" }, () =>
          ctx.chips.transfer("a", "a", 1_000, { reason: "自分から自分へ" }),
        ),
      ),
    ).toBe("ERR_SELF_TRANSFER");
    expect(snapshot(ctx)).toEqual(before);
  });

  it("残高不足の内部移動は部分更新を残さない", () => {
    const before = snapshot(ctx);
    expect(
      codeOf(() =>
        ctx.chips.runGroup({ groupKey: "short:transfer", kind: "solo_game", actorId: "a" }, () =>
          ctx.chips.transfer("a", HOUSE_HOLDER, 50_001, { reason: "残高を超える賭け" }),
        ),
      ),
    ).toBe("ERR_INSUFFICIENT_CHIPS");
    expect(snapshot(ctx)).toEqual(before);
  });

  it("holder残高不足の返還・精算も部分更新を残さない", () => {
    const before = snapshot(ctx);
    expect(codeOf(() => ctx.chips.redeem("a", 50_001, "short:redeem"))).toBe("ERR_INSUFFICIENT_CHIPS");
    expect(codeOf(() => ctx.chips.redeemToAccount(HOUSE_HOLDER, 50_001, DEPT, "test", "short:settle"))).toBe(
      "ERR_INSUFFICIENT_CHIPS",
    );
    expect(snapshot(ctx)).toEqual(before);
  });
});

/**
 * PR8監査・項目11: エラー型の最終形。
 *
 * 「投げていれば何でもいい」にしないため、公開コードの集合そのものを固定する。
 * 旧名称（`ERR_INSUFFICIENT_ETHER` 等）が union に残っていると、新コードでも
 * `e.code === "ERR_INSUFFICIENT_ETHER"` が型検査を通ってしまい、依存が静かに増える。
 */
describe("ChipLedgerError の公開型（項目11）", () => {
  const EXPECTED_CODES: ChipLedgerErrorCode[] = [
    "ERR_BAD_AMOUNT",
    "ERR_BAD_IDENTIFIER",
    "ERR_INSUFFICIENT_CHIPS",
    "ERR_DUPLICATE",
    "ERR_RESERVED_FUNDS",
    "ERR_SELF_TRANSFER",
    "ERR_CASINO_OPENING_NOT_COMPLETE",
    "ERR_UNKNOWN_OPENING_VERSION",
    "ERR_CORRUPT_BALANCE",
  ];

  it("name は常に ChipLedgerError で、code と meta を持つ", () => {
    const e = new ChipLedgerError("ERR_BAD_AMOUNT", { landIn: -1 });
    expect(e.name).toBe("ChipLedgerError");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("ERR_BAD_AMOUNT");
    expect(e.message).toBe("ERR_BAD_AMOUNT");
    expect(e.meta).toEqual({ landIn: -1 });
  });

  it("公開コードの集合が仕様どおりで、旧エテル名称を含まない", () => {
    const src = readFileSync(new URL("../src/casino/exchange.ts", import.meta.url), "utf8");
    const union = src.slice(src.indexOf("export type ChipLedgerErrorCode"), src.indexOf("/** @deprecated `ChipLedgerErrorCode`"));
    const declared = [...union.matchAll(/"(ERR_[A-Z_]+)"/g)].map((m) => m[1]!);
    expect([...declared].sort()).toEqual([...EXPECTED_CODES].sort());
    // 旧名称は union のメンバーではない（＝新コードから型で参照できない）
    expect(declared).not.toContain("ERR_INSUFFICIENT_ETHER");
    expect(declared).not.toContain("ERR_BAD_INPUT");
    expect(declared).not.toContain("ERR_CORRUPTED_BALANCE");
  });

  it("旧名称は deprecated エイリアス定数としてだけ残り、新コードを指す", async () => {
    const mod = await import("../src/casino/exchange.js");
    expect(mod.ERR_INSUFFICIENT_ETHER).toBe("ERR_INSUFFICIENT_CHIPS");
    expect(mod.ERR_BAD_INPUT).toBe("ERR_BAD_IDENTIFIER");
    expect(mod.ERR_CORRUPTED_BALANCE).toBe("ERR_CORRUPT_BALANCE");
  });

  it("賭場の production コードに `as never` が残っていない", () => {
    const src = [
      readFileSync(new URL("../src/casino/exchange.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../src/casino/chip-ledger.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../src/casino/chip-tx.ts", import.meta.url), "utf8"),
    ].join("\n");
    // コメント中の言及（「as never で迂回させない」）は許すが、実コードでの使用は許さない
    const codeLines = src.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l));
    expect(codeLines.filter((l) => /\bas never\b/.test(l))).toEqual([]);
  });
});
