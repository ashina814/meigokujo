import { describe, expect, it, vi } from "vitest";
import {
  CHIP_ESCROW,
  ChipLedger,
  ChipTx,
  EventLog,
  EVENT_MARKET_CREATE_FEE,
  EVENT_MARKET_MAX_OPTIONS,
  EVENT_MARKET_PERSONAL_CAP,
  FORMAL_OPENING_VERSION,
  Ledger,
  Markets,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Market } from "@meigokujo/core";

// config.ts は環境変数を要求して process.exit(1) するため、
// ita.ts（→ permissions.js → config.js）は静的 import できない。
// scheduler.test.ts と同じ流儀で、env を先に設定してから動的 import する。
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const itaModule = import("../src/commands/ita.js");

/**
 * イベントLand板（緊急イベント用 hotfix）のUIテスト。
 *
 * services は実際の Markets（landLedger 接続込み）を使い、handleItaCommand /
 * handleItaEventButton / handleItaEventSelect / handleItaEventModal という
 * 公開エントリポイントだけを経由して振る舞いを確認する（内部の render 関数は非export のため
 * 意図的に触らない＝実装詳細ではなく利用者から見える結果を検証する）。
 */
const ROLE_A = "111111111111111111";
const ROLE_B = "222222222222222222";
const ROLE_OTHER = "999999999999999999";

function buildTestServices() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  // 正式開業ロックは外せない（PR8監査・ブロッカーA）。標準板の回帰テストが ChipLedger を
  // 通すので、資金グループを開ける状態（opening_v1）にしておく（core側テストの openFormally と同じ）。
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ledger.lastTransactionId(),
  });
  const ether = new ChipLedger(db, ledger, events, { chipTx });
  const markets = new Markets(db, ether, events, { landLedger: ledger });
  return { db, ledger, markets };
}

