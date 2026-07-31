import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Payroll, type MemberRoles } from "../src/payroll/service.js";

registerDefaultTxTypes();

const STAFF = "staff:test";
const ROLE = "role:salary";
const members: MemberRoles[] = [
  { userId: "alice", roleIds: [ROLE] },
  { userId: "bob", roleIds: [ROLE] },
];

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const payroll = new Payroll(db, ledger);
  payroll.setSalary(ROLE, "給与役職", 100_000, STAFF);
  return { db, ledger, payroll };
}

describe("未完了給与Runの回収", () => {
  it("draft・approved・部分失敗だけを月順で返し、成功済みと見送り済みを除外する", () => {
    const { db, ledger, payroll } = setup();

    // 新しい月から作り、状態を確定してから古い月を作る。通常運用では古い未完了が新規月をブロックする。
    const cancelled = payroll.generateDraft("2026-11", members, STAFF);
    payroll.cancel(cancelled.id, STAFF);

    ledger.ensureAccount("user:alice", "user");
    ledger.setAccountStatus("user:alice", "frozen");
    const partial = payroll.generateDraft("2026-10", members, STAFF);
    payroll.approve(partial.id, STAFF);
    payroll.execute(partial.id, STAFF);
    ledger.setAccountStatus("user:alice", "active");

    const succeeded = payroll.generateDraft("2026-09", members, STAFF);
    payroll.approve(succeeded.id, STAFF);
    payroll.execute(succeeded.id, STAFF);

    const approved = payroll.generateDraft("2026-08", members, STAFF);
    payroll.approve(approved.id, STAFF);

    payroll.generateDraft("2026-07", members, STAFF);

    expect(payroll.listRecoverableRuns().map((run) => [run.period, run.status])).toEqual([
      ["2026-07", "draft"],
      ["2026-08", "approved"],
      ["2026-10", "executed"],
    ]);

    db.close();
  });

  it("新しい月の生成・承認・実行を、より古い未完了Runが構造的にブロックする", () => {
    const { db, payroll } = setup();

    const august = payroll.generateDraft("2026-08", members, STAFF);
    const july = payroll.generateDraft("2026-07", members, STAFF);

    expect(() => payroll.generateDraft("2026-09", members, STAFF)).toThrowError(/ERR_OLDER_RUN_PENDING/);
    expect(() => payroll.approve(august.id, STAFF)).toThrowError(/ERR_OLDER_RUN_PENDING/);

    payroll.approve(july.id, STAFF);
    payroll.execute(july.id, STAFF);
    payroll.approve(august.id, STAFF);

    const june = payroll.generateDraft("2026-06", members, STAFF);
    payroll.approve(june.id, STAFF);
    expect(() => payroll.execute(august.id, STAFF)).toThrowError(/ERR_OLDER_RUN_PENDING/);

    db.close();
  });

  it("実行レポートが欠損・破損・構造不正なら安全側で回収対象に残す", () => {
    const { db, payroll } = setup();
    const run = payroll.generateDraft("2026-07", members, STAFF);
    payroll.approve(run.id, STAFF);

    const malformedReports: Array<string | null> = [
      null,
      "not-json",
      "{}",
      '{"failed":null}',
      '{"succeeded":"2","skippedAsPaid":0,"failed":[],"totalPaid":200000}',
      '{"succeeded":2,"skippedAsPaid":0,"failed":[{"userId":"alice","code":"ERR","details":null}],"totalPaid":200000}',
    ];

    for (const reportJson of malformedReports) {
      db.prepare("UPDATE payout_runs SET status = 'executed', report_json = ? WHERE id = ?").run(reportJson, run.id);
      expect(payroll.listRecoverableRuns().map((item) => item.id)).toContain(run.id);
    }

    db.close();
  });
});
