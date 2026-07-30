import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ config: { ownerId: "owner-user" } }));

import { isAdmin } from "../src/permissions.js";

function servicesWithRoles(adminRoleIds: string[], legacyAdminRoleId?: string) {
  return {
    settings: {
      getJson: vi.fn((key: string, fallback: unknown) => (key === "roles:admin" ? adminRoleIds : fallback)),
      getString: vi.fn((key: string) => (key === "role:admin" ? legacyAdminRoleId : undefined)),
    },
  } as any;
}

function interaction(userId: string, roleIds: string[] = []) {
  const held = new Set(roleIds);
  return {
    user: { id: userId },
    member: { roles: { cache: { has: (roleId: string) => held.has(roleId) } } },
  } as any;
}

describe("管理コマンド権限", () => {
  it("OWNER_ID はロール設定に関係なく利用できる", () => {
    expect(isAdmin(interaction("owner-user"), servicesWithRoles([]))).toBe(true);
  });

  it("複数設定した管理ロールのどれか一つを持てば利用できる", () => {
    const services = servicesWithRoles(["maou-role", "shirei-role"]);

    expect(isAdmin(interaction("user-a", ["maou-role"]), services)).toBe(true);
    expect(isAdmin(interaction("user-b", ["shirei-role"]), services)).toBe(true);
    expect(isAdmin(interaction("user-c", ["other-role"]), services)).toBe(false);
  });

  it("新しい複数ロール設定が未投入なら旧 role:admin を引き続き使う", () => {
    const services = servicesWithRoles([], "legacy-admin-role");

    expect(isAdmin(interaction("user-a", ["legacy-admin-role"]), services)).toBe(true);
    expect(isAdmin(interaction("user-b", ["other-role"]), services)).toBe(false);
  });

  it("複数ロール設定が存在する場合は旧単一設定より優先する", () => {
    const services = servicesWithRoles(["new-admin-role"], "legacy-admin-role");

    expect(isAdmin(interaction("user-a", ["legacy-admin-role"]), services)).toBe(false);
    expect(isAdmin(interaction("user-b", ["new-admin-role"]), services)).toBe(true);
  });

  it("ギルドメンバー情報が無ければ権限を与えない", () => {
    const services = servicesWithRoles(["admin-role"]);
    const dmInteraction = { user: { id: "user-a" }, member: null } as any;

    expect(isAdmin(dmInteraction, services)).toBe(false);
  });
});
