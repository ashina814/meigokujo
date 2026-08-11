import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Returns, Settings, Shop, Tickets, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 確定したあと、**チケットの操作メッセージが実際に完了表示へ変わるか**。
 *
 * 以前、確定ハンドラは `controlMessage: null` を渡していたため、台帳は閉じたのに
 * 操作UIは押せるまま残っていた（報告文だけ「完了」と出る状態）。
 * ここでは組み立て関数ではなく**実ハンドラを通して**、元メッセージへ届いた
 * 編集内容を検証する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const returnModule = import("../src/commands/entry-return.js");
const reevalModule = import("../src/commands/reeval.js");

const ROLE = { ghost: "r-ghost", majin: "r-majin", meirei: "r-meirei", wait: "r-wait", staff: "r-staff" };
const USER = "1463201396567441441";
const STAFF_USER = "222222222222222222";
const THREAD = "t-1";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const returns = new Returns(db, settings, events);
  const shop = new Shop(db, ledger, events);
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
  const item = shop.createItem({ name: "再評価チャレンジ", price_land: 100, kind: "one_shot", delivery: "manual" }, "test");
  settings.set("shop:reeval_item_id", item.id, "test");
  const services = { db, ledger, settings, events, entry, evaluation, returns, shop, tickets, item } as unknown as Services;
  return { db, ledger, settings, events, entry, evaluation, returns, shop, tickets, item, services };
}

/** 実際のチケット操作メッセージの代わり。編集内容をそのまま受け取る */
function controlMessage() {
  const state = { content: ["📮 **受付** — <@u>", "", "🔴 **対応状況:** 未対応"].join("\n"), payload: null as null | Record<string, unknown> };
  return {
    message: {
      id: "m-1",
      get content() {
        return state.content;
      },
      edit: vi.fn(async (payload: Record<string, unknown>) => {
        state.payload = payload;
        state.content = String(payload.content);
        return undefined;
      }),
    },
    state,
  };
}

/** ロック・アーカイブまで含めたスレッド。失敗を差し込める */
function fakeThread(opts: { lockFails?: boolean; archiveFails?: boolean; renameFails?: boolean } = {}) {
  return {
    id: THREAD,
    name: "🔴未対応｜出戻り-テスト",
    setName: vi.fn(async function (this: { name: string }, name: string) {
      if (opts.renameFails) throw new Error("Missing Access");
      this.name = name;
      return undefined;
    }),
    setLocked: vi.fn(async () => {
      if (opts.lockFails) throw new Error("Missing Permissions");
      return undefined;
    }),
    setArchived: vi.fn(async () => {
      if (opts.archiveFails) throw new Error("Missing Permissions");
      return undefined;
    }),
  };
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
    roles: {
      cache: new Collection(Object.values(ROLE).map((r) => [r, { id: r, position: 10 }] as [string, { id: string; position: number }])),
    },
  } as unknown as Guild;
  return { guild, member, cache };
}

const staffMember = { roles: { cache: new Collection([[ROLE.staff, { id: ROLE.staff }]]) } };

/** 編集後のメッセージから、操作の状態を読む */
function componentState(payload: Record<string, unknown> | null) {
  const rows = (payload?.components ?? []) as { toJSON(): { components: unknown[] } }[];
  const components = rows.flatMap((row) => row.toJSON().components) as { custom_id?: string; disabled?: boolean; label?: string }[];
  return {
    content: String(payload?.content ?? ""),
    ids: components.map((c) => c.custom_id),
    of: (id: string) => components.find((c) => c.custom_id === id),
  };
}

describe("出戻りの確定が操作UIを完了状態にする", () => {
  function returnee(ctx: ReturnType<typeof setup>) {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.evaluation.promoteToMajin(USER, "test");
    ctx.returns.recordDeparture(USER);
    ctx.returns.markReturnedToWaiting(USER, null);
  }

  async function submitReturn(ctx: ReturnType<typeof setup>, thread: ReturnType<typeof fakeThread>) {
    const { handleReturnReasonSubmit } = await returnModule;
    const { guild } = fakeGuild([ROLE.wait]);
    ctx.tickets.create(THREAD, USER, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [ROLE.staff] });
    const control = controlMessage();
    await handleReturnReasonSubmit(
      {
        customId: "ret:reason:ghost",
        channelId: THREAD,
        channel: thread,
        message: control.message,
        guild,
        member: staffMember,
        user: { id: STAFF_USER },
        fields: { getTextInputValue: () => "反省が見られたため" },
        reply: vi.fn(async () => undefined),
        deferReply: vi.fn(async () => undefined),
        editReply: vi.fn(async () => undefined),
      } as never,
      ctx.services,
    );
    return control;
  }

  it("戻し先の選択 → 理由modal → 確定 で、元メッセージが完了表示になり操作が無効化される", async () => {
    const ctx = setup();
    returnee(ctx);
    const thread = fakeThread();
    const control = await submitReturn(ctx, thread);

    expect(control.message.edit).toHaveBeenCalledTimes(1);
    const ui = componentState(control.state.payload);
    expect(ui.content).toContain("✅ **対応状況:** 完了");
    expect(ui.content).not.toContain("🔴 **対応状況:**");
    // 受付固有の操作（戻し先の選択）は残るが押せない
    expect(ui.of("ret:target")?.disabled).toBe(true);
    // 共通の「対応する」も無効
    expect(ui.of("ticket:claim")?.disabled).toBe(true);
    // スレッドも完了名 + ロック + アーカイブ
    expect(thread.setName).toHaveBeenCalledWith("✅完了｜出戻り-テスト", expect.any(String));
    expect(thread.setLocked).toHaveBeenCalled();
    expect(thread.setArchived).toHaveBeenCalled();
    expect(ctx.events.listByType("ticket_display_repair_needed")).toHaveLength(0);
  });

  it("ロックだけ失敗しても修復対象として記録される（握り潰さない）", async () => {
    const ctx = setup();
    returnee(ctx);
    const thread = fakeThread({ lockFails: true });
    await submitReturn(ctx, thread);

    // 台帳は確定済み
    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
    const repair = ctx.events.listByType("ticket_display_repair_needed");
    expect(repair).toHaveLength(1);
    expect(JSON.parse(repair[0]!.payload_json!).problems.join(" ")).toContain("ロックに失敗");
  });
});

