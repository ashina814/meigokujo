import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Message } from "discord.js";
import { openDb, Settings, TcSocialObservations } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { classifyTitleTcMessage, trackTitleTcMessage, trackTitleTcReaction } from "../src/tc-social-tracking.js";

const CREATED = new Date("2026-08-20T12:00:00+09:00").getTime();

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  settings.set("guild:main", "guild-main", "test");
  const tcSocial = new TcSocialObservations(db);
  const services = { settings, tcSocial } as unknown as Services;
  return { db, settings, tcSocial, services };
}

function permissions(canView: boolean | null) {
  if (canView === null) return null;
  return new PermissionsBitField(canView ? [PermissionFlagsBits.ViewChannel] : []);
}

function fakeMessage(
  options: {
    id?: string;
    authorId?: string;
    bot?: boolean;
    webhookId?: string | null;
    system?: boolean;
    guild?: boolean;
    guildId?: string;
    content?: string;
    attachments?: number;
    channelId?: string;
    channelType?: ChannelType;
    canView?: boolean | null;
    parentId?: string | null;
    parentType?: ChannelType;
    parentCanView?: boolean | null;
    threadOwnerId?: string | null;
    threadCreatedAt?: number | null;
    replyTo?: string | null;
  } = {},
): Message {
  const channelType = options.channelType ?? ChannelType.GuildText;
  const isThread = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channelType);
  const channelId = options.channelId ?? "channel-1";
  const parentId = options.parentId ?? (isThread ? "parent-1" : "category-1");
  const parent = isThread
    ? {
        id: parentId,
        type: options.parentType ?? ChannelType.GuildText,
        parentId: "category-1",
        permissionsFor: () => permissions(options.parentCanView === undefined ? true : options.parentCanView),
      }
    : null;
  return {
    id: options.id ?? "message-1",
    author: { id: options.authorId ?? "author-1", bot: options.bot ?? false },
    webhookId: options.webhookId ?? null,
    system: options.system ?? false,
    inGuild: () => options.guild ?? true,
    guildId: options.guildId ?? "guild-main",
    guild: { roles: { everyone: { id: "everyone" } } },
    content: options.content ?? "hello",
    attachments: { size: options.attachments ?? 0 },
    channelId,
    channel: {
      id: channelId,
      type: channelType,
      parentId,
      parent,
      ownerId: options.threadOwnerId ?? (isThread ? "thread-owner" : null),
      createdTimestamp: options.threadCreatedAt ?? (isThread ? CREATED - 100 : null),
      isThread: () => isThread,
      permissionsFor: () => permissions(options.canView === undefined ? true : options.canView),
    },
    reference: options.replyTo ? { messageId: options.replyTo } : null,
    createdTimestamp: CREATED,
  } as unknown as Message;
}

function messageRows(db: ReturnType<typeof openDb>) {
  return db.prepare("SELECT * FROM tc_message_observations ORDER BY message_id").all() as Array<Record<string, unknown>>;
}

