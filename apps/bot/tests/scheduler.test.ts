import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, openDb, registerDefaultTxTypes, Settings, Shop, Tickets, TREASURY } from "@meigokujo/core";
import { runSchedulerTaskOnce, sendChunkedLines } from "../src/scheduler-utils.js";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

function makeSettings() {
  const values = new Map<string, string>();
  return {
    values,
    settings: {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: string) => values.set(key, value)),
    },
  };
}

describe("Scheduler実行済みマーカー", () => {
  it("失敗時はcompletedを保存せず、次回成功時に保存する", async () => {
    const { values, settings } = makeSettings();

    await expect(
      runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", async () => {
        throw new Error("temporary");
      }),
    ).rejects.toThrow("temporary");
    expect(values.has("daily:task")).toBe(false);

    const ran = await runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", async () => undefined);
    expect(ran).toBe(true);
    expect(values.get("daily:task")).toBe("1");
    expect(settings.set).toHaveBeenLastCalledWith("daily:task", "1", "system:test");
  });

  it("completed済み・in-flight中は同じ処理を二重実行しない", async () => {
    const { values, settings } = makeSettings();
    let release!: () => void;
    const first = runSchedulerTaskOnce(
      { settings } as any,
      "daily:task",
      "system:test",
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const secondTask = vi.fn(async () => undefined);
    await expect(runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", secondTask)).resolves.toBe(false);
    expect(secondTask).not.toHaveBeenCalled();

    release();
    await expect(first).resolves.toBe(true);
    expect(values.get("daily:task")).toBe("1");

    const afterCompleted = vi.fn(async () => undefined);
    await expect(runSchedulerTaskOnce({ settings } as any, "daily:task", "system:test", afterCompleted)).resolves.toBe(false);
    expect(afterCompleted).not.toHaveBeenCalled();
  });
});

describe("sendChunkedLines", () => {
  it("指定されたロールだけをallowedMentionsに通し、ユーザーメンションは通知許可しない", async () => {
    const send = vi.fn(async () => undefined);
    const channel = { send } as any;

    await sendChunkedLines(channel, "header <@&staff_role>", ["line <@user_id>"], {
      allowedRoleIds: ["staff_role"],
    });

    expect(send).toHaveBeenCalledWith({
      content: "header <@&staff_role>\nline <@user_id>",
      allowedMentions: { parse: [], roles: ["staff_role"] },
    });
  });
});

