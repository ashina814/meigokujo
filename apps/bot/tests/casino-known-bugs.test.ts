import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  EtherExchange,
  Escrow,
  EventLog,
  FreeSpins,
  HOUSE_HOLDER,
  Items,
  Ledger,
  Markets,
  Vip,
  CRASH_MAX_MULT_CAP,
  getConsumableDef,
  isPlayerHolder,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { FreeSpinUnpayableError, resolveFreeSpin, resumePendingFreeSpins, spinPaid } from "../src/casino/slots.js";
import { cashOutMultiplier } from "../src/casino/crash.js";
import {
  MAX_BET,
  MIN_BET,
  acquireSeat,
  checkRetry,
  effectiveMaxBet,
  handleRetryPress,
  releaseSeat,
} from "../src/casino/common.js";
import { buyConsumable } from "../src/commands/bakuten.js";
import { collectStakes, refundAll, settlePvp } from "../src/casino/pvp-common.js";
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
  return rebuild(openDb(":memory:"), rng);
}

/**
 * 同じ DB の上にサービス一式を**もう一度**組み立てる。
 *
 * 本番の `buildServices()` と同じ形なので、これを呼ぶこと自体が
 * 「プロセスが落ちて再起動した」の模擬になる（DB に残っていない状態は当然消える）。
 */
function rebuild(db: ReturnType<typeof openDb>, rng: CasinoRng = scriptedRng([0.5])) {
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const items = new Items(db);
  const casino = new Casino(db, ether, events, { items });
  const vip = new Vip(db, ether, events);
  // 本番（services.ts）と同じ配線。**確定精算のときだけ**通算損益へ足す
  const recordPlayerNet = (userId: string, net: number) => {
    if (isPlayerHolder(userId)) casino.recordGameNet(userId, net);
  };
  const escrow = new Escrow(db, ether, events, { onPlayerNet: recordPlayerNet });
  const markets = new Markets(db, ether, events, { onPlayerNet: recordPlayerNet });
  const freeSpins = new FreeSpins(db);
  const services = { db, ether, casino, items, vip, escrow, markets, freeSpins, rng, events } as unknown as Services;
  return { db, chipTx, ether, casino, items, vip, escrow, markets, freeSpins, events, services };
}

function seedBalance(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

/** 商店テストで使う実在の商品（価格・付与のふるまいを商品定義から引く） */
const CONSUMABLE_KEY = "omamori";

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

  /**
   * 上限は「ちょうど」と「+1」で挙動が変わるのが唯一の正解なので、境界だけを並べて押さえる。
   * VIP の有効/期限切れもここで一緒に見る（期限切れが通常上限に落ちないと、
   * 一度でも VIP になった人が永久に2倍で張れてしまう）。
   */
  describe("賭け上限の境界値", () => {
    const FUTURE = 4_102_444_800; // 2100年
    const PAST = 1_000_000_000; // 2001年

    function boundaryCtx() {
      const ctx = setup();
      const rich = MAX_BET * 4;
      for (const u of ["vip_active", "vip_expired", "plain"]) seedBalance(ctx.db, u, rich);
      ctx.db.prepare("INSERT INTO casino_vip (user_id, expires_at) VALUES (?, ?)").run("vip_active", FUTURE);
      ctx.db.prepare("INSERT INTO casino_vip (user_id, expires_at) VALUES (?, ?)").run("vip_expired", PAST);
      return ctx;
    }

    it("有効VIPの上限は MAX_BET×2、期限切れVIPと通常は MAX_BET", () => {
      const ctx = boundaryCtx();
      expect(ctx.vip.isVip("vip_active")).toBe(true);
      expect(ctx.vip.isVip("vip_expired")).toBe(false);
      expect(effectiveMaxBet(ctx.services, "vip_active")).toBe(MAX_BET * 2);
      expect(effectiveMaxBet(ctx.services, "vip_expired")).toBe(MAX_BET);
      expect(effectiveMaxBet(ctx.services, "plain")).toBe(MAX_BET);
      ctx.db.close();
    });

    it("通常上限ちょうどは通り、+1 は断られる（通常・期限切れVIP）", () => {
      const ctx = boundaryCtx();
      for (const u of ["plain", "vip_expired"]) {
        expect(checkRetry(ctx.services, u, MAX_BET), `${u} ちょうど`).toEqual({ ok: true, bet: MAX_BET });
        expect(checkRetry(ctx.services, u, MAX_BET + 1).ok, `${u} +1`).toBe(false);
      }
      ctx.db.close();
    });

    it("有効VIPは通常上限+1が通り、VIP上限ちょうども通る", () => {
      const ctx = boundaryCtx();
      expect(checkRetry(ctx.services, "vip_active", MAX_BET + 1)).toEqual({ ok: true, bet: MAX_BET + 1 });
      expect(checkRetry(ctx.services, "vip_active", MAX_BET * 2)).toEqual({ ok: true, bet: MAX_BET * 2 });
      ctx.db.close();
    });

    it("有効VIPでも VIP上限+1 は断られる", () => {
      const ctx = boundaryCtx();
      const denied = checkRetry(ctx.services, "vip_active", MAX_BET * 2 + 1);
      expect(denied.ok).toBe(false);
      expect(denied.ok === false && denied.reason).toContain("VIP");
      ctx.db.close();
    });

    it("最低額ちょうどは通り、−1 は断られる", () => {
      const ctx = boundaryCtx();
      expect(checkRetry(ctx.services, "plain", MIN_BET)).toEqual({ ok: true, bet: MIN_BET });
      expect(checkRetry(ctx.services, "plain", MIN_BET - 1).ok).toBe(false);
      ctx.db.close();
    });
  });
});

