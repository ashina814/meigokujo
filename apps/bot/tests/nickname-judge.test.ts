import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { ChatInputCommandInteraction, Guild, GuildMember, UserSelectMenuInteraction } from "discord.js";
import { Entry, EventLog, Evaluation, Ledger, Nicknames, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 門番の判定画面。
 *
 * 確認が要る名前（denylist の `flag`）は一括合格に含めず、門番が中身を見て
 * 通したときだけ入城できる。**承認できるのはいまの判定対象だけ**で、
 * 説明会に来ていない人を選んでも効かない（承認は入城の可否を動かす操作なので、
 * その場で見えている相手にしか効かせない）。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const entryModule = import("../src/commands/entry.js");

const ROLE = { wait: "r-wait", judge: "r-judge", ghost: "r-ghost" };
const VC = "vc-1";
const JUDGE = "900000000000000001";
const PRESENT = "900000000000000002"; // VCに居て、確認が要る名前
const ABSENT = "900000000000000003"; // VCに居ない（判定対象外）で、確認が要る名前

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const nicknames = new Nicknames(db, events);
  settings.set("role:queue_wait", ROLE.wait, "test");
  settings.set("role:judge", ROLE.judge, "test");
  settings.set("role:ghost", ROLE.ghost, "test");
  settings.set("channel:session_vc", VC, "test");
  settings.set("entry_require_name", 1, "test"); // 名前ゲートON
  const services = {
    db,
    ledger,
    settings,
    events,
    entry,
    evaluation,
    nicknames,
    returns: { isReturnee: () => false },
    titles: { evaluate: vi.fn(() => []) },
  } as unknown as Services;
  return { db, settings, events, entry, nicknames, services };
}

function memberOf(id: string, roles: string[]): GuildMember {
  return {
    id,
    user: { bot: false, id },
    roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) },
  } as unknown as GuildMember;
}

function guildWith(inVc: GuildMember[]): Guild {
  return {
    id: "g1",
    channels: {
      fetch: vi.fn(async () => ({ isVoiceBased: () => true, members: new Collection(inVc.map((m) => [m.id, m])) })),
    },
    members: { fetch: vi.fn(async (id: string) => inVc.find((m) => m.id === id)) },
  } as unknown as Guild;
}

/** 判定画面の説明文 */
const descOf = (fn: ReturnType<typeof vi.fn>) =>
  String((fn.mock.calls.at(-1) as never[])[0]?.embeds?.[0]?.data?.description ?? "");

