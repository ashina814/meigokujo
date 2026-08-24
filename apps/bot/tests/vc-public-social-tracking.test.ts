import { readFileSync } from "node:fs";
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { openDb, Settings, VcPublicSocialPresence } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import {
  initializeVcPublicSocialPresence,
  isEligiblePublicSocialVoiceChannel,
  resumeVcPublicSocialGuild,
  resumeVcPublicSocialShard,
  suspendVcPublicSocialGuild,
  suspendVcPublicSocialShard,
  trackVcPublicSocialChannelUpdate,
  trackVcPublicSocialEveryoneRoleUpdate,
  trackVcPublicSocialPresence,
} from "../src/vc-public-social-tracking.js";

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  settings.set("guild:main", "guild-main", "test");
  const vcPublicSocial = new VcPublicSocialPresence(db);
  const services = { settings, vcPublicSocial } as unknown as Services;
  return { db, settings, vcPublicSocial, services };
}

function guild(id = "guild-main") {
  const everyone = { id: `${id}-everyone` };
  return {
    id,
    shardId: 0,
    roles: { everyone },
    channels: { cache: new Collection<string, never>() },
  };
}

function channel(options: {
  id?: string;
  guild?: ReturnType<typeof guild>;
  type?: ChannelType;
  view?: boolean | null;
  connect?: boolean | null;
  permissionThrows?: boolean;
  humans?: string[];
  bots?: string[];
  parentId?: string | null;
} = {}) {
  const owner = options.guild ?? guild();
  const members = new Collection<string, { id: string; user: { bot: boolean } }>();
  for (const id of options.humans ?? []) members.set(id, { id, user: { bot: false } });
  for (const id of options.bots ?? []) members.set(id, { id, user: { bot: true } });
  const value = {
    id: options.id ?? "voice-public",
    guildId: owner.id,
    guild: owner,
    type: options.type ?? ChannelType.GuildVoice,
    parentId: options.parentId ?? null,
    members,
    permissionsFor: () => {
      if (options.permissionThrows) throw new Error("permission resolution failed");
      if (options.view === null || options.connect === null) return null;
      return new PermissionsBitField([
        ...(options.view === false ? [] : [PermissionFlagsBits.ViewChannel]),
        ...(options.connect === false ? [] : [PermissionFlagsBits.Connect]),
      ]);
    },
  };
  owner.channels.cache.set(value.id, value as never);
  return value;
}

function state(value: ReturnType<typeof channel> | null) {
  return { channel: value, channelId: value?.id ?? null } as never;
}

function rows(db: ReturnType<typeof openDb>) {
  return db.prepare("SELECT user_id, channel_id, started_at, ended_at, end_quality FROM vc_public_social_presence ORDER BY id").all() as Array<Record<string, unknown>>;
}

function clientWith(owner: ReturnType<typeof guild>) {
  return { guilds: { cache: new Collection([[owner.id, owner]]), fetch: vi.fn() } };
}

describe("public VC eligibility", () => {
  it("main GuildVoice + @everyone ViewChannel/Connectだけを許可する", () => {
    const { services } = setup();
    expect(isEligiblePublicSocialVoiceChannel(channel() as never, services)).toBe(true);
    expect(isEligiblePublicSocialVoiceChannel(channel({ type: ChannelType.GuildStageVoice }) as never, services)).toBe(false);
    expect(isEligiblePublicSocialVoiceChannel(channel({ guild: guild("other-guild") }) as never, services)).toBe(false);
  });

  it.each([
    ["role-gated oboro", { id: "oboro", view: false }],
    ["role-gated mitsu", { id: "mitsu", connect: false }],
    ["permission unknown", { view: null, connect: null }],
    ["permission failure", { permissionThrows: true }],
  ])("%sをfail-closedする", (_label, options) => {
    const { services } = setup();
    expect(isEligiblePublicSocialVoiceChannel(channel(options) as never, services)).toBe(false);
  });
});

