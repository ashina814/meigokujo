import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { CasinoChipFlow } from "../src/casino/chip-flow.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * 正規の入れ子グループを検算Bが説明できるか。
 *
 * `ChipTx.runGroup()` は入れ子の呼び出しを外側グループへ合流させる。つまり
 * 賭場商店の購入やランク卓の着席の中で自動預入が動くと、`casino_tx.group_key` は
 * **業務操作のキー**になり、Land 取引の冪等キー（`chip:auto-deposit:*`）とは別物になる。
 * 旧実装はこの2つの一致を要求していたため、正規の入れ子で必ず止まった
 * （本番 tx#3306 / ランク卓着席）。
 *
 * ここで固定するのは「入れ子を許す」ことではなく、**何をもって説明可能とするか**:
 * 操作キーは Land 取引と 1:1、金額・holder・actor・種別・版・グループ確定はそのまま、
 * 入れ子を許す業務種別は列挙したものだけ。
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow);
  const chipFlow = new CasinoChipFlow(db, chips, events);
  openFormally(chipTx, ledger);
  return { db, ledger, events, chipTx, chips, escrow, integrity, chipFlow };
}

type Ctx = ReturnType<typeof setup>;

function fundUser(ctx: Ctx, userId: string, land: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount: land,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: `seed:${userId}:${land}:${Math.random()}`,
  });
}

const checkB = (ctx: Ctx) => ctx.integrity.checkB();
const notes = (ctx: Ctx) => checkB(ctx).mismatches.map((m) => m.note);

/** Land を動かした最後の明細 */
function lastLandDetail(ctx: Ctx) {
  return ctx.db
    .prepare("SELECT * FROM casino_tx WHERE ledger_tx_id IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get() as { id: number; op_key: string; group_key: string; ledger_tx_id: number; actor_id: string };
}

describe("正常系: 検算Bが通る", () => {
  it("1) 単独の預入", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);

    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");

    expect(checkB(ctx).ok).toBe(true);
    ctx.db.close();
  });

  it("2) 単独の返還", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");

    ctx.chips.redeem("alice", 400, "chip:redeem:alice:1");

    expect(checkB(ctx).ok).toBe(true);
    ctx.db.close();
  });

  it("3) 賭場商店の購入（shop:buy）の中で動いた自動預入", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);

    // 本番の buyConsumable と同じ形: 外側 shop:buy の中で ensureFreeChips を呼ぶ
    ctx.chips.runGroup({ groupKey: "shop:buy:alice:item:op1", kind: "shop", actorId: "alice" }, () => {
      ctx.chipFlow.ensureFreeChips("alice", 800, "op1");
      ctx.chips.transfer("alice", HOUSE_HOLDER, 800, { reason: "賭場商店での購入: test" });
    });

    const detail = lastLandDetail(ctx);
    expect(detail.group_key).toBe("shop:buy:alice:item:op1"); // 外側へ合流している
    expect(detail.op_key).toBe("chip:auto-deposit:alice:op1"); // 操作は内側のまま残る
    expect(checkB(ctx).ok).toBe(true);
    ctx.db.close();
  });

  it("4) ランク卓の着席（table_hold）で自動預入したあと、通常の返還ができる", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 50_000);

    // 本番 tx#3306 と同じ形（ranked:join の中の chip:auto-deposit）
    ctx.chips.runGroup(
      { groupKey: "ranked:join:pt_1:alice:op9", kind: "table_hold", actorId: "alice" },
      () => {
        ctx.chipFlow.ensureFreeChips("alice", 30_900, "ranked-join-pt_1-alice-op9");
      },
    );
    expect(checkB(ctx).ok).toBe(true);

    ctx.chipFlow.redeemFreeChips("alice", "scheduler:1", "10分無操作");

    const b = checkB(ctx);
    expect(b.ok).toBe(true);
    expect(ctx.chips.pool()).toBe(ctx.chips.outstanding());
    ctx.db.close();
  });
});