describe("説明会の開催枠", () => {
  function scheduleFor(values: Record<string, string>) {
    const settings = { getString: vi.fn((key: string) => values[key]) };
    return { settings };
  }

  it("未設定なら現行運用（月・木を除く 21/22/23時）のまま", async () => {
    const { sessionSchedule, describeSessionSchedule, nextSessionStart } = await import("../src/scheduler.js");
    const schedule = sessionSchedule(scheduleFor({}) as any);

    expect(schedule).toEqual({ hours: [21, 22, 23], skipDow: [1, 4] });
    expect(describeSessionSchedule(schedule)).toBe("月・木を除く 21 / 22 / 23 時");

    // 2026-07-31(金) 21:30 JST → 同日22時会
    const friday2130 = new Date("2026-07-31T12:30:00Z");
    expect(nextSessionStart(schedule, friday2130)?.toISOString()).toBe("2026-07-31T13:00:00.000Z");
    // 日曜23:30 JST → 月曜は休みなので火曜21時会
    const sunday2330 = new Date("2026-08-02T14:30:00Z");
    expect(nextSessionStart(schedule, sunday2330)?.toISOString()).toBe("2026-08-04T12:00:00.000Z");
  });

  it("設定した時刻・休みの曜日で次の開催が決まる", async () => {
    const { sessionSchedule, describeSessionSchedule, nextSessionStart } = await import("../src/scheduler.js");
    const schedule = sessionSchedule(
      scheduleFor({ "entry:session_hours": "[20, 22]", "entry:session_skip_dow": "[0, 6]" }) as any,
    );

    expect(schedule).toEqual({ hours: [20, 22], skipDow: [0, 6] });
    expect(describeSessionSchedule(schedule)).toBe("日・土を除く 20 / 22 時");
    // 金曜22:30 JST → 土日は休みなので月曜20時会
    expect(nextSessionStart(schedule, new Date("2026-07-31T13:30:00Z"))?.toISOString()).toBe("2026-08-03T11:00:00.000Z");
  });

  it("カンマ区切りでも受け付け、範囲外・数値でない値は捨てる", async () => {
    const { sessionSchedule } = await import("../src/scheduler.js");
    const schedule = sessionSchedule(
      scheduleFor({ "entry:session_hours": "23, 21, 21, 24, あ", "entry:session_skip_dow": "4,1" }) as any,
    );

    expect(schedule).toEqual({ hours: [21, 23], skipDow: [1, 4] });
  });

  it("休みの曜日は空配列なら毎日開催、時刻が全滅した設定は既定値へ落とす", async () => {
    const { sessionSchedule, describeSessionSchedule } = await import("../src/scheduler.js");
    const everyday = sessionSchedule(scheduleFor({ "entry:session_skip_dow": "[]" }) as any);
    expect(everyday.skipDow).toEqual([]);
    expect(describeSessionSchedule(everyday)).toBe("毎日 21 / 22 / 23 時");

    // 説明会が黙って消えるほうが害が大きいので、壊れた値は既定値で運転を続ける
    const broken = sessionSchedule(
      scheduleFor({ "entry:session_hours": "[99]", "entry:session_skip_dow": "毎日" }) as any,
    );
    expect(broken).toEqual({ hours: [21, 22, 23], skipDow: [1, 4] });
  });

  it("全曜日が休みなら次の開催は無い", async () => {
    const { sessionSchedule, describeSessionSchedule, nextSessionStart } = await import("../src/scheduler.js");
    const schedule = sessionSchedule(scheduleFor({ "entry:session_skip_dow": "[0,1,2,3,4,5,6]" }) as any);

    expect(nextSessionStart(schedule, new Date("2026-07-31T12:30:00Z"))).toBeNull();
    expect(describeSessionSchedule(schedule)).toBe("現在は定例の説明会がありません");
  });
});

describe("説明会通知タスク", () => {
  it("通知予定時刻から2分間は再試行窓になり、窓外と開始後は送らない", async () => {
    const { isSessionNotificationDue } = await import("../src/scheduler.js");

    expect(isSessionNotificationDue({ hour: 20, minute: 30 }, 21, 30)).toBe(true);
    expect(isSessionNotificationDue({ hour: 20, minute: 31 }, 21, 30)).toBe(true);
    expect(isSessionNotificationDue({ hour: 20, minute: 32 }, 21, 30)).toBe(true);
    expect(isSessionNotificationDue({ hour: 20, minute: 33 }, 21, 30)).toBe(false);
    expect(isSessionNotificationDue({ hour: 21, minute: 0 }, 21, 30)).toBe(false);
  });

  it("0時開催の通知は前日23時台に出る", async () => {
    const { isSessionNotificationDue } = await import("../src/scheduler.js");

    expect(isSessionNotificationDue({ hour: 23, minute: 55 }, 0, 55)).toBe(true);
    expect(isSessionNotificationDue({ hour: 0, minute: 55 }, 0, 55)).toBe(false);
  });

  it("説明会チャンネル取得失敗時にマーカーが保存されない", async () => {
    const { values, settings } = makeSettings();
    values.set("channel:entry_guide", "guide");
    const { sendSessionNotification } = await import("../src/scheduler.js");
    const client = { channels: { fetch: vi.fn(async () => { throw new Error("temporary"); }) } };

    await expect(
      runSchedulerTaskOnce({ settings } as any, "session:notify:test", "system:test", () =>
        sendSessionNotification(client as any, { settings } as any, 21, "30m"),
      ),
    ).rejects.toThrow("session_notify:channel_fetch_failed");

    expect(values.get("session:notify:test")).toBeUndefined();
  });

  it("説明会送信成功後にだけマーカーが保存される", async () => {
    const { values, settings } = makeSettings();
    values.set("channel:entry_guide", "guide");
    values.set("role:queue_wait", "wait_role");
    const send = vi.fn(async () => undefined);
    const { sendSessionNotification } = await import("../src/scheduler.js");
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
    };

    await expect(
      runSchedulerTaskOnce({ settings } as any, "session:notify:test", "system:test", () =>
        sendSessionNotification(client as any, { settings } as any, 21, "5m"),
      ),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { roles: ["wait_role"] } }));
    expect(values.get("session:notify:test")).toBe("1");
  });
});