describe("③ フリースピンの取りこぼしが起きない", () => {
  it("胴元が払えるときは全額支払われ、保留記録が settled になる", () => {
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    seedBalance(ctx.db, "u1", 10_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);

    const paid = spinPaid(ctx.services, "u1", 1_000, "int-1");
    const before = ctx.ether.balanceOf("u1");
    const free = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    expect(free.payout).toBe(25_000);
    expect(ctx.ether.balanceOf("u1")).toBe(before + 25_000);
    expect(ctx.freeSpins.get(paid.pendingFreeSpin!.id)!.status).toBe("settled");
    expect(ctx.freeSpins.pendingCount()).toBe(0);
    ctx.db.close();
  });

  it("胴元が払えないときは権利を残したまま巻き戻す（配当0で完了扱いにしない）", () => {
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    const bet = 1_000;
    seedBalance(ctx.db, "u1", 10_000);
    // 有料スピンぶんは払えるが、25倍のフリースピン配当には全く足りない胴元
    seedBalance(ctx.db, HOUSE_HOLDER, 5_000);

    const paid = spinPaid(ctx.services, "u1", bet, "int-1");
    expect(paid.freeSpin).toBe(true);
    const before = ctx.ether.balanceOf("u1");

    expect(() => resolveFreeSpin(ctx.services, paid.pendingFreeSpin!)).toThrow(FreeSpinUnpayableError);

    expect(ctx.ether.balanceOf("u1")).toBe(before);
    // 記録の無い取引を作らない（明細も group も残らない）
    expect(ctx.chipTx.listByGroup("slots:spin:u1:int-1:free:1")).toEqual([]);
    expect(ctx.chipTx.getGroup("slots:spin:u1:int-1:free:1")).toBeUndefined();
    // **権利は消えていない**
    expect(ctx.freeSpins.get(paid.pendingFreeSpin!.id)!.status).toBe("pending");
    // 運営が後から気づける
    const logged = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_house_insufficient'")
      .get() as { n: number };
    expect(logged.n).toBe(1);

    // 胴元に資金が戻れば、同じ出目で払える
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    const free = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    expect(free.matched).toBe("王冠");
    expect(free.payout).toBe(bet * 25);
    expect(ctx.ether.balanceOf("u1")).toBe(before + bet * 25);
    ctx.db.close();
  });
});

/**
 * レビュー指摘の本体。有料スピンとフリースピンは別 group なので、
 * 「有料が settled → 演出中に落ちる」で無料スピン権が消えていた。
 * 権利を DB に持たせて、プロセスの寿命と切り離す。
 */
