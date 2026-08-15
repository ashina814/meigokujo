import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/commands/original-role-ticket.ts"), "utf8");

describe("legacy original-role migration policy", () => {
  it("requires the ticket owner to actually hold the selected Discord role", () => {
    expect(source).toContain("member.roles.cache.has(role.id)");
    expect(source).toContain("本人が現在持っている実ロールとして確認できませんでした");
  });

  it("does not infer a historical expiry from missing purchase history", () => {
    expect(source).toContain("expiresAt: null");
    expect(source).toContain("再購入は発生していません");
    expect(source).toContain("期限は旧購入履歴から推測せず未設定です");
  });
});
