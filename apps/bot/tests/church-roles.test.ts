import { describe, expect, it } from "vitest";
import { getRoleIds, memberInSlot, setRoleIds } from "../src/church-roles.js";

function servicesWithRoleStore() {
  const store = new Map<string, unknown>();
  return {
    settings: {
      getJson: <T>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
      getString: () => undefined,
      set: (key: string, value: unknown) => store.set(key, value),
    },
  };
}

function memberWithRoles(roleIds: string[]) {
  return { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } };
}

describe("room_normal_free role slot", () => {
  it("stores multiple roles, reloads them, matches any one, and can be cleared", () => {
    const services = servicesWithRoleStore() as any;

    setRoleIds(services, "room_normal_free", ["free-a", "free-b"], "test");

    expect(getRoleIds(services, "room_normal_free")).toEqual(["free-a", "free-b"]);
    expect(memberInSlot(memberWithRoles(["free-b"]) as any, services, "room_normal_free")).toBe(true);
    expect(memberInSlot(memberWithRoles(["other"]) as any, services, "room_normal_free")).toBe(false);

    setRoleIds(services, "room_normal_free", [], "test");

    expect(getRoleIds(services, "room_normal_free")).toEqual([]);
    expect(memberInSlot(memberWithRoles(["free-a"]) as any, services, "room_normal_free")).toBe(false);
  });
});
