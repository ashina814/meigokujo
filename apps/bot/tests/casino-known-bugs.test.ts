import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  EtherExchange,
  EventLog,
  HOUSE_HOLDER,
  Items,
  Ledger,
  Vip,
  CRASH_MAX_MULT_CAP,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { spinOnce } from "../src/casino/slots.js";
import { cashOutMultiplier } from "../src/casino/crash.js";
import { MAX_BET, MIN_BET, checkRetry, effectiveMaxBet } from "../src/casino/common.js";
import { asobuCommand } from "../src/commands/asobu.js";
import { shobuCommand } from "../src/commands/shobu.js";

registerDefaultTxTypes();

/**
 * PR3（既知バグ一括）の回帰テスト。各バグに1本ずつ。
 *
 * どれも「気づかないまま金額や表示がずれる」種類の欠陥なので、
 * 直したことより**元の壊れ方を再現する条件でテストを書く**ことを優先している。
 */

function setup(rng: CasinoRng = scriptedRng([0.5])) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const items = new Items(db);
  const casino = new Casino(db, ether, events, { items });
  const vip = new Vip(db, ether, events);
  const services = { db, ether, casino, items, vip, rng, events } as unknown as Services;
  return { db, chipTx, ether, casino, items, vip, events, services };
}

function seedBalance(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

/** scriptedRng の値 → スロットの絵柄。0.98 = ✨魂片（3つでフリースピン）／0.85 = 👑王冠（3つで25倍） */
const SCATTER = 0.98;
const CROWN = 0.85;

describe("① クラッシュの払戻が上限でクランプされる", () => {
  it("31秒以上粘っても払戻倍率が CRASH_MAX_MULT_CAP を超えない", () => {
    // 成長率 0.00015/ms。100倍に到達するのは exp(0.00015t)=100 → t≒30,701ms
    const tTo100x = Math.log(CRASH_MAX_MULT_CAP) / 0.00015;
    // 崩壊点は上限よりずっと上（＝クランプが効かなければ倍率は伸び続ける）
    const farCrash = 10_000;

    expect(cashOutMultiplier(tTo100x - 1, farCrash)).toBeLessThanOrEqual(CRASH_MAX_MULT_CAP);
    expect(cashOutMultiplier(tTo100x + 1_000, farCrash)).toBe(CRASH_MAX_MULT_CAP);
    // 60秒粘れば素の指数は 8,000 倍を超えるが、払戻は上限のまま
    expect(Math.exp(0.00015 * 60_000)).toBeGreaterThan(8_000);
    expect(cashOutMultiplier(60_000, farCrash)).toBe(CRASH_MAX_MULT_CAP);
  });

  it("上限より手前では従来どおり実時間の倍率で、崩壊点も超えない", () => {
    expect(cashOutMultiplier(10_000, 10_000)).toBeCloseTo(Math.floor(Math.exp(1.5) * 100) / 100, 2);
    // 崩壊点が上限より低ければ崩壊点で頭打ち（順序が入れ替わっても壊れない）
    expect(cashOutMultiplier(60_000, 3.5)).toBe(3.5);
    // 最低でも 1.0（元金割れの倍率を作らない）
    expect(cashOutMultiplier(0, 10)).toBe(1.0);
  });
});

describe("② VIP の賭け上限が到達可能", () => {
  it("/遊ぶ・/勝負 の賭けオプションに max_value が焼き込まれていない", () => {
    // 上限は利用者ごとに違うので、全員共通のコマンド定義に入れてはいけない
    const betOptions = [asobuCommand, shobuCommand].flatMap((cmd) =>
      (cmd.toJSON().options ?? []).flatMap((sub) =>
        ((sub as { options?: Array<{ name: string; max_value?: number; min_value?: number }> }).options ?? []).filter(
          (o) => o.name === "賭け" || o.name === "アンティ",
        ),
      ),
    );
    expect(betOptions.length).toBeGreaterThan(0);
    for (const o of betOptions) {
      expect(o.max_value).toBeUndefined();
      expect(o.min_value).toBe(MIN_BET);
    }
  });

  it("VIP は MAX_BET を超える額で「もう一回」が通り、非VIPは断られる", () => {
    const ctx = setup();
    const over = MAX_BET + 1;
    seedBalance(ctx.db, "vipper", over * 2);
    seedBalance(ctx.db, "normal", over * 2);
    ctx.db.prepare("INSERT INTO casino_vip (user_id, expires_at) VALUES (?, ?)").run("vipper", 4_102_444_800);

    expect(effectiveMaxBet(ctx.services, "vipper")).toBe(MAX_BET * 2);
    expect(effectiveMaxBet(ctx.services, "normal")).toBe(MAX_BET);

    expect(checkRetry(ctx.services, "vipper", over)).toEqual({ ok: true, bet: over });
    const denied = checkRetry(ctx.services, "normal", over);
    expect(denied.ok).toBe(false);
    ctx.db.close();
  });
});

describe("③ フリースピンの配当が黙って消えない", () => {
  it("胴元が払えないときは配当0で理由が残る（画面に出た額だけ増えないをやめる）", () => {
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    const bet = 1_000;
    seedBalance(ctx.db, "u1", 10_000);
    // 有料スピンぶんは払えるが、25倍のフリースピン配当には全く足りない胴元
    seedBalance(ctx.db, HOUSE_HOLDER, 5_000);

    const paid = spinOnce(ctx.services, "u1", bet, "int-1", 0);
    expect(paid.freeSpin).toBe(true);
    const before = ctx.ether.balanceOf("u1");

    const free = spinOnce(ctx.services, "u1", bet, "int-1", 1);
    expect(free.matched).toBe("王冠");
    // 払えない額は「払った」ことにしない
    expect(free.payout).toBe(0);
    expect(free.unpaid).toBe(bet * 25);
    expect(ctx.ether.balanceOf("u1")).toBe(before);
    // 記録の無い取引を作らない（明細は0行）
    expect(ctx.chipTx.listByGroup("slots:spin:u1:int-1:free:1")).toEqual([]);
    // 運営が後から気づける
    const logged = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_house_insufficient'")
      .get() as { n: number };
    expect(logged.n).toBe(1);
    ctx.db.close();
  });

  it("胴元が払えるときは従来どおり全額支払われる", () => {
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    seedBalance(ctx.db, "u1", 10_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);

    spinOnce(ctx.services, "u1", 1_000, "int-1", 0);
    const before = ctx.ether.balanceOf("u1");
    const free = spinOnce(ctx.services, "u1", 1_000, "int-1", 1);
    expect(free.payout).toBe(25_000);
    expect(free.unpaid).toBe(0);
    expect(ctx.ether.balanceOf("u1")).toBe(before + 25_000);
    ctx.db.close();
  });
});

describe("④ 賭場商店の購入が単一トランザクション", () => {
  it("付与に失敗したらエテルも減らない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 50_000);
    const before = ctx.ether.balanceOf("u1");
    const price = 5_000;

    // grant の途中で落ちる状況を作る（購入経路と同じ形のグループ）
    expect(() =>
      ctx.ether.runGroup({ groupKey: "shop:buy:u1:x:1", kind: "shop", actorId: "u1" }, () => {
        ctx.ether.transfer("u1", HOUSE_HOLDER, price, { reason: "賭場商店での購入: x" });
        throw new Error("grant 失敗");
      }),
    ).toThrow("grant 失敗");

    expect(ctx.ether.balanceOf("u1")).toBe(before);
    expect(ctx.chipTx.getGroup("shop:buy:u1:x:1")).toBeUndefined();
    expect(ctx.chipTx.listByGroup("shop:buy:u1:x:1")).toEqual([]);
    ctx.db.close();
  });

  it("成功した購入は徴収と付与が両方残る", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 50_000);
    const key = "amulet_test";
    ctx.ether.runGroup({ groupKey: "shop:buy:u1:ok:1", kind: "shop", actorId: "u1" }, () => {
      ctx.ether.transfer("u1", HOUSE_HOLDER, 5_000, { reason: `賭場商店での購入: ${key}` });
      ctx.items.grant("u1", key, 1);
    });
    expect(ctx.ether.balanceOf("u1")).toBe(45_000);
    expect(ctx.items.inventory("u1").find((i) => i.key === key)?.quantity).toBe(1);
    ctx.db.close();
  });
});