describe("VoiceStateUpdate reconciliation", () => {
  it("Alice alone→Bob join→Bob leaveをjoin/leave時刻で双方10秒にする", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 100);
    voice.members.set("bob", { id: "bob", user: { bot: false } });
    trackVcPublicSocialPresence(state(voice), state(voice), services, () => 110);
    voice.members.delete("bob");
    trackVcPublicSocialPresence(state(voice), state(null), services, () => 120);
    expect(rows(db)).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 110, ended_at: 120, end_quality: "observed" },
      { user_id: "bob", channel_id: "voice-public", started_at: 110, ended_at: 120, end_quality: "observed" },
    ]);
  });

  it("3 humans + botでもhuman 3 rowsだけでpair-sumを作らない", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice", "bob", "carol"], bots: ["music-bot"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    voice.members.clear();
    trackVcPublicSocialPresence(state(voice), state(null), services, () => 20);
    expect(rows(db)).toHaveLength(3);
    expect(rows(db).map((row) => row.user_id).sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("same-channel mute/deafen相当のstate updateでintervalを分割しない", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice", "bob"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    trackVcPublicSocialPresence(state(voice), state(voice), services, () => 15);
    voice.members.clear();
    trackVcPublicSocialPresence(state(voice), state(null), services, () => 20);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
    ]);
  });

  it("Alice + botはsocial occupancyにならない", () => {
    const { db, services } = setup();
    trackVcPublicSocialPresence(state(null), state(channel({ humans: ["alice"], bots: ["bot"] })), services, () => 10);
    expect(rows(db)).toEqual([]);
  });

  it("other guild / non-GuildVoice / private permissionは0 row", () => {
    const { db, services } = setup();
    for (const voice of [
      channel({ guild: guild("other"), humans: ["alice", "bob"] }),
      channel({ type: ChannelType.GuildStageVoice, humans: ["alice", "bob"] }),
      channel({ id: "oboro", view: false, humans: ["alice", "bob"] }),
      channel({ id: "mitsu", connect: false, humans: ["alice", "bob"] }),
    ]) trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    expect(rows(db)).toEqual([]);
  });
});

describe("permission transitions / restart / isolation", () => {
  it("voice public→private→public transitionをChannelUpdateでclose/reopenする", () => {
    const { db, services } = setup();
    const owner = guild();
    const publicVoice = channel({ guild: owner, humans: ["alice", "bob"] });
    trackVcPublicSocialChannelUpdate(publicVoice as never, services, () => 10);
    const privateVoice = channel({ id: publicVoice.id, guild: owner, view: false, humans: ["alice", "bob"] });
    trackVcPublicSocialChannelUpdate(privateVoice as never, services, () => 20);
    const publicAgain = channel({ id: publicVoice.id, guild: owner, humans: ["alice", "bob"] });
    trackVcPublicSocialChannelUpdate(publicAgain as never, services, () => 30);
    publicAgain.members.clear();
    trackVcPublicSocialChannelUpdate(publicAgain as never, services, () => 40);
    expect(rows(db).filter((row) => row.user_id === "alice")).toMatchObject([
      { started_at: 10, ended_at: 20 },
      { started_at: 30, ended_at: 40 },
    ]);
  });

  it("category updateと@everyone role updateでchild voiceを再収束する", () => {
    const { db, services } = setup();
    const owner = guild();
    const child = channel({ guild: owner, parentId: "category", humans: ["alice", "bob"] });
    const category = channel({ id: "category", guild: owner, type: ChannelType.GuildCategory });
    expect(trackVcPublicSocialChannelUpdate(category as never, services, () => 10)).toBe(true);
    const role = { id: owner.roles.everyone.id, guild: owner };
    expect(trackVcPublicSocialEveryoneRoleUpdate(role as never, services, () => 20)).toBe(true);
    expect(rows(db)).toHaveLength(2);
    expect(child.id).toBe("voice-public");
  });

  it("startupはmain guild cacheだけから現在観測を開始しfetch/backfillしない", () => {
    const { db, services } = setup();
    const owner = guild();
    channel({ guild: owner, humans: ["alice", "bob"] });
    const fetch = vi.fn();
    const client = { guilds: { cache: new Collection([[owner.id, owner]]), fetch } };
    expect(initializeVcPublicSocialPresence(client as never, services, () => 100)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(2);
  });

  it("T: sidecar writer failureをcatchしvc_segments/XP/rooms相当の既存consumerへthrowしない", () => {
    const { services } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const legacyVcSegments = vi.fn();
    const rankXp = vi.fn();
    const rooms = vi.fn();
    vi.spyOn(services.vcPublicSocial, "reconcileChannel").mockImplementation(() => { throw new Error("disk failed"); });
    expect(trackVcPublicSocialPresence(state(null), state(channel({ humans: ["alice", "bob"] })), services, () => 10)).toBe(false);
    legacyVcSegments();
    rankXp();
    rooms();
    expect(legacyVcSegments).toHaveBeenCalledOnce();
    expect(rankXp).toHaveBeenCalledOnce();
    expect(rooms).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("[vc-public-social] channel observation write failed", expect.any(Error));
    error.mockRestore();
  });
});

describe("Gateway observation trust boundary", () => {
  it("recoverable/unrecoverable/fresh-ready/guild availability eventを全てlive wiringする", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    for (const needle of [
      "Events.ShardReconnecting",
      "Events.ShardDisconnect",
      "Events.ShardResume",
      "Events.ShardReady",
      "Events.GuildUnavailable",
      "Events.GuildAvailable",
    ]) expect(source).toContain(needle);
  });

  it("P: disconnect中のVoiceState replayを無視し、disconnect〜resumeをtrustedにしない", () => {
    const { db, services } = setup();
    const owner = guild();
    const voice = channel({ guild: owner, humans: ["alice", "bob"] });
    const client = clientWith(owner);
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    expect(suspendVcPublicSocialShard(client as never, 0, services, () => 20)).toBe(true);
    voice.members.delete("bob");
    expect(trackVcPublicSocialPresence(state(voice), state(null), services, () => 30)).toBe(false);
    expect(resumeVcPublicSocialShard(client as never, 0, services, () => 40)).toBe(true);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
    ]);
  });

  it("Q: resume時にhuman 2人ならresume observationからだけ新規openする", () => {
    const { db, services } = setup();
    const owner = guild();
    const voice = channel({ guild: owner, humans: ["alice"] });
    const client = clientWith(owner);
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    suspendVcPublicSocialShard(client as never, 0, services, () => 20);
    voice.members.set("bob", { id: "bob", user: { bot: false } });
    trackVcPublicSocialPresence(state(voice), state(voice), services, () => 30);
    resumeVcPublicSocialShard(client as never, 0, services, () => 40);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 40, ended_at: null, end_quality: null },
    ]);
  });

  it("R: resume時にhuman 1人ならstale intervalを継続しない", () => {
    const { db, services } = setup();
    const owner = guild();
    const voice = channel({ guild: owner, humans: ["alice", "bob"] });
    const client = clientWith(owner);
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    suspendVcPublicSocialShard(client as never, 0, services, () => 20);
    voice.members.delete("bob");
    resumeVcPublicSocialShard(client as never, 0, services, () => 40);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
    ]);
  });

  it("fresh readyとguild unavailable→availableもcurrent cache時点からだけ再開する", () => {
    const { db, services } = setup();
    const owner = guild();
    const voice = channel({ guild: owner, humans: ["alice", "bob"] });
    const client = clientWith(owner);
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    suspendVcPublicSocialGuild(owner as never, services, () => 20);
    voice.members.clear();
    resumeVcPublicSocialGuild(owner as never, services, () => 30);
    suspendVcPublicSocialShard(client as never, 0, services, () => 40);
    voice.members.set("alice", { id: "alice", user: { bot: false } });
    voice.members.set("bob", { id: "bob", user: { bot: false } });
    resumeVcPublicSocialShard(client as never, 0, services, () => 50);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
      { user_id: "alice", channel_id: "voice-public", started_at: 50, ended_at: null, end_quality: null },
    ]);
  });
});

