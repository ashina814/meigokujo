import { describe, expect, it, vi } from "vitest";
import { MessageType, PermissionFlagsBits } from "discord.js";
import { Ledger, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import {
  BOOST_REWARD_LAST_RECOVERY_AT_SETTING,
  BOOST_REWARD_LD,
  BOOST_REWARD_STARTED_AT_SETTING,
  handleBoostRewardMessage,
  initializeBoostRewardRecovery,
} from "../src/boost-reward.js";

function services() {
  registerDefaultTxTypes();
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  settings.set("guild:main", "guild-main", "test");
  return { db, ledger, settings } as any;
}

function boostMessage(id: string, timestamp: number, userId = "user-1") {
  const send = vi.fn(async () => undefined);
  return {
    value: {
      id,
      type: MessageType.GuildBoost,
      author: { id: userId, bot: false },
      guildId: "guild-main",
      createdTimestamp: timestamp,
      channel: { isSendable: () => true, send },
    } as any,
    send,
  };
}

function recoveryClient(
  fetchMessages: ReturnType<typeof vi.fn>,
  options: { readHistory?: boolean; viewChannel?: boolean } = {},
) {
  const readHistory = options.readHistory ?? true;
  const viewChannel = options.viewChannel ?? true;
  const permissions = {
    has: vi.fn((permission: bigint) => {
      if (permission === PermissionFlagsBits.ReadMessageHistory) return readHistory;
      if (permission === PermissionFlagsBits.ViewChannel) return viewChannel;
      return true;
    }),
  };
  const systemChannel = {
    id: "system-channel",
    permissionsFor: vi.fn(() => permissions),
    messages: { fetch: fetchMessages },
  };
  const guild = {
    systemChannel,
    systemChannelFlags: { has: vi.fn(() => false) },
    members: { me: { id: "bot-user" } },
  };
  return { guilds: { cache: new Map([["guild-main", guild]]) } } as any;
}

describe("サーバーブースト報酬 権限・user順序", () => {
  it("履歴APIがemptyでもReadMessageHistory権限が無ければ開始時刻とwatermarkを確定しない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const fetchMessages = vi.fn(async () => new Map());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages, { readHistory: false }), s);

    expect(fetchMessages).not.toHaveBeenCalled();
    expect(s.settings.getString(BOOST_REWARD_STARTED_AT_SETTING)).toBeUndefined();
    expect(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING)).toBeUndefined();
    vi.useRealTimers();
  });

  it("先行Aが失敗したuserは復旧pass後のlive Cも保留し、次回A→B→C順で解決する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const started = Math.floor(new Date("2026-08-18T18:00:00+09:00").getTime() / 1_000);
    s.settings.set(BOOST_REWARD_STARTED_AT_SETTING, started, "test");
    s.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, started, "test");
    s.ledger.ensureAccount("user:user-bad", "user");
    s.ledger.setAccountStatus("user:user-bad", "frozen");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const a = boostMessage("bad-a", new Date("2026-08-18T19:00:00+09:00").getTime(), "user-bad");
    const b = boostMessage("bad-b", new Date("2026-08-18T19:05:00+09:00").getTime(), "user-bad");
    const good = boostMessage("good-a", new Date("2026-08-18T19:10:00+09:00").getTime(), "user-good");
    const firstFetch = vi.fn(async () =>
      new Map([
        [good.value.id, good.value],
        [b.value.id, b.value],
        [a.value.id, a.value],
      ]),
    );

    await initializeBoostRewardRecovery(recoveryClient(firstFetch), s);

    expect(s.ledger.balanceOf("user:user-bad")).toBe(0);
    expect(s.ledger.balanceOf("user:user-good")).toBe(BOOST_REWARD_LD);

    // 復旧passが終了してもAが未解決なので、同じuserのlive Cは先払いしない。
    s.ledger.setAccountStatus("user:user-bad", "active");
    const c = boostMessage("bad-c", new Date("2026-08-18T20:00:01+09:00").getTime(), "user-bad");
    expect(await handleBoostRewardMessage(c.value, s)).toBe(true);
    expect(s.ledger.balanceOf("user:user-bad")).toBe(0);
    expect(c.send).not.toHaveBeenCalled();

    const retryFetch = vi.fn(async () =>
      new Map([
        [b.value.id, b.value],
        [a.value.id, a.value],
      ]),
    );
    await initializeBoostRewardRecovery(recoveryClient(retryFetch), s);

    expect(s.ledger.balanceOf("user:user-bad")).toBe(BOOST_REWARD_LD * 2);
    const outcomes = s.db
      .prepare(
        "SELECT message_id, outcome FROM boost_reward_events WHERE user_id = 'user-bad' ORDER BY event_at, message_id",
      )
      .all() as Array<{ message_id: string; outcome: string }>;
    expect(outcomes).toEqual([
      { message_id: "bad-a", outcome: "paid" },
      { message_id: "bad-b", outcome: "paid" },
      { message_id: "bad-c", outcome: "capped" },
    ]);
    vi.useRealTimers();
  });
});