describe("⑤ 通算損益が total_earned − total_lost", () => {
  it("勝った回の賭け額を二重に引かない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 100_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);

    // 勝ち（1,000 賭けて 3,000 受取 → 純 +2,000）と負け（1,000 賭けて 0 → 純 −1,000）
    ctx.casino.settleSolo("u1", "テスト", 1_000, 3_000, { chain: false, fuku: false, operationId: "win" });
    ctx.casino.settleSolo("u1", "テスト", 1_000, 0, { chain: false, fuku: false, operationId: "lose" });

    const s = ctx.casino.stats("u1");
    expect(s.total_earned).toBe(2_000);
    expect(s.total_lost).toBe(1_000);
    // 実際の純損益 = +2,000 − 1,000 = +1,000
    expect(s.total_earned - s.total_lost).toBe(1_000);
    // 旧式（total_earned − total_wagered）だと 2,000 − 2,000 = 0 で、勝ち分が消えていた
    expect(s.total_earned - s.total_wagered).toBe(0);
    ctx.db.close();
  });

  it("引き分けはどちらにも積まない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 100_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    ctx.casino.settleSolo("u1", "テスト", 1_000, 1_000, { chain: false, fuku: false, operationId: "push" });
    const s = ctx.casino.stats("u1");
    expect(s.total_earned).toBe(0);
    expect(s.total_lost).toBe(0);
    ctx.db.close();
  });
});

describe("⑥ リトライの拒否に理由がつく", () => {
  it("範囲外・残高不足のどちらも理由つきで断る（黙って return しない）", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 10_000);

    const tooSmall = checkRetry(ctx.services, "u1", MIN_BET - 1);
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.ok === false && tooSmall.reason.length).toBeGreaterThan(0);

    const tooBig = checkRetry(ctx.services, "u1", MAX_BET + 1);
    expect(tooBig.ok).toBe(false);

    const broke = checkRetry(ctx.services, "u1", 20_000);
    expect(broke.ok).toBe(false);
    expect(broke.ok === false && broke.reason).toContain("所持");

    expect(checkRetry(ctx.services, "u1", 5_000)).toEqual({ ok: true, bet: 5_000 });
    ctx.db.close();
  });
});