describe("③b フリースピン権はプロセスをまたいで残る", () => {
  const REELS = [SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN];

  it("有料スピン確定直後にプロセスが落ちても、再構築したサービスから同じ無料スピンを再開できる", () => {
    const ctx = setup(scriptedRng(REELS));
    seedBalance(ctx.db, "u1", 10_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);

    const paid = spinPaid(ctx.services, "u1", 1_000, "int-1");
    expect(paid.pendingFreeSpin).not.toBeNull();
    const balanceAfterPaid = ctx.ether.balanceOf("u1");

    // ── ここでプロセスが落ちたとみなす。同じ DB から**別のサービス一式**を組み直す ──
    const restarted = rebuild(ctx.db, scriptedRng([0.01, 0.01, 0.01])); // 乱数は別物にしておく

    const pending = restarted.freeSpins.listPending("u1");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.operationId).toBe("int-1");
    expect(pending[0]!.bet).toBe(1_000);
    expect(pending[0]!.sourceGroup).toBe("slots:spin:u1:int-1:paid");

    const free = resolveFreeSpin(restarted.services, pending[0]!);
    // 出目は獲得時に確定・保存してあるので、乱数を差し替えても同じ
    expect(free.reels).toEqual(paid.pendingFreeSpin!.reels);
    expect(free.matched).toBe("王冠");
    expect(free.payout).toBe(25_000);
    expect(restarted.ether.balanceOf("u1")).toBe(balanceAfterPaid + 25_000);
    ctx.db.close();
  });

  it("同じ無料スピンを二度処理しても一度しか払わない", () => {
    const ctx = setup(scriptedRng(REELS));
    seedBalance(ctx.db, "u1", 10_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);

    const paid = spinPaid(ctx.services, "u1", 1_000, "int-1");
    const first = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    const after = ctx.ether.balanceOf("u1");

    // 再開経路からもう一度・別サービスからもう一度
    const restarted = rebuild(ctx.db, scriptedRng([0.5]));
    const second = resolveFreeSpin(restarted.services, paid.pendingFreeSpin!);
    resumePendingFreeSpins(restarted.services);

    expect(second).toEqual(first);
    expect(restarted.ether.balanceOf("u1")).toBe(after);
    expect(restarted.chipTx.listByGroup("slots:spin:u1:int-1:free:1")).toHaveLength(1);
    ctx.db.close();
  });

  it("賭場が停止中は動かず、権利だけ残る", () => {
    const ctx = setup(scriptedRng(REELS));
    seedBalance(ctx.db, "u1", 10_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    const paid = spinPaid(ctx.services, "u1", 1_000, "int-1");
    const before = ctx.ether.balanceOf("u1");

    // 賭場を閉じる（資金グループそのものが作れなくなる＝本番と同じ止め方）
    ctx.chipTx.setClosedReason(() => "テストで閉場中");

    expect(() => resolveFreeSpin(ctx.services, paid.pendingFreeSpin!)).toThrow();
    expect(ctx.ether.balanceOf("u1")).toBe(before);
    expect(ctx.freeSpins.get(paid.pendingFreeSpin!.id)!.status).toBe("pending");

    // 再開後に払える
    ctx.chipTx.setClosedReason(() => null);
    const free = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    expect(free.payout).toBe(25_000);
    expect(ctx.ether.balanceOf("u1")).toBe(before + 25_000);
    ctx.db.close();
  });

  it("起動時の一括再開で払われ、払えなかったぶんは権利が残る", () => {
    const ctx = setup(scriptedRng(REELS));
    seedBalance(ctx.db, "u1", 10_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    spinPaid(ctx.services, "u1", 1_000, "int-1");

    // 胴元を空にして起動 → 払えないので権利が残る
    seedBalance(ctx.db, HOUSE_HOLDER, 0);
    let boot = rebuild(ctx.db, scriptedRng([0.5]));
    let r = resumePendingFreeSpins(boot.services);
    expect(r.total).toBe(1);
    expect(r.settled).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(boot.freeSpins.pendingCount()).toBe(1);

    // 資金を入れてもう一度起動 → 払われる
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    boot = rebuild(ctx.db, scriptedRng([0.5]));
    r = resumePendingFreeSpins(boot.services);
    expect(r.settled).toBe(1);
    expect(r.paid).toBe(25_000);
    expect(boot.freeSpins.pendingCount()).toBe(0);
    ctx.db.close();
  });
});

/**
 * 購入経路そのもの（`buyConsumable`）を通す。テストの中で runGroup → transfer → grant を
 * 組み直すと「テストが正しい形を知っている」だけになり、UI 側が別の形で書いていても気づけない。
 * `handleBakutenSelect` はこの関数を呼ぶだけなので、ここが実経路になる。
 */
describe("④ 賭場商店の購入が単一トランザクション", () => {
  /** 実在する商品を1つ使う（価格・キーは商品定義から取る） */
  const ITEM = CONSUMABLE_KEY;
  const PRICE = getConsumableDef(CONSUMABLE_KEY)!.price;

  it("付与に失敗したら代金・在庫・group・明細がすべて戻る", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", PRICE * 10);
    const before = ctx.ether.balanceOf("u1");

    // 付与の途中で落ちる状況を作る（購入サービスの内側で投げる）
    const realGrant = ctx.items.grant.bind(ctx.items);
    ctx.items.grant = () => {
      throw new Error("grant 失敗");
    };
    expect(() => buyConsumable(ctx.services, "u1", ITEM, "op-fail")).toThrow("grant 失敗");
    ctx.items.grant = realGrant;

    const groupKey = `shop:buy:u1:${ITEM}:op-fail`;
    expect(ctx.ether.balanceOf("u1")).toBe(before);
    expect(ctx.items.inventory("u1").find((i) => i.key === ITEM)?.quantity ?? 0).toBe(0);
    expect(ctx.chipTx.getGroup(groupKey)).toBeUndefined();
    expect(ctx.chipTx.listByGroup(groupKey)).toEqual([]);
    ctx.db.close();
  });

  it("成功した購入は徴収と付与が同じ group に入る", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", PRICE * 10);
    const r = buyConsumable(ctx.services, "u1", ITEM, "op-ok");

    expect(r.ok).toBe(true);
    expect(ctx.ether.balanceOf("u1")).toBe(PRICE * 10 - PRICE);
    expect(ctx.items.inventory("u1").find((i) => i.key === ITEM)?.quantity).toBe(1);
    // 徴収の明細がこの group に載っている（group 無しの取引を作っていない）
    const rows = ctx.chipTx.listByGroup(r.groupKey);
    expect(rows.length).toBe(1);
    expect(rows[0]!.to_holder).toBe(HOUSE_HOLDER);
    expect(rows[0]!.amount).toBe(PRICE);
    expect(ctx.chipTx.getGroup(r.groupKey)?.status).toBe("settled");
    ctx.db.close();
  });

  it("同じ interaction ID の再送で二重課金・二重付与しない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", PRICE * 10);

    const first = buyConsumable(ctx.services, "u1", ITEM, "same-op");
    const second = buyConsumable(ctx.services, "u1", ITEM, "same-op");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.groupKey).toBe(first.groupKey);
    // 1回ぶんしか動いていない
    expect(ctx.ether.balanceOf("u1")).toBe(PRICE * 10 - PRICE);
    expect(ctx.items.inventory("u1").find((i) => i.key === ITEM)?.quantity).toBe(1);
    expect(ctx.chipTx.listByGroup(first.groupKey).length).toBe(1);
    ctx.db.close();
  });

  it("残高不足は資金を動かさずに ok:false（例外にしない）", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", PRICE - 1);
    const r = buyConsumable(ctx.services, "u1", ITEM, "op-broke");
    expect(r.ok).toBe(false);
    expect(r.held).toBe(PRICE - 1);
    expect(ctx.ether.balanceOf("u1")).toBe(PRICE - 1);
    expect(ctx.items.inventory("u1").find((i) => i.key === ITEM)?.quantity ?? 0).toBe(0);
    ctx.db.close();
  });
});