describe("再評価面談の確定が操作UIを完了状態にする", () => {
  function ready(ctx: ReturnType<typeof setup>) {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    ctx.ledger.transfer({
      from: "sys:treasury",
      to: `user:${USER}`,
      amount: 10_000,
      type: "adjust",
      actor: "test",
      idempotencyKey: `seed-${USER}`,
    });
    const purchase = ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: "test", memberRoleIds: [] }).purchase;
    ctx.tickets.upsertPanel(
      { id: "reeval", name: "再評価面談", title: "再評価面談", description: "説明", buttonLabel: "申請", staffRoleIds: [ROLE.staff] },
      "test",
    );
    ctx.tickets.create(THREAD, USER, "reeval", { id: "reeval", name: "再評価面談", notifyRoleIds: [], staffRoleIds: [ROLE.staff] });
    ctx.tickets.linkPurchase(THREAD, purchase.id, "test");
    return purchase.id;
  }

  async function press(ctx: ReturnType<typeof setup>, which: "approve" | "reject") {
    const mod = await reevalModule;
    const { guild } = fakeGuild([ROLE.meirei]);
    const thread = fakeThread();
    const control = controlMessage();
    const handler = which === "approve" ? mod.handleReevalApprove : mod.handleReevalReject;
    await handler(
      {
        customId: `reeval:${which}`,
        channelId: THREAD,
        channel: thread,
        message: control.message,
        guild,
        member: staffMember,
        user: { id: STAFF_USER },
        reply: vi.fn(),
        deferReply: vi.fn(async () => undefined),
        editReply: vi.fn(async () => undefined),
      } as never,
      ctx.services,
    );
    return { control, thread };
  }

  it("承認を押すと、元メッセージが完了表示になり承認・見送りが無効化される", async () => {
    const ctx = setup();
    ready(ctx);
    const { control, thread } = await press(ctx, "approve");

    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
    const ui = componentState(control.state.payload);
    expect(ui.content).toContain("✅ **対応状況:** 完了");
    expect(ui.of("reeval:approve")?.disabled).toBe(true);
    expect(ui.of("reeval:reject")?.disabled).toBe(true);
    expect(ui.of("ticket:claim")?.disabled).toBe(true);
    expect(thread.setLocked).toHaveBeenCalled();
  });

  it("見送りを押した場合も同じく完了表示になる", async () => {
    const ctx = setup();
    ready(ctx);
    const { control } = await press(ctx, "reject");

    expect(ctx.entry.getSoul(USER)!.status).toBe("meirei"); // 見送りは階級を動かさない
    const ui = componentState(control.state.payload);
    expect(ui.content).toContain("✅ **対応状況:** 完了");
    expect(ui.of("reeval:approve")?.disabled).toBe(true);
  });
});

describe("表示だけの修復", () => {
  it("クローズ済みチケットの「表示を修復」で、台帳を触らずに完了表示へ直せる", async () => {
    const { handleTicketButton } = await import("../src/commands/tickets.js");
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.tickets.create(THREAD, USER, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [ROLE.staff] });
    ctx.tickets.close(THREAD, "user:staff"); // 台帳だけ閉じ、表示は未対応のまま残っている
    const closedAt = ctx.tickets.get(THREAD)!.closed_at;

    const thread = fakeThread();
    const control = controlMessage();
    const reply = vi.fn(async () => undefined);
    await handleTicketButton(
      {
        customId: "ticket:close",
        channelId: THREAD,
        channel: thread,
        message: control.message,
        guild: fakeGuild([]).guild,
        member: staffMember,
        user: { id: STAFF_USER },
        reply,
      } as never,
      ctx.services,
    );

    const ui = componentState(control.state.payload);
    expect(ui.content).toContain("✅ **対応状況:** 完了");
    expect(ui.of("ret:target")?.disabled).toBe(true);
    expect(thread.setName).toHaveBeenCalledWith("✅完了｜出戻り-テスト", expect.any(String));
    expect(thread.setLocked).toHaveBeenCalled();
    // 台帳は一切動かない
    expect(ctx.tickets.get(THREAD)!.closed_at).toBe(closedAt);
    expect(String((reply.mock.calls[0] as never[])[0].content)).toContain("表示を完了状態に直しました");
  });
});