describe("チケット24時間通知のスナップショット", () => {
  function setupTickets() {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const tickets = new Tickets(db, events);
    const settings = new Settings(db);
    settings.set("channel:kessai", "kessai", "test");
    const services = { db, tickets, settings };
    const oldTs = Math.floor(Date.now() / 1000) - 25 * 3600;
    tickets.create("threadA", "userA", "consult", {
      id: "panelA",
      name: "相談A",
      notifyRoleIds: ["notify"],
      staffRoleIds: ["staff"],
    });
    tickets.create("threadB", "userB", "consult", {
      id: "panelB",
      name: "相談B",
      notifyRoleIds: ["notify"],
      staffRoleIds: ["staff"],
    });
    db.prepare("UPDATE tickets SET created_at=? WHERE thread_id IN ('threadA','threadB')").run(oldTs);
    db.prepare("UPDATE tickets SET panel_name=? WHERE thread_id='threadB'").run("長い相談".repeat(500));
    return { db, tickets, services };
  }

  it("途中失敗後に新しくstaleになったチケットを同じバッチでmarkRemindedしない", async () => {
    const { db, tickets, services } = setupTickets();
    const send = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("send failed"));
    const client = { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) } };
    const { processStaleTicketNotifications } = await import("../src/scheduler.js");

    await expect(processStaleTicketNotifications(client as any, services as any)).rejects.toThrow("send failed");
    tickets.create("threadC", "userC", "consult", {
      id: "panelC",
      name: "相談C",
      notifyRoleIds: ["notify"],
      staffRoleIds: ["staff"],
    });
    db.prepare("UPDATE tickets SET created_at=? WHERE thread_id='threadC'").run(Math.floor(Date.now() / 1000) - 25 * 3600);

    send.mockResolvedValue(undefined);
    await processStaleTicketNotifications(client as any, services as any);

    expect(tickets.get("threadA")?.reminded_at).not.toBeNull();
    expect(tickets.get("threadB")?.reminded_at).not.toBeNull();
    expect(tickets.get("threadC")?.reminded_at).toBeNull();
    expect(send.mock.calls.filter((call) => String(call[0]?.content ?? "").includes("<@&staff>"))).toHaveLength(1);

    await processStaleTicketNotifications(client as any, services as any);
    expect(tickets.get("threadC")?.reminded_at).not.toBeNull();
    db.close();
  });
});

