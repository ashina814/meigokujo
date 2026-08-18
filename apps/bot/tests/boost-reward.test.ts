import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { Ledger, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import {
  BOOST_REWARD_LD,
  BOOST_REWARD_MONTHLY_LIMIT,
  boostRewardMonthRangeJst,
  boostRewardPaidCountThisMonth,
  handleBoostRewardMessage,
} from "../src/boost-reward.js";

function services() {
  registerDefaultTxTypes();
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  return {
    db,
    ledger,
    settings: {
      getString: vi.fn((key: string) => (key === "guild:main" ? "guild-main" : undefined)),
    },
  } as any;
}

function boostMessage(id: string, overrides: Record<string, unknown> = {}) {
  const send = vi.fn(async () => undefined);
  return {
    value: {
      id,
      type: MessageType.GuildBoost,
      author: { id: "user-1", bot: false },
      guildId: "guild-main",
      channel: { isSendable: () => true, send },
      ...overrides,
    } as any,
    send,
  };
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
    const s = services();
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

  it("JST月境界を正しくUnix秒へ変換する", () => {
    const range = boostRewardMonthRangeJst(new Date("2026-08-18T12:00:00+09:00").getTime());
    expect(range.start).toBe(Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000));
    expect(range.end).toBe(Math.floor(new Date("2026-09-01T00:00:00+09:00").getTime() / 1_000));
  });
});
