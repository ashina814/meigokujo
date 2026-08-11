import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Returns, Settings, Tickets, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 出戻りの導線が端から端まで繋がっているか。
 *
 * 以前、判断材料と戻し先の選択をチケットへ**送り忘れていた**（import しただけで
 * `thread.send` の components へ足していなかった）ため、押せる画面が存在しなかった。
 * 「受付 → チケット作成 → 戻し先の選択 → 理由modal → 確定」まで到達できることを固定する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const ticketsModule = import("../src/commands/tickets.js");
const returnModule = import("../src/commands/entry-return.js");

const ROLE = { ghost: "r-ghost", majin: "r-majin", meirei: "r-meirei", wait: "r-wait", staff: "r-staff" };
const USER = "1463201396567441441";
const STAFF_USER = "222222222222222222";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const returns = new Returns(db, settings, events);
  const tickets = new Tickets(db, events);
  for (const [k, v] of [
    ["role:ghost", ROLE.ghost],
    ["role:majin", ROLE.majin],
    ["role:meirei", ROLE.meirei],
    ["role:queue_wait", ROLE.wait],
    ["role:ticket_staff", ROLE.staff],
  ] as const) {
    settings.set(k, v, "test");
  }
  tickets.upsertPanel(
    { id: "return", name: "出戻り申請", title: "出戻り申請", description: "説明", buttonLabel: "申請", staffRoleIds: [ROLE.staff] },
    "test",
  );
  const services = { db, ledger, settings, events, entry, evaluation, returns, tickets } as unknown as Services;
  return { db, ledger, settings, events, entry, evaluation, returns, tickets, services };
}

/** 退出して戻ってきた魔人 */
function returnee(ctx: ReturnType<typeof setup>) {
  ctx.entry.recordJoin(USER);
  ctx.entry.ghostify(USER, "test");
  ctx.evaluation.promoteToMajin(USER, "test");
  ctx.returns.recordDeparture(USER);
  ctx.returns.markReturnedToWaiting(USER, null);
}

function fakeGuild(memberRoles: string[]) {
  const cache = new Collection(memberRoles.map((r) => [r, { id: r }] as [string, { id: string }]));
  const member = {
    id: USER,
    joinedTimestamp: 1_700_000_000_000,
    roles: {
      cache,
      remove: vi.fn(async (id: string) => void cache.delete(id)),
      add: vi.fn(async (id: string) => void cache.set(id, { id })),
    },
  } as unknown as GuildMember;
  const guild = {
    id: "g1",
    members: { fetch: vi.fn(async () => member), me: { roles: { highest: { position: 100 } } } },
    roles: { cache: new Collection(Object.values(ROLE).map((r) => [r, { id: r, position: 10 }] as [string, { id: string; position: number }])) },
  } as unknown as Guild;
  return { guild, member, cache };
}

