import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  Escrow,
  EtherExchange,
  EventLog,
  HOUSE_HOLDER,
  FreeSpins,
  HouseReservations,
  Items,
  JACKPOT_HOLDER,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { resolveFreeSpin, spinPaid } from "../src/casino/slots.js";
import { settleChinchiroRound } from "../src/casino/chinchiro.js";
import { settleRoulette } from "../src/casino/roulette.js";
import { drawNagareboshi, ensureNagareboshiTable } from "../src/commands/nagareboshi.js";

registerDefaultTxTypes();

/**
 * 実際のゲーム経路（スロット1スピン・チンチロ1ラウンド・流れ星1回）が
 * 「外部操作1回 = 最外部グループ1個」になっているかを見る。
 *
 * 演出（Discordの編集・待ち時間）は資金と関係しないので、資金処理の入口関数を直接叩く。
 */
function setup(rng: CasinoRng) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const items = new Items(db);
  const reservations = new HouseReservations(db, ether, events);
  ether.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const casino = new Casino(db, ether, events, { items, reservations });
  const escrow = new Escrow(db, ether, events);
  const freeSpins = new FreeSpins(db);
  const services = { db, ether, casino, items, escrow, freeSpins, reservations, rng, events } as unknown as Services;
  return { db, chipTx, ether, casino, items, escrow, freeSpins, reservations, services };
}

/** 監査経路を通さずに残高を作る（テストの下ごしらえ専用） */
function seedBalance(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

/**
 * scriptedRng の値 → スロットの絵柄（重み累積 100 のうちどこに落ちるか）。
 * 0.98 → ✨魂片（スキャッター）／0.85 → 👑王冠
 */
const SCATTER = 0.98;
const CROWN = 0.85;

describe("スロット: 通常スピンとフリースピンは別のグループ", () => {
  it("フリースピンの配当が実際に加算され、グループが2つできる", () => {
    // 1回目: ✨✨✨（フリースピン獲得・配当0） / 無料スピンの出目: 👑👑👑（25倍）
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx.db, "u1", 10_000);
    const bet = 1_000;

    const paid = spinPaid(ctx.services, "u1", bet, "int-1");
    expect(paid.freeSpin).toBe(true);
    expect(paid.payout).toBe(0);
    expect(ctx.ether.balanceOf("u1")).toBe(9_000);
    // 無料スピン権は有料スピンと同じトランザクションで DB に残っている
    expect(paid.pendingFreeSpin).not.toBeNull();
    expect(paid.pendingFreeSpin!.status).toBe("pending");

    const free = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    expect(free.matched).toBe("王冠");
    expect(free.payout).toBe(bet * 25);
    // 無料スピンなので賭けは引かれず、配当だけ増える
    expect(ctx.ether.balanceOf("u1")).toBe(9_000 + 25_000);

    expect(ctx.chipTx.getGroup("slots:spin:u1:int-1:paid")).toBeDefined();
    expect(ctx.chipTx.getGroup("slots:spin:u1:int-1:free:1")).toBeDefined();
    // 無料スピンの配当も明細に残る（記録の無い移動を作らない）
    expect(ctx.chipTx.listByGroup("slots:spin:u1:int-1:free:1").map((r) => r.reason)).toEqual(["フリースピンの配当"]);
    ctx.db.close();
  });

  it("同じスピンをもう一度実行しても、表示も資金も1回分のまま", () => {
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx.db, "u1", 10_000);
    const bet = 1_000;

    const paid = spinPaid(ctx.services, "u1", bet, "int-1");
    const free = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    const balanceAfter = ctx.ether.balanceOf("u1");

    // 再実行: リール・役・フリースピン獲得・配当のすべてが保存済みの値で返る
    expect(spinPaid(ctx.services, "u1", bet, "int-1")).toEqual(paid);
    expect(resolveFreeSpin(ctx.services, paid.pendingFreeSpin!)).toEqual(free);
    expect(ctx.ether.balanceOf("u1")).toBe(balanceAfter);
    expect(ctx.casino.stats("u1").games).toBe(1); // 有料スピン1回ぶんだけ
    ctx.db.close();
  });
});

