import { describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type { Message } from "discord.js";
import { openDb, RankEngine, Settings, TitleV2Store, TextActivity } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { handleMessageXp, isSafeTitleTextActivityMessage } from "../src/rank-tracker.js";

/**
 * PR E1: `text_active_days`のproduction callsite（`handleMessageXp()`内の
 * `services.textActivity.recordActiveDay(...)`呼び出し）を直接固定する
 * （PR #159レビューの教訓——helper単体testだけでは実callsite削除を検知できない）。
 *
 * PR #160レビュー: private/role-gated channel・thread（forum post含む）を
 * `text_active_days`から除外するprivacy guard（`isSafeTitleTextActivityMessage()`）の
 * production callsite testも含む。この判定はtext_active_days記録の可否だけに使い、
 * 既存Rank XP eligibilityは変えない——private channelでもRank XPは通常通り付与される
 * ことをテストで固定する。
 */

function setup() {
  const db = openDb(":memory:");
  const ranks = new RankEngine(db);
  const titleV2 = new TitleV2Store(db);
  const settings = new Settings(db);
  const textActivity = new TextActivity(db);
  const services = { ranks, titleV2, settings, textActivity } as unknown as Services;
  return { db, ranks, titleV2, settings, textActivity, services };
}

/** デフォルトは「public GuildTextでthreadではない、@everyoneがViewChannel可能」——安全側。 */
function fakeMessage(
  userId: string,
  opts: {
    content?: string;
    attachmentsSize?: number;
    bot?: boolean;
    guild?: boolean;
    channelId?: string;
    parentId?: string | null;
    createdTimestamp?: number;
    isThread?: boolean;
    channelType?: ChannelType;
    /** @everyoneがViewChannelできるか。nullはpermission解決不能（fail-closed）を模す。 */
    everyoneCanView?: boolean | null;
  } = {},
): Message {
  // ??はnullをundefinedと区別しない——"permission解決不能"を表すnullが
  // デフォルトのtrueへ潰れてしまうため、明示的にundefinedだけをdefault対象にする。
  const everyoneCanView = opts.everyoneCanView === undefined ? true : opts.everyoneCanView;
  const permissions =
    everyoneCanView === null
      ? null
      : new PermissionsBitField(everyoneCanView ? [PermissionFlagsBits.ViewChannel] : []);
  return {
    author: { bot: opts.bot ?? false, id: userId },
    inGuild: () => opts.guild ?? true,
    content: opts.content ?? "hello",
    attachments: { size: opts.attachmentsSize ?? 0 },
    channel: {
      parentId: opts.parentId ?? null,
      isThread: () => opts.isThread ?? false,
      type: opts.channelType ?? ChannelType.GuildText,
      permissionsFor: () => permissions,
    },
    channelId: opts.channelId ?? "chan-1",
    createdTimestamp: opts.createdTimestamp ?? Date.now(),
    guild: { roles: { everyone: { id: "everyone-role" } } },
  } as unknown as Message;
}

function countTextActiveDays(db: ReturnType<typeof openDb>, userId: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM text_active_days WHERE user_id = ?`).get(userId) as { c: number }).c;
}

describe("handleMessageXp() — text_active_days production callsiteの実配線固定", () => {
  it("qualifying messageでtext_active_days rowが実際に作られる", async () => {
    const { db, services } = setup();
    const userId = "prod-text-activity-user";
    const createdTimestamp = new Date("2026-08-20T12:00:00+09:00").getTime(); // discord.js: ミリ秒
    await handleMessageXp(fakeMessage(userId, { createdTimestamp }), services);

    const row = db.prepare(`SELECT activity_date, observed_at FROM text_active_days WHERE user_id = ?`).get(userId) as
      | { activity_date: string; observed_at: number }
      | undefined;
    expect(row?.activity_date).toBe("2026-08-20");
    expect(row?.observed_at).toBe(Math.floor(createdTimestamp / 1000));
  });

  it("XP cooldown独立性: rank XPがcooldown中でaward=nullでも、その日のtext_active_days rowは作られる（§13）", async () => {
    const { db, ranks, services } = setup();
    const userId = "cooldown-user";
    ranks.awardText(userId, 10, 30); // 直前にXP付与済み(30秒cooldown中にする)
    const xpBefore = ranks.getText(userId).xp;

    const createdTimestamp = new Date("2026-08-20T12:00:01+09:00").getTime();
    await handleMessageXp(fakeMessage(userId, { createdTimestamp }), services);

    // cooldown中なのでXPは変わっていない(awardText()はnullを返して早期return)。
    expect(ranks.getText(userId).xp).toBe(xpBefore);
    // それでもtext_active_days rowは作られている。
    expect(countTextActiveDays(db, userId)).toBe(1);
  });

  it("timestamp単位: message.createdTimestamp(ミリ秒)が秒へ正規化されて保存される（13桁msをそのまま保存しない、§46）", async () => {
    const { db, services } = setup();
    const userId = "unit-test-user";
    const msTimestamp = 1_787_270_400_000; // 13桁ミリ秒
    await handleMessageXp(fakeMessage(userId, { createdTimestamp: msTimestamp }), services);
    const row = db.prepare(`SELECT observed_at FROM text_active_days WHERE user_id = ?`).get(userId) as {
      observed_at: number;
    };
    expect(row.observed_at).toBe(Math.floor(msTimestamp / 1000));
    expect(String(row.observed_at)).toHaveLength(10); // 秒(10桁)。msの13桁のまま保存されていない。
  });
});

describe("excluded / non-qualifying messages（§48）", () => {
  it("xp_excluded_channels対象message → text_active_days 0", async () => {
    const { db, settings, services } = setup();
    settings.set("xp_excluded_channels", ["excluded-chan"], "test");
    const userId = "excluded-user";
    await handleMessageXp(fakeMessage(userId, { channelId: "excluded-chan" }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("bot message → 0", async () => {
    const { db, services } = setup();
    const userId = "bot-user";
    await handleMessageXp(fakeMessage(userId, { bot: true }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("guild外(DM) → 0", async () => {
    const { db, services } = setup();
    const userId = "dm-user";
    await handleMessageXp(fakeMessage(userId, { guild: false }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("空message(contentもattachmentも無し) → 0", async () => {
    const { db, services } = setup();
    const userId = "empty-user";
    await handleMessageXp(fakeMessage(userId, { content: "", attachmentsSize: 0 }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });
});

describe("private/thread channel exclusion（PR #160レビュー §5）", () => {
  it("A. public GuildText + @everyone ViewChannel=true → text_active_days 1", async () => {
    const { db, services } = setup();
    const userId = "public-channel-user";
    await handleMessageXp(fakeMessage(userId, { everyoneCanView: true }), services);
    expect(countTextActiveDays(db, userId)).toBe(1);
  });

  it("B. private GuildText（@everyone ViewChannel=false）→ text_active_days 0、Rank XPは付与される", async () => {
    const { db, ranks, services } = setup();
    const userId = "private-channel-user";
    await handleMessageXp(fakeMessage(userId, { everyoneCanView: false }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
    expect(ranks.getText(userId).xp).toBeGreaterThan(0); // safe-source除外がRank除外へ広がっていない
  });

  it("C. permission解決がnull/unknown → text_active_days 0、Rank XPは継続（fail-closed）", async () => {
    const { db, ranks, services } = setup();
    const userId = "unresolvable-permission-user";
    await handleMessageXp(fakeMessage(userId, { everyoneCanView: null }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
    expect(ranks.getText(userId).xp).toBeGreaterThan(0);
  });

  it("D. PublicThread → text_active_days 0", async () => {
    const { db, services } = setup();
    const userId = "public-thread-user";
    await handleMessageXp(fakeMessage(userId, { isThread: true, channelType: ChannelType.PublicThread }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("E. PrivateThread → text_active_days 0", async () => {
    const { db, services } = setup();
    const userId = "private-thread-user";
    await handleMessageXp(fakeMessage(userId, { isThread: true, channelType: ChannelType.PrivateThread }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("F. forum post thread（AnnouncementThread相当のforum post）→ text_active_days 0", async () => {
    const { db, services } = setup();
    const userId = "forum-post-user";
    // forum postはPublicThread/PrivateThread型のchannelとしてmessageが飛んでくる。
    await handleMessageXp(
      fakeMessage(userId, { isThread: true, channelType: ChannelType.PublicThread, parentId: "forum-parent" }),
      services,
    );
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("G. public text channel + xp_excluded_channels → 0（既存test維持）", async () => {
    const { db, settings, services } = setup();
    settings.set("xp_excluded_channels", ["excluded-chan"], "test");
    const userId = "excluded-public-user";
    await handleMessageXp(
      fakeMessage(userId, { channelId: "excluded-chan", everyoneCanView: true }),
      services,
    );
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("GuildVoice内テキストは対象外（VC内テキストを暗黙に「普通のTC」へ含めない）", async () => {
    const { db, services } = setup();
    const userId = "voice-text-user";
    await handleMessageXp(fakeMessage(userId, { channelType: ChannelType.GuildVoice }), services);
    expect(countTextActiveDays(db, userId)).toBe(0);
  });

  it("channel.type自体はGuildTextを騙るがisThread()=trueな不整合fixtureも除外する（type allowlistとisThread()チェックが独立していることの確認）", async () => {
    const { db, services } = setup();
    const userId = "spoofed-thread-user";
    await handleMessageXp(
      fakeMessage(userId, { channelType: ChannelType.GuildText, isThread: true, everyoneCanView: true }),
      services,
    );
    expect(countTextActiveDays(db, userId)).toBe(0);
  });
});

describe("isSafeTitleTextActivityMessage()", () => {
  it("public GuildAnnouncementも安全channelとして許可される", () => {
    const message = fakeMessage("alice", { channelType: ChannelType.GuildAnnouncement, everyoneCanView: true });
    expect(isSafeTitleTextActivityMessage(message as unknown as Message<true>)).toBe(true);
  });
});

describe("writer failure isolation（§18, §49）", () => {
  it("TextActivity.recordActiveDay()がthrowしても、RankEngine.awardText()は実行され、errorがlogされる", async () => {
    const { ranks, titleV2, settings } = setup();
    const throwingTextActivity = {
      recordActiveDay: () => {
        throw new Error("boom");
      },
    };
    const services = { ranks, titleV2, settings, textActivity: throwingTextActivity } as unknown as Services;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const userId = "failure-isolation-user";
    await expect(handleMessageXp(fakeMessage(userId), services)).resolves.toBeUndefined();

    expect(ranks.getText(userId).xp).toBeGreaterThan(0); // v2 source failureに関わらずRank XPは付与される
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("text-activity"), expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it("isSafeTitleTextActivityMessage()自体がthrowしても、RankEngine.awardText()は実行され、errorがlogされる", async () => {
    const { ranks, services } = setup();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // channel.isThread()が無い(=呼び出しでTypeErrorになる)壊れたmessage fixture。
    const brokenMessage = {
      author: { bot: false, id: "broken-channel-user" },
      inGuild: () => true,
      content: "hello",
      attachments: { size: 0 },
      channel: { parentId: null }, // isThread/type/permissionsForが無い
      channelId: "chan-1",
      createdTimestamp: Date.now(),
    } as unknown as Message;

    await expect(handleMessageXp(brokenMessage, services)).resolves.toBeUndefined();

    expect(ranks.getText("broken-channel-user").xp).toBeGreaterThan(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("text-activity"), expect.any(Error));
    consoleErrorSpy.mockRestore();
  });
});
