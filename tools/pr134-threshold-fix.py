from pathlib import Path


def replace_one(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new))

# Core invoice issuance must reject invoices that the current Land policy cannot pay.
replace_one(
    "packages/core/src/original-role/cases.ts",
    'import type { OriginalRoleRow } from "./service.js";\n',
    'import type { OriginalRoleRow } from "./service.js";\nimport { Settings } from "../settings/service.js";\n',
)
replace_one(
    "packages/core/src/original-role/cases.ts",
    '  | "ERR_INVALID_INVOICE_AMOUNT"\n  | "ERR_EXCEPTION_REASON_REQUIRED";\n',
    '  | "ERR_INVALID_INVOICE_AMOUNT"\n  | "ERR_INVOICE_NEEDS_APPROVAL"\n  | "ERR_EXCEPTION_REASON_REQUIRED";\n',
)
replace_one(
    "packages/core/src/original-role/cases.ts",
    '''export class OriginalRoleCases {\n  constructor(\n    private readonly db: Database.Database,\n    private readonly events: EventLog,\n  ) {}\n''',
    '''export class OriginalRoleCases {\n  private readonly settings: Settings;\n\n  constructor(\n    private readonly db: Database.Database,\n    private readonly events: EventLog,\n  ) {\n    this.settings = new Settings(db);\n  }\n''',
)
replace_one(
    "packages/core/src/original-role/cases.ts",
    '''    const reason = input.reason?.trim() || null;\n    if (input.kind === "exception" && !reason) throw new OriginalRoleCaseError("ERR_EXCEPTION_REASON_REQUIRED");\n    if (this.pendingInvoiceByCase(serviceCase.id)) {\n''',
    '''    const reason = input.reason?.trim() || null;\n    if (input.kind === "exception" && !reason) throw new OriginalRoleCaseError("ERR_EXCEPTION_REASON_REQUIRED");\n    const approvalThreshold = this.settings.getNumber("approval_threshold");\n    // Ledger.transfer と同じ境界: threshold ちょうどは承認不要、超過だけ承認必須。\n    // この請求フローには approvedBy を渡す経路を作らないため、支払不能なpending invoiceを先に作らない。\n    if (input.amount > approvalThreshold) {\n      throw new OriginalRoleCaseError("ERR_INVOICE_NEEDS_APPROVAL", {\n        amount: input.amount,\n        threshold: approvalThreshold,\n      });\n    }\n    if (this.pendingInvoiceByCase(serviceCase.id)) {\n''',
)

# Staff-facing UI explains that no invoice was created and how to resolve it.
replace_one(
    "apps/bot/src/commands/original-role-ticket.ts",
    '''function baselineContinuation(services: Services): number {\n  const raw = Number(services.settings.getString("original_role_renew_price"));\n  return Number.isSafeInteger(raw) && raw > 0 ? raw : ORIGINAL_ROLE_CONTINUATION_BASELINE_LAND;\n}\n\nexport function originalRoleTicketControlRow() {\n''',
    '''function baselineContinuation(services: Services): number {\n  const raw = Number(services.settings.getString("original_role_renew_price"));\n  return Number.isSafeInteger(raw) && raw > 0 ? raw : ORIGINAL_ROLE_CONTINUATION_BASELINE_LAND;\n}\n\nfunction invoiceApprovalBlockMessage(error: unknown, amount: number): string | null {\n  if (!(error instanceof OriginalRoleCaseError) || error.code !== "ERR_INVOICE_NEEDS_APPROVAL") return null;\n  const threshold = Number(error.details.threshold);\n  const thresholdLabel = Number.isFinite(threshold) ? fmtLd(threshold) : "現在の高額承認閾値";\n  return `請求額 ${fmtLd(amount)} は高額承認閾値 ${thresholdLabel} を超えるため発行できません。**請求は作成していません。** 金額または設定価格を閾値以下にしてください。`;\n}\n\nexport function originalRoleTicketControlRow() {\n''',
)
replace_one(
    "apps/bot/src/commands/original-role-ticket.ts",
    '''  } catch (error) {\n    const pending = services.originalRoleCases.pendingInvoiceByTicket(ticket.thread_id);\n    await interaction.reply({\n      content: pending ? `未払いの請求 #${pending.id} があるため、新しい請求は出していません。既存請求を再掲します。` : `請求を発行できませんでした: ${String(error)}`,\n      flags: MessageFlags.Ephemeral,\n    });\n    if (pending) await postInvoice(interaction, pending);\n  }\n}\n''',
    '''  } catch (error) {\n    const approvalBlocked = invoiceApprovalBlockMessage(error, amount);\n    if (approvalBlocked) {\n      await interaction.reply({ content: approvalBlocked, flags: MessageFlags.Ephemeral });\n      return;\n    }\n    const pending = services.originalRoleCases.pendingInvoiceByTicket(ticket.thread_id);\n    await interaction.reply({\n      content: pending ? `未払いの請求 #${pending.id} があるため、新しい請求は出していません。既存請求を再掲します。` : `請求を発行できませんでした: ${String(error)}`,\n      flags: MessageFlags.Ephemeral,\n    });\n    if (pending) await postInvoice(interaction, pending);\n  }\n}\n''',
)
replace_one(
    "apps/bot/src/commands/original-role-ticket.ts",
    '''  } catch (error) {\n    const message = error instanceof OriginalRoleCaseError && error.code === "ERR_PENDING_INVOICE_EXISTS"\n      ? "未払い請求があるため、新しい請求は出していません。"\n      : "例外請求を発行できませんでした。";\n    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });\n  }\n''',
    '''  } catch (error) {\n    const message = invoiceApprovalBlockMessage(error, amount)\n      ?? (error instanceof OriginalRoleCaseError && error.code === "ERR_PENDING_INVOICE_EXISTS"\n        ? "未払い請求があるため、新しい請求は出していません。"\n        : "例外請求を発行できませんでした。");\n    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });\n  }\n''',
)

