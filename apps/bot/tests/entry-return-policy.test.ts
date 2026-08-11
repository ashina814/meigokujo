import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { GuildMember } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Returns, Settings, Tickets, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 出戻りは通常導線から入城できない、というルールの固定。
 *
 * 一度抜けた人を新規と同じ扱いで亡霊にすると、過去の在籍も元の階級も見ずに
 * 入城処理が走る。必ず出戻り申請 → 運営判断を通す。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const ticketsModule = import("../src/commands/tickets.js");
const displayModule = import("../src/commands/ticket-display.js");
const returnModule = import("../src/commands/entry-return.js");

const NEWCOMER = "111111111111111111";
const RETURNEE = "222222222222222222";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const returns = new Returns(db, settings, events);
  const tickets = new Tickets(db, events);
  const services = { db, ledger, settings, events, entry, evaluation, returns, tickets } as unknown as Services;
  return { db, ledger, settings, events, entry, evaluation, returns, tickets, services };
}

describe("通常の説明会判定と出戻りの切り分け", () => {
  it("新規の案内待ちは通常判定で亡霊になれる", () => {
    const ctx = setup();
    ctx.entry.recordJoin(NEWCOMER);

    expect(ctx.returns.isReturnee(NEWCOMER)).toBe(false);
    const result = ctx.entry.ghostify(NEWCOMER, "user:judge");
    expect(result.blocked).toBeUndefined();
    expect(ctx.entry.getSoul(NEWCOMER)!.status).toBe("ghost");
    expect(result.granted).toBeGreaterThan(0);
  });

  it("出戻りの案内待ちは通常判定で亡霊にならない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(RETURNEE);
    ctx.entry.ghostify(RETURNEE, "user:judge");
    ctx.evaluation.promoteToMajin(RETURNEE, "user:judge");
    ctx.returns.recordDeparture(RETURNEE);
    ctx.returns.markReturnedToWaiting(RETURNEE, null);
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(RETURNEE);

    expect(ctx.returns.isReturnee(RETURNEE)).toBe(true);
    const result = ctx.entry.ghostify(RETURNEE, "user:judge");

    expect(result.blocked).toBe("returnee");
    expect(result.granted).toBe(0);
    // 台帳は1バイトも動かない
    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(RETURNEE)).toEqual(before);
    expect(ctx.events.listByTarget(RETURNEE).map((e) => e.type)).toContain("entry_ghostify_blocked_returnee");
  });

  it("亡霊ロールの手動付与など別経路からも迂回できない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(RETURNEE);
    ctx.returns.recordDeparture(RETURNEE);
    ctx.returns.markReturnedToWaiting(RETURNEE, null);

    // ghostify を直接呼んでも同じ結果になる（入口を選ばず止まる）
    expect(ctx.entry.ghostify(RETURNEE, "system:role-add").blocked).toBe("returnee");
    expect(ctx.entry.getSoul(RETURNEE)!.status).toBe("waiting");
    expect(ctx.ledger.balanceOf(`user:${RETURNEE}`)).toBe(0);
  });

  it("出戻りでも運営判断を通れば亡霊になれる", () => {
    const ctx = setup();
    ctx.entry.recordJoin(RETURNEE);
    ctx.returns.recordDeparture(RETURNEE);
    ctx.returns.markReturnedToWaiting(RETURNEE, null);

    const result = ctx.returns.reinstate(RETURNEE, "ghost", "user:staff", {});

    expect(result!.cycle!.promotionRequired).toBe(6);
    expect(ctx.entry.getSoul(RETURNEE)!.status).toBe("ghost");
    // 出戻り扱いは解けている（もう通常判定の対象外ではない）
    expect(ctx.returns.isReturnee(RETURNEE)).toBe(false);
  });
});

describe("再参加のDM", () => {
  const guildId = "1463201396567441441";

  it("設置済みなら出戻り申請への導線を出す", async () => {
    const { returnWelcomeMessage, returnPanelLink } = await returnModule;
    const ctx = setup();
    ctx.tickets.upsertPanel({ id: "return", name: "出戻り申請", title: "t", description: "d", buttonLabel: "b" }, "test");
    ctx.tickets.setPanelMessage("return", "ch-1", "msg-1", "test");

    const link = returnPanelLink(ctx.services, guildId);
    const dm = returnWelcomeMessage(ctx.services, guildId);

    expect(link).toBe(`https://discord.com/channels/${guildId}/ch-1/msg-1`);
    const description = dm.embeds[0]!.toJSON().description!;
    expect(description).toContain(link!);
    expect(description).toContain("出戻り申請");
    // 通常の説明会案内は出さない
    expect(description).not.toContain("説明会場VC");
  });

  it("未設置なら壊れたリンクを出さず、運営へ相談するよう案内する", async () => {
    const { returnWelcomeMessage, returnPanelLink } = await returnModule;
    const ctx = setup();
    ctx.tickets.upsertPanel({ id: "return", name: "出戻り申請", title: "t", description: "d", buttonLabel: "b" }, "test");
    // 設置していない（channelId / messageId が無い）

    expect(returnPanelLink(ctx.services, guildId)).toBeNull();
    const description = returnWelcomeMessage(ctx.services, guildId).embeds[0]!.toJSON().description!;
    expect(description).not.toContain("discord.com/channels");
    expect(description).toContain("運営にお声がけください");
  });

  it("パネル自体が無くてもリンクを作らない", async () => {
    const { returnPanelLink } = await returnModule;
    const ctx = setup();
    expect(returnPanelLink(ctx.services, guildId)).toBeNull();
  });
});

