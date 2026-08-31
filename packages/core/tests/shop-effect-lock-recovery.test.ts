import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * **収束は「所有者が死んでいる」と言えるときにしか鍵を触れない。**
 *
 * `held` は「落ちた」ではなく「いま実行しているかもしれない」。時間でも存在でも
 * 死は証明できないので、稼働中の巡回が横取りすると、実行中の worker と次の worker が
 * 同じ効果を二重に投げる——Task #214 が防ごうとしているものそのものになる。
 *
 * また、達成された状態は**操作によって逆**になる。add は「在れば達成」、
 * remove は「無ければ達成」。行に記録された `operation` で決める。
 */

registerDefaultTxTypes();
const GUILD = "g-main";
const USER = "u-rec";
const ROLE = "r-vip";
const KEY = Shop.discordRoleEffectKey(GUILD, USER, ROLE);

function setup() {
  const db = openDb(":memory:");
  const shop = new Shop(db, new Ledger(db), new EventLog(db));
  return { db, shop };
}
type Ctx = ReturnType<typeof setup>;

const acquire = (ctx: Ctx, operation: "add" | "remove", owner = "worker-1") =>
  ctx.shop.acquireExternalEffectLock({ scope: "discord_role", key: KEY, operation, owner });

const holder = (ctx: Ctx) => ctx.shop.externalEffectLockHolder(KEY);

// ── RF-A 生きている held は奪えない ──────────────────────────────────────────

describe("RF-A: 稼働中の held は横取りできない", () => {
  it("定期収束（includeHeld なし）は held に触れない", () => {
    const ctx = setup();
    const a = acquire(ctx, "add");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const before = holder(ctx)!;

    // 定期巡回が同じ資源を観測した（ロールはまだ無い）
    expect(ctx.shop.recoverExternalEffectLock({ key: KEY, observed: "absent", actor: "system:cron" })).toBe(false);

    const after = holder(ctx)!;
    expect(after.state).toBe("held");
    expect(after.owner_token).toBe(before.owner_token);
    expect(after.owner).toBe("worker-1");
    // 次の worker はまだ取れない＝二重実行が生まれない
    expect(acquire(ctx, "add", "worker-2").ok).toBe(false);
    ctx.db.close();
  });

  it("定期収束の一覧に held は出てこない", () => {
    const ctx = setup();
    acquire(ctx, "add");
    expect(ctx.shop.listUnresolvedExternalEffectLocks(50, ["uncertain"])).toHaveLength(0);
    expect(ctx.shop.listUnresolvedExternalEffectLocks(50, ["held", "uncertain"])).toHaveLength(1);
    ctx.db.close();
  });

  it("再起動境界（includeHeld）でだけ held を収束できる", () => {
    const ctx = setup();
    acquire(ctx, "add");
    expect(
      ctx.shop.recoverExternalEffectLock({ key: KEY, observed: "absent", actor: "system:startup", includeHeld: true }),
    ).toBe(true);
    expect(holder(ctx)).toBeUndefined();
    expect(acquire(ctx, "add", "worker-2").ok).toBe(true);
    ctx.db.close();
  });

  it("uncertain は稼働中でも収束してよい（所有者は確実性を手放している）", () => {
    const ctx = setup();
    const a = acquire(ctx, "add");
    if (!a.ok) return;
    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "?", actor: "worker-1" });
    expect(ctx.shop.recoverExternalEffectLock({ key: KEY, observed: "present", actor: "system:cron" })).toBe(true);
    expect(holder(ctx)).toBeUndefined();
    ctx.db.close();
  });
});

// ── RF-B / RF-C operation ごとの真理値表 ─────────────────────────────────────

describe("RF-B / RF-C: 達成の判定は operation で逆になる", () => {
  const cases: Array<{
    op: "add" | "remove";
    observed: "present" | "absent";
    expected: "settled" | "released";
  }> = [
    { op: "add", observed: "present", expected: "settled" },
    { op: "add", observed: "absent", expected: "released" },
    { op: "remove", observed: "absent", expected: "settled" },
    { op: "remove", observed: "present", expected: "released" },
  ];

  for (const c of cases) {
    it(`${c.op} + ${c.observed} -> ${c.expected}`, () => {
      const ctx = setup();
      const a = acquire(ctx, c.op);
      if (!a.ok) return;
      ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "?", actor: "w" });

      expect(ctx.shop.recoverExternalEffectLock({ key: KEY, observed: c.observed, actor: "sys" })).toBe(true);

      const row = ctx.db
        .prepare("SELECT state, operation FROM shop_external_effect_locks WHERE effect_key = ?")
        .get(KEY) as { state: string; operation: string };
      expect(row.operation).toBe(c.op);
      expect(row.state).toBe(c.expected);
      ctx.db.close();
    });
  }

  it("判定は呼び出し側ではなく行の operation を使う", () => {
    const ctx = setup();
    const a = acquire(ctx, "remove");
    if (!a.ok) return;
    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "?", actor: "w" });
    // ロールが在る = remove は**達成できていない**
    ctx.shop.recoverExternalEffectLock({ key: KEY, observed: "present", actor: "sys" });
    expect(
      ctx.db.prepare("SELECT state FROM shop_external_effect_locks WHERE effect_key = ?").pluck().get(KEY),
    ).toBe("released");
    ctx.db.close();
  });

  it("観測できなければ live のまま残る", () => {
    const ctx = setup();
    const a = acquire(ctx, "remove");
    if (!a.ok) return;
    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "?", actor: "w" });
    // 収束処理は member を取れなければ recoverExternalEffectLock を呼ばない。
    // 呼ばれない限り live のまま
    expect(holder(ctx)?.state).toBe("uncertain");
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(1);
    ctx.db.close();
  });

  it("収束は delivered evidence を1つも作らない", () => {
    const ctx = setup();
    const a = acquire(ctx, "add");
    if (!a.ok) return;
    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "?", actor: "w" });
    ctx.shop.recoverExternalEffectLock({ key: KEY, observed: "present", actor: "sys" });
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_verified_delivery_evidence").pluck().get(),
    ).toBe(0);
    ctx.db.close();
  });
});

// ── RF-D 剥奪が資源を持っていれば add は入れない ────────────────────────────

describe("RF-D: remove の所有者がいるあいだ add は取れない", () => {
  it("同じ資源なので操作が違っても排他される", () => {
    const ctx = setup();
    expect(acquire(ctx, "remove", "system:shop-role-revocation").ok).toBe(true);
    expect(acquire(ctx, "add", "system:shop-timed-access").ok).toBe(false);
    expect(acquire(ctx, "add", "system:shop-delivery").ok).toBe(false);
    expect(holder(ctx)?.owner).toBe("system:shop-role-revocation");
    expect(holder(ctx)?.operation).toBe("remove");
    ctx.db.close();
  });
});
