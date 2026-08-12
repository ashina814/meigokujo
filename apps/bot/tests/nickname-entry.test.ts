import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Nicknames, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 入城の条件は「名前が登録済みで、城の規則を通っていること」。
 *
 * - 案内待ちの人は**入城案内パネルから自分で**名前を決める（一般メンバーは
 *   Discordの権限上、自分ではニックネームを変更できない）
 * - 門番は**押す前に** ✅/⚠️/❌ が見える
 * - 手で亡霊ロールを付けても、名前が無ければ**ロールごと差し戻す**
 *   （亡霊ロールは住民用チャンネルを一気に開けるので、ghostify を止めるだけでは
 *   「台帳は未入城なのに中に入れている」状態が成立してしまう）
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const entryModule = import("../src/commands/entry.js");

const ROLE = { ghost: "r-ghost", wait: "r-wait" };
const USER = "1463201396567441441";
const OTHER = "1463201396567441442";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const nicknames = new Nicknames(db, events);
  settings.set("role:ghost", ROLE.ghost, "test");
  settings.set("role:queue_wait", ROLE.wait, "test");
  settings.set("channel:waiters_board", "ch-board", "test");
  const services = {
    db,
    ledger,
    settings,
    events,
    entry,
    evaluation,
    nicknames,
    titles: { evaluate: vi.fn(() => []) },
  } as unknown as Services;
  return { db, ledger, settings, events, entry, nicknames, services };
}

/**
 * 名前設定モーダルの送信。
 * `shared` を渡すと同じ相手（＝同じ Discord 側の状態）へ複数本ぶつけられる。
 */
function modalSubmit(
  input: string,
  opts: { setFails?: string; setChangesAnyway?: boolean; delayMs?: number; shared?: { nickname: string | null } } = {},
) {
  const state = opts.shared ?? { nickname: null as string | null };
  const member = {
    id: USER,
    get nickname() {
      return state.nickname;
    },
    get displayName() {
      return state.nickname ?? "グローバル名";
    },
    setNickname: vi.fn(async (name: string) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.setFails) {
        if (opts.setChangesAnyway) state.nickname = name; // APIは失敗を返したが実際は変わった
        throw new Error(opts.setFails);
      }
      state.nickname = name;
      return undefined;
    }),
  };
  const interaction = {
    customId: "entry:name-input",
    user: { id: USER },
    guild: { id: "g1", members: { fetch: vi.fn(async () => member) } },
    member,
    fields: { getTextInputValue: () => input },
    reply: vi.fn(async () => undefined),
  };
  return { interaction: interaction as never, member, state, reply: interaction.reply };
}

const contentOf = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])[0]?.content ?? "");

describe("案内待ちが自分で名前を決める", () => {
  it("規則を通れば、その場でサーバーニックネームが設定される", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    const m = modalSubmit("こはく");

    await handleEntryModal(m.interaction, ctx.services);

    expect(m.state.nickname).toBe("こはく");
    expect(ctx.nicknames.get(USER)?.nickname).toBe("こはく");
    expect(contentOf(m.reply)).toContain("こはく");
    ctx.db.close();
  });

  it("記号を含む名前は設定しない（Discordを叩きもしない）", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    const m = modalSubmit("★ほし★");

    await handleEntryModal(m.interaction, ctx.services);

    expect(m.member.setNickname).not.toHaveBeenCalled();
    expect(ctx.nicknames.get(USER)).toBeNull();
    expect(contentOf(m.reply)).toContain("使えない文字");
    ctx.db.close();
  });

  it("他の人が使っている名前は取れない", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    ctx.nicknames.claim({ userId: OTHER, nickname: "こはく", setVia: "entry", actor: "t" });
    const m = modalSubmit("こはく");

    await handleEntryModal(m.interaction, ctx.services);

    expect(m.member.setNickname).not.toHaveBeenCalled();
    expect(contentOf(m.reply)).toContain("既に他の方が使っています");
    ctx.db.close();
  });

  it("既存の重複（誰の持ち物でもない予約）も取れない", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    ctx.nicknames.importLegacy(
      [
        { userId: OTHER, nickname: "来世" },
        { userId: "999", nickname: "来世" },
      ],
      "staff",
    );
    const m = modalSubmit("来世");

    await handleEntryModal(m.interaction, ctx.services);

    expect(m.member.setNickname).not.toHaveBeenCalled();
    expect(contentOf(m.reply)).toContain("既に城内で使われている");
    ctx.db.close();
  });

  it("**Discord側が失敗したら予約を残さない**", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    const m = modalSubmit("こはく", { setFails: "Missing Permissions" });

    await handleEntryModal(m.interaction, ctx.services);

    expect(ctx.nicknames.get(USER)).toBeNull();
    expect(ctx.nicknames.reservation("こはく")).toBeNull();
    expect(contentOf(m.reply)).toContain("設定できませんでした");
    // 取れなくなっていないこと
    expect(ctx.nicknames.claim({ userId: OTHER, nickname: "こはく", setVia: "entry", actor: "t" }).ok).toBe(true);
    ctx.db.close();
  });

  it("**setNickname がエラーでも、取り直して希望どおりなら成功として扱う**", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    // APIはエラーを返したが、実際には変わっていた（応答だけ落ちた等）
    const m = modalSubmit("こはく", { setFails: "Service Unavailable", setChangesAnyway: true });

    await handleEntryModal(m.interaction, ctx.services);

    expect(m.state.nickname).toBe("こはく");
    expect(ctx.nicknames.get(USER)?.nickname).toBe("こはく"); // 正本を巻き戻さない
    expect(ctx.nicknames.reservation("こはく")?.user_id).toBe(USER);
    expect(contentOf(m.reply)).toContain("こはく");
    ctx.db.close();
  });

  it("説明会までは何度でも変えられる", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    await handleEntryModal(modalSubmit("まちがい").interaction, ctx.services);
    const second = modalSubmit("ただしい");

    await handleEntryModal(second.interaction, ctx.services);

    expect(ctx.nicknames.get(USER)?.nickname).toBe("ただしい");
    expect(ctx.nicknames.reservation("まちがい")).toBeNull();
    ctx.db.close();
  });
});

