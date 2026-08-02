import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { deptAccount } from "../departments/service.js";
import { ChipLedger, HOUSE_HOLDER } from "./chip-ledger.js";
import { HouseReservations } from "./reservations.js";

const now = () => Math.floor(Date.now() / 1000);
export type RemittanceStatus = "draft" | "approved" | "executed" | "rejected";
export interface RemittanceRow { id: number; key: string; amount: number; status: RemittanceStatus; createdBy: string; approvedBy: string | null; executedAt: number | null; }

/** PR14: 月次納付と補填は自動実行せず、永続draft→別人承認→一度だけ実行する。 */
export class CasinoRemittance {
  constructor(private readonly db: Database.Database, private readonly ledger: Ledger, private readonly chips: ChipLedger, private readonly reservations: HouseReservations, private readonly departmentKey = "賭博場") {
    ledger.ensureAccount(deptAccount(departmentKey), "system");
    db.exec(`CREATE TABLE IF NOT EXISTS casino_remittances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL CHECK(status IN ('draft','approved','executed','rejected')), created_by TEXT NOT NULL,
      approved_by TEXT, executed_at INTEGER, created_at INTEGER NOT NULL
    )`);
  }

  surplus(minimumWorkingCapital: number): number {
    if (!Number.isSafeInteger(minimumWorkingCapital) || minimumWorkingCapital < 0) throw new Error("minimumWorkingCapital must be non-negative integer");
    return Math.max(0, this.chips.balanceOf(HOUSE_HOLDER) - this.reservations.totalReserved() - minimumWorkingCapital);
  }
  draft(key: string, bps: number, minimumWorkingCapital: number, actor: string): RemittanceRow {
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new Error("bps must be 0..10000");
    const amount = Math.floor(this.surplus(minimumWorkingCapital) * bps / 10_000);
    if (amount <= 0) throw new Error("納付可能余剰がありません");
    this.db.prepare("INSERT INTO casino_remittances (key,amount,status,created_by,created_at) VALUES (?,?,'draft',?,?)").run(key, amount, actor, now());
    return this.get(key)!;
  }
  approve(key: string, actor: string): RemittanceRow {
    const row = this.get(key); if (!row || row.status !== "draft") throw new Error("承認可能な納付案ではありません");
    if (row.createdBy === actor) throw new Error("起案者自身は承認できません");
    this.db.prepare("UPDATE casino_remittances SET status='approved', approved_by=? WHERE key=? AND status='draft'").run(actor, key);
    return this.get(key)!;
  }
  execute(key: string, actor: string): RemittanceRow {
    const row = this.get(key); if (!row || row.status !== "approved") throw new Error("実行可能な納付案ではありません");
    const dept = deptAccount(this.departmentKey);
    this.chips.runGroup({ groupKey: `casino:remittance:${key}`, kind: "remittance", actorId: actor }, () => {
      // house chips → casino department Land → treasury。JP/relief/claims はこの経路に一切入らない。
      this.chips.redeemToAccount(HOUSE_HOLDER, row.amount, dept, actor, `casino:remittance:${key}:redeem`);
      const land = this.ledger.transfer({ from: dept, to: TREASURY, amount: row.amount, type: "casino_remittance", actor, reason: "賭場月次納付", idempotencyKey: `casino:remittance:${key}:treasury` });
      if (land.duplicate) throw new Error("納付Land取引の冪等キー衝突");
      const changed = this.db.prepare("UPDATE casino_remittances SET status='executed', executed_at=? WHERE key=? AND status='approved'").run(now(), key);
      if (changed.changes !== 1) throw new Error("納付状態が古く実行できません");
    });
    return this.get(key)!;
  }
  /** 補填は国庫→賭博場部署→準備口座→house の唯一の経路。自動呼出し用途は持たない。 */
  bailout(key: string, amount: number, actor: string, approvedBy: string): void {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !approvedBy || approvedBy === actor) throw new Error("補填には正の額と別承認者が必要");
    const dept = deptAccount(this.departmentKey);
    this.chips.runGroup({ groupKey: `casino:bailout:${key}`, kind: "bailout", actorId: actor }, () => {
      const land = this.ledger.transfer({ from: TREASURY, to: dept, amount, type: "casino_bailout", actor, approvedBy, reason: "承認済み賭場補填", idempotencyKey: `casino:bailout:${key}:dept` });
      if (land.duplicate) throw new Error("補填Land取引の冪等キー衝突");
      this.chips.fundFromAccount(dept, amount, HOUSE_HOLDER, `casino:bailout:${key}:fund`);
    });
  }
  get(key: string): RemittanceRow | undefined {
    const r = this.db.prepare("SELECT * FROM casino_remittances WHERE key=?").get(key) as any;
    return r && { id: r.id, key: r.key, amount: r.amount, status: r.status, createdBy: r.created_by, approvedBy: r.approved_by, executedAt: r.executed_at };
  }
}