describe("ショップ月額ロール剥奪", () => {
  function setupShop(roleId = "role_old") {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    ledger.ensureAccount("user:user1", "user");
    ledger.transfer({
      from: TREASURY,
      to: "user:user1",
      amount: 100_000,
      type: "initial",
      actor: "test",
      idempotencyKey: `fund:${Math.random()}`,
    });
    const events = new EventLog(db);
    const shop = new Shop(db, ledger, events);
    const item = shop.createItem(
      {
        name: "月額ロール",
        price_land: 100,
        kind: "monthly",
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: roleId }),
      },
      "staff",
    );
    const purchase = shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    db.prepare("UPDATE shop_purchases SET expires_at=1, auto_renew=0 WHERE id=?").run(purchase.id);
    shop.chargeMonthlySubscriptions("system:test");
    return { db, events, shop, item, purchase };
  }

  it("失効購入の剥奪再試行時、同じロールを付与するactive購入があれば剥がさず一度だけ完了記録する", async () => {
    const { db, events, shop, item, purchase } = setupShop();
    shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] });
    const remove = vi.fn(async () => undefined);
    const member = { roles: { cache: { has: vi.fn(() => true) }, remove } };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };
    const settings = { getString: vi.fn((key: string) => key === "guild:main" ? "guild" : undefined) };
    const { processShopRoleRevocations } = await import("../src/scheduler.js");
    const services = { db, events, shop, settings };

    await processShopRoleRevocations(client as any, services as any);
    await processShopRoleRevocations(client as any, services as any);

    expect(remove).not.toHaveBeenCalled();
    const row = db.prepare("SELECT status FROM shop_role_revocations WHERE purchase_id=?").get(purchase.id) as { status: string };
    expect(row.status).toBe("done");
    const doneEvents = db.prepare("SELECT * FROM events WHERE type='shop_role_revocation_done'").all();
    expect(doneEvents).toHaveLength(1);
    db.close();
  });

  it("active購入がなければロールを剥奪し、Discord API一時失敗後は剥奪だけ再試行する", async () => {
    const { db, events, shop, purchase } = setupShop();
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const member = { roles: { cache: { has: vi.fn(() => true) }, remove } };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };
    const settings = { getString: vi.fn((key: string) => key === "guild:main" ? "guild" : undefined) };
    const { processShopRoleRevocations } = await import("../src/scheduler.js");
    const services = { db, events, shop, settings };

    await expect(processShopRoleRevocations(client as any, services as any)).rejects.toThrow("shop_role_revocation_failed");
    let row = db.prepare("SELECT status, attempts FROM shop_role_revocations WHERE purchase_id=?").get(purchase.id) as { status: string; attempts: number };
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);

    await processShopRoleRevocations(client as any, services as any);
    row = db.prepare("SELECT status, attempts FROM shop_role_revocations WHERE purchase_id=?").get(purchase.id) as { status: string; attempts: number };
    expect(row.status).toBe("done");
    expect(remove).toHaveBeenCalledTimes(2);

    await processShopRoleRevocations(client as any, services as any);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT * FROM events WHERE type='shop_role_revocation_done'").all()).toHaveLength(1);
    db.close();
  });

  it("既存の失効購入に剥奪キューが無くても起動時バックフィルで回収する", async () => {
    const { db, events, shop, purchase } = setupShop();
    db.prepare("DELETE FROM shop_role_revocations WHERE purchase_id=?").run(purchase.id);
    const remove = vi.fn(async () => undefined);
    const member = { roles: { cache: { has: vi.fn(() => true) }, remove } };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };
    const settings = { getString: vi.fn((key: string) => key === "guild:main" ? "guild" : undefined) };
    const { processShopRoleRevocations } = await import("../src/scheduler.js");

    await processShopRoleRevocations(client as any, { db, events, shop, settings } as any);

    expect(remove).toHaveBeenCalledWith("role_old");
    const row = db.prepare("SELECT status, role_id FROM shop_role_revocations WHERE purchase_id=?").get(purchase.id) as { status: string; role_id: string };
    expect(row).toEqual({ status: "done", role_id: "role_old" });
    db.close();
  });

  it("月額処理途中で例外が起きた場合は外側トランザクションでDB変更を戻す", async () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE scheduler_atomic_probe (id INTEGER PRIMARY KEY)");
    const fakeShop = {
      chargeMonthlySubscriptions: vi.fn(() => {
        db.prepare("INSERT INTO scheduler_atomic_probe(id) VALUES (1)").run();
        throw new Error("after expire queue failure");
      }),
    };
    const { chargeMonthlySubscriptionsAtomically } = await import("../src/scheduler-recovery.js");

    expect(() => chargeMonthlySubscriptionsAtomically({ db, shop: fakeShop } as any, "system:test")).toThrow("after expire queue failure");
    const count = db.prepare("SELECT COUNT(*) AS c FROM scheduler_atomic_probe").get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });
});

