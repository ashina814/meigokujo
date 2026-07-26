import { describe, expect, it, vi } from "vitest";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));
vi.mock("../src/church-roles.js", () => ({ isChurchManager: () => false }));

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: "poster",
    status: "open",
    thread_id: "thread",
    claimed_by: "staff",
    created_at: 1,
    claimed_at: null,
    closed_at: null,
    type: "iken",
    reply_wish: "no",
    body: "返信は不要です。",
    stage: "active",
    disposition: null,
    disposition_at: null,
    disposition_by: null,
    close_reason: null,
    closed_by: null,
    body_purge_at: null,
    body_purged_at: null,
    body_retention_reason: null,
    panel_msg_id: null,
    court_status: null,
    court_category: null,
    court_consent: null,
    court_thread_id: null,
    court_url: null,
    court_case_no: null,
    ...overrides,
  };
}

function makeHarness(sendDm: () => Promise<void>) {
  const row = makeRow();
  const threadSend = vi.fn(async () => undefined);
  const setArchived = vi.fn(async () => undefined);
  const thread = { isThread: () => true, send: threadSend, setArchived };
  const editReply = vi.fn(async () => undefined);

  const interaction = {
    user: { id: "staff" },
    client: {
      users: { fetch: vi.fn(async () => ({ send: sendDm })) },
      channels: { fetch: vi.fn(async () => thread) },
    },
    deferReply: vi.fn(async () => undefined),
    editReply,
    reply: vi.fn(async () => undefined),
  };
  const services = {
    settings: { getNumber: vi.fn(() => 90) },
    confessions: {
      get: vi.fn(() => row),
      closeVoiceReceivedAtomic: vi.fn(() => ({
        ok: true,
        row: makeRow({ status: "closed", close_reason: "voice_received", closed_by: "staff" }),
      })),
      openEmergencyFor: vi.fn(() => null),
      closeEmergency: vi.fn(),
      isAssignee: vi.fn(() => false),
    },
  };

  return { interaction, services, threadSend, setArchived, editReply };
}

describe("トートの耳・返信不要案件の専用クローズ", () => {
  it("DM成功時は投稿者へ伝えたことを担当者に表示する", async () => {
    const { interaction, services, threadSend, editReply, setArchived } = makeHarness(vi.fn(async () => undefined));
    const { closeAsVoiceReceived } = await import("../src/commands/confession.js");

    await closeAsVoiceReceived(interaction as any, services as any, 1);

    expect(services.confessions.closeVoiceReceivedAtomic).toHaveBeenCalledWith(1, "staff", 90);
    expect(editReply).toHaveBeenCalledWith({
      content: "投稿者へ『あなたの声は届きました』と伝えてクローズしました",
    });
    expect(threadSend.mock.calls[0]?.[0]?.content).toContain("DM送信にも成功");
    expect(setArchived).toHaveBeenCalledWith(true);
  });

  it("DM失敗時もクローズは維持し、DMできなかったことを担当者とスレッドに残す", async () => {
    const { interaction, services, threadSend, editReply, setArchived } = makeHarness(
      vi.fn(async () => {
        throw new Error("dm disabled");
      }),
    );
    const { closeAsVoiceReceived } = await import("../src/commands/confession.js");

    await closeAsVoiceReceived(interaction as any, services as any, 1);

    expect(services.confessions.closeVoiceReceivedAtomic).toHaveBeenCalledWith(1, "staff", 90);
    expect(editReply).toHaveBeenCalledWith({
      content: "案件はクローズしましたが、投稿者へDMを送れませんでした",
    });
    expect(threadSend.mock.calls[0]?.[0]?.content).toContain("DMを送れませんでした");
    expect(setArchived).toHaveBeenCalledWith(true);
  });
});
