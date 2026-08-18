import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType, PermissionFlagsBits } from "discord.js";
import { Ledger, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";

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

function recoveryClient(fetchMessages: ReturnType<typeof vi.fn>) {
  const permissions = {
    has: vi.fn((permission: bigint) =>
      permission === PermissionFlagsBits.ViewChannel || permission === PermissionFlagsBits.ReadMessageHistory,
    ),
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("サーバーブースト報酬 restart pending", () => {
  it("失敗したAがDiscord履歴から消えて再起動してもB/Cを先払いしない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const s = services();
    const started = Math.floor(new Date("2026-08-18T18:00:00+09:00").getTime() / 1_000);
    s.settings.set("boost_reward:auto_started_at", started, "test");
    s.settings.set("boost_reward:last_recovery_at", started, "test");
    s.ledger.ensureAccount("user:user-bad", "user");
    s.ledger.setAccountStatus("user:user-bad", "frozen");

    const a = boostMessage("boost-a", new Date("2026-08-18T19:00:00+09:00").getTime(), "user-bad");
    const b = boostMessage("boost-b", new Date("2026-08-18T19:05:00+09:00").getTime(), "user-bad");
    const firstFetch = vi.fn(async () =>
      new Map([
        [b.value.id, b.value],
        [a.value.id, a.value],
      ]),
    );

    const first = await import("../src/boost-reward.js");
    await first.initializeBoostRewardRecovery(recoveryClient(firstFetch), s);

    expect(s.ledger.balanceOf("user:user-bad")).toBe(0);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_pending WHERE user_id = 'user-bad'").get() as { c: number }).c,
    ).toBe(2);

    // 本当のプロセス再起動相当。module-level Mapは捨てる。
    vi.resetModules();
    const fresh = await import("../src/boost-reward.js");
    s.ledger.setAccountStatus("user:user-bad", "active");

    // AのDiscord system messageは削除済みで、履歴にはBしか残っていない。
    const retryFetch = vi.fn(async () => new Map([[b.value.id, b.value]]));
    const retryClient = recoveryClient(retryFetch);
    await fresh.initializeBoostRewardRecovery(retryClient, s);

    // DB pendingからAを復元しているので、BはAを追い越せない。
    expect(s.ledger.balanceOf("user:user-bad")).toBe(0);
    expect(b.send).not.toHaveBeenCalled();

    // operatorが削除済みAを確認して補償するとAだけ解決し、次のblockerはBへ進む。
    expect(
      fresh.recordManualBoostCompensation(
        { messageId: a.value.id, userId: "user-bad", eventTimestampMs: a.value.createdTimestamp },
        s,
        "operator:1",
      ),
    ).toEqual({ kind: "paid", count: 1 });
    expect(s.ledger.balanceOf("user:user-bad")).toBe(fresh.BOOST_REWARD_LD);

    // A解決直後にlive Cが来ても、未解決Bが残っているので先払いしない。
    const c = boostMessage("boost-c", new Date("2026-08-18T20:00:01+09:00").getTime(), "user-bad");
    expect(await fresh.handleBoostRewardMessage(c.value, s)).toBe(true);
    expect(s.ledger.balanceOf("user:user-bad")).toBe(fresh.BOOST_REWARD_LD);
    expect(c.send).not.toHaveBeenCalled();

    // 次の復旧でB→Cの順。Bが2回目を受け取り、Cは月次上限になる。
    await fresh.initializeBoostRewardRecovery(retryClient, s);
    expect(s.ledger.balanceOf("user:user-bad")).toBe(fresh.BOOST_REWARD_LD * 2);
    const outcomes = s.db
      .prepare("SELECT message_id, outcome FROM boost_reward_events WHERE user_id = 'user-bad' ORDER BY event_at, message_id")
      .all() as Array<{ message_id: string; outcome: string }>;
    expect(outcomes).toEqual([
      { message_id: "boost-a", outcome: "paid" },
      { message_id: "boost-b", outcome: "paid" },
      { message_id: "boost-c", outcome: "capped" },
    ]);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_pending WHERE user_id = 'user-bad'").get() as { c: number }).c,
    ).toBe(0);
  });
});
