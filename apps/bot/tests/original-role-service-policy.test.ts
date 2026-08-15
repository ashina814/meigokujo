import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const shop = readFileSync(resolve(root, "src/commands/shop-panel.ts"), "utf8");
const userUi = readFileSync(resolve(root, "src/commands/original-role.ts"), "utf8");
const ticket = readFileSync(resolve(root, "src/commands/original-role-ticket.ts"), "utf8");
const jobs = readFileSync(resolve(root, "src/original-role-jobs.ts"), "utf8");
const legacyAdmin = readFileSync(resolve(root, "src/commands/original-role-admin.ts"), "utf8");

describe("original role human-service policy", () => {
  it("normal shop UI starts a persistent service ticket instead of self purchase/renew", () => {
    expect(userUi).toContain('setCustomId("ticket:open:original_role")');
    expect(userUi).toContain("新しいオリロを相談する");
    expect(userUi).not.toContain('setLabel(`更新する (');
    expect(shop).toContain("旧セルフ更新UIは終了しました");
  });

  it("staff explicitly chooses invoice kind and exception requires reason", () => {
    expect(ticket).toContain('value: "new"');
    expect(ticket).toContain('value: "continuation"');
    expect(ticket).toContain('value: "restart"');
    expect(ticket).toContain('value: "exception"');
    expect(ticket).toContain('setCustomId("reason")');
    expect(ticket).toContain("setRequired(true)");
  });

  it("unpayable high-value invoices are blocked at issue time with a clear staff message", () => {
    expect(ticket).toContain("ERR_INVOICE_NEEDS_APPROVAL");
    expect(ticket).toContain("請求は作成していません");
    expect(ticket).toContain("金額または設定価格を閾値以下にしてください");
    expect(ticket).toContain('error.code === "ERR_NEEDS_APPROVAL"');
  });

  it("legacy real role can be linked without purchase inference", () => {
    expect(ticket).toContain("実ロールをカルテ登録");
    expect(ticket).toContain("expiresAt: null");
    expect(ticket).toContain("再購入は発生していません");
  });

  it("legacy unpaid applications cannot re-enter the old approve->auto-create path", () => {
    const approveBody = legacyAdmin.split("export async function handleOriginalRoleApprove", 2)[1]?.split("export async function handleOriginalRoleDecision", 1)[0] ?? "";
    expect(approveBody).not.toContain("originalRoles.approve(");
    expect(approveBody).not.toContain("Botがロールを作成してお付けします");
    expect(approveBody).toContain("original_role_legacy_migration_requested");
    expect(approveBody).toContain("専用の相談カルテ");
  });

  it("expiry job never removes Discord roles automatically", () => {
    expect(jobs).not.toContain("member.roles.remove");
    expect(jobs).not.toContain(".roles.remove(");
    expect(jobs).toContain("Botはロールを自動で外さず");
  });
});
