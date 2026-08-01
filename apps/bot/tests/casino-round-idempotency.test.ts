import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  Escrow,
  EtherExchange,
  EventLog,
  HOUSE_HOLDER,
  Items,
  JACKPOT_HOLDER,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { spinOnce } from "../src/casino/slots.js";
import { settleChinchiroRound } from "../src/casino/chinchiro.js";
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
  const casino = new Casino(db, ether, events, { items });
  const escrow = new Escrow(db, ether, events);
  const services = { db, ether, casino, items, escrow, rng, events } as unknown as Services;
  return { db, chipTx, ether, casino, items, escrow, services };
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
    // 1回目: ✨✨✨（フリースピン獲得・配当0） / 2回目: 👑👑👑（25倍）
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    seedBalance(ctx.db, "u1", 10_000);
    const bet = 1_000;

    const paid = spinOnce(ctx.services, "u1", bet, "int-1", 0);
    expect(paid.freeSpin).toBe(true);
    expect(paid.payout).toBe(0);
    expect(ctx.ether.balanceOf("u1")).toBe(9_000);

    const free = spinOnce(ctx.services, "u1", bet, "int-1", 1);
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

    const paid = spinOnce(ctx.services, "u1", bet, "int-1", 0);
    const free = spinOnce(ctx.services, "u1", bet, "int-1", 1);
    const balanceAfter = ctx.ether.balanceOf("u1");

    // 再実行: リール・役・フリースピン獲得・配当のすべてが保存済みの値で返る
    expect(spinOnce(ctx.services, "u1", bet, "int-1", 0)).toEqual(paid);
    expect(spinOnce(ctx.services, "u1", bet, "int-1", 1)).toEqual(free);
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