describe("異常系: 検算Bが止める", () => {
  it("5) Landだけ手で準備口座へ入れる", () => {
    const ctx = setup();
    fundUser(ctx, "mallory", 5_000);

    ctx.ledger.transfer({
      from: "user:mallory",
      to: ctx.chips.reserveHolder(),
      amount: 1_000,
      type: "chip_deposit",
      actor: "user:mallory",
      approvedBy: "system:ether",
      reason: "賭場チップ預入",
      refType: "casino_chip",
      refId: "mallory",
      idempotencyKey: "chip:deposit:mallory:forged",
    });

    expect(notes(ctx)).toContain("no_matching_chip_tx");
    ctx.db.close();
  });

  it("6) casino_tx の明細を消す", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");

    ctx.db.prepare("DELETE FROM casino_tx WHERE ledger_tx_id IS NOT NULL").run();

    expect(notes(ctx)).toContain("no_matching_chip_tx");
    ctx.db.close();
  });

  it("7) 金額が食い違う", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");

    ctx.db.prepare("UPDATE casino_tx SET land_amount = 999 WHERE ledger_tx_id IS NOT NULL").run();

    expect(notes(ctx)).toContain("land_amount_mismatch");
    ctx.db.close();
  });

  it("8) actor / holder / 操作キーが食い違う", () => {
    for (const [column, value, note] of [
      ["op_actor_id", "user:mallory", "chip_tx_actor_mismatch"],
      ["to_holder", "mallory", "holder_mismatch"],
      ["op_key", "chip:deposit:alice:other", "op_key_mismatch"],
    ] as const) {
      const ctx = setup();
      fundUser(ctx, "alice", 5_000);
      ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");

      ctx.db.prepare(`UPDATE casino_tx SET ${column} = ? WHERE ledger_tx_id IS NOT NULL`).run(value);

      expect(notes(ctx)).toContain(note);
      ctx.db.close();
    }
  });

  it("9) 開始残高の版が食い違う", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");

    ctx.db.prepare("UPDATE casino_tx SET opening_version = 'opening_v2' WHERE ledger_tx_id IS NOT NULL").run();

    expect(notes(ctx)).toContain("chip_tx_version_mismatch");
    ctx.db.close();
  });

  it("10) グループが無い / 確定していない / 入れ子を許さない種別", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");
    const detail = lastLandDetail(ctx);

    ctx.db.prepare("UPDATE casino_tx_groups SET status='failed' WHERE group_key=?").run(detail.group_key);
    expect(notes(ctx)).toContain("group_not_settled:failed");

    ctx.db.prepare("UPDATE casino_tx_groups SET status='settled', kind='solo_game' WHERE group_key=?").run(detail.group_key);
    expect(notes(ctx)).toContain("group_kind_mismatch");

    // 入れ子だが、資金移動を起こしてよいと決めていない業務種別
    ctx.db
      .prepare("INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, created_at, settled_at) VALUES ('solo:1','solo_game','settled','user:alice',0,0)")
      .run();
    ctx.db.prepare("UPDATE casino_tx SET group_key='solo:1' WHERE id=?").run(detail.id);
    expect(notes(ctx)).toContain("group_kind_not_nestable:solo_game");

    // グループ行そのものが消えた場合（DB破損相当なので外部キーを外して作る）
    ctx.db.pragma("foreign_keys = OFF");
    ctx.db.prepare("DELETE FROM casino_tx_groups WHERE group_key='solo:1'").run();
    expect(notes(ctx)).toContain("no_chip_group");
    ctx.db.close();
  });

  it("11) 1つのLand取引に複数の明細がぶら下がる", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");
    const detail = lastLandDetail(ctx);

    // 操作キーは一意（部分UNIQUE索引）なので、別キーで二重にぶら下げる細工をする
    ctx.db
      .prepare(
        `INSERT INTO casino_tx (group_key, seq, tx_kind, to_holder, amount, reason, actor_id, opening_version,
                                land_amount, ledger_tx_id, created_at, op_key, op_actor_id)
         VALUES (?, 99, 'deposit', 'alice', 1000, '二重', 'user:alice', 'opening_v1', 1000, ?, 0, ?, 'user:alice')`,
      )
      .run(detail.group_key, detail.ledger_tx_id, "chip:deposit:alice:1:dup");

    expect(notes(ctx)).toContain("multiple_matching_chip_tx");
    ctx.db.close();
  });

  it("同じ操作キーで二度Landを動かせない（索引で書き込み時に弾く）", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    ctx.chips.deposit("alice", 1_000, "chip:deposit:alice:1");
    const detail = lastLandDetail(ctx);

    expect(() =>
      ctx.db
        .prepare(
          `INSERT INTO casino_tx (group_key, seq, tx_kind, to_holder, amount, reason, actor_id, opening_version,
                                  land_amount, ledger_tx_id, created_at, op_key, op_actor_id)
           VALUES (?, 98, 'deposit', 'alice', 1000, '二重', 'user:alice', 'opening_v1', 1000, ?, 0, ?, 'user:alice')`,
        )
        .run(detail.group_key, detail.ledger_tx_id, detail.op_key),
    ).toThrow(/UNIQUE/);
    ctx.db.close();
  });
});

