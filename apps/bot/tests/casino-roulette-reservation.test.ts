import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  ChipLedger,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { acceptRouletteBet, settleRoulette, voidRouletteTable } from "../src/casino/roulette.js";

registerDefaultTxTypes();

/**
 * PR5 マージ直前レビュー対応: ルーレットを卓単位の胴元債務予約へ統合する。
 *
 * 見るのは:
 * - 張り増し・張り直しで予約額が原子的に増減すること
 * - 予約が取れなければ旧ベット・旧エスクロー・旧予約のどれも変わらないこと
 * - 全員の精算が成功するまで予約が残り、成功後に一度だけ解放されること
 * - 途中の参加者で例外が出れば、精算も予約解放もまとめて巻き戻ること
 * - 卓の無効化（void）で返金と予約解放が同じトランザクションで行われること
 * - 同じセッションの再試行で二重予約・二重精算しないこと
 */

function setup(rng: CasinoRng = scriptedRng([0.5])) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, ledger, events, { chipTx, requireOpeningV1: false });
  const items = new Items(db);
  const reservations = new HouseReservations(db, ether, events);
  ether.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const casino = new Casino(db, ether, events, { items, reservations });
  const escrow = new Escrow(db, ether, events);
  const services = { db, ether, chips: ether, chipTx, casino, items, escrow, reservations, rng, events } as unknown as Services;
  return { db, ether, casino, items, escrow, reservations, services };
}

function seed(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

const RESERVATION_KEY = (session: string) => `roulette:reserve:${session}`;

describe("acceptRouletteBet: 卓全体の債務を原子的に予約する", () => {
  it("新規ベットで卓の予約が作られる（even=2倍 → 増分は賭け額と同額）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const session = "roulette:s1";
    const bets = new Map();

    const r = acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op1");
    expect(r.ok).toBe(true);
    expect(bets.get("alice")).toEqual({ userId: "alice", type: "red", amount: 1_000 });
    // even(2倍) の増分債務 = 賭け額そのもの
    expect(c.reservations.get(RESERVATION_KEY(session))?.amount).toBe(1_000);
  });

  it("零(single=36倍)は増分債務が賭け額の35倍になる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const session = "roulette:s1";
    const bets = new Map();

    acceptRouletteBet(c.services, session, bets, "alice", "green", 1_000, "op1");
    expect(c.reservations.get(RESERVATION_KEY(session))?.amount).toBe(35_000);
  });

  it("張り増し（同じtype・別ユーザー追加）で予約額が増える", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    seed(c.db, "bob", 100_000);
    const session = "roulette:s1";
    const bets = new Map();

    acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op1");
    expect(c.reservations.get(RESERVATION_KEY(session))?.amount).toBe(1_000);
    acceptRouletteBet(c.services, session, bets, "bob", "black", 2_000, "op2");
    // 赤1,000(+1,000) と 黒2,000(+2,000) は同じ回転で同時成立しうるので合算
    expect(c.reservations.get(RESERVATION_KEY(session))?.amount).toBe(3_000);
  });

  it("張り直し（同一ユーザーが零→赤へ変更）で債務が減り、余力が戻る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 100_000);
    const session = "roulette:s1";
    const bets = new Map();

    acceptRouletteBet(c.services, session, bets, "alice", "green", 1_000, "op1"); // 35,000
    const availableBefore = c.reservations.available();
    acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op2"); // 1,000
    expect(c.reservations.get(RESERVATION_KEY(session))?.amount).toBe(1_000);
    expect(c.reservations.available()).toBe(availableBefore + 34_000);
    expect(bets.get("alice")).toEqual({ userId: "alice", type: "red", amount: 1_000 });
  });

  it("予約増額に失敗したら旧ベット・旧エスクロー・旧予約のどれも変わらない", () => {
    const c = setup();
    // house はちょうど 1,000 しか無い。零(35倍)への張り直しは通らない
    seed(c.db, HOUSE_HOLDER, 1_000);
    seed(c.db, "alice", 100_000);
    const session = "roulette:s1";
    const bets = new Map();

    const first = acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op1");
    expect(first.ok).toBe(true);
    const reservedBefore = c.reservations.get(RESERVATION_KEY(session));
    const escrowBefore = c.escrow.poolOf(session);
    const balanceBefore = c.ether.balanceOf("alice");

    const second = acceptRouletteBet(c.services, session, bets, "alice", "green", 1_000, "op2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("capacity");

    // 予約・エスクロー・bets のどれも変わっていない
    expect(c.reservations.get(RESERVATION_KEY(session))).toEqual(reservedBefore);
    expect(c.escrow.poolOf(session)).toBe(escrowBefore);
    expect(c.ether.balanceOf("alice")).toBe(balanceBefore);
    expect(bets.get("alice")).toEqual({ userId: "alice", type: "red", amount: 1_000 });
  });

  it("残高不足でエスクローへ預けられなければ broke で断り、状態は変わらない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 500); // 賭け額 1,000 に届かない
    const session = "roulette:s1";
    const bets = new Map();

    const r = acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("broke");
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeUndefined();
    expect(bets.has("alice")).toBe(false);
  });

  it("別チャンネル2卓（別session）が同じ余力を奪い合い、片方は容量不足で断られる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100);
    seed(c.db, "alice", 100_000);
    seed(c.db, "bob", 100_000);
    const betsA = new Map();
    const betsB = new Map();

    const a = acceptRouletteBet(c.services, "roulette:table-a", betsA, "alice", "red", 80, "op1");
    expect(a.ok).toBe(true);
    const b = acceptRouletteBet(c.services, "roulette:table-b", betsB, "bob", "red", 80, "op1");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("capacity");
    expect(c.reservations.totalReserved()).toBe(80);
  });
});

