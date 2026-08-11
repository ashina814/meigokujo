import { describe, expect, it } from "vitest";
import {
  EventLog,
  Evaluation,
  Ledger,
  Settings,
  canBackfillHistoricalMajin,
  canCatchUpPromotion,
  openDb,
  roleToRestoreForStatus,
  type SoulStatus,
} from "../src/index.js";
import { Entry } from "../src/entry/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

/**
 * 既存不整合の回収操作。
 *
 * 通常導線（`/審判` → `/昇格`）を今さら流すと、評価期間・初期発行・公開の昇格告知が
 * **新規に発生**してしまう。回収は「既に起きていたことを台帳へ追認する」だけなので、
 * 遷移を1本に固定し、根拠を実行時に再確認することを押さえる。
 */

registerDefaultTxTypes();
const ALLOW = ["703048809030090843", "788782267035549716"] as const;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  return { db, ledger, settings, events, entry, evaluation };
}

describe("履歴追認の判定（waiting → 魔人）", () => {
  const base = { allowlist: ALLOW, userId: ALLOW[0], currentStatus: "waiting" as SoulStatus | null, hasMajinRole: true };

  it("許可リスト内・waiting・魔人ロールあり なら追認できる", () => {
    expect(canBackfillHistoricalMajin(base)).toEqual({ ok: true });
  });

  it("許可リストに無いIDは弾く（汎用の昇格口にしない）", () => {
    expect(canBackfillHistoricalMajin({ ...base, userId: "999999999999999999" })).toEqual({
      ok: false,
      reason: "not_in_allowlist",
    });
  });

  it("魔人ロールを持っていなければ追認しない（根拠が無い）", () => {
    expect(canBackfillHistoricalMajin({ ...base, hasMajinRole: false })).toEqual({ ok: false, reason: "majin_role_missing" });
  });

  it("waiting 以外からは動かさない", () => {
    for (const status of ["ghost", "kenma", "mazoku", "meirei", "departed"] as SoulStatus[]) {
      expect(canBackfillHistoricalMajin({ ...base, currentStatus: status })).toEqual({
        ok: false,
        reason: `unexpected_status:${status}`,
      });
    }
    expect(canBackfillHistoricalMajin({ ...base, currentStatus: "majin" })).toEqual({ ok: false, reason: "already_majin" });
    expect(canBackfillHistoricalMajin({ ...base, currentStatus: null })).toEqual({ ok: false, reason: "no_soul_row" });
  });
});

describe("昇格記録の追いつきの判定（ghost → 魔人）", () => {
  const base = { currentStatus: "ghost" as SoulStatus | null, hasMajinRole: true, promotionScore: 5, promotionRequired: 5 };

  it("3条件すべて満たせば追いつかせられる", () => {
    expect(canCatchUpPromotion(base)).toEqual({ ok: true });
  });

  it("昇格印が要求数に届かなければ弾く", () => {
    expect(canCatchUpPromotion({ ...base, promotionScore: 4 })).toEqual({ ok: false, reason: "promotion_score_short:4/5" });
  });

  it("魔人ロールが無ければ弾く（ロール上も昇格していない）", () => {
    expect(canCatchUpPromotion({ ...base, hasMajinRole: false })).toEqual({ ok: false, reason: "majin_role_missing" });
  });

  it("亡霊以外からは動かさない", () => {
    expect(canCatchUpPromotion({ ...base, currentStatus: "waiting" })).toEqual({ ok: false, reason: "unexpected_status:waiting" });
    expect(canCatchUpPromotion({ ...base, currentStatus: "majin" })).toEqual({ ok: false, reason: "unexpected_status:majin" });
  });
});

