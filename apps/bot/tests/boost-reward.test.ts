import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { Ledger, Settings, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import {
  BOOST_REWARD_LAST_RECOVERY_AT_SETTING,
  BOOST_REWARD_LD,
  BOOST_REWARD_MONTHLY_LIMIT,
  BOOST_REWARD_STARTED_AT_SETTING,
  boostRewardMonthRangeJst,
  boostRewardPaidCountThisMonth,
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

function boostMessage(id: string, overrides: Record<string, unknown> = {}) {
  const send = vi.fn(async () => undefined);
  return {
    value: {
      id,
      type: MessageType.GuildBoost,
      author: { id: "user-1", bot: false },
      guildId: "guild-main",
      createdTimestamp: Date.now(),
      channel: { isSendable: () => true, send },
      ...overrides,
    } as any,
    send,
  };
}

function recoveryClient(fetchMessages: ReturnType<typeof vi.fn>, suppressed = false) {
  const systemChannel = {
    id: "system-channel",
    messages: { fetch: fetchMessages },
  };
  const guild = {
    systemChannel,
    systemChannelFlags: { has: vi.fn(() => suppressed) },
  };
  return {
    guilds: { cache: new Map([["guild-main", guild]]) },
  } as any;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("サーバーブースト自動報酬", () => {
  it("1回50,000Ld、同一JST月は2回まで支給する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T19:30:00+09:00"));
    const s = services();
    const first = boostMessage("boost-1");
    const second = boostMessage("boost-2");
    const third = boostMessage("boost-3");

    expect(await handleBoostRewardMessage(first.value, s)).toBe(true);
    expect(await handleBoostRewardMessage(second.value, s)).toBe(true);
    expect(await handleBoostRewardMessage(third.value, s)).toBe(true);

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * BOOST_REWARD_MONTHLY_LIMIT);
    expect(boostRewardPaidCountThisMonth(s, "user-1")).toBe(2);
    expect(first.send).toHaveBeenCalledOnce();
    expect(second.send).toHaveBeenCalledOnce();
    expect(third.send).toHaveBeenCalledOnce();
    expect(third.send.mock.calls[0]?.[0]?.content).toContain("2回まで");

    const events = s.db.prepare("SELECT outcome FROM boost_reward_events ORDER BY message_id").all() as Array<{
      outcome: string;
    }>;
    expect(events.map((e) => e.outcome)).toEqual(["paid", "paid", "capped"]);
  });

  it("同じDiscordメッセージIDを再処理しても二重支給・二重通知しない", async () => {
    const s = services();
    const message = boostMessage("boost-1");

    await handleBoostRewardMessage(message.value, s);
    await handleBoostRewardMessage(message.value, s);

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD);
    expect(message.send).toHaveBeenCalledOnce();
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_events WHERE message_id = ?").get("boost-1") as { c: number }).c,
    ).toBe(1);
  });

  it("支払い済み・イベント記録欠落から再処理しても二重払いせず記録だけ追いつく", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    s.settings.set(
      BOOST_REWARD_STARTED_AT_SETTING,
      Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000),
      "test",
    );
    s.ledger.ensureAccount("user:user-1", "user");
    s.ledger.transfer({
      from: TREASURY,
      to: "user:user-1",
      amount: BOOST_REWARD_LD,
      type: "reward_boost",
      actor: "system:boost",
      reason: "サーバーブースト報酬",
      refType: "discord_boost",
      refId: "boost-1",
      idempotencyKey: "boost:boost-1",
    });
    const message = boostMessage("boost-1");

    await handleBoostRewardMessage(message.value, s);

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD);
    expect(message.send).not.toHaveBeenCalled();
    expect(
      (s.db.prepare("SELECT outcome FROM boost_reward_events WHERE message_id = ?").get("boost-1") as { outcome: string })
        .outcome,
    ).toBe("paid");
  });

  it("JSTで月が変われば再び2回まで支給できる", async () => {
    vi.useFakeTimers();
    const s = services();

    vi.setSystemTime(new Date("2026-08-31T23:59:50+09:00"));
    await handleBoostRewardMessage(boostMessage("aug-1").value, s);
    await handleBoostRewardMessage(boostMessage("aug-2").value, s);
    expect(boostRewardPaidCountThisMonth(s, "user-1")).toBe(2);

    vi.setSystemTime(new Date("2026-09-01T00:00:10+09:00"));
    await handleBoostRewardMessage(boostMessage("sep-1").value, s);

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * 3);
    expect(boostRewardPaidCountThisMonth(s, "user-1")).toBe(1);
  });

  it("処理が月を跨いでもDiscordメッセージ発生時刻のJST月へ計上する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:10+09:00"));
    const s = services();
    s.settings.set(
      BOOST_REWARD_STARTED_AT_SETTING,
      Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000),
      "test",
    );

    const aug = boostMessage("aug-late", {
      createdTimestamp: new Date("2026-08-31T23:59:59+09:00").getTime(),
    });
    const sep = boostMessage("sep-now", {
      createdTimestamp: new Date("2026-09-01T00:00:01+09:00").getTime(),
    });
    await handleBoostRewardMessage(aug.value, s);
    await handleBoostRewardMessage(sep.value, s);

    expect(boostRewardPaidCountThisMonth(s, "user-1", new Date("2026-08-31T23:59:59+09:00").getTime())).toBe(1);
    expect(boostRewardPaidCountThisMonth(s, "user-1", new Date("2026-09-01T00:00:01+09:00").getTime())).toBe(1);
  });

  it("既存のreward_boost手動支給も月2回上限へ含める", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    s.ledger.ensureAccount("user:user-1", "user");
    s.ledger.transfer({
      from: TREASURY,
      to: "user:user-1",
      amount: BOOST_REWARD_LD,
      type: "reward_boost",
      actor: "operator",
      reason: "手動ブースト報酬",
      idempotencyKey: "manual:boost:1",
    });

    await handleBoostRewardMessage(boostMessage("auto-1").value, s);
    await handleBoostRewardMessage(boostMessage("auto-2").value, s);

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * 2);
    expect(boostRewardPaidCountThisMonth(s, "user-1")).toBe(2);
  });

  it("自動で月2回払った後の手動reward_boostもDB側で拒否する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    await handleBoostRewardMessage(boostMessage("auto-1").value, s);
    await handleBoostRewardMessage(boostMessage("auto-2").value, s);

    expect(() =>
      s.ledger.transfer({
        from: TREASURY,
        to: "user:user-1",
        amount: BOOST_REWARD_LD,
        type: "reward_boost",
        actor: "operator",
        reason: "手動ブースト報酬",
        idempotencyKey: "manual:boost:3",
      }),
    ).toThrow(/ERR_BOOST_MONTHLY_LIMIT/);
    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * 2);
  });

  it("Tier到達メッセージや別Guildは報酬対象にしない", async () => {
    const s = services();

    expect(
      await handleBoostRewardMessage(
        boostMessage("tier", { type: MessageType.GuildBoostTier1 }).value,
        s,
      ),
    ).toBe(false);
    expect(
      await handleBoostRewardMessage(boostMessage("other", { guildId: "other-guild" }).value, s),
    ).toBe(false);

    expect(s.ledger.balanceOf("user:user-1")).toBe(0);
  });

  it("初回導入は開始時刻を保存し、過去メッセージを遡及走査しない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const fetchMessages = vi.fn(async () => new Map());

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages), s);

    expect(fetchMessages).not.toHaveBeenCalled();
    expect(Number(s.settings.getString(BOOST_REWARD_STARTED_AT_SETTING))).toBe(Math.floor(Date.now() / 1_000));
    expect(Number(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING))).toBe(Math.floor(Date.now() / 1_000));
    expect(
      (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='boost_reward_events'").get() as { name: string })
        .name,
    ).toBe("boost_reward_events");
  });

  it("起動時に停止中の未処理Boostをsystem channel履歴から回収する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    s.settings.set(
      BOOST_REWARD_STARTED_AT_SETTING,
      Math.floor(new Date("2026-08-18T18:00:00+09:00").getTime() / 1_000),
      "test",
    );
    s.settings.set(
      BOOST_REWARD_LAST_RECOVERY_AT_SETTING,
      Math.floor(new Date("2026-08-18T18:30:00+09:00").getTime() / 1_000),
      "test",
    );
    const missed = boostMessage("missed-boost", {
      createdTimestamp: new Date("2026-08-18T19:15:00+09:00").getTime(),
    });
    const fetchMessages = vi.fn(async () => new Map([[missed.value.id, missed.value]]));

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages), s);

    expect(fetchMessages).toHaveBeenCalledOnce();
    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD);
    expect(missed.send).toHaveBeenCalledOnce();
    expect(Number(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING))).toBe(Math.floor(Date.now() / 1_000));
  });

  it("Discord側でBoost通知が抑止されていれば起動時に警告する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMessages = vi.fn(async () => new Map());

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages, true), s);

    expect(warn.mock.calls.flat().join(" ")).toContain("サーバーブースト通知が抑止");
  });

  it("JST月境界を正しくUnix秒へ変換する", () => {
    const range = boostRewardMonthRangeJst(new Date("2026-08-18T12:00:00+09:00").getTime());
    expect(range.start).toBe(Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000));
    expect(range.end).toBe(Math.floor(new Date("2026-09-01T00:00:00+09:00").getTime() / 1_000));
  });
});
