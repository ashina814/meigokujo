import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import { openDb, RankEngine, Settings, TitleV2Store, TextActivity } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { handleMessageXp } from "../src/rank-tracker.js";

/**
 * PR E1: `text_active_days`のproduction callsite（`handleMessageXp()`内の
 * `services.textActivity.recordActiveDay(...)`呼び出し）を直接固定する
 * （PR #159レビューの教訓——helper単体testだけでは実callsite削除を検知できない）。
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
  } = {},
): Message {
  return {
    author: { bot: opts.bot ?? false, id: userId },
    inGuild: () => opts.guild ?? true,
    content: opts.content ?? "hello",
    attachments: { size: opts.attachmentsSize ?? 0 },
    channel: { parentId: opts.parentId ?? null },
    channelId: opts.channelId ?? "chan-1",
    createdTimestamp: opts.createdTimestamp ?? Date.now(),
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
});