describe("台帳の階級から復元すべきロール", () => {
  it("上位階級はそのロールを足す", () => {
    expect(roleToRestoreForStatus("majin")).toBe("majin");
    expect(roleToRestoreForStatus("kenma")).toBe("kenma");
    expect(roleToRestoreForStatus("mazoku")).toBe("mazoku");
    expect(roleToRestoreForStatus("ghost")).toBe("ghost");
  });

  it("入城前・離脱済み・迷霊は自動復元しない", () => {
    // 迷霊は懲罰なので、台帳を根拠に自動で付け直さない
    for (const status of ["waiting", "departed", "meirei", null] as Array<SoulStatus | null>) {
      expect(roleToRestoreForStatus(status)).toBeNull();
    }
  });
});

describe("追認の書き込み（副作用を増やさない）", () => {
  it("waiting→魔人 の追認で、初期発行も評価期間も作らない", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id='u1'").get() as Record<string, unknown>;

    const ok = ctx.evaluation.backfillHistoricalRank("u1", "majin", "user:staff", { basis: "test" });

    expect(ok).toBe(true);
    const after = ctx.db.prepare("SELECT * FROM souls WHERE user_id='u1'").get() as Record<string, unknown>;
    expect(after.status).toBe("majin");
    // 評価スナップショット・期限・亡霊化時刻は触らない
    for (const col of ["ghost_at", "eval_deadline_at", "eval_started_at", "eval_policy_version"]) {
      expect(after[col]).toEqual(before[col]);
    }
    // 初期発行が発生していない
    expect(ctx.ledger.balanceOf("user:u1")).toBe(0);
    expect(ctx.events.listByTarget("u1").map((e) => e.type)).toContain("rank_history_backfill");
    expect(ctx.events.listByTarget("u1").map((e) => e.type)).not.toContain("ghosted");
  });

  it("追認の根拠を事件録のpayloadへ残す", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.evaluation.backfillHistoricalRank("u1", "majin", "user:staff", { basis: "role_and_salary", majinRoleId: "r-majin" });

    const row = ctx.events.listByTarget("u1").find((e) => e.type === "rank_history_backfill")!;
    const payload = JSON.parse(row.payload_json!) as { from: string; to: string; evidence: Record<string, unknown> };
    expect(payload).toMatchObject({ from: "waiting", to: "majin" });
    expect(payload.evidence).toMatchObject({ basis: "role_and_salary", majinRoleId: "r-majin" });
  });

  it("waiting でなくなっていたら書かない（二度押し・競合で上位階級を巻き戻さない）", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    expect(ctx.evaluation.backfillHistoricalRank("u1", "majin", "user:staff", {})).toBe(true);

    // 2回目。既に majin なので前提が崩れている
    expect(ctx.evaluation.backfillHistoricalRank("u1", "majin", "user:staff", {})).toBe(false);
    expect(ctx.entry.getSoul("u1")!.status).toBe("majin");
    expect(ctx.events.listByTarget("u1").filter((e) => e.type === "rank_history_backfill")).toHaveLength(1);
    expect(ctx.events.listByTarget("u1").map((e) => e.type)).toContain("rank_history_backfill_skipped");
  });

  it("昇格の追いつきは promoteToMajin と同じDB意味論になる（期限クリア + promotion事件録）", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", "user:staff");
    expect(ctx.entry.getSoul("u1")!.eval_deadline_at).not.toBeNull();

    const ok = ctx.evaluation.catchUpPromotion("u1", "user:staff", { promotionScore: 5, promotionRequired: 5 });

    expect(ok).toBe(true);
    const soul = ctx.entry.getSoul("u1")!;
    expect(soul.status).toBe("majin");
    expect(soul.eval_deadline_at).toBeNull();
    const promo = ctx.events.listByTarget("u1").find((e) => e.type === "promotion")!;
    expect(JSON.parse(promo.payload_json!)).toMatchObject({ to: "majin", catchup: true });
  });

  it("亡霊でなくなっていたら追いつかせない", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", "user:staff");
    ctx.evaluation.catchUpPromotion("u1", "user:staff", {});

    expect(ctx.evaluation.catchUpPromotion("u1", "user:staff", {})).toBe(false);
    expect(ctx.events.listByTarget("u1").filter((e) => e.type === "promotion")).toHaveLength(1);
  });
});