describe("同じ人が並行して名前を送ったとき", () => {
  /** 正本（DB）と Discord の表示が一致し、取り残した予約が無いこと */
  function assertConsistent(ctx: ReturnType<typeof setup>, discordName: string | null) {
    const row = ctx.nicknames.get(USER);
    expect(row).not.toBeNull();
    expect(row!.nickname).toBe(discordName); // DB と Discord が食い違わない
    expect(ctx.nicknames.reservation(row!.name_key)?.user_id).toBe(USER);
    // 使っていない名前の予約が残っていない
    const all = ctx.db.prepare("SELECT name_key FROM nickname_reservations").all() as Array<{ name_key: string }>;
    expect(all.map((r) => r.name_key)).toEqual([row!.name_key]);
  }

  it("A→B を同時に送っても、DBとDiscordが食い違わない", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    const shared = { nickname: null as string | null };
    const a = modalSubmit("えーめい", { shared, delayMs: 5 });
    const b = modalSubmit("びーめい", { shared, delayMs: 5 });

    await Promise.all([handleEntryModal(a.interaction, ctx.services), handleEntryModal(b.interaction, ctx.services)]);

    assertConsistent(ctx, shared.nickname);
    expect(["えーめい", "びーめい"]).toContain(shared.nickname);
    ctx.db.close();
  });

  it("**片方が失敗しても、もう片方の正本を消さない**", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    const shared = { nickname: null as string | null };
    // 1本目は Discord 側で必ず失敗する。巻き戻しが2本目を巻き込まないこと
    const failing = modalSubmit("しっぱい", { shared, setFails: "Missing Permissions", delayMs: 5 });
    const ok = modalSubmit("せいこう", { shared, delayMs: 5 });

    await Promise.all([
      handleEntryModal(failing.interaction, ctx.services),
      handleEntryModal(ok.interaction, ctx.services),
    ]);

    expect(shared.nickname).toBe("せいこう");
    assertConsistent(ctx, "せいこう");
    ctx.db.close();
  });

  it("同じ名前を同時に2本送っても壊れない", async () => {
    const { handleEntryModal } = await entryModule;
    const ctx = setup();
    const shared = { nickname: null as string | null };
    const a = modalSubmit("おなじ", { shared, delayMs: 5 });
    const b = modalSubmit("おなじ", { shared, delayMs: 5 });

    await Promise.all([handleEntryModal(a.interaction, ctx.services), handleEntryModal(b.interaction, ctx.services)]);

    assertConsistent(ctx, "おなじ");
    ctx.db.close();
  });
});