/**
 * 通算損益 = total_earned − total_lost が、**その利用者の賭場残高の増減と一致する**ことを見る。
 * 個々の内訳ではなく「残高が幾ら動いたか」を突き合わせるので、
 * 数え漏らし（連鎖ボーナス・福の重み・フリースピン・JP）はここで落ちる。
 */
describe("⑤ 通算損益がゲーム由来の実現損益と一致する", () => {
  const netOf = (ctx: ReturnType<typeof setup>, uid: string) => {
    const s = ctx.casino.stats(uid);
    return s.total_earned - s.total_lost;
  };

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
    expect(netOf(ctx, "u1")).toBe(1_000);
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

  it("連鎖ボーナスと福の重みを含めて残高の増減と一致する", () => {
    const ctx = setup();
    // 福の重みが効く残高（scale=10 の既定で 100,000 超なら 10%）
    seedBalance(ctx.db, "u1", 2_000_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 10_000_000);
    const before = ctx.ether.balanceOf("u1");

    // 連勝を積んでから勝つ（2連勝目から連鎖倍率が乗る）
    for (let i = 0; i < 3; i++) {
      ctx.casino.settleSolo("u1", "テスト", 1_000, 2_000, { operationId: `w${i}` });
    }
    const r = ctx.casino.settleSolo("u1", "テスト", 10_000, 30_000, { operationId: "big" });
    expect(r.chainBonus).toBeGreaterThan(0);
    expect(r.fukuTax).toBeGreaterThan(0);

    const after = ctx.ether.balanceOf("u1");
    // 残高の増減と通算損益が 1 Ld も違わない
    expect(netOf(ctx, "u1")).toBe(after - before);
    ctx.db.close();
  });

  it("フリースピンの配当と JP 当選が通算損益に載る", () => {
    const ctx = setup(scriptedRng([SCATTER, SCATTER, SCATTER, CROWN, CROWN, CROWN]));
    seedBalance(ctx.db, "u1", 100_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 10_000_000);
    const before = ctx.ether.balanceOf("u1");

    const paid = spinPaid(ctx.services, "u1", 1_000, "int-1");
    expect(paid.freeSpin).toBe(true);
    const free = resolveFreeSpin(ctx.services, paid.pendingFreeSpin!);
    expect(free.payout).toBe(25_000);

    // JP 当選（賭けを伴わない払い出し）
    ctx.ether.runGroup({ groupKey: "seed:jp", kind: "solo_game", actorId: "sys" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, "jackpot", 50_000, { reason: "JPシード" }),
    );
    const won = ctx.casino.seizeJackpot("u1", "スロット", "jp-1", 1);
    expect(won).toBeGreaterThan(0);

    const after = ctx.ether.balanceOf("u1");
    expect(netOf(ctx, "u1")).toBe(after - before);
    // 試合数は有料スピンの1回だけ（フリースピンと JP で水増ししない）
    expect(ctx.casino.stats("u1").games).toBe(1);
    ctx.db.close();
  });

  it("冪等な再試行では損益が動かない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 100_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);

    ctx.casino.settleSolo("u1", "テスト", 1_000, 3_000, { chain: false, fuku: false, operationId: "same" });
    const once = ctx.casino.stats("u1");
    ctx.casino.settleSolo("u1", "テスト", 1_000, 3_000, { chain: false, fuku: false, operationId: "same" });
    const twice = ctx.casino.stats("u1");

    expect(twice.total_earned).toBe(once.total_earned);
    expect(twice.total_lost).toBe(once.total_lost);
    expect(twice.games).toBe(once.games);
    ctx.db.close();
  });

  it("対人戦の純損益と場代が通算損益に載り、不成立返金では動かない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "winner", 100_000);
    seedBalance(ctx.db, "loser", 100_000);
    const wBefore = ctx.ether.balanceOf("winner");
    const lBefore = ctx.ether.balanceOf("loser");
    const bet = 10_000;

    expect(collectStakes(ctx.services, ["winner", "loser"], bet, "op-1", "sess-1", "テスト対人")).toBe(true);
    const { payout, houseCut } = settlePvp(ctx.services, ["winner"], bet * 2, "op-1", "sess-1");
    expect(houseCut).toBe(Math.floor(bet * 2 * 0.03));
    expect(payout).toBe(bet * 2 - houseCut);

    // 勝者は「+相手の賭け − 場代」、敗者は「−賭け額」。どちらも残高の増減と一致する
    expect(netOf(ctx, "winner")).toBe(ctx.ether.balanceOf("winner") - wBefore);
    expect(netOf(ctx, "loser")).toBe(ctx.ether.balanceOf("loser") - lBefore);
    expect(netOf(ctx, "loser")).toBe(-bet);
    expect(netOf(ctx, "winner")).toBe(bet - houseCut);

    // 不成立返金は差引0
    expect(collectStakes(ctx.services, ["winner"], bet, "op-2", "sess-2", "テスト対人")).toBe(true);
    refundAll(ctx.services, ["winner"], bet, "op-2", "sess-2");
    expect(netOf(ctx, "winner")).toBe(bet - houseCut);
    ctx.db.close();
  });

  /**
   * レビュー指摘: 預託時に −stake、返金時に +stake を記録していたので、
   * 「対局中なのに通算負けが増える」「全額返金なのに earned と lost が両方膨らむ」。
   * 記録は**確定精算のときだけ**にする。
   */
  it("預託しただけでは通算損益が動かない（対局中に負けが増えない）", () => {
    const ctx = setup();
    seedBalance(ctx.db, "a", 100_000);
    seedBalance(ctx.db, "b", 100_000);

    expect(collectStakes(ctx.services, ["a", "b"], 10_000, "op-1", "sess-1", "テスト対人")).toBe(true);
    // 卓は立っているが、まだ何も確定していない
    for (const u of ["a", "b"]) {
      const s = ctx.casino.stats(u);
      expect(s.total_earned, u).toBe(0);
      expect(s.total_lost, u).toBe(0);
    }
    ctx.db.close();
  });

  it("全額返金では total_earned も total_lost も膨らまない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "a", 100_000);
    seedBalance(ctx.db, "b", 100_000);

    collectStakes(ctx.services, ["a", "b"], 10_000, "op-1", "sess-1", "テスト対人");
    refundAll(ctx.services, ["a", "b"], 10_000, "op-1", "sess-1");

    for (const u of ["a", "b"]) {
      const s = ctx.casino.stats(u);
      expect(s.total_earned, u).toBe(0);
      expect(s.total_lost, u).toBe(0);
      expect(ctx.ether.balanceOf(u), u).toBe(100_000);
    }
    ctx.db.close();
  });

  it("起動時の孤児返金でも通算損益が動かない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "a", 100_000);
    collectStakes(ctx.services, ["a"], 10_000, "op-1", "sess-1", "テスト対人");

    // 再起動して孤児として返金される経路
    const boot = rebuild(ctx.db);
    boot.escrow.sweepAll("system:startup");

    expect(boot.ether.balanceOf("a")).toBe(100_000);
    const s = boot.casino.stats("a");
    expect(s.total_earned).toBe(0);
    expect(s.total_lost).toBe(0);
    ctx.db.close();
  });

  it("板（予想市場）の確定精算も通算損益に載る", () => {
    const ctx = setup();
    seedBalance(ctx.db, "hit", 100_000);
    seedBalance(ctx.db, "miss", 100_000);
    seedBalance(ctx.db, HOUSE_HOLDER, 1_000_000);
    const hitBefore = ctx.ether.balanceOf("hit");
    const missBefore = ctx.ether.balanceOf("miss");

    const m = ctx.markets.create({
      guildId: "g", creatorId: "admin", title: "テスト板",
      options: ["A", "B"], durationMin: 60, payoutMode: "parimutuel", fee: 0, operationId: "m1",
    });
    ctx.markets.bet(m.id, "hit", 0, 10_000, "b1");
    ctx.markets.bet(m.id, "miss", 1, 10_000, "b2");
    // 張っただけでは動かない
    expect(ctx.casino.stats("hit").total_earned).toBe(0);
    expect(ctx.casino.stats("miss").total_lost).toBe(0);

    // 締切 → 結果報告 → 参加者全員が承認 → 精算
    ctx.markets.close(m.id, "admin");
    ctx.markets.report(m.id, "admin", 0, true);
    ctx.markets.approve(m.id, "hit");
    const done = ctx.markets.approve(m.id, "miss");
    expect(done.settled).not.toBeNull();

    expect(netOf(ctx, "hit")).toBe(ctx.ether.balanceOf("hit") - hitBefore);
    expect(netOf(ctx, "miss")).toBe(ctx.ether.balanceOf("miss") - missBefore);
    expect(netOf(ctx, "miss")).toBe(-10_000);
    expect(netOf(ctx, "hit")).toBeGreaterThan(0);
    ctx.db.close();
  });

  it("VIP・商店の支出は通算損益に入れない", () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 500_000);
    const price = getConsumableDef(CONSUMABLE_KEY)!.price;

    buyConsumable(ctx.services, "u1", CONSUMABLE_KEY, "shop-op");
    ctx.vip.join("u1", "vip-op");

    expect(ctx.ether.balanceOf("u1")).toBeLessThan(500_000 - price + 1);
    // 賭けていないので戦績は空のまま
    const s = ctx.casino.stats("u1");
    expect(s.total_earned).toBe(0);
    expect(s.total_lost).toBe(0);
    ctx.db.close();
  });
});

