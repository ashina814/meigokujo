import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Payroll, PayrollError, type MemberRoles } from "../src/payroll/service.js";
import { Settings, SETTING_DEFAULTS } from "../src/settings/service.js";

registerDefaultTxTypes();

const STAFF = "staff:shitsuritsukyo";

// 給料表（現行転記の一部）
const ROLE_MAJIN = "role:majin";
const ROLE_MAZOKU = "role:mazoku";
const ROLE_GINKOIN = "role:ginkoin";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const payroll = new Payroll(db, ledger);
  const settings = new Settings(db);
  payroll.setSalary(ROLE_MAJIN, "魔人", 40_000, STAFF);
  payroll.setSalary(ROLE_MAZOKU, "魔族", 100_000, STAFF);
  payroll.setSalary(ROLE_GINKOIN, "銀行員", 80_000, STAFF);
  return { db, ledger, payroll, settings };
}

const members: MemberRoles[] = [
  { userId: "alice", roleIds: [ROLE_MAZOKU, ROLE_GINKOIN] }, // 兼務 → 全額重複
  { userId: "bob", roleIds: [ROLE_MAJIN] },
  { userId: "carol", roleIds: ["role:none"] }, // 給料表に無いロールのみ → 対象外
];

describe("設定基盤", () => {
  it("未設定は既定値、設定後は保存値を返す", () => {
    const { settings } = setup();
    expect(settings.getNumber("approval_threshold")).toBe(SETTING_DEFAULTS.approval_threshold);
    settings.set("approval_threshold", 2_000_000, STAFF);
    expect(settings.getNumber("approval_threshold")).toBe(2_000_000);
  });

  it("JSON設定（VCホワイトリスト等）と文字列設定を扱える", () => {
    const { settings } = setup();
    expect(settings.getJson<string[]>("vc_whitelist", [])).toEqual([]);
    settings.set("vc_whitelist", ["vc:100", "vc:200"], STAFF);
    expect(settings.getJson<string[]>("vc_whitelist", [])).toEqual(["vc:100", "vc:200"]);
    settings.set("channel:public_log", "123456789", STAFF);
    expect(settings.getString("channel:public_log")).toBe("123456789");
  });

  it("設定変更は監査ログ（outbox）に残る", () => {
    const { settings, ledger } = setup();
    settings.set("bump_reward", 1_000, STAFF);
    const audit = ledger.pendingOutbox().filter((o) => o.kind === "audit_log");
    expect(audit.some((o) => o.payload.includes("setting_changed"))).toBe(true);
  });
});

describe("給与バッチ", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("複数ロールは全額重複で計画が作られる", () => {
    const run = ctx.payroll.generateDraft("2026-07", members, STAFF);
    const plan = ctx.payroll.planOf(run);
    const alice = plan.items.find((i) => i.userId === "alice");
    expect(alice?.total).toBe(180_000); // 魔族100,000 + 銀行員80,000
    expect(alice?.breakdown.length).toBe(2);
    expect(plan.items.find((i) => i.userId === "carol")).toBeUndefined();
    expect(plan.totalPayout).toBe(220_000);
  });

  it("計画はスナップショット: draft後に給料表を変えても実行額は不変", () => {
    const run = ctx.payroll.generateDraft("2026-07", members, STAFF);
    ctx.payroll.setSalary(ROLE_MAJIN, "魔人", 999_999, STAFF); // 後から改定
    ctx.payroll.approve(run.id, STAFF);
    ctx.payroll.execute(run.id, STAFF);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(40_000); // 改定前の額
  });

  it("draft → approved → executed の順序を強制する", () => {
    const run = ctx.payroll.generateDraft("2026-07", members, STAFF);
    expect(() => ctx.payroll.execute(run.id, STAFF)).toThrowError(/ERR_INVALID_STATUS/);
    ctx.payroll.approve(run.id, STAFF);
    expect(() => ctx.payroll.approve(run.id, STAFF)).toThrowError(/ERR_INVALID_STATUS/);
    const report = ctx.payroll.execute(run.id, STAFF);
    expect(report.succeeded).toBe(2);
    expect(report.totalPaid).toBe(220_000);
    expect(ctx.ledger.moneySupply()).toBe(220_000);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("再実行しても二重支給されない（支給済みはスキップ）", () => {
    const run = ctx.payroll.generateDraft("2026-07", members, STAFF);
    ctx.payroll.approve(run.id, STAFF);
    ctx.payroll.execute(run.id, STAFF);
    const second = ctx.payroll.execute(run.id, STAFF);
    expect(second.succeeded).toBe(0);
    expect(second.skippedAsPaid).toBe(2);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(180_000);
    expect(ctx.ledger.moneySupply()).toBe(220_000);
  });

  it("部分失敗（凍結口座）はスキップして続行し、レポートに残る。再実行で救済できる", () => {
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.setAccountStatus("user:alice", "frozen");
    const run = ctx.payroll.generateDraft("2026-07", members, STAFF);
    ctx.payroll.approve(run.id, STAFF);
    const report = ctx.payroll.execute(run.id, STAFF);
    expect(report.succeeded).toBe(1); // bob のみ
    expect(report.failed).toEqual([
      { userId: "alice", code: "ERR_FROZEN", details: { accountId: "user:alice" } },
    ]);
    // 凍結解除後の再実行で alice だけ支給される
    ctx.ledger.setAccountStatus("user:alice", "active");
    const retry = ctx.payroll.execute(run.id, STAFF);
    expect(retry.succeeded).toBe(1);
    expect(retry.skippedAsPaid).toBe(1);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(180_000);
  });

  it("同一期間の draft は作り直せるが、承認後は再生成できない（月1回を構造で保証）", () => {
    const run1 = ctx.payroll.generateDraft("2026-07", members, STAFF);
    const run2 = ctx.payroll.generateDraft("2026-07", members.slice(0, 2), STAFF);
    expect(run2.id).toBe(run1.id); // 同じ run を更新
    ctx.payroll.approve(run2.id, STAFF);
    expect(() => ctx.payroll.generateDraft("2026-07", members, STAFF)).toThrowError(/ERR_INVALID_STATUS/);
  });

  it("period の形式・空計画・キャンセル済み実行を拒否する", () => {
    expect(() => ctx.payroll.generateDraft("2026-13", members, STAFF)).toThrowError(/ERR_INVALID_PERIOD/);
    expect(() =>
      ctx.payroll.generateDraft("2026-08", [{ userId: "x", roleIds: ["role:none"] }], STAFF),
    ).toThrowError(/ERR_EMPTY_PLAN/);
    const run = ctx.payroll.generateDraft("2026-09", members, STAFF);
    ctx.payroll.cancel(run.id, STAFF);
    expect(() => ctx.payroll.approve(run.id, STAFF)).toThrowError(/ERR_INVALID_STATUS/);
    expect(() => ctx.payroll.execute(run.id, STAFF)).toThrowError(/ERR_INVALID_STATUS/);
  });

  it("支給は国庫から出て、取引に payout_run の参照が付く", () => {
    const run = ctx.payroll.generateDraft("2026-07", members, STAFF);
    ctx.payroll.approve(run.id, STAFF);
    ctx.payroll.execute(run.id, STAFF);
    const history = ctx.ledger.history("user:bob");
    expect(history[0]?.type).toBe("salary");
    expect(history[0]?.from_account).toBe(TREASURY);
    expect(history[0]?.ref_type).toBe("payout_run");
    expect(history[0]?.ref_id).toBe(String(run.id));
    expect(history[0]?.approved_by).toBe(STAFF);
  });
});