describe("チンチロ: 全分岐が同じラウンドのグループ", () => {
  it("所持額が倍付け損失ちょうどでも、二度実行して減るのは1回分だけ", () => {
    const ctx = setup(scriptedRng([0.5]));
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx.db, "u1", 2_000); // bet 1,000 + 追加徴収 1,000 ちょうど

    const first = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1");
    expect(first.branch).toBe("double_loss");
    expect(ctx.ether.balanceOf("u1")).toBe(0);

    // 残高が0でも、同じ操作の再試行は倍付け負けの結果をそのまま返す
    // （通常負け側へ回って別グループでもう一度徴収する、が起きない）
    const second = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1");
    expect(second).toEqual(first);
    expect(ctx.ether.balanceOf("u1")).toBe(0);
    expect(ctx.chipTx.listByGroup("chinchiro:round:u1:op-1").map((r) => r.reason)).toEqual([
      "賭け金",
      "倍付け負けの追加徴収",
    ]);
    expect(ctx.chipTx.getGroup("solo:チンチロ:u1:op-1")).toBeUndefined();
    ctx.db.close();
  });

  it("所持額が倍付け損失より少し上でも、二度実行して減るのは1回分だけ", () => {
    const ctx = setup(scriptedRng([0.5]));
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx.db, "u1", 2_500);

    const first = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1");
    expect(first.branch).toBe("double_loss");
    expect(ctx.ether.balanceOf("u1")).toBe(500);

    expect(settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1")).toEqual(first);
    expect(ctx.ether.balanceOf("u1")).toBe(500);
    expect(ctx.casino.stats("u1").games).toBe(1);
    ctx.db.close();
  });

  it("残高不足のフォールバックも同じグループで確定する", () => {
    const ctx = setup(scriptedRng([0.5]));
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx.db, "u1", 1_500); // 追加徴収 1,000 に足りない

    const first = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1");
    expect(first.branch).toBe("fallback_loss");
    expect(ctx.ether.balanceOf("u1")).toBe(500);

    expect(settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1")).toEqual(first);
    expect(ctx.ether.balanceOf("u1")).toBe(500);
    ctx.db.close();
  });
});

describe("ルーレット: 1回転が1グループ", () => {
  const SESSION = "roulette:int-1";
  /** rouletteSpin = int(0,36) = floor(f*37)。0.03 → 出目 1（🔴赤・奇数・小） */
  const SPIN_ONE = 0.03;

  function seatTwo(ctx: ReturnType<typeof setup>, houseBalance = 1_000_000) {
    seedBalance(ctx.db, HOUSE_HOLDER, houseBalance);
    seedBalance(ctx.db, "alice", 10_000);
    seedBalance(ctx.db, "bob", 10_000);
    // 受付時のエスクロー（張った時点で預ける）
    expect(ctx.escrow.holdAll(SESSION, ["alice", "bob"], 1_000, "roulette", "hold-1")).toBe(true);
    return [
      { userId: "alice", type: "red" as const, amount: 1_000 },
      { userId: "bob", type: "black" as const, amount: 1_000 },
    ];
  }

  it("出目と全員の結果が保存値から再生され、資金は二度動かない", () => {
    const ctx = setup(scriptedRng([SPIN_ONE]));
    const bets = seatTwo(ctx);

    const first = settleRoulette(ctx.services, SESSION, bets);
    expect(first.n).toBe(1);
    expect(first.results).toEqual([
      { userId: "alice", type: "red", amount: 1_000, won: true, payout: 2_000, net: 1_000 },
      { userId: "bob", type: "black", amount: 1_000, won: false, payout: 0, net: -1_000 },
    ]);
    const alice = ctx.ether.balanceOf("alice");
    const bob = ctx.ether.balanceOf("bob");
    expect(alice).toBe(11_000); // 預けた1,000が戻り、賭け1,000を払って配当2,000（+1,000）
    expect(bob).toBe(9_000); // 預けた1,000が戻り、賭け1,000を払って外れ（−1,000）

    // 再試行: 抽選し直さず、出目も分配も保存済みの値をそのまま返す
    const again = settleRoulette(ctx.services, SESSION, bets);
    expect(again).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(alice);
    expect(ctx.ether.balanceOf("bob")).toBe(bob);
    expect(ctx.casino.stats("alice").games).toBe(1);
    expect(ctx.escrow.poolOf(SESSION)).toBe(0);
    ctx.db.close();
  });

  it("途中で落ちたら全員分がロールバックし、預り金は卓に残る", () => {
    const ctx = setup(scriptedRng([SPIN_ONE]));
    const bets = seatTwo(ctx);
    const holder = ctx.escrow.holderId(SESSION);

    expect(() =>
      settleRoulette(ctx.services, SESSION, bets, (i) => {
        if (i === 1) throw new Error("2人目で落ちる");
      }),
    ).toThrow("2人目で落ちる");

    // 1人目の精算もエスクロー返還も戻っている（「全員返金済み・一部だけ精算済み」を作らない）
    expect(ctx.ether.balanceOf("alice")).toBe(9_000);
    expect(ctx.ether.balanceOf("bob")).toBe(9_000);
    expect(ctx.ether.balanceOf(holder)).toBe(2_000);
    expect(ctx.escrow.poolOf(SESSION)).toBe(2_000);
    expect(ctx.casino.stats("alice").games).toBe(0);
    expect(ctx.chipTx.getGroup(`${SESSION}:settle`)).toBeUndefined();

    // 巻き戻っているので同じセッションで再試行でき、今度は最後まで通る
    expect(settleRoulette(ctx.services, SESSION, bets).n).toBe(1);
    expect(ctx.ether.balanceOf("alice")).toBe(11_000);
    expect(ctx.escrow.poolOf(SESSION)).toBe(0);
    ctx.db.close();
  });

  it("胴元が払えないときは握り潰さず、回転ごと巻き戻す", () => {
    // 胴元 500 ◈: alice の賭け 1,000 を取り込んでも配当 2,000 に届かない
    const ctx = setup(scriptedRng([SPIN_ONE]));
    const bets = seatTwo(ctx, 500);

    expect(() => settleRoulette(ctx.services, SESSION, bets)).toThrow();

    // 「残高不足で無効」と表示して先へ進む（＝その人だけ賭け金が返ったまま）にはしない
    expect(ctx.ether.balanceOf("alice")).toBe(9_000);
    expect(ctx.ether.balanceOf("bob")).toBe(9_000);
    expect(ctx.escrow.poolOf(SESSION)).toBe(2_000);
    expect(ctx.chipTx.getGroup(`${SESSION}:settle`)).toBeUndefined();

    // 呼び出し側は卓ごと返金して閉じられる
    expect(ctx.escrow.refund(SESSION)).toBe(2);
    expect(ctx.ether.balanceOf("alice")).toBe(10_000);
    expect(ctx.ether.balanceOf("bob")).toBe(10_000);
    ctx.db.close();
  });
});