describe("MessageCreate TC sidecar eligibility/persistence", () => {
  it("public GuildText human messageをevent/knowledge time分離で1行保存する", async () => {
    const { db, services } = setup();
    await expect(trackTitleTcMessage(fakeMessage(), services, () => CREATED + 500)).resolves.toBe(true);
    expect(messageRows(db)[0]).toMatchObject({
      message_id: "message-1",
      author_id: "author-1",
      surface_id: "channel-1",
      area_id: "channel-1",
      surface_kind: "channel",
      created_at_ms: CREATED,
      observed_at_ms: CREATED + 500,
    });
  });

  it("same replayは1 rowかつfirst observedAt不変", async () => {
    const { db, services } = setup();
    await trackTitleTcMessage(fakeMessage(), services, () => CREATED + 100);
    await trackTitleTcMessage(fakeMessage(), services, () => CREATED + 999);
    expect(messageRows(db)).toHaveLength(1);
    expect(messageRows(db)[0]?.observed_at_ms).toBe(CREATED + 100);
  });

  it("content長を保存せず、attachment-only qualifying messageもmetadataだけ保存する", async () => {
    const { db, services } = setup();
    await trackTitleTcMessage(fakeMessage({ id: "long", content: "secret-content".repeat(10_000) }), services, () => CREATED + 1);
    await trackTitleTcMessage(fakeMessage({ id: "attachment", content: "", attachments: 1 }), services, () => CREATED + 2);
    expect(messageRows(db)).toHaveLength(2);
    expect(JSON.stringify(messageRows(db))).not.toContain("secret-content");
  });

  it.each([
    ["bot", { bot: true }],
    ["webhook", { webhookId: "webhook" }],
    ["system", { system: true }],
    ["DM", { guild: false }],
    ["other guild", { guildId: "guild-other" }],
  ])("%s messageを除外する", async (_label, options) => {
    const { db, services } = setup();
    await trackTitleTcMessage(fakeMessage(options), services, () => CREATED + 1);
    expect(messageRows(db)).toHaveLength(0);
  });

  it("role-gated/permission unknownとxp/title excluded channelを除外する", async () => {
    for (const canView of [false, null] as const) {
      const { db, services } = setup();
      await trackTitleTcMessage(fakeMessage({ canView }), services, () => CREATED + 1);
      expect(messageRows(db)).toHaveLength(0);
    }
    const { db, settings, services } = setup();
    settings.set("xp_excluded_channels", ["channel-1"], "test");
    await trackTitleTcMessage(fakeMessage(), services, () => CREATED + 1);
    expect(messageRows(db)).toHaveLength(0);
  });

  it("PublicThread/AnnouncementThread/forum postを許可し、area_idをpublic parentへ畳む", async () => {
    const { db, services } = setup();
    await trackTitleTcMessage(fakeMessage({ id: "public", channelId: "thread-public", channelType: ChannelType.PublicThread }), services, () => CREATED + 1);
    await trackTitleTcMessage(fakeMessage({ id: "announcement", channelId: "thread-ann", channelType: ChannelType.AnnouncementThread }), services, () => CREATED + 2);
    await trackTitleTcMessage(
      fakeMessage({ id: "forum", channelId: "thread-forum", channelType: ChannelType.PublicThread, parentType: ChannelType.GuildForum }),
      services,
      () => CREATED + 3,
    );
    expect(messageRows(db).map((row) => [row.message_id, row.area_id, row.surface_kind])).toEqual([
      ["announcement", "parent-1", "announcement_thread"],
      ["forum", "parent-1", "forum_post"],
      ["public", "parent-1", "public_thread"],
    ]);
  });

  it("PrivateThreadとprivate parentを除外する", async () => {
    const { db, services } = setup();
    await trackTitleTcMessage(fakeMessage({ id: "private", channelType: ChannelType.PrivateThread }), services, () => CREATED + 1);
    await trackTitleTcMessage(
      fakeMessage({ id: "gated-parent", channelType: ChannelType.PublicThread, parentCanView: false }),
      services,
      () => CREATED + 2,
    );
    expect(messageRows(db)).toHaveLength(0);
  });

  it("10 threads under同じparentを同じareaとして永続化する", async () => {
    const { db, services } = setup();
    for (let index = 0; index < 10; index += 1) {
      await trackTitleTcMessage(
        fakeMessage({ id: `m-${index}`, channelId: `thread-${index}`, channelType: ChannelType.PublicThread, parentId: "forum" }),
        services,
        () => CREATED + index,
      );
    }
    expect(new Set(messageRows(db).map((row) => row.area_id))).toEqual(new Set(["forum"]));
  });
});

describe("classifier policy boundary", () => {
  it("text_active_daysと別policyとしてpublic forumを許可するがPrivateThreadは許可しない", () => {
    const { services } = setup();
    expect(classifyTitleTcMessage(fakeMessage({ channelType: ChannelType.PublicThread, parentType: ChannelType.GuildForum }) as Message<true>, services)?.surfaceKind).toBe("forum_post");
    expect(classifyTitleTcMessage(fakeMessage({ channelType: ChannelType.PrivateThread }) as Message<true>, services)).toBeNull();
  });
});