describe("チケットの状態が変わっても受付固有の操作を消さない", () => {
  function ticketRow(ctx: ReturnType<typeof setup>, panelId: string, purchaseId: number | null) {
    ctx.tickets.create("t-1", RETURNEE, panelId, { id: panelId, name: panelId, notifyRoleIds: [], staffRoleIds: [] });
    if (purchaseId !== null) {
      ctx.db.prepare("UPDATE tickets SET linked_purchase_id=? WHERE thread_id='t-1'").run(purchaseId);
    }
    return ctx.tickets.get("t-1")!;
  }
  const ids = (rows: { toJSON(): { components: unknown[] } }[]) =>
    rows.flatMap((r) => r.toJSON().components).map((c) => (c as { custom_id?: string }).custom_id);

  it("claim後も出戻りの戻し先selectが残る", async () => {
    const { ticketRowsFor } = await ticketsModule;
    const ctx = setup();
    const ticket = ticketRow(ctx, "return", null);

    expect(ids(ticketRowsFor(ctx.services, ticket, "open"))).toContain("ret:target");
    expect(ids(ticketRowsFor(ctx.services, ticket, "claimed"))).toContain("ret:target");
  });

  it("claim後も再評価の承認・見送りが残る", async () => {
    const { ticketRowsFor } = await ticketsModule;
    const ctx = setup();
    const ticket = ticketRow(ctx, "reeval", 63);

    const claimed = ids(ticketRowsFor(ctx.services, ticket, "claimed"));
    expect(claimed).toContain("reeval:approve");
    expect(claimed).toContain("reeval:reject");
  });

  it("確定後（closed）は操作を残しつつ無効化する", async () => {
    const { ticketRowsFor } = await ticketsModule;
    const ctx = setup();
    const ticket = ticketRow(ctx, "return", null);

    const rows = ticketRowsFor(ctx.services, ticket, "closed");
    const select = rows.flatMap((r) => r.toJSON().components).find((c) => (c as { custom_id?: string }).custom_id === "ret:target");
    expect(select).toBeDefined();
    expect((select as { disabled?: boolean }).disabled).toBe(true);
    // 共通ボタンも完了状態
    const close = rows.flatMap((r) => r.toJSON().components).find((c) => (c as { custom_id?: string }).custom_id === "ticket:close");
    expect((close as { disabled?: boolean }).disabled).toBe(true);
  });

  it("面談権が無い再評価チケットでは承認を押せない", async () => {
    const { ticketRowsFor } = await ticketsModule;
    const ctx = setup();
    const ticket = ticketRow(ctx, "reeval", null);

    const approve = ticketRowsFor(ctx.services, ticket, "claimed")
      .flatMap((r) => r.toJSON().components)
      .find((c) => (c as { custom_id?: string }).custom_id === "reeval:approve");
    expect((approve as { disabled?: boolean }).disabled).toBe(true);
  });
});

describe("確定後のDiscord側の完了処理", () => {
  function fakeThread(opts: { renameFails?: boolean } = {}) {
    return {
      id: "t-1",
      name: "🔴未対応｜出戻り申請-someone",
      setName: vi.fn(async (name: string) => {
        if (opts.renameFails) throw new Error("Missing Permissions");
        return name;
      }),
      setLocked: vi.fn(async () => undefined),
      setArchived: vi.fn(async () => undefined),
    };
  }

  it("操作UIの無効化・スレッド名・lock/archive まで行う", async () => {
    const { finalizeTicketDiscordState } = await displayModule;
    const { ticketRowsFor } = await ticketsModule;
    const ctx = setup();
    ctx.tickets.create("t-1", RETURNEE, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [] });
    ctx.tickets.close("t-1", "user:staff");
    const thread = fakeThread();
    const edit = vi.fn(async () => undefined);

    const problems = await finalizeTicketDiscordState(ctx.services, thread as never, ctx.tickets.get("t-1"), {
      controlMessage: { content: "📮 出戻り申請\n\n🔴 **対応状況:** 未対応", edit },
      // 受付固有の操作行は呼び出し側が渡す（依存の向きを一方向に保つため）
      components: ticketRowsFor(ctx.services, ctx.tickets.get("t-1"), "closed"),
      actor: "user:staff",
      reason: "出戻り申請の対応完了",
    });

    expect(problems).toEqual([]);
    expect(edit).toHaveBeenCalledTimes(1);
    const payload = (edit.mock.calls[0] as never[])[0] as { content: string; components: { toJSON(): { components: unknown[] } }[] };
    expect(payload.content).toContain("✅ **対応状況:** 完了");
    // 受付固有の操作は残しつつ無効化されている
    const select = payload.components.flatMap((r) => r.toJSON().components).find((c) => (c as { custom_id?: string }).custom_id === "ret:target");
    expect((select as { disabled?: boolean }).disabled).toBe(true);
    expect(thread.setName).toHaveBeenCalled();
    expect(String((thread.setName.mock.calls[0] as never[])[0])).toContain("✅完了｜");
    expect(thread.setLocked).toHaveBeenCalled();
    expect(thread.setArchived).toHaveBeenCalled();
  });

  it("表示だけ失敗しても台帳は巻き戻さず、修復が必要なことを記録する", async () => {
    const { finalizeTicketDiscordState } = await displayModule;
    const ctx = setup();
    ctx.tickets.create("t-1", RETURNEE, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [] });
    ctx.tickets.close("t-1", "user:staff");
    const thread = fakeThread({ renameFails: true });

    const problems = await finalizeTicketDiscordState(ctx.services, thread as never, ctx.tickets.get("t-1"), {
      controlMessage: null,
      actor: "user:staff",
      reason: "出戻り申請の対応完了",
    });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("スレッド名");
    // DB側の完了は取り消さない
    expect(ctx.tickets.get("t-1")!.status).toBe("closed");
    expect(ctx.events.listByType("ticket_display_repair_needed")).toHaveLength(1);
  });
});