describe("カロン分割タスク", () => {
  function deadlineRow(userId: string) {
    return { user_id: userId, eval_deadline_at: Math.floor(Date.now() / 1000) + 3600 };
  }

  function charonServices(values = new Map<string, string>()) {
    values.set("channel:keikiban", "keikiban");
    values.set("channel:kessai", "kessai");
    const settings = {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const row = deadlineRow("user1");
    return {
      values,
      settings,
      services: {
        db: openDb(":memory:"),
        settings,
        evaluation: {
          dueBetween: vi.fn(() => [row]),
          overdue: vi.fn(() => [row]),
          promotionScore: vi.fn(() => ({ total: 1 })),
          demotionCount: vi.fn(() => 0),
          thresholdsFor: vi.fn(() => ({ promotionRequired: 5, demotionThreshold: 4 })),
          evaluationCount: vi.fn(() => 1),
          threadFor: vi.fn(() => "thread1"),
        },
      },
    };
  }

  it("カロンの一部処理失敗後、失敗部分だけ再試行され、期限一覧・承認パネルが重複投稿されない", async () => {
    const { values, services, settings } = charonServices();
    const dueSend = vi.fn(async () => { throw new Error("due failed"); });
    const panelSend = vi.fn(async () => undefined);
    const fetch = vi.fn(async (id: string) => {
      if (id === "keikiban") return { isTextBased: () => true, send: dueSend };
      if (id === "kessai") return { isTextBased: () => true, send: panelSend };
      return null;
    });
    const client = { channels: { fetch } };
    const { postCharonDueList, postCharonOverduePanel } = await import("../src/scheduler.js");

    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:due_list:test", "system:test", () =>
        postCharonDueList(client as any, services as any),
      ),
    ).rejects.toThrow("due failed");
    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:overdue_panel:test", "system:test", () =>
        postCharonOverduePanel(client as any, services as any),
      ),
    ).resolves.toBe(true);

    expect(values.get("charon:due_list:test")).toBeUndefined();
    expect(values.get("charon:overdue_panel:test")).toBe("1");
    expect(panelSend).toHaveBeenCalledTimes(1);

    dueSend.mockImplementation(async () => undefined);
    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:due_list:test", "system:test", () =>
        postCharonDueList(client as any, services as any),
      ),
    ).resolves.toBe(true);
    await expect(
      runSchedulerTaskOnce({ settings } as any, "charon:overdue_panel:test", "system:test", () =>
        postCharonOverduePanel(client as any, services as any),
      ),
    ).resolves.toBe(false);

    expect(values.get("charon:due_list:test")).toBe("1");
    expect(panelSend).toHaveBeenCalledTimes(1);
    services.db.close();
  });

  it("個人通知失敗時に通知済み扱いにならず、再試行で二重通知しない", async () => {
    const values = new Map<string, string>();
    const row = deadlineRow("user1");
    const settings = {
      getString: vi.fn((key: string) => values.get(key)),
      set: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const services = {
      settings,
      evaluation: { dueBetween: vi.fn(() => [row]) },
    };
    const dmSend = vi.fn(async () => { throw new Error("dm closed"); });
    const client = { users: { fetch: vi.fn(async () => ({ send: dmSend })) }, channels: { fetch: vi.fn() } };
    const { sendCharonNotifications } = await import("../src/scheduler.js");

    await expect(sendCharonNotifications(client as any, services as any)).rejects.toThrow("charon_notifications_failed");
    expect([...values.keys()].some((key) => key.startsWith("charon:notified:dm:user1"))).toBe(false);

    dmSend.mockImplementation(async () => undefined);
    await expect(sendCharonNotifications(client as any, services as any)).resolves.toBeUndefined();
    expect([...values.keys()].filter((key) => key.startsWith("charon:notified:dm:user1"))).toHaveLength(1);
    await expect(sendCharonNotifications(client as any, services as any)).resolves.toBeUndefined();
    expect(dmSend).toHaveBeenCalledTimes(2);
  });
});
