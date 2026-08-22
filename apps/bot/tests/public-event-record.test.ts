import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { openDb, PublicEvents, Settings } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { handlePublicEventRecordButton, handlePublicEventRecordCommand } from "../src/commands/public-event-record.js";

const ADMIN_ROLE_ID = "admin-role-id";

function fakeServices() {
  const db = openDb(":memory:");
  const publicEvents = new PublicEvents(db);
  const settings = new Settings(db);
  settings.set("role:admin", ADMIN_ROLE_ID, "test-setup");
  return { db, settings, services: { publicEvents, settings } as unknown as Services };
}

/** roles.cache.has()で判定できる最小限のfake GuildMember。admin roleの有無を後から切り替えられる。 */
function fakeMember(userId: string, roleIds: readonly string[]) {
  return { id: userId, roles: { cache: new Map(roleIds.map((id) => [id, {}])) } };
}

function fakeChatInput(opts: {
  userId: string;
  member?: ReturnType<typeof fakeMember> | null;
  eventKey?: string;
  name?: string;
  eventDate?: string;
  participants?: string;
}) {
  const optionValues: Record<string, string> = {
    イベントキー: opts.eventKey ?? "gf-2026-08-22",
    イベント名: opts.name ?? "God Field大会",
    開催日: opts.eventDate ?? "2026-08-22",
    参加者: opts.participants ?? "111111111111111111 222222222222222222",
  };
  return {
    id: `cmd-${Math.random()}`,
    user: { id: opts.userId },
    member: opts.member ?? null,
    options: { getString: (name: string) => optionValues[name] ?? null },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & { reply: ReturnType<typeof vi.fn> };
}

function fakeButton(customId: string, userId: string, member?: ReturnType<typeof fakeMember> | null) {
  return {
    customId,
    id: `btn-${Math.random()}`,
    user: { id: userId },
    member: member ?? null,
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & { update: ReturnType<typeof vi.fn> };
}

function extractCustomIds(payload: unknown): string[] {
  const rows = ((payload as { components?: unknown[] }).components ?? []) as Array<{
    toJSON(): { components: Array<{ custom_id?: string }> };
  }>;
  return rows.flatMap((row) => row.toJSON().components.map((c) => c.custom_id ?? ""));
}

beforeEach(() => {
  process.env.OWNER_ID ??= "test-owner";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("運営限定ゲート", () => {
  it("運営でないuserはpreviewすら出せない、DB 0", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "not-an-admin" });
    await handlePublicEventRecordCommand(interaction, services);
    expect(String(interaction.reply.mock.calls[0]![0].content)).toContain("運営限定");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });
});

describe("§61 preview → confirm / cancel flow", () => {
  it("slash実行 → previewのみ、DB 0 rows", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "test-owner" });
    await handlePublicEventRecordCommand(interaction, services);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0]![0];
    expect(payload.flags).toBeDefined(); // ephemeral
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_event_participations`).get()).toEqual({ c: 0 });
  });

  it("confirm → DB rowsが作られる", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "test-owner" });
    await handlePublicEventRecordCommand(interaction, services);
    const customId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:ok:"))!;

    const button = fakeButton(customId, "test-owner");
    await handlePublicEventRecordButton(button, services);

    expect(button.update).toHaveBeenCalledTimes(1);
    expect(String(button.update.mock.calls[0]![0].content)).toContain("✅");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_event_participations`).get()).toEqual({ c: 2 });
  });

  it("cancel → DB 0のまま", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "test-owner" });
    await handlePublicEventRecordCommand(interaction, services);
    const customId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:no:"))!;

    const button = fakeButton(customId, "test-owner");
    await handlePublicEventRecordButton(button, services);

    expect(String(button.update.mock.calls[0]![0].content)).toContain("やめました");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });
});

describe("§62 invalid participant token → entire request reject", () => {
  it("有効tokenと不正tokenが混ざると全体rejectし、有効な分だけ保存しない", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({
      userId: "test-owner",
      participants: "<@111111111111111111> garbage <@222222222222222222>",
    });
    await handlePublicEventRecordCommand(interaction, services);

    const payload = interaction.reply.mock.calls[0]![0];
    expect(String(payload.content)).toContain("認識できない");
    expect(payload.components).toBeUndefined(); // previewボタンは出さない
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });

  it("メンション形式・生ID形式はどちらも受け付ける", async () => {
    const { services } = fakeServices();
    const interaction = fakeChatInput({
      userId: "test-owner",
      participants: "<@111111111111111111> 222222222222222222 <@!333333333333333333>",
    });
    await handlePublicEventRecordCommand(interaction, services);
    const payload = interaction.reply.mock.calls[0]![0];
    expect(String(payload.description ?? JSON.stringify(payload))).not.toContain("認識できない");
  });
});

describe("§63 unauthorized confirm", () => {
  it("admin Aがpreview、admin Bがconfirm → DB 0", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "test-owner" }); // admin A（isAdmin()を通す唯一のtest identity）
    await handlePublicEventRecordCommand(interaction, services);
    const customId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:ok:"))!;

    const button = fakeButton(customId, "admin-b"); // 別人（confirm時にisAdmin()は再検証しないが、initiator bindingで弾かれるはず）
    await handlePublicEventRecordButton(button, services);

    expect(button.update).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });
});

