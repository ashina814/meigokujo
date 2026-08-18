import { describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { Ledger, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import {
  BOOST_REWARD_LD,
  BOOST_REWARD_STARTED_AT_SETTING,
  handleBoostRewardMessage,
  recordManualBoostCompensation,
} from "../src/boost-reward.js";

function services() {
  registerDefaultTxTypes();
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  settings.set("guild:main", "guild-main", "test");
  settings.set(
    BOOST_REWARD_STARTED_AT_SETTING,
    Math.floor(new Date("2026-08-18T18:00:00+09:00").getTime() / 1_000),
    "test",
  );
  return { db, ledger, settings } as any;
}

function boostMessage(id: string, timestamp: number, userId = "user-1") {
  return {
    id,
    type: MessageType.GuildBoost,
    author: { id: userId, bot: false },
    guildId: "guild-main",
    createdTimestamp: timestamp,
    channel: { isSendable: () => false },
  } as any;
}

describe("サーバーブースト報酬 手動補償順序", () => {
  it("先行Aが未解決なら後続Bの手動補償もDBで拒否し、A解決後だけBを支給できる", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const aAt = new Date("2026-08-18T19:00:00+09:00").getTime();
    const bAt = new Date("2026-08-18T19:05:00+09:00").getTime();

    s.ledger.ensureAccount("user:user-1", "user");
    s.ledger.setAccountStatus("user:user-1", "frozen");
    await expect(handleBoostRewardMessage(boostMessage("boost-a", aAt), s)).rejects.toThrow();
    s.ledger.setAccountStatus("user:user-1", "active");

    expect(() =>
      recordManualBoostCompensation(
        { messageId: "boost-b", userId: "user-1", eventTimestampMs: bAt },
        s,
        "operator:1",
      ),
    ).toThrow(/ERR_BOOST_EARLIER_PENDING/);
    expect(s.ledger.balanceOf("user:user-1")).toBe(0);

    expect(
      recordManualBoostCompensation(
        { messageId: "boost-a", userId: "user-1", eventTimestampMs: aAt },
        s,
        "operator:1",
      ),
    ).toEqual({ kind: "paid", count: 1 });
    expect(
      recordManualBoostCompensation(
        { messageId: "boost-b", userId: "user-1", eventTimestampMs: bAt },
        s,
        "operator:1",
      ),
    ).toEqual({ kind: "paid", count: 2 });
    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * 2);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_pending WHERE user_id = 'user-1'").get() as { c: number }).c,
    ).toBe(0);

    vi.useRealTimers();
  });
});