describe("出戻り導線が端から端まで繋がっている", () => {
  it("returnパネルのチケットには判断材料と戻し先の選択が付く", async () => {
    const { buildTicketOpeningMessage } = await ticketsModule;
    const ctx = setup();
    returnee(ctx);
    const { member } = fakeGuild([ROLE.wait]);
    const panel = ctx.tickets.getPanel("return")!;

    const message = buildTicketOpeningMessage(ctx.services, panel, USER, member, {
      panelName: panel.name,
      notifyRoleIds: [],
      invitedFailed: 0,
      reevalPurchaseId: null,
    });

    // 戻し先の選択が実際に付いている（押せる画面が存在する）
    const customIds = message.components.flatMap((row) => row.toJSON().components).map((c) => (c as { custom_id?: string }).custom_id);
    expect(customIds).toContain("ret:target");
    // 判断材料の埋め込みも付いている
    expect(message.embeds.length).toBeGreaterThan(0);
    const embed = message.embeds[0]!.toJSON();
    expect(embed.title).toContain("出戻り");
    expect(JSON.stringify(embed.fields)).toContain("majin"); // 最終階級が読める
  });

  it("通常の受付にはボタンだけが付く（余計な選択は出ない）", async () => {
    const { buildTicketOpeningMessage } = await ticketsModule;
    const ctx = setup();
    ctx.tickets.upsertPanel(
      { id: "consult", name: "個別相談", title: "個別相談", description: "説明", buttonLabel: "相談" },
      "test",
    );
    const { member } = fakeGuild([]);
    const panel = ctx.tickets.getPanel("consult")!;

    const message = buildTicketOpeningMessage(ctx.services, panel, USER, member, {
      panelName: panel.name,
      notifyRoleIds: [],
      invitedFailed: 0,
      reevalPurchaseId: null,
    });

    const customIds = message.components.flatMap((row) => row.toJSON().components).map((c) => (c as { custom_id?: string }).custom_id);
    expect(customIds).toContain("ticket:claim");
    expect(customIds).not.toContain("ret:target");
    expect(message.embeds).toHaveLength(0);
  });

  it("再評価面談の受付には承認・見送りが付く（同じ足し忘れを繰り返さない）", async () => {
    const { buildTicketOpeningMessage } = await ticketsModule;
    const ctx = setup();
    ctx.tickets.upsertPanel(
      { id: "reeval", name: "再評価面談", title: "再評価面談", description: "説明", buttonLabel: "申請" },
      "test",
    );
    const { member } = fakeGuild([]);
    const panel = ctx.tickets.getPanel("reeval")!;

    const message = buildTicketOpeningMessage(ctx.services, panel, USER, member, {
      panelName: panel.name,
      notifyRoleIds: [],
      invitedFailed: 0,
      reevalPurchaseId: 63,
    });

    const customIds = message.components.flatMap((row) => row.toJSON().components).map((c) => (c as { custom_id?: string }).custom_id);
    expect(customIds).toContain("reeval:approve");
    expect(customIds).toContain("reeval:reject");
  });

  it("選択 → 理由modal → 確定 まで到達できる", async () => {
    const { handleReturnTargetSelect, handleReturnReasonSubmit } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    const { guild, cache } = fakeGuild([ROLE.wait]);
    ctx.tickets.create("t-1", USER, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [ROLE.staff] });

    // 1) 運営が戻し先を選ぶ → 理由modal が出る
    const staffMember = { roles: { cache: new Collection([[ROLE.staff, { id: ROLE.staff }]]) } };
    const showModal = vi.fn(async () => undefined);
    await handleReturnTargetSelect(
      { values: ["ghost"], member: staffMember, showModal, reply: vi.fn(), user: { id: STAFF_USER } } as never,
      ctx.services,
    );
    expect(showModal).toHaveBeenCalledTimes(1);
    const modal = (showModal.mock.calls[0] as unknown[])[0] as { data: { custom_id: string } };
    expect(modal.data.custom_id).toBe("ret:reason:ghost");

    // 2) 理由を書いて確定
    const editReply = vi.fn(async () => undefined);
    await handleReturnReasonSubmit(
      {
        customId: "ret:reason:ghost",
        channelId: "t-1",
        guild,
        member: staffMember,
        user: { id: STAFF_USER },
        fields: { getTextInputValue: () => "反省が見られたため" },
        reply: vi.fn(),
        deferReply: vi.fn(async () => undefined),
        editReply,
      } as never,
      ctx.services,
    );

    // 台帳・ロール・チケットがすべて揃う
    const soul = ctx.entry.getSoul(USER)!;
    expect(soul.status).toBe("ghost");
    expect(soul.eval_promotion_required).toBe(6); // 出戻りの +1
    expect(cache.has(ROLE.ghost)).toBe(true);
    expect(cache.has(ROLE.wait)).toBe(false);
    expect(ctx.tickets.get("t-1")!.status).toBe("closed");
    const audit = ctx.events.listByTarget(USER).find((e) => e.type === "entry_return_reinstated")!;
    expect(JSON.parse(audit.payload_json!)).toMatchObject({ to: "ghost", reason: "反省が見られたため" });
    expect(ctx.events.listByType("entry_return_roles_verified")).toHaveLength(1);
    expect(editReply).toHaveBeenCalled();
  });

  it("戻し先のロールが未設定なら、台帳もチケットも変更しない", async () => {
    const { handleReturnReasonSubmit } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    ctx.db.prepare("DELETE FROM settings WHERE key='role:ghost'").run();
    const { guild } = fakeGuild([ROLE.wait]);
    ctx.tickets.create("t-1", USER, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [ROLE.staff] });
    const reply = vi.fn(async () => undefined);

    await handleReturnReasonSubmit(
      {
        customId: "ret:reason:ghost",
        channelId: "t-1",
        guild,
        member: { roles: { cache: new Collection([[ROLE.staff, { id: ROLE.staff }]]) } },
        user: { id: STAFF_USER },
        fields: { getTextInputValue: () => "理由" },
        reply,
        deferReply: vi.fn(),
        editReply: vi.fn(),
      } as never,
      ctx.services,
    );

    expect(ctx.entry.getSoul(USER)!.status).toBe("waiting");
    expect(ctx.tickets.get("t-1")!.status).toBe("open");
    expect(String((reply.mock.calls[0] as never[])[0].content)).toContain("ロール設定");
  });
});