describe("確認が要る名前（denylist の flag）", () => {
  it("一括合格の対象から外れ、門番が通して初めて入城できる", async () => {
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    ctx.nicknames.claim({ userId: USER, nickname: "ようかくにん", setVia: "entry", actor: "t" });
    ctx.nicknames.addDenyWord("ようかくにん", "staff", { action: "flag" });
    const w = roleAdded(ctx);

    // 未確認のうちは通さない（ロールごと差し戻す）
    await handleMemberRoleUpdate(w.oldMember, w.newMember, ctx.services);
    expect(w.roleRemove).toHaveBeenCalledWith(ROLE.ghost, expect.any(String));
    expect(ctx.entry.getSoul(USER)?.status ?? "waiting").not.toBe("ghost");

    // 門番が確認して通す
    expect(ctx.nicknames.approveFlagged(USER, "user:judge")).toBe(true);
    const w2 = roleAdded(ctx);
    await handleMemberRoleUpdate(w2.oldMember, w2.newMember, ctx.services);

    expect(ctx.entry.getSoul(USER)?.status).toBe("ghost");
    ctx.db.close();
  });
});

/** 亡霊ロールが手で付いた瞬間の GuildMemberUpdate */
function roleAdded(_ctx: ReturnType<typeof setup>) {
  const cacheOf = (ids: string[]) => new Collection(ids.map((id) => [id, { id }] as [string, { id: string }]));
  const roleRemove = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const guild = {
    id: "g1",
    members: { fetch: vi.fn(async () => newMember) },
    channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
    client: { channels: { fetch: vi.fn(async () => null) } },
  } as unknown as Guild;
  const oldMember = { id: USER, user: { bot: false }, guild, roles: { cache: cacheOf([ROLE.wait]) } } as unknown as GuildMember;
  const newMember = {
    id: USER,
    user: { bot: false },
    guild,
    roles: { cache: cacheOf([ROLE.wait, ROLE.ghost]), add: vi.fn(async () => undefined), remove: roleRemove },
    send: vi.fn(async () => undefined),
  } as unknown as GuildMember;
  return { oldMember, newMember, guild, roleRemove, send };
}

describe("手で入城ロールを付けられたとき", () => {
  it("名前が未登録なら**ロールを差し戻し**、理由を記録してスタッフへ知らせる", async () => {
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    const w = roleAdded(ctx);

    await handleMemberRoleUpdate(w.oldMember, w.newMember, ctx.services);

    expect(w.roleRemove).toHaveBeenCalledWith(ROLE.ghost, expect.any(String));
    expect(ctx.entry.getSoul(USER)?.status ?? "waiting").not.toBe("ghost"); // 入城していない
    expect(ctx.events.listByType("entry_blocked_by_name")).toHaveLength(1);
    expect(ctx.events.listByType("entry_role_reverted")).toHaveLength(1);
    expect(String((w.send.mock.calls.at(-1) as never[])[0]?.content)).toContain("名前");
    ctx.db.close();
  });

  it("名前が登録済みなら通常どおり入城でき、名前が固定される", async () => {
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    ctx.nicknames.claim({ userId: USER, nickname: "こはく", setVia: "entry", actor: "t" });
    const w = roleAdded(ctx);

    await handleMemberRoleUpdate(w.oldMember, w.newMember, ctx.services);

    expect(w.roleRemove).not.toHaveBeenCalledWith(ROLE.ghost, expect.any(String));
    expect(ctx.entry.getSoul(USER)?.status).toBe("ghost");
    expect(ctx.nicknames.get(USER)?.locked_at).not.toBeNull();
    ctx.db.close();
  });

  it("規則違反の名前でも差し戻す（あとから禁止語が増えた場合）", async () => {
    const { handleMemberRoleUpdate } = await entryModule;
    const ctx = setup();
    ctx.nicknames.claim({ userId: USER, nickname: "ばつわーど", setVia: "entry", actor: "t" });
    ctx.nicknames.addDenyWord("ばつわーど", "staff");
    const w = roleAdded(ctx);

    await handleMemberRoleUpdate(w.oldMember, w.newMember, ctx.services);

    expect(w.roleRemove).toHaveBeenCalledWith(ROLE.ghost, expect.any(String));
    expect(ctx.entry.getSoul(USER)?.status ?? "waiting").not.toBe("ghost");
    ctx.db.close();
  });
});

describe("入城後の固定", () => {
  it("固定後はパネルから変更できず、商館へ案内する", async () => {
    const { handleEntryButton } = await entryModule;
    const ctx = setup();
    ctx.nicknames.claim({ userId: USER, nickname: "こはく", setVia: "entry", actor: "t" });
    ctx.nicknames.lock(USER, "staff");
    const interaction = {
      customId: "entry:name",
      isButton: () => true,
      isUserSelectMenu: () => false,
      user: { id: USER },
      reply: vi.fn(async () => undefined),
      showModal: vi.fn(async () => undefined),
    };

    await handleEntryButton(interaction as never, ctx.services);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(contentOf(interaction.reply)).toContain("公式ショップ");
    ctx.db.close();
  });
});
