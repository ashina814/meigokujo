from pathlib import Path

p = Path("packages/core/tests/casino-ranked-disputes-final-concurrency.serial.test.ts")
text = p.read_text(encoding="utf-8")
marker = '  it("B: two manual arbitrations have one winner and move/release/refund/history exactly once", async () => {'
if marker not in text:
    raise SystemExit("B marker missing")
extra = r'''  it("A1: finalize commits first -> deadline closes to awaiting_arbitration and never refunds", async () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const [finalize, deadlineRun] = await Promise.all([
      spawnRunner(ctx.dbPath, "finalize", evidenceOperationId, deadline - 1, deadline, startAt),
      spawnRunner(ctx.dbPath, "deadline", "deadline:after-finalize", deadline - 1, deadline, startAt + 600),
    ]);

    expect(finalize.ok).toBe(true);
    expect(deadlineRun.ok).toBe(true);
    expect(deadlineRun.result).toEqual({ closed: 1, autoRefunded: 0, failed: 0 });
    const db = openDb(ctx.dbPath);
    expect(db.prepare("SELECT storage_status FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId)).toEqual({ storage_status: "stored" });
    expect(db.prepare("SELECT status, resolved_at FROM casino_table_disputes WHERE table_id='t1'").get()).toEqual({ status: "awaiting_arbitration", resolved_at: null });
    expect(db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get()).toEqual({ state: "disputed" });
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(10_000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n).toBe(0);
    db.close();
  }, 60_000);

  it("A2: deadline commits first -> one refund and later finalize is rejected", async () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const [deadlineRun, finalize] = await Promise.all([
      spawnRunner(ctx.dbPath, "deadline", "deadline:before-finalize", deadline - 1, deadline, startAt),
      spawnRunner(ctx.dbPath, "finalize", evidenceOperationId, deadline - 1, deadline, startAt + 600),
    ]);

    expect(deadlineRun.ok).toBe(true);
    expect(deadlineRun.result).toEqual({ closed: 0, autoRefunded: 1, failed: 0 });
    expect(finalize.ok).toBe(false);
    const db = openDb(ctx.dbPath);
    expect(db.prepare("SELECT storage_status FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId)).toEqual({ storage_status: "pending" });
    const dispute = db.prepare("SELECT status, resolved_at AS resolvedAt, resolution_kind AS resolutionKind FROM casino_table_disputes WHERE table_id='t1'").get() as { status: string; resolvedAt: number | null; resolutionKind: string | null };
    expect(dispute.status).toBe("insufficient_evidence");
    expect(dispute.resolutionKind).toBe("insufficient_evidence");
    expect(dispute.resolvedAt).not.toBeNull();
    expect(db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get()).toEqual({ state: "cancelled" });
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n).toBe(1);
    db.close();
  }, 60_000);

'''
p.write_text(text.replace(marker, extra + marker, 1), encoding="utf-8")
