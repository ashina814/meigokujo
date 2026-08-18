import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { Ledger, Settings, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import {
  BOOST_REWARD_LAST_RECOVERY_AT_SETTING,
  BOOST_REWARD_LD,
  BOOST_REWARD_STARTED_AT_SETTING,
  handleBoostRewardMessage,
  initializeBoostRewardRecovery,
  recordManualBoostCompensation,
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

function recoveryClient(fetchMessages: ReturnType<typeof vi.fn>, options: { suppressed?: boolean; channel?: boolean } = {}) {
  const systemChannel =
    options.channel === false
      ? null
      : {
          id: "system-channel",
          permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
          messages: { fetch: fetchMessages },
        };
  const guild = {
    systemChannel,
    systemChannelFlags: { has: vi.fn(() => options.suppressed ?? false) },
    members: { me: { id: "bot-user" } },
  };
  return { guilds: { cache: new Map([["guild-main", guild]]) } } as any;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("サーバーブースト報酬 hardening", () => {
  it("Boost通知が抑止中なら開始時刻とwatermarkを確定しない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const fetchMessages = vi.fn(async () => new Map());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages, { suppressed: true }), s);

    expect(fetchMessages).not.toHaveBeenCalled();
    expect(s.settings.getString(BOOST_REWARD_STARTED_AT_SETTING)).toBeUndefined();
    expect(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING)).toBeUndefined();
  });

  it("system channelが無い場合も開始時刻とwatermarkを確定しない", async () => {
    const s = services();
    const fetchMessages = vi.fn(async () => new Map());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages, { channel: false }), s);

    expect(fetchMessages).not.toHaveBeenCalled();
    expect(s.settings.getString(BOOST_REWARD_STARTED_AT_SETTING)).toBeUndefined();
    expect(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING)).toBeUndefined();
  });

  it("初回の履歴preflightに失敗したら開始時刻を確定せず、成功した再初期化でだけ開始する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failedFetch = vi.fn(async () => {
      throw new Error("Missing Access");
    });

    await expect(initializeBoostRewardRecovery(recoveryClient(failedFetch), s)).rejects.toThrow(/Missing Access/);
    expect(s.settings.getString(BOOST_REWARD_STARTED_AT_SETTING)).toBeUndefined();
    expect(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING)).toBeUndefined();

    const successfulFetch = vi.fn(async () => new Map());
    await initializeBoostRewardRecovery(recoveryClient(successfulFetch), s);
    expect(successfulFetch).toHaveBeenCalledOnce();
    expect(Number(s.settings.getString(BOOST_REWARD_STARTED_AT_SETTING))).toBe(Math.floor(Date.now() / 1_000));
    expect(Number(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING))).toBe(Math.floor(Date.now() / 1_000));
  });

  it("履歴fetch自体が失敗したらliveを先払いせずblockedでqueue保持し、再初期化成功後に処理する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    const started = Math.floor(new Date("2026-08-18T18:00:00+09:00").getTime() / 1_000);
    s.settings.set(BOOST_REWARD_STARTED_AT_SETTING, started, "test");
    s.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, started, "test");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let rejectFetch!: (reason?: unknown) => void;
    const firstFetch = new Promise<Map<string, any>>((_, reject) => {
      rejectFetch = reject;
    });
    const fetchMessages = vi.fn(() => firstFetch);
    const recovery = initializeBoostRewardRecovery(recoveryClient(fetchMessages), s);

    const c = boostMessage("boost-c", new Date("2026-08-18T20:00:01+09:00").getTime());
    expect(await handleBoostRewardMessage(c.value, s)).toBe(true);
    expect(s.ledger.balanceOf("user:user-1")).toBe(0);

    rejectFetch(new Error("temporary history failure"));
    await expect(recovery).rejects.toThrow(/temporary history failure/);

    const d = boostMessage("boost-d", new Date("2026-08-18T20:00:02+09:00").getTime());
    expect(await handleBoostRewardMessage(d.value, s)).toBe(true);
    expect(s.ledger.balanceOf("user:user-1")).toBe(0);

    const retryFetch = vi.fn(async () => new Map());
    await initializeBoostRewardRecovery(recoveryClient(retryFetch), s);

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * 2);
    expect(c.send).toHaveBeenCalledOnce();
    expect(d.send).toHaveBeenCalledOnce();
  });

  it("停止中A/Bのbackfill中に新着Cが来てもA/Bを先に支給してCを上限扱いにする", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-18T20:00:00+09:00");
    vi.setSystemTime(now);
    const s = services();
    const started = Math.floor(new Date("2026-08-18T18:00:00+09:00").getTime() / 1_000);
    s.settings.set(BOOST_REWARD_STARTED_AT_SETTING, started, "test");
    s.settings.set(BOOST_REWARD_LAST_RECOVERY_AT_SETTING, started, "test");

    const a = boostMessage("boost-a", new Date("2026-08-18T19:00:00+09:00").getTime());
    const b = boostMessage("boost-b", new Date("2026-08-18T19:10:00+09:00").getTime());
    const c = boostMessage("boost-c", new Date("2026-08-18T20:00:01+09:00").getTime());

    let release!: (value: Map<string, any>) => void;
    const firstFetch = new Promise<Map<string, any>>((resolve) => {
      release = resolve;
    });
    const fetchMessages = vi.fn(() => firstFetch);

    const recovery = initializeBoostRewardRecovery(recoveryClient(fetchMessages), s);
    expect(await handleBoostRewardMessage(c.value, s)).toBe(true);
    expect(s.ledger.balanceOf("user:user-1")).toBe(0);

    release(
      new Map([
        [b.value.id, b.value],
        [a.value.id, a.value],
      ]),
    );
    await recovery;

    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD * 2);
    const outcomes = s.db
      .prepare("SELECT message_id, outcome FROM boost_reward_events ORDER BY event_at, message_id")
      .all() as Array<{ message_id: string; outcome: string }>;
    expect(outcomes).toEqual([
      { message_id: "boost-a", outcome: "paid" },
      { message_id: "boost-b", outcome: "paid" },
      { message_id: "boost-c", outcome: "capped" },
    ]);
  });

  it("同一userの先行Boostが失敗したらそのuserの後続だけ繰越し、別userは処理を続ける", async () => {
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

    const failedAtMs = new Date("2026-08-18T19:00:00+09:00").getTime();
    const firstBad = boostMessage("bad-a", failedAtMs, "user-bad");
    const secondBad = boostMessage("bad-b", new Date("2026-08-18T19:05:00+09:00").getTime(), "user-bad");
    const good = boostMessage("good-a", new Date("2026-08-18T19:10:00+09:00").getTime(), "user-good");
    const fetchMessages = vi.fn(async () =>
      new Map([
        [good.value.id, good.value],
        [secondBad.value.id, secondBad.value],
        [firstBad.value.id, firstBad.value],
      ]),
    );

    await initializeBoostRewardRecovery(recoveryClient(fetchMessages), s);

    expect(s.ledger.balanceOf("user:user-bad")).toBe(0);
    expect(s.ledger.balanceOf("user:user-good")).toBe(BOOST_REWARD_LD);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_events WHERE message_id = 'bad-b'").get() as { c: number }).c,
    ).toBe(0);
    expect(Number(s.settings.getString(BOOST_REWARD_LAST_RECOVERY_AT_SETTING))).toBe(Math.floor(failedAtMs / 1_000));
  });

  it("同一message IDを別userとして再入力したらconflictで止める", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    s.settings.set(
      BOOST_REWARD_STARTED_AT_SETTING,
      Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000),
      "test",
    );
    const eventTimestampMs = new Date("2026-08-18T19:00:00+09:00").getTime();
    recordManualBoostCompensation(
      { messageId: "boost-conflict", userId: "user-1", eventTimestampMs },
      s,
      "operator:1",
    );

    const wrongUser = boostMessage("boost-conflict", eventTimestampMs, "user-2");
    await expect(handleBoostRewardMessage(wrongUser.value, s)).rejects.toThrow(/ERR_BOOST_EVENT_CONFLICT/);
    expect(s.ledger.balanceOf("user:user-1")).toBe(BOOST_REWARD_LD);
    expect(s.ledger.balanceOf("user:user-2")).toBe(0);
  });

  it("同じcanonical keyの既存取引でも内容が違えばrecovered扱いにしない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00+09:00"));
    const s = services();
    s.settings.set(
      BOOST_REWARD_STARTED_AT_SETTING,
      Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000),
      "test",
    );
    s.ledger.ensureAccount("user:user-1", "user");

    // draft途中の壊れた既存行をraw SQLで再現する。
    s.db.exec("DROP TRIGGER trg_reward_boost_event_required_v3; DROP TRIGGER trg_reward_boost_monthly_limit_v3;");
    s.db.prepare(
      `INSERT INTO transactions
         (idempotency_key, from_account, to_account, amount, type, reason,
          ref_type, ref_id, actor_id, approved_by, reversal_of, created_at)
       VALUES (?, ?, ?, ?, 'reward_boost', 'broken draft row', 'discord_boost', ?, 'test', NULL, NULL, ?)`,
    ).run(
      "boost:boost-orphan",
      TREASURY,
      "user:user-1",
      12_345,
      "boost-orphan",
      Math.floor(Date.now() / 1_000),
    );
    // guardを戻す。
    new Ledger(s.db);

    const message = boostMessage("boost-orphan", new Date("2026-08-18T19:00:00+09:00").getTime());
    await expect(handleBoostRewardMessage(message.value, s)).rejects.toThrow(/ERR_BOOST_PRIOR_TX_CONFLICT/);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS c FROM boost_reward_events WHERE message_id = 'boost-orphan'").get() as { c: number }).c,
    ).toBe(0);
  });
});