describe("ReactionAdd sidecar", () => {
  async function seed() {
    const setupResult = setup();
    await trackTitleTcMessage(fakeMessage(), setupResult.services, () => CREATED + 1);
    return setupResult;
  }

  function reaction(options: { partial?: boolean; fetch?: ReturnType<typeof vi.fn>; guildId?: string } = {}) {
    const full = { partial: false, message: { id: "message-1", guildId: options.guildId ?? "guild-main" } };
    return options.partial ? { partial: true, fetch: options.fetch ?? vi.fn().mockResolvedValue(full), message: full.message } : full;
  }

  function user(options: { id?: string; bot?: boolean; partial?: boolean; fetch?: ReturnType<typeof vi.fn> } = {}) {
    const full = { id: options.id ?? "reactor", bot: options.bot ?? false, partial: false };
    return options.partial ? { ...full, partial: true, fetch: options.fetch ?? vi.fn().mockResolvedValue(full) } : full;
  }

  it("other human reactionを記録し、self/botを除外する", async () => {
    const { db, services } = await seed();
    expect(await trackTitleTcReaction(reaction() as never, user() as never, services, () => CREATED + 100)).toBe(true);
    expect(await trackTitleTcReaction(reaction() as never, user({ id: "author-1" }) as never, services, () => CREATED + 200)).toBe(false);
    expect(await trackTitleTcReaction(reaction() as never, user({ id: "bot", bot: true }) as never, services, () => CREATED + 300)).toBe(false);
    expect(db.prepare("SELECT * FROM tc_reaction_observations").all()).toHaveLength(1);
  });

  it("同reactor同postへ3emoji相当のaddでも1fact、remove/re-add相当でもfirst observed不変", async () => {
    const { db, services } = await seed();
    for (const offset of [100, 200, 300]) {
      await trackTitleTcReaction(reaction() as never, user() as never, services, () => CREATED + offset);
    }
    expect(db.prepare("SELECT * FROM tc_reaction_observations").all()).toEqual([
      { message_id: "message-1", reactor_id: "reactor", observed_at_ms: CREATED + 100 },
    ]);
  });

  it("partial reaction/userを必要最小fetchし、fetch failureはresolve falseで通常処理へ伝播しない", async () => {
    const { services } = await seed();
    expect(await trackTitleTcReaction(reaction({ partial: true }) as never, user({ partial: true }) as never, services, () => CREATED + 100)).toBe(true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = reaction({ partial: true, fetch: vi.fn().mockRejectedValue(new Error("fetch failed")) });
    await expect(trackTitleTcReaction(failed as never, user() as never, services, () => CREATED + 200)).resolves.toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reaction observation failed"), expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("pre-feature message reactionは0でmessage historyをbackfillしない", async () => {
    const { db, services } = setup();
    expect(await trackTitleTcReaction(reaction() as never, user() as never, services, () => CREATED + 100)).toBe(false);
    expect(messageRows(db)).toHaveLength(0);
  });

  it("other guild reactionをmain guild observationへ混入させない", async () => {
    const { db, services } = await seed();
    expect(
      await trackTitleTcReaction(reaction({ guildId: "guild-other" }) as never, user() as never, services, () => CREATED + 100),
    ).toBe(false);
    expect(db.prepare("SELECT * FROM tc_reaction_observations").all()).toHaveLength(0);
  });
});

describe("production client wiring", () => {
  it("GuildMessageReactions intent・必要partials・MessageReactionAdd sidecarを配線する", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("GatewayIntentBits.GuildMessageReactions");
    for (const partial of ["Partials.Message", "Partials.Channel", "Partials.Reaction", "Partials.User"]) {
      expect(source).toContain(partial);
    }
    expect(source).toContain("client.on(Events.MessageReactionAdd");
    expect(source).toContain("trackTitleTcReaction(reaction, user, services)");
  });
});
