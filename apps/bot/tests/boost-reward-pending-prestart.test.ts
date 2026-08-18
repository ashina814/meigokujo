import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { Ledger, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";

function services() {
  registerDefaultTxTypes();
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  settings.set("guild:main", "guild-main", "test");
  return { db, ledger, settings } as any;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("サーバーブースト報酬 pending開始境界", () => {
  it("自動化開始前にfail-closed中で届いたBoostを永続pendingにしない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const s = services();
    vi.resetModules();
    const boost = await import("../src/boost-reward.js");
    const guild = {
      systemChannel: { id: "system-channel" },
      systemChannelFlags: { has: vi.fn(() => true) },
      members: { me: { id: "bot-user" } },
    };
    const client = { guilds: { cache: new Map([["guild-main", guild]]) } } as any;

    await boost.initializeBoostRewardRecovery(client, s);
    expect(s.settings.getString(boost.BOOST_REWARD_STARTED_AT_SETTING)).toBeUndefined();

    const send = vi.fn(async () => undefined);
    const message = {
      id: "pre-start",
      type: MessageType.GuildBoost,
      author: { id: "user-1", bot: false },
      guildId: "guild-main",
      createdTimestamp: Date.now(),
      channel: { isSendable: () => true, send },
    } as any;

    expect(await boost.handleBoostRewardMessage(message, s)).toBe(true);
    expect(s.ledger.balanceOf("user:user-1")).toBe(0);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_pending").get() as { c: number }).c,
    ).toBe(0);
  });
});