describe("§64 expired confirm", () => {
  it("TTL超過後のconfirmはDB 0のまま", async () => {
    vi.useFakeTimers();
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "test-owner" });
    await handlePublicEventRecordCommand(interaction, services);
    const customId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:ok:"))!;

    vi.advanceTimersByTime(10 * 60_000); // TTL(5分)を超過させる

    const button = fakeButton(customId, "test-owner");
    await handlePublicEventRecordButton(button, services);

    expect(String(button.update.mock.calls[0]![0].content)).toContain("期限");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });
});

describe("§65 customId leak test", () => {
  it("button customIdにparticipant ID・eventKey・event名が含まれない", async () => {
    const { services } = fakeServices();
    const interaction = fakeChatInput({
      userId: "test-owner",
      eventKey: "gf-2026-08-22",
      name: "God Field大会シークレット",
      participants: "<@111111111111111111>",
    });
    await handlePublicEventRecordCommand(interaction, services);
    const payload = interaction.reply.mock.calls[0]![0];
    const customIds = extractCustomIds(payload);
    expect(customIds.length).toBeGreaterThan(0);
    for (const id of customIds) {
      expect(id).not.toContain("111111111111111111");
      expect(id).not.toContain("gf-2026-08-22");
      expect(id).not.toContain("God");
    }
  });
});

describe("PR #162レビュー BLOCKER 1: unknown pev actionのfail-close", () => {
  it("有効なpending tokenでも未知actionはDB 0・recordFinalizedEvent到達0", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({ userId: "test-owner" });
    await handlePublicEventRecordCommand(interaction, services);
    const okCustomId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:ok:"))!;
    const token = okCustomId.split(":")[2]!;

    const spy = vi.spyOn(services.publicEvents, "recordFinalizedEvent");
    const button = fakeButton(`pev:future_unknown:${token}`, "test-owner");
    await handlePublicEventRecordButton(button, services);

    expect(spy).not.toHaveBeenCalled();
    expect(button.update).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });

  it("有効tokenでも malformed customId（actionもtokenも無い）はDB 0", async () => {
    const { db, services } = fakeServices();
    const button = fakeButton("pev:", "test-owner");
    await handlePublicEventRecordButton(button, services);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });
});

describe("PR #162レビュー BLOCKER 2: confirm時のadmin権限再検証", () => {
  it("admin Aがpreview、confirm前にA本人のadmin権限を外す → A本人のConfirmでもDB 0", async () => {
    const { db, services } = fakeServices();
    // OWNERは常にadminなので、role保持だけでadminになる非OWNER identityを使う。
    const adminMember = fakeMember("non-owner-admin", [ADMIN_ROLE_ID]);
    const interaction = fakeChatInput({ userId: "non-owner-admin", member: adminMember });
    await handlePublicEventRecordCommand(interaction, services);
    const customId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:ok:"))!;

    // confirm前にA本人からadmin roleを外す（同じuserIdだが、role非保持のmemberでconfirm）。
    const demotedMember = fakeMember("non-owner-admin", []);
    const button = fakeButton(customId, "non-owner-admin", demotedMember);
    await handlePublicEventRecordButton(button, services);

    expect(String(button.update.mock.calls[0]![0].content)).toContain("運営権限");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
  });

  it("admin権限を保持したままのconfirmは通常通り成功する（回帰確認）", async () => {
    const { db, services } = fakeServices();
    const adminMember = fakeMember("non-owner-admin", [ADMIN_ROLE_ID]);
    const interaction = fakeChatInput({ userId: "non-owner-admin", member: adminMember });
    await handlePublicEventRecordCommand(interaction, services);
    const customId = extractCustomIds(interaction.reply.mock.calls[0]![0]).find((id) => id.startsWith("pev:ok:"))!;

    const button = fakeButton(customId, "non-owner-admin", adminMember);
    await handlePublicEventRecordButton(button, services);

    expect(String(button.update.mock.calls[0]![0].content)).toContain("✅");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 1 });
  });
});

describe("PR #162レビュー BLOCKER 3: preview participant countはdedupe後の値と一致する", () => {
  it("111, 222, <@111> → preview 2人 → confirm result 2人 → DB 2 rows", async () => {
    const { db, services } = fakeServices();
    const interaction = fakeChatInput({
      userId: "test-owner",
      participants: "111111111111111111 222222222222222222 <@111111111111111111>",
    });
    await handlePublicEventRecordCommand(interaction, services);
    const payload = interaction.reply.mock.calls[0]![0];
    const embedJson = (payload.embeds[0] as { toJSON(): { description?: string } }).toJSON();
    expect(String(embedJson.description)).toContain("参加者: **2人**");

    const customId = extractCustomIds(payload).find((id) => id.startsWith("pev:ok:"))!;
    const button = fakeButton(customId, "test-owner");
    await handlePublicEventRecordButton(button, services);

    expect(String(button.update.mock.calls[0]![0].content)).toContain("参加者: 2人");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_event_participations`).get()).toEqual({ c: 2 });
  });
});
