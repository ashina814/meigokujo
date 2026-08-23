import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { openDb, PublicEvents, Settings } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { handlePublicEventCompleteButton, handlePublicEventCompleteCommand } from "../src/commands/public-event-complete.js";

const ADMIN_ROLE_ID = "admin-role-id";

function fakeServices() {
  const db = openDb(":memory:");
  const publicEvents = new PublicEvents(db);
  publicEvents.recordFinalizedEvent({
    eventKey: "canonical-event",
    name: "DB正本イベント名",
    eventDate: "2026-08-20",
    participantUserIds: ["alice", "bob"],
    recordedBy: "roster-staff",
  });
  const settings = new Settings(db);
  settings.set("role:admin", ADMIN_ROLE_ID, "setup");
  return { db, services: { publicEvents, settings } as unknown as Services };
}

function fakeMember(userId: string, roleIds: readonly string[]) {
  return { id: userId, roles: { cache: new Map(roleIds.map((id) => [id, {}])) } };
}

function fakeCommand(opts: { userId: string; eventKey?: string; member?: ReturnType<typeof fakeMember> | null }) {
  return {
    id: `cmd-${Math.random()}`,
    user: { id: opts.userId },
    member: opts.member ?? null,
    options: { getString: () => opts.eventKey ?? "canonical-event" },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & { reply: ReturnType<typeof vi.fn> };
}

function fakeButton(customId: string, userId: string, member?: ReturnType<typeof fakeMember> | null) {
  return {
    customId,
    user: { id: userId },
    member: member ?? null,
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & { update: ReturnType<typeof vi.fn> };
}

function customIds(payload: unknown): string[] {
  const rows = ((payload as { components?: unknown[] }).components ?? []) as Array<{
    toJSON(): { components: Array<{ custom_id?: string }> };
  }>;
  return rows.flatMap((row) => row.toJSON().components.map((component) => component.custom_id ?? ""));
}

function completionCount(db: ReturnType<typeof openDb>): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM public_event_completions`).get() as { count: number }).count;
}

beforeEach(() => {
  process.env.OWNER_ID ??= "test-owner";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-23T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("/イベント完了記録 preview → confirm", () => {
  it("non-adminはpreview不可、slashだけではDB write 0", async () => {
    const { db, services } = fakeServices();
    const denied = fakeCommand({ userId: "not-admin" });
    await handlePublicEventCompleteCommand(denied, services);
    expect(String(denied.reply.mock.calls[0]![0].content)).toContain("運営限定");
    expect(completionCount(db)).toBe(0);

    const preview = fakeCommand({ userId: "test-owner" });
    await handlePublicEventCompleteCommand(preview, services);
    expect(completionCount(db)).toBe(0);
  });

  it("previewはeventKey/name/date/countをDB正本から表示し、不可逆なcompletion attestationを明記", async () => {
    const { services } = fakeServices();
    const preview = fakeCommand({ userId: "test-owner" });
    await handlePublicEventCompleteCommand(preview, services);
    const serialized = JSON.stringify(preview.reply.mock.calls[0]![0]);
    for (const expected of ["canonical-event", "DB正本イベント名", "2026-08-20", "2人", "終了済み", "不可逆"]) {
      expect(serialized).toContain(expected);
    }
  });

  it("confirmだけがcompletionを1 row記録する", async () => {
    const { db, services } = fakeServices();
    const preview = fakeCommand({ userId: "test-owner" });
    await handlePublicEventCompleteCommand(preview, services);
    const id = customIds(preview.reply.mock.calls[0]![0]).find((value) => value.startsWith("pevc:ok:"))!;
    const button = fakeButton(id, "test-owner");
    await handlePublicEventCompleteButton(button, services);
    expect(completionCount(db)).toBe(1);
    expect(String(button.update.mock.calls[0]![0].content)).toContain("✅");
  });

  it("cancelでは書かない", async () => {
    const { db, services } = fakeServices();
    const preview = fakeCommand({ userId: "test-owner" });
    await handlePublicEventCompleteCommand(preview, services);
    const id = customIds(preview.reply.mock.calls[0]![0]).find((value) => value.startsWith("pevc:no:"))!;
    await handlePublicEventCompleteButton(fakeButton(id, "test-owner"), services);
    expect(completionCount(db)).toBe(0);
  });

  it("missing eventはpreview buttonを作らずfail-closed", async () => {
    const { db, services } = fakeServices();
    const preview = fakeCommand({ userId: "test-owner", eventKey: "missing-event" });
    await handlePublicEventCompleteCommand(preview, services);
    expect(String(preview.reply.mock.calls[0]![0].content)).toContain("確認できません");
    expect(completionCount(db)).toBe(0);
  });
});

describe("completion confirm safety", () => {
  it("preview開始admin本人以外のconfirmを拒否", async () => {
    const { db, services } = fakeServices();
    const preview = fakeCommand({ userId: "test-owner" });
    await handlePublicEventCompleteCommand(preview, services);
    const id = customIds(preview.reply.mock.calls[0]![0]).find((value) => value.startsWith("pevc:ok:"))!;
    const other = fakeButton(id, "other-admin", fakeMember("other-admin", [ADMIN_ROLE_ID]));
    await handlePublicEventCompleteButton(other, services);
    expect(other.update).not.toHaveBeenCalled();
    expect(completionCount(db)).toBe(0);
  });

  it("confirm直前にadmin権限を再検証", async () => {
    const { db, services } = fakeServices();
    const preview = fakeCommand({ userId: "role-admin", member: fakeMember("role-admin", [ADMIN_ROLE_ID]) });
    await handlePublicEventCompleteCommand(preview, services);
    const id = customIds(preview.reply.mock.calls[0]![0]).find((value) => value.startsWith("pevc:ok:"))!;
    const demoted = fakeButton(id, "role-admin", fakeMember("role-admin", []));
    await handlePublicEventCompleteButton(demoted, services);
    expect(String(demoted.update.mock.calls[0]![0].content)).toContain("運営権限");
    expect(completionCount(db)).toBe(0);
  });

  it("malformed/unknown customIdを拒否し、TTL expiryでも書かない", async () => {
    const { db, services } = fakeServices();
    const preview = fakeCommand({ userId: "test-owner" });
    await handlePublicEventCompleteCommand(preview, services);
    const ok = customIds(preview.reply.mock.calls[0]![0]).find((value) => value.startsWith("pevc:ok:"))!;
    const token = ok.split(":")[2]!;
    for (const malformed of [`pevc:unknown:${token}`, `pevc:ok:${token}:extra`, "pevc:"]) {
      await handlePublicEventCompleteButton(fakeButton(malformed, "test-owner"), services);
    }
    expect(completionCount(db)).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    const expired = fakeButton(ok, "test-owner");
    await handlePublicEventCompleteButton(expired, services);
    expect(String(expired.update.mock.calls[0]![0].content)).toContain("期限");
    expect(completionCount(db)).toBe(0);
  });
});