describe("確認が要る名前の承認", () => {
  async function openJudgment(ctx: ReturnType<typeof setup>) {
    const { handleSessionCommand } = await entryModule;
    const judge = memberOf(JUDGE, [ROLE.judge]);
    const present = memberOf(PRESENT, [ROLE.wait]);
    const guild = guildWith([judge, present]);
    const reply = vi.fn(async () => undefined);
    const command = {
      guild,
      member: judge,
      user: { id: JUDGE },
      options: { getSubcommand: () => "判定" },
      reply,
      isButton: () => false,
      isUserSelectMenu: () => false,
    } as unknown as ChatInputCommandInteraction;
    await handleSessionCommand(command, ctx.services);
    return { guild, judge, reply };
  }

  function selectInteraction(guild: Guild, judge: GuildMember, values: string[]) {
    const update = vi.fn(async () => undefined);
    return {
      interaction: {
        customId: "entry:judgeflag",
        values,
        guild,
        member: judge,
        user: { id: JUDGE },
        isButton: () => false,
        isUserSelectMenu: () => true,
        update,
        reply: vi.fn(async () => undefined),
      } as unknown as UserSelectMenuInteraction,
      update,
    };
  }

  it("いま判定対象の人は、門番が確認すれば通せる", async () => {
    const { handleEntryButton } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin(PRESENT);
    ctx.nicknames.claim({ userId: PRESENT, nickname: "ようかくにん", setVia: "entry", actor: "t" });
    ctx.nicknames.addDenyWord("ようかくにん", "staff", { action: "flag" });
    const { guild, judge, reply } = await openJudgment(ctx);
    // 最初は合格に含まれていない
    expect(descOf(reply)).toContain("名前の確認が要る 1名");

    const sel = selectInteraction(guild, judge, [PRESENT]);
    await handleEntryButton(sel.interaction, ctx.services);

    expect(ctx.nicknames.status(PRESENT).kind).toBe("ok");
    expect(descOf(sel.update)).toContain("合格→亡霊にする 1名");
    ctx.db.close();
  });

  it("**判定対象に居ない人を選んでも承認しない**", async () => {
    const { handleEntryButton } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin(PRESENT);
    ctx.entry.recordJoin(ABSENT);
    ctx.nicknames.claim({ userId: PRESENT, nickname: "ようかくにんA", setVia: "entry", actor: "t" });
    ctx.nicknames.claim({ userId: ABSENT, nickname: "ようかくにんB", setVia: "entry", actor: "t" });
    ctx.nicknames.addDenyWord("ようかくにん", "staff", { action: "flag" });
    const { guild, judge } = await openJudgment(ctx);

    // 説明会に来ていない ABSENT を混ぜて選ぶ
    const sel = selectInteraction(guild, judge, [PRESENT, ABSENT]);
    await handleEntryButton(sel.interaction, ctx.services);

    expect(ctx.nicknames.status(PRESENT).kind).toBe("ok"); // 対象なので通る
    expect(ctx.nicknames.status(ABSENT).kind).toBe("review"); // 対象外は据え置き
    expect(ctx.nicknames.get(ABSENT)?.flag_ok_at).toBeNull();
    expect(ctx.events.listByType("nickname_flag_approval_ignored")).toHaveLength(1);
    ctx.db.close();
  });

  it("保留にした人は承認できない", async () => {
    const { handleEntryButton } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin(PRESENT);
    ctx.nicknames.claim({ userId: PRESENT, nickname: "ようかくにん", setVia: "entry", actor: "t" });
    ctx.nicknames.addDenyWord("ようかくにん", "staff", { action: "flag" });
    const { guild, judge } = await openJudgment(ctx);

    // まず保留にする
    const hold = {
      customId: "entry:judgehold",
      values: [PRESENT],
      guild,
      member: judge,
      user: { id: JUDGE },
      isButton: () => false,
      isUserSelectMenu: () => true,
      update: vi.fn(async () => undefined),
    } as unknown as UserSelectMenuInteraction;
    await handleEntryButton(hold, ctx.services);

    const sel = selectInteraction(guild, judge, [PRESENT]);
    await handleEntryButton(sel.interaction, ctx.services);

    expect(ctx.nicknames.status(PRESENT).kind).toBe("review");
    ctx.db.close();
  });
});

describe("複数の要確認語に当たっている場合", () => {
  it("**門番の画面に一致した語を全部出す**（1語だけ見て通させない）", async () => {
    const { handleSessionCommand } = await entryModule;
    const ctx = setup();
    ctx.entry.recordJoin(PRESENT);
    ctx.nicknames.claim({ userId: PRESENT, nickname: "あやしいことば", setVia: "entry", actor: "t" });
    ctx.nicknames.addDenyWord("あやしい", "staff", { action: "flag" });
    ctx.nicknames.addDenyWord("ことば", "staff", { action: "flag" });

    const judge = memberOf(JUDGE, [ROLE.judge]);
    const present = memberOf(PRESENT, [ROLE.wait]);
    const reply = vi.fn(async () => undefined);
    await handleSessionCommand(
      {
        guild: guildWith([judge, present]),
        member: judge,
        user: { id: JUDGE },
        options: { getSubcommand: () => "判定" },
        reply,
      } as unknown as ChatInputCommandInteraction,
      ctx.services,
    );

    const desc = descOf(reply);
    expect(desc).toContain("2件に一致");
    expect(desc).toContain("あやしい");
    expect(desc).toContain("ことば");
    ctx.db.close();
  });
});