# Core regression mirrors production: Ledger and invoice issuance both read the same live setting.
replace_one(
    "packages/core/tests/original-role-service-case.test.ts",
    '  ShopError,\n  Tickets,\n',
    '  ShopError,\n  Settings,\n  Tickets,\n',
)
replace_one(
    "packages/core/tests/original-role-service-case.test.ts",
    '''  const events = new EventLog(db);\n  const ledger = new Ledger(db);\n  const tickets = new Tickets(db, events);\n''',
    '''  const events = new EventLog(db);\n  const settings = new Settings(db);\n  const ledger = new Ledger(db, { approvalThreshold: () => settings.getNumber("approval_threshold") });\n  const tickets = new Tickets(db, events);\n''',
)
replace_one(
    "packages/core/tests/original-role-service-case.test.ts",
    '  return { db, events, ledger, tickets, roles, cases, shop, item, serviceCase };\n',
    '  return { db, events, settings, ledger, tickets, roles, cases, shop, item, serviceCase };\n',
)
replace_one(
    "packages/core/tests/original-role-service-case.test.ts",
    '''  it("本人だけが支払い、purchase/transaction/staff/timeを請求へ残す", () => {\n''',
    '''  it("approval thresholdちょうどの請求は発行でき、本人が支払える", () => {\n    const ctx = setup();\n    ctx.settings.set("approval_threshold", 750_000, "test");\n    const invoice = ctx.cases.issueInvoice({ threadId: "thread-1", kind: "new", amount: 750_000, actor: "user:staff" });\n    const before = ctx.ledger.balanceOf(`user:${USER}`);\n    const paid = ctx.shop.purchaseOriginalRoleInvoice({ invoiceId: invoice.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], idempotencyKey: `threshold-equal:${invoice.id}` });\n    expect(paid.purchase.paid_land).toBe(750_000);\n    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - 750_000);\n    expect(ctx.cases.invoice(invoice.id)?.status).toBe("paid");\n    ctx.db.close();\n  });\n\n  it("approval threshold超は標準/例外ともpending invoiceを作らずLandも動かさない", () => {\n    const ctx = setup();\n    ctx.settings.set("approval_threshold", 749_999, "test");\n    const beforeBalance = ctx.ledger.balanceOf(`user:${USER}`);\n    const beforeInvoices = (ctx.db.prepare("SELECT COUNT(*) AS n FROM original_role_invoices").get() as { n: number }).n;\n    const beforePurchases = ctx.shop.countPurchases();\n    const beforeTransactions = (ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n;\n\n    let standardError: unknown;\n    try {\n      ctx.cases.issueInvoice({ threadId: "thread-1", kind: "new", amount: 750_000, actor: "user:staff" });\n    } catch (error) {\n      standardError = error;\n    }\n    expect(standardError).toBeInstanceOf(OriginalRoleCaseError);\n    expect((standardError as OriginalRoleCaseError).code).toBe("ERR_INVOICE_NEEDS_APPROVAL");\n    expect((standardError as OriginalRoleCaseError).details).toMatchObject({ amount: 750_000, threshold: 749_999 });\n\n    expect(() => ctx.cases.issueInvoice({\n      threadId: "thread-1",\n      kind: "exception",\n      amount: 750_000,\n      reason: "閾値超の例外",\n      actor: "user:staff",\n    })).toThrowError(OriginalRoleCaseError);\n\n    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM original_role_invoices").get() as { n: number }).n).toBe(beforeInvoices);\n    expect(ctx.shop.countPurchases()).toBe(beforePurchases);\n    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n).toBe(beforeTransactions);\n    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(beforeBalance);\n    ctx.db.close();\n  });\n\n  it("本人だけが支払い、purchase/transaction/staff/timeを請求へ残す", () => {\n''',
)

# Source policy regression: UI must surface the issue-time block and retain payment-time defense.
replace_one(
    "apps/bot/tests/original-role-service-policy.test.ts",
    '''  it("legacy real role can be linked without purchase inference", () => {\n''',
    '''  it("unpayable high-value invoices are blocked at issue time with a clear staff message", () => {\n    expect(ticket).toContain("ERR_INVOICE_NEEDS_APPROVAL");\n    expect(ticket).toContain("請求は作成していません");\n    expect(ticket).toContain("金額または設定価格を閾値以下にしてください");\n    expect(ticket).toContain('error.code === "ERR_NEEDS_APPROVAL"');\n  });\n\n  it("legacy real role can be linked without purchase inference", () => {\n''',
)

print("PR134 threshold fix applied")