describe("settleRoulette: 全員成功後に一度だけ卓予約を解放する", () => {
  function seatTwo(c: ReturnType<typeof setup>, session: string, houseBalance = 1_000_000) {
    seed(c.db, HOUSE_HOLDER, houseBalance);
    seed(c.db, "alice", 10_000);
    seed(c.db, "bob", 10_000);
    const bets = new Map();
    acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op1");
    acceptRouletteBet(c.services, session, bets, "bob", "black", 1_000, "op2");
    return [...bets.values()];
  }

  it("精算前は予約が生きており、成功後に解放される", () => {
    const c = setup(scriptedRng([0.03])); // 出目1（赤・奇数・小）
    const session = "roulette:s1";
    const bets = seatTwo(c, session);
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeDefined();

    settleRoulette(c.services, session, bets);
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeUndefined();
  });

  it("2人目の精算で例外が出ると、1人目の精算・予約解放もまとめて巻き戻る", () => {
    const c = setup(scriptedRng([0.03]));
    const session = "roulette:s1";
    const bets = seatTwo(c, session);
    const reservedBefore = c.reservations.get(RESERVATION_KEY(session));

    expect(() =>
      settleRoulette(c.services, session, bets, (i) => {
        if (i === 1) throw new Error("2人目で落ちる");
      }),
    ).toThrow("2人目で落ちる");

    // 予約は残っている（解放されていない）
    expect(c.reservations.get(RESERVATION_KEY(session))).toEqual(reservedBefore);
    // 1人目の精算も戻っている
    expect(c.casino.stats("alice").games).toBe(0);

    // 巻き戻っているので再試行でき、今度は最後まで通って解放される
    expect(settleRoulette(c.services, session, bets).n).toBe(1);
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeUndefined();
  });

  it("同じセッション・同じbetsで再試行しても二重予約・二重精算しない（保存済み結果を再生する）", () => {
    const c = setup(scriptedRng([0.03]));
    const session = "roulette:s1";
    const bets = seatTwo(c, session);

    const first = settleRoulette(c.services, session, bets);
    const aliceAfterFirst = c.ether.balanceOf("alice");
    const bobAfterFirst = c.ether.balanceOf("bob");

    const second = settleRoulette(c.services, session, bets);
    expect(second).toEqual(first);
    expect(c.ether.balanceOf("alice")).toBe(aliceAfterFirst);
    expect(c.ether.balanceOf("bob")).toBe(bobAfterFirst);
    expect(c.casino.stats("alice").games).toBe(1); // 2度目は資金を動かしていない
    // 解放も冪等（無いものをもう一度解放しても何も起きない）
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeUndefined();
  });

  it("予約後に他経路でhouseが薄くなっても、精算は卓ごと巻き戻り予約は残る（資金は消えない）", () => {
    const c = setup(scriptedRng([0.03]));
    const session = "roulette:s1";
    // house が潤沢な間に正規の受付経路（acceptRouletteBet）で予約を取る
    const bets = seatTwo(c, session, 1_000_000);
    const reservedBefore = c.reservations.get(RESERVATION_KEY(session));
    expect(reservedBefore?.amount).toBe(2_000);

    // 予約の裏付けが壊れた状況を模す（本来は daily/stocks 等が settleableBalance を
    // 尊重するので起きないはずだが、settleRoulette 自身の安全性を独立に確認する）
    seed(c.db, HOUSE_HOLDER, 500);

    expect(() => settleRoulette(c.services, session, bets)).toThrow();
    // 精算は巻き戻り、予約は残ったまま（資金だけ消えて権利が失われることはない）
    expect(c.reservations.get(RESERVATION_KEY(session))).toEqual(reservedBefore);
    expect(c.casino.stats("alice").games).toBe(0);
  });
});

describe("voidRouletteTable: 返金と予約解放を同じトランザクションで行う", () => {
  it("返金後は予約が残らない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "alice", 10_000);
    const session = "roulette:s1";
    const bets = new Map();
    acceptRouletteBet(c.services, session, bets, "alice", "red", 1_000, "op1");
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeDefined();
    const balanceBeforeVoid = c.ether.balanceOf("alice");

    voidRouletteTable(c.services, session);

    expect(c.reservations.get(RESERVATION_KEY(session))).toBeUndefined();
    expect(c.ether.balanceOf("alice")).toBe(balanceBeforeVoid + 1_000); // 賭け金が戻る
    expect(c.escrow.poolOf(session)).toBe(0);
  });

  it("予約が無い卓（誰も張らなかった等）を void しても何も起きない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const session = "roulette:empty";
    expect(() => voidRouletteTable(c.services, session)).not.toThrow();
    expect(c.reservations.get(RESERVATION_KEY(session))).toBeUndefined();
  });
});