describe("⑥ リトライは断っても押し直せる", () => {
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

  /**
   * 純関数 `checkRetry` のテストだけでは足りない。壊れていたのは**順序**で、
   * 「先に collector を止めてから断る」と、ボタンは残っているのに二度と反応しない。
   * 全ゲームの retry ボタンは `handleRetryPress` を呼ぶだけなので、ここが実ハンドラになる。
   */
  function fakeButton(uid: string) {
    const calls = { reply: [] as string[], followUp: [] as string[], deferUpdate: 0 };
    return {
      calls,
      btn: {
        user: { id: uid },
        reply: async (p: { content?: string }) => {
          calls.reply.push(p.content ?? "");
        },
        followUp: async (p: { content?: string }) => {
          calls.followUp.push(p.content ?? "");
        },
        deferUpdate: async () => {
          calls.deferUpdate++;
        },
      },
    };
  }

  function fakeCollector() {
    const stopped: string[] = [];
    return { stopped, collector: { stop: (reason?: string) => stopped.push(reason ?? "") } };
  }

  it("断ったときは collector を止めない（もう一度押せる）", async () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 10_000);
    const { btn, calls } = fakeButton("u1");
    const { collector, stopped } = fakeCollector();
    const ran: number[] = [];

    // 1回目: 所持を超える額 → 断られる
    await handleRetryPress({
      services: ctx.services,
      btn: btn as never,
      collector,
      betRaw: 999_999,
      run: async (bet) => void ran.push(bet),
    });
    expect(calls.reply.length).toBe(1);
    expect(ran).toEqual([]);
    expect(stopped).toEqual([]); // ← ここが本題。止めていたら次の押下が無応答になる
    expect(calls.deferUpdate).toBe(0);

    // 2回目: 押し直せば通る
    await handleRetryPress({
      services: ctx.services,
      btn: btn as never,
      collector,
      betRaw: 5_000,
      run: async (bet) => void ran.push(bet),
    });
    expect(ran).toEqual([5_000]);
    expect(stopped).toEqual(["retry"]);
    expect(calls.deferUpdate).toBe(1);
    ctx.db.close();
  });

  it("受け付けたときだけ collector を止め、座席を返してから回す", async () => {
    const ctx = setup();
    seedBalance(ctx.db, "u1", 10_000);
    const { btn, calls } = fakeButton("u1");
    const { collector, stopped } = fakeCollector();
    let seatDuringRun = false;

    await handleRetryPress({
      services: ctx.services,
      btn: btn as never,
      collector,
      betRaw: 1_000,
      // 本体の実行中は座席が確保されている（＝二重起動を防げている）
      run: async () => void (seatDuringRun = !acquireSeat("u1")),
    });

    expect(stopped).toEqual(["retry"]);
    expect(calls.deferUpdate).toBe(1);
    expect(seatDuringRun).toBe(true);
    // 本体が終われば座席は返っている
    expect(acquireSeat("u1")).toBe(true);
    releaseSeat("u1");
    ctx.db.close();
  });

  it("どのゲームも retry の中で collector を直接止めていない", () => {
    // 順序を各ゲームで書き直せてしまうと、また同じ壊し方に戻る。
    // 停止は handleRetryPress の中だけ、という構造をここで固定する
    const dir = fileURLToPath(new URL("../src/casino/", import.meta.url));
    for (const f of ["slots", "crash", "blackjack", "chinchiro", "chohan", "poker", "holdem"]) {
      const src = readFileSync(`${dir}${f}.ts`, "utf8");
      expect(src.includes("handleRetryPress"), `${f}: 共通処理を通していない`).toBe(true);
      expect(src.includes('stop("retry")'), `${f}: retry で collector を直接止めている`).toBe(false);
    }
  });
});