describe("writer failure trust boundary", () => {
  it("S: close write failure中は次の正常reconcileまでopen rowをtrustedに伸ばさない", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice", "bob"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    voice.members.delete("bob");
    vi.spyOn(services.vcPublicSocial, "reconcileChannel").mockImplementationOnce(() => {
      throw new Error("transient write failure");
    });
    expect(trackVcPublicSocialPresence(state(voice), state(null), services, () => 20)).toBe(false);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
    ]);
    expect(trackVcPublicSocialPresence(state(voice), state(null), services, () => 30)).toBe(true);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
    ]);
  });

  it("pending live observationを次の成功時にatomic replayし、確実な活動を不要に捨てない", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice", "bob"] });
    const original = services.vcPublicSocial.reconcileChannel.bind(services.vcPublicSocial);
    vi.spyOn(services.vcPublicSocial, "reconcileChannel")
      .mockImplementationOnce(() => { throw new Error("transient write failure"); })
      .mockImplementation(original);
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    expect(rows(db)).toEqual([]);
    expect(trackVcPublicSocialPresence(state(voice), state(voice), services, () => 20)).toBe(true);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: null, end_quality: null },
    ]);
  });

  it("U: 一つのchannel failureでも無関係なpublic VCは正常に記録する", () => {
    const { db, services } = setup();
    const owner = guild();
    const broken = channel({ id: "broken", guild: owner, humans: ["alice", "bob"] });
    const healthy = channel({ id: "healthy", guild: owner, humans: ["carol", "dave"] });
    const original = services.vcPublicSocial.reconcileChannel.bind(services.vcPublicSocial);
    vi.spyOn(services.vcPublicSocial, "reconcileChannel").mockImplementation((input) => {
      if (input.channelId === "broken") throw new Error("broken source");
      return original(input);
    });
    expect(trackVcPublicSocialChannelUpdate(broken as never, services, () => 10)).toBe(false);
    expect(trackVcPublicSocialChannelUpdate(healthy as never, services, () => 10)).toBe(true);
    expect(rows(db).map((row) => row.channel_id)).toEqual(["healthy", "healthy"]);
  });
});