function seedLand(ledger: Ledger, userId: string, amount: number): void {
  ledger.ensureAccount(`user:${userId}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount,
    type: "initial",
    actor: "t",
    idempotencyKey: `seed:${userId}:${Math.random()}`,
  });
}

let opCounter = 0;
function fakeId(prefix = "int"): string {
  return `${prefix}-${++opCounter}`;
}

function fakeClient() {
  return { channels: { fetch: vi.fn().mockResolvedValue(null) } };
}

function fakeChatInputInteraction(opts: {
  userId: string;
  subcommand: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  roles?: Record<string, { id: string } | null>;
  channelSend?: ReturnType<typeof vi.fn>;
}) {
  return {
    id: fakeId("cmd"),
    user: { id: opts.userId },
    guildId: "g1",
    channel: { send: opts.channelSend ?? vi.fn().mockResolvedValue({ channelId: "chan1", id: "msg1" }) },
    client: fakeClient(),
    options: {
      getSubcommand: () => opts.subcommand,
      getString: (name: string) => opts.strings?.[name] ?? null,
      getInteger: (name: string) => opts.integers?.[name] ?? null,
      getRole: (name: string) => opts.roles?.[name] ?? null,
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeMember(roleIds: string[]) {
  return { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } };
}

function fakeButtonInteraction(opts: { customId: string; userId: string; roleIds?: string[]; isAdminPerm?: boolean }) {
  return {
    id: fakeId("btn"), // operationId として core の runEventOp へそのまま渡る（冪等キー）
    customId: opts.customId,
    user: { id: opts.userId },
    member: opts.roleIds ? fakeMember(opts.roleIds) : null,
    memberPermissions: { has: () => opts.isAdminPerm ?? false },
    client: fakeClient(),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeSelectInteraction(opts: {
  customId: string;
  userId: string;
  values: string[];
  roleIds?: string[];
  isAdminPerm?: boolean;
}) {
  return {
    id: fakeId("sel"),
    customId: opts.customId,
    user: { id: opts.userId },
    member: opts.roleIds ? fakeMember(opts.roleIds) : null,
    memberPermissions: { has: () => opts.isAdminPerm ?? false },
    values: opts.values,
    client: fakeClient(),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeModalInteraction(opts: { customId: string; userId: string; amount: string; roleIds?: string[] }) {
  return {
    id: fakeId("modal"), // operationId として core の runEventOp へそのまま渡る（冪等キー）
    customId: opts.customId,
    user: { id: opts.userId },
    member: opts.roleIds ? fakeMember(opts.roleIds) : null,
    client: fakeClient(),
    fields: { getTextInputValue: (key: string) => (key === "amount" ? opts.amount : "") },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/板 イベント立てる: コマンド登録", () => {
  it("イベント立てるサブコマンドが議題/選択肢/締切分/参加ロール1必須で登録される", async () => {
    const { itaCommand } = await itaModule;
    const json = itaCommand.toJSON();
    const names = json.options?.map((o) => o.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["立てる", "イベント立てる", "一覧"]));

    const evt = json.options?.find((o) => o.name === "イベント立てる") as {
      options?: Array<{ name: string; required?: boolean }>;
    };
    expect(evt).toBeTruthy();
    const optByName = new Map((evt.options ?? []).map((o) => [o.name, o]));
    expect(optByName.get("議題")?.required).toBe(true);
    expect(optByName.get("選択肢")?.required).toBe(true);
    expect(optByName.get("締切分")?.required).toBe(true);
    expect(optByName.get("参加ロール1")?.required).toBe(true);
    expect(optByName.get("参加ロール2")?.required).toBe(false);
    expect(optByName.get("参加ロール5")?.required).toBe(false);
    expect(optByName.get("方式")?.required).toBe(false);
  });

  it("通常板の立てるサブコマンドは選択肢2〜4のまま変更されていない（回帰）", async () => {
    const { itaCommand } = await itaModule;
    const json = itaCommand.toJSON();
    const std = json.options?.find((o) => o.name === "立てる") as {
      options?: Array<{ name: string; required?: boolean }>;
    };
    const names = (std.options ?? []).map((o) => o.name);
    expect(names).toEqual(["議題", "選択肢", "締切分", "方式"]);
  });
});

describe("イベントLand板: 作成コマンド", () => {
  it("参加ロールをsnapshotとして保存し、開設手数料をLandで徴収する", async () => {
    const { handleItaCommand } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator1", EVENT_MARKET_CREATE_FEE);
    const channelSend = vi.fn().mockResolvedValue({ channelId: "chan1", id: "msg1" });
    const interaction = fakeChatInputInteraction({
      userId: "creator1",
      subcommand: "イベント立てる",
      strings: { 議題: "誰が優勝する？", 選択肢: "A,B,C" },
      integers: { 締切分: 30 },
      roles: { 参加ロール1: { id: ROLE_A }, 参加ロール2: { id: ROLE_B } },
      channelSend,
    });

    await handleItaCommand(interaction as any, ctx as any);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const rows = ctx.db.prepare("SELECT * FROM casino_markets").all() as Market[];
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m.market_mode).toBe("event");
    expect(JSON.parse(m.allowed_role_ids_json)).toEqual([ROLE_A, ROLE_B]);
    expect(ctx.ledger.balanceOf("sys:escrow:market:fees")).toBe(EVENT_MARKET_CREATE_FEE);
    expect(channelSend).toHaveBeenCalledTimes(1);
  });

  it("選択肢が33個ならエラー返信し、板を作らない", async () => {
    const { handleItaCommand } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator2", EVENT_MARKET_CREATE_FEE);
    const optionsStr = Array.from({ length: 33 }, (_, i) => `opt${i}`).join(",");
    const interaction = fakeChatInputInteraction({
      userId: "creator2",
      subcommand: "イベント立てる",
      strings: { 議題: "x", 選択肢: optionsStr },
      integers: { 締切分: 30 },
      roles: { 参加ロール1: { id: ROLE_A } },
    });
    await handleItaCommand(interaction as any, ctx as any);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const arg = interaction.reply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain(String(EVENT_MARKET_MAX_OPTIONS));
    expect(ctx.markets.listOpen()).toHaveLength(0);
  });
});

describe("イベントLand板: パネルUI（32択の select menu 分割）", () => {
  it("32択なら賭け先選択が2つのselect menuへ分割される（25 + 7）", async () => {
    const { handleItaCommand } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator3", EVENT_MARKET_CREATE_FEE);
    const channelSend = vi.fn().mockResolvedValue({ channelId: "chan1", id: "msg1" });
    const options32 = Array.from({ length: 32 }, (_, i) => `opt${i}`).join(",");
    const interaction = fakeChatInputInteraction({
      userId: "creator3",
      subcommand: "イベント立てる",
      strings: { 議題: "32択テスト", 選択肢: options32 },
      integers: { 締切分: 30 },
      roles: { 参加ロール1: { id: ROLE_A } },
      channelSend,
    });
    await handleItaCommand(interaction as any, ctx as any);

    const payload = channelSend.mock.calls[0]![0] as { components: Array<{ toJSON(): unknown }> };
    const rowsJson = payload.components.map((r) => r.toJSON() as { components: Array<{ type: number; custom_id?: string; options?: unknown[] }> });
    const selectRows = rowsJson.filter((r) => r.components[0]?.custom_id?.startsWith("itaevt:betsel:"));
    expect(selectRows).toHaveLength(2);
    expect((selectRows[0]!.components[0]!.options as unknown[]).length).toBe(25);
    expect((selectRows[1]!.components[0]!.options as unknown[]).length).toBe(7);
    // 各 option label は100文字以内、custom idは100文字以内（Discord制限）
    for (const row of selectRows) {
      const comp = row.components[0]! as { custom_id: string; options: Array<{ label: string }> };
      expect(comp.custom_id.length).toBeLessThanOrEqual(100);
      for (const opt of comp.options) expect(opt.label.length).toBeLessThanOrEqual(100);
    }
  });

  it("25択以下なら賭け先選択は1つのselect menuにまとまる", async () => {
    const { handleItaCommand } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator4", EVENT_MARKET_CREATE_FEE);
    const channelSend = vi.fn().mockResolvedValue({ channelId: "chan1", id: "msg1" });
    const options10 = Array.from({ length: 10 }, (_, i) => `opt${i}`).join(",");
    const interaction = fakeChatInputInteraction({
      userId: "creator4",
      subcommand: "イベント立てる",
      strings: { 議題: "10択テスト", 選択肢: options10 },
      integers: { 締切分: 30 },
      roles: { 参加ロール1: { id: ROLE_A } },
      channelSend,
    });
    await handleItaCommand(interaction as any, ctx as any);

    const payload = channelSend.mock.calls[0]![0] as { components: Array<{ toJSON(): unknown }> };
    const rowsJson = payload.components.map((r) => r.toJSON() as { components: Array<{ custom_id?: string; options?: unknown[] }> });
    const selectRows = rowsJson.filter((r) => r.components[0]?.custom_id?.startsWith("itaevt:betsel:"));
    expect(selectRows).toHaveLength(1);
    expect((selectRows[0]!.components[0]!.options as unknown[]).length).toBe(10);
  });

  it("open状態のパネルに承認・異議ボタンは出ない（締切る・無効化のみ）", async () => {
    const { handleItaCommand } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator5", EVENT_MARKET_CREATE_FEE);
    const channelSend = vi.fn().mockResolvedValue({ channelId: "chan1", id: "msg1" });
    const interaction = fakeChatInputInteraction({
      userId: "creator5",
      subcommand: "イベント立てる",
      strings: { 議題: "x", 選択肢: "A,B" },
      integers: { 締切分: 30 },
      roles: { 参加ロール1: { id: ROLE_A } },
      channelSend,
    });
    await handleItaCommand(interaction as any, ctx as any);
    const payload = channelSend.mock.calls[0]![0] as { components: Array<{ toJSON(): unknown }> };
    const allLabels = payload.components
      .map((r) => r.toJSON() as { components: Array<{ label?: string }> })
      .flatMap((r) => r.components.map((c) => c.label))
      .filter(Boolean);
    expect(allLabels).not.toContain("承認");
    expect(allLabels).not.toContain("異議あり");
  });
});

describe("イベントLand板: ロール制限つきbet（選択→金額modal→即時決済）", () => {
  it("役割を持たない利用者はselect時点で拒否され、modalは開かない", async () => {
    const { handleItaEventSelect } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator6", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator6",
      title: "x",
      options: ["A", "B"],
      durationMin: 30,
      allowedRoleIds: [ROLE_A],
      operationId: fakeId(),
    });
    const sel = fakeSelectInteraction({
      customId: `itaevt:betsel:${m.id}:0`,
      userId: "bettor",
      values: ["0"],
      roleIds: [ROLE_OTHER],
    });
    await handleItaEventSelect(sel as any, ctx as any);
    expect(sel.showModal).not.toHaveBeenCalled();
    expect(sel.reply).toHaveBeenCalledTimes(1);
  });

  it("役割を持つ利用者はmodalが開き、送信するとLandが即時に動く", async () => {
    const { handleItaEventSelect, handleItaEventModal } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator7", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator7",
      title: "x",
      options: ["A", "B"],
      durationMin: 30,
      allowedRoleIds: [ROLE_A],
      operationId: fakeId(),
    });
    seedLand(ctx.ledger, "bettor", 5_000);

    const sel = fakeSelectInteraction({
      customId: `itaevt:betsel:${m.id}:0`,
      userId: "bettor",
      values: ["0"],
      roleIds: [ROLE_A],
    });
    await handleItaEventSelect(sel as any, ctx as any);
    expect(sel.showModal).toHaveBeenCalledTimes(1);
    const modalArg = sel.showModal.mock.calls[0]![0] as { data: { custom_id: string } };
    const modalCustomId = modalArg.data.custom_id;
    expect(modalCustomId.startsWith(`itaevt:amt:${m.id}:0:`)).toBe(true);

    const before = ctx.ledger.balanceOf("user:bettor");
    const modal = fakeModalInteraction({ customId: modalCustomId, userId: "bettor", amount: "700", roleIds: [ROLE_A] });
    await handleItaEventModal(modal as any, ctx as any);
    expect(ctx.ledger.balanceOf("user:bettor")).toBe(before - 700);
    const replyArg = modal.reply.mock.calls[0]![0] as { content: string };
    expect(replyArg.content).toContain("Ld");
    expect(replyArg.content).not.toContain("◈");
  });
});

describe("イベントLand板: 結果確定フロー（承認なし・本人確認のみ）", () => {
  async function setupClosedMarketWithBet() {
    const { handleItaEventModal, handleItaEventSelect } = await itaModule;
    const ctx = buildTestServices();
    seedLand(ctx.ledger, "creator8", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator8",
      title: "x",
      options: ["A", "B"],
      durationMin: 30,
      allowedRoleIds: [ROLE_A],
      operationId: fakeId(),
    });
    seedLand(ctx.ledger, "winner", 3_000);
    const sel = fakeSelectInteraction({ customId: `itaevt:betsel:${m.id}:0`, userId: "winner", values: ["0"], roleIds: [ROLE_A] });
    await handleItaEventSelect(sel as any, ctx as any);
    const modalCustomId = (sel.showModal.mock.calls[0]![0] as { data: { custom_id: string } }).data.custom_id;
    await handleItaEventModal(
      fakeModalInteraction({ customId: modalCustomId, userId: "winner", amount: "1000", roleIds: [ROLE_A] }) as any,
      ctx as any,
    );
    ctx.markets.close(m.id, "creator8");
    return { ctx, m };
  }

  it("結果選択後は本人確認ボタンが出て、confirm前はLandが動かない", async () => {
    const { handleItaEventButton, handleItaEventSelect } = await itaModule;
    const { ctx, m } = await setupClosedMarketWithBet();

    const reportBtn = fakeButtonInteraction({ customId: `itaevt:report:${m.id}`, userId: "creator8" });
    await handleItaEventButton(reportBtn as any, ctx as any);
    expect(reportBtn.reply).toHaveBeenCalledTimes(1);

    const winnerBefore = ctx.ledger.balanceOf("user:winner");
    const escrowBefore = ctx.ledger.balanceOf("sys:escrow:market:" + m.id);

    const ressel = fakeSelectInteraction({ customId: `itaevt:ressel:${m.id}:0`, userId: "creator8", values: ["0"] });
    await handleItaEventSelect(ressel as any, ctx as any);
    expect(ressel.update).toHaveBeenCalledTimes(1);
    const updateArg = ressel.update.mock.calls[0]![0] as {
      components: Array<{ toJSON(): { components: Array<{ label?: string; custom_id?: string }> } }>;
    };
    const buttons = updateArg.components.flatMap((r) => r.toJSON().components);
    expect(buttons.some((b) => b.label === "精算を確定")).toBe(true);
    expect(buttons.some((b) => b.label === "戻る")).toBe(true);
    const confirmCustomId = buttons.find((b) => b.label === "精算を確定")!.custom_id!;
    expect(confirmCustomId).toBe(`itaevt:confirm:${m.id}:0`);

    // confirm 前なので Land はまだ動いていない・板もまだ closed
    expect(ctx.ledger.balanceOf("user:winner")).toBe(winnerBefore);
    expect(ctx.ledger.balanceOf("sys:escrow:market:" + m.id)).toBe(escrowBefore);
    expect(ctx.markets.get(m.id)!.status).toBe("closed");
  });

  it("精算を確定を押すと即時settledになり、Landが精算される", async () => {
    const { handleItaEventButton } = await itaModule;
    const { ctx, m } = await setupClosedMarketWithBet();
    const winnerBefore = ctx.ledger.balanceOf("user:winner");

    const confirmBtn = fakeButtonInteraction({ customId: `itaevt:confirm:${m.id}:0`, userId: "creator8" });
    await handleItaEventButton(confirmBtn as any, ctx as any);

    expect(confirmBtn.update).toHaveBeenCalledTimes(1);
    expect(ctx.markets.get(m.id)!.status).toBe("settled");
    expect(ctx.ledger.balanceOf("user:winner")).toBeGreaterThan(winnerBefore);
    expect(ctx.ledger.balanceOf("sys:escrow:market:" + m.id)).toBe(0);
    // approvals行が作られていない（承認フローを一切通っていない証拠）
    expect(ctx.markets.approvals(m.id)).toHaveLength(0);

    const updateArg = confirmBtn.update.mock.calls[0]![0] as { content: string };
    expect(updateArg.content).toContain("Ld");
    expect(updateArg.content).not.toContain("◈");
  });
});

describe("通常板UIの回帰（既存 handleItaButton の分岐を壊していない）", () => {
  it("ita: 名前空間の standard bet フローが引き続き動く", async () => {
    const { handleItaButton } = await itaModule;
    const ctx = buildTestServices();
    // 標準板は手数料0で作れる（チップ残高0でもOK）
    const m = ctx.markets.create({
      operationId: fakeId(),
      guildId: "g",
      creatorId: "std-creator",
      title: "通常板",
      options: ["A", "B"],
      durationMin: 30,
      fee: 0,
    });
    expect(m.market_mode).toBe("standard");
    // close ボタン（ita:close:<id>）は creator が締切れる
    const btn = fakeButtonInteraction({ customId: `ita:close:${m.id}`, userId: "std-creator" });
    await handleItaButton(btn as any, ctx as any);
    expect(ctx.markets.get(m.id)!.status).toBe("closed");
  });
});