describe("流れ星: 料金・回数・抽選・報酬が1グループ", () => {
  const jackpotDraw = () => setup(scriptedRng([0.99])); // 必ず ✨流れ星（報酬あり）

  it("初回無料の再実行でも、回数も報酬も1回分だけ", () => {
    const ctx = jackpotDraw();
    ensureNagareboshiTable(ctx.services);
    seedBalance(ctx.db, JACKPOT_HOLDER, 50_000);
    seedBalance(ctx.db, "u1", 10_000);

    const first = drawNagareboshi(ctx.services, "u1", "2026-08-01", "op-1");
    expect(first).toMatchObject({ ok: true, fee: 0, outcomeKey: "nagareboshi", paid: 10_000 });
    expect(ctx.ether.balanceOf("u1")).toBe(20_000);

    expect(drawNagareboshi(ctx.services, "u1", "2026-08-01", "op-1")).toEqual(first);
    expect(ctx.ether.balanceOf("u1")).toBe(20_000);
    expect(count(ctx.db, "u1", "2026-08-01")).toBe(1);
    ctx.db.close();
  });

  it("有料回の再実行でも、料金も回数も報酬も1回分だけ", () => {
    const ctx = jackpotDraw();
    ensureNagareboshiTable(ctx.services);
    seedBalance(ctx.db, JACKPOT_HOLDER, 50_000);
    seedBalance(ctx.db, "u1", 10_000);

    drawNagareboshi(ctx.services, "u1", "2026-08-01", "op-1"); // 初回（無料）
    const balanceAfterFirst = ctx.ether.balanceOf("u1");

    const paid = drawNagareboshi(ctx.services, "u1", "2026-08-01", "op-2");
    expect(paid).toMatchObject({ ok: true, fee: 1_000, paid: 10_000 });
    const balanceAfterPaid = ctx.ether.balanceOf("u1");
    expect(balanceAfterPaid).toBe(balanceAfterFirst - 1_000 + 10_000);

    expect(drawNagareboshi(ctx.services, "u1", "2026-08-01", "op-2")).toEqual(paid);
    expect(ctx.ether.balanceOf("u1")).toBe(balanceAfterPaid);
    expect(count(ctx.db, "u1", "2026-08-01")).toBe(2);
    expect(ctx.chipTx.listByGroup("nagareboshi:u1:op-2").map((r) => r.reason)).toEqual([
      "流れ星の祈り代",
      "流れ星の褒賞",
    ]);
    ctx.db.close();
  });
});

function count(db: ReturnType<typeof openDb>, uid: string, day: string): number {
  const row = db.prepare("SELECT count FROM casino_nagareboshi WHERE user_id = ? AND day_key = ?").get(uid, day) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}