describe("移行: 既存DBの入れ子明細を説明できるようにする", () => {
  it("op_key を持たない既存DBでも、移行後は検算Bが通る（本番 tx#3306 と同じ形）", () => {
    const dir = mkdtempSync(join(tmpdir(), "casino-op-key-"));
    const file = join(dir, "bot.db");
    try {
      // 1) 本番と同じ形のデータを作る: ランク卓着席の中で自動預入
      const ctx = { ...setup(), db: openDb(file) } as unknown as Ctx;
      const built = (() => {
        const db = ctx.db;
        const ledger = new Ledger(db);
        const events = new EventLog(db);
        const chipTx = new ChipTx(db);
        const chips = new ChipLedger(db, ledger, events, { chipTx });
        const escrow = new Escrow(db, chips, events);
        const chipFlow = new CasinoChipFlow(db, chips, events);
        openFormally(chipTx, ledger);
        const built = { db, ledger, events, chipTx, chips, escrow, chipFlow, integrity: new CasinoIntegrity(db, ledger, chips, escrow) };
        fundUser(built as unknown as Ctx, "alice", 50_000);
        chips.runGroup({ groupKey: "ranked:join:pt_1:alice:op1", kind: "table_hold", actorId: "alice" }, () => {
          chipFlow.ensureFreeChips("alice", 30_900, "ranked-join-pt_1-alice-op1");
        });
        return built;
      })();
      expect(built.integrity.checkB().ok).toBe(true);

      // 2) 移行前の状態へ戻す（op_key を持たない既存行）
      built.db.prepare("UPDATE casino_tx SET op_key = NULL, op_actor_id = NULL").run();
      built.db.close();

      // 3) 開き直す＝移行が走る
      const db = openDb(file);
      const ledger = new Ledger(db);
      const events = new EventLog(db);
      const chips = new ChipLedger(db, ledger, events, { chipTx: new ChipTx(db) });
      const integrity = new CasinoIntegrity(db, ledger, chips, new Escrow(db, chips, events));

      const nested = db
        .prepare("SELECT op_key, op_actor_id, group_key FROM casino_tx WHERE ledger_tx_id IS NOT NULL")
        .get() as { op_key: string; op_actor_id: string; group_key: string };
      expect(nested.op_key).toBe("chip:auto-deposit:alice:ranked-join-pt_1-alice-op1");
      expect(nested.op_actor_id).toBe("user:alice");
      expect(nested.group_key).toBe("ranked:join:pt_1:alice:op1");
      expect(integrity.checkB().ok).toBe(true);
      // 埋めた根拠は監査へ残す
      const audit = db
        .prepare("SELECT payload FROM outbox WHERE payload LIKE ? ORDER BY id DESC LIMIT 1")
        .get("%casino_tx_op_key_backfilled%") as { payload: string };
      expect(JSON.parse(audit.payload).nested).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
