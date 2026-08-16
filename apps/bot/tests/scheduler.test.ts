import { describe, expect, it, vi } from "vitest";
import {
  EventLog,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  SessionCalendar,
  Settings,
  Shop,
  Tickets,
  TREASURY,
} from "@meigokujo/core";
import { runSchedulerTaskOnce, sendChunkedLines } from "../src/scheduler-utils.js";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

// scheduler.js は config が環境変数を要求するので静的 import できない。
// 代わりにここで読み込みを始め、各テストは同じ Promise を待つ（初回の変換待ちで
// テスト単体の制限時間を使い切らないようにする）。
const schedulerModule = import("../src/scheduler.js");

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

function makeRankedTimeoutServices({
  phase = "formal",
  status = "open",
  result = { processed: 1, refunded: 0, disputed: 0 },
  disputeResult = { closed: 1, autoRefunded: 0, failed: 0 },
  processThrows,
  stateThrows,
}: {
  phase?: string;
  status?: string;
  result?: { processed: number; refunded: number; disputed: number };
  disputeResult?: { closed: number; autoRefunded: number; failed: number };
  processThrows?: Error;
  stateThrows?: Error;
} = {}) {
  return {
    chipTx: {
      openingPhase: vi.fn(() => {
        if (stateThrows) throw stateThrows;
        return phase;
      }),
    },
    casinoStatus: {
      current: vi.fn(() => {
        if (stateThrows) throw stateThrows;
        return { status };
      }),
    },
    rankedTables: {
      processDueTables: vi.fn(() => {
        if (processThrows) throw processThrows;
        return result;
      }),
    },
    rankedDisputes: {
      processEvidenceDeadlines: vi.fn(() => disputeResult),
    },
    events: { log: vi.fn() },
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

describe("次の説明会", () => {
  // 案内の「次は何時か」は通常枠だけでなく休止・臨時追加まで織り込んだ実際の予定を返す。
  // 通常枠の設定そのものの解釈は packages/core の entry-sessions.test.ts が持つ。
  function calendarServices() {
    const db = openDb(":memory:");
    const settings = new Settings(db);
    const sessions = new SessionCalendar(db, settings, new EventLog(db));
    return { db, settings, sessions, services: { db, settings, sessions } as any };
  }

  it("例外が無ければ通常枠どおり", async () => {
    const { db, services } = calendarServices();
    const { nextSessionStart } = await schedulerModule;

    // 金 21:30 JST → 同日22時会
    expect(nextSessionStart(services, new Date("2026-07-31T12:30:00Z"))?.toISOString()).toBe("2026-07-31T13:00:00.000Z");
    // 日 23:30 JST → 月曜は休みなので火曜21時会
    expect(nextSessionStart(services, new Date("2026-08-02T14:30:00Z"))?.toISOString()).toBe("2026-08-04T12:00:00.000Z");
    db.close();
  });

  it("休止した枠は案内せず、臨時追加した枠は案内する", async () => {
    const { db, sessions, services } = calendarServices();
    const { nextSessionStart } = await schedulerModule;
    const friday2030 = new Date("2026-07-31T11:30:00Z");

    sessions.skip({ date: "2026-07-31", hour: 21, reason: "門番不在", actor: "user:1", now: friday2030 });
    expect(nextSessionStart(services, friday2030)?.toISOString()).toBe("2026-07-31T13:00:00.000Z");

    // 月曜は通常休みだが、臨時枠を足せばそこが次の案内になる
    const sunday2330 = new Date("2026-08-02T14:30:00Z");
    sessions.add({ date: "2026-08-03", hour: 21, actor: "user:1", now: sunday2330 });
    expect(nextSessionStart(services, sunday2330)?.toISOString()).toBe("2026-08-03T12:00:00.000Z");
    db.close();
  });

  it("開催予定が無ければ null", async () => {
    const { db, settings, services } = calendarServices();
    const { nextSessionStart } = await schedulerModule;
    settings.set("entry:session_skip_dow", "[0,1,2,3,4,5,6]", "test");

    expect(nextSessionStart(services, new Date("2026-07-31T12:30:00Z"))).toBeNull();
    db.close();
  });
});

describe("説明会通知タスク", () => {
  it("通知予定時刻から2分間は再試行窓になり、窓外と開始後は送らない", async () => {
    const { isSessionNotificationDue } = await schedulerModule;

    expect(isSessionNotificationDue({ hour: 20, minute: 30 }, 21, 30)).toBe(true);
    expect(isSessionNotificationDue({ hour: 20, minute: 31 }, 21, 30)).toBe(true);
    expect(isSessionNotificationDue({ hour: 20, minute: 32 }, 21, 30)).toBe(true);
    expect(isSessionNotificationDue({ hour: 20, minute: 33 }, 21, 30)).toBe(false);
    expect(isSessionNotificationDue({ hour: 21, minute: 0 }, 21, 30)).toBe(false);
  });

  it("0時開催の通知は前日23時台に出る", async () => {
    const { isSessionNotificationDue } = await schedulerModule;

    expect(isSessionNotificationDue({ hour: 23, minute: 55 }, 0, 55)).toBe(true);
    expect(isSessionNotificationDue({ hour: 0, minute: 55 }, 0, 55)).toBe(false);
  });

  it("説明会チャンネル取得失敗時にマーカーが保存されない", async () => {
    const { values, settings } = makeSettings();
    values.set("channel:entry_guide", "guide");
    const { sendSessionNotification } = await schedulerModule;
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
    const { sendSessionNotification } = await schedulerModule;
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
    const { processStaleTicketNotifications } = await schedulerModule;

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

describe("ショップ 失効とロール剥奪", () => {
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
    db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchase.id);
    shop.expireOverdue("system:test");
    return { db, events, shop, item, purchase };
  }

  it("失効購入の剥奪再試行時、同じロールを付与するactive購入があれば剥がさず一度だけ完了記録する", async () => {
    const { db, events, shop, item, purchase } = setupShop();
    shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] });
    const remove = vi.fn(async () => undefined);
    const member = { roles: { cache: { has: vi.fn(() => true) }, remove } };
    const client = { guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => member) } })) } };
    const settings = { getString: vi.fn((key: string) => key === "guild:main" ? "guild" : undefined) };
    const { processShopRoleRevocations } = await schedulerModule;
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
    const { processShopRoleRevocations } = await schedulerModule;
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
    const { processShopRoleRevocations } = await schedulerModule;

    await processShopRoleRevocations(client as any, { db, events, shop, settings } as any);

    expect(remove).toHaveBeenCalledWith("role_old");
    const row = db.prepare("SELECT status, role_id FROM shop_role_revocations WHERE purchase_id=?").get(purchase.id) as { status: string; role_id: string };
    expect(row).toEqual({ status: "done", role_id: "role_old" });
    db.close();
  });

  it("失効の確定は1件ずつ巻き戻る（1件の失敗が他の失効を巻き添えにしない）", async () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const shop = new Shop(db, ledger, events);
    const item = shop.createItem(
      { name: "月額", price_land: 100, kind: "monthly", delivery: "auto", delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: "r1" }) },
      "staff",
    );
    for (const u of ["u1", "u2"]) {
      ledger.ensureAccount(`user:${u}`, "user");
      ledger.transfer({ from: TREASURY, to: `user:${u}`, amount: 1_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: `seed:${u}` });
    }
    const a = shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    const b = shop.purchase({ itemId: item.id, userId: "u2", actor: "u2", memberRoleIds: [] }).purchase;
    db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id IN (?,?)").run(a.id, b.id);

    const { expireOverduePurchases } = await import("../src/scheduler-recovery.js");
    const { expired, failed } = expireOverduePurchases({ shop } as never, "system:test");

    expect(failed).toEqual([]);
    expect(expired.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(db.prepare("SELECT COUNT(*) AS c FROM shop_role_revocations WHERE status='pending'").get()).toEqual({ c: 2 });
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
    const { postCharonDueList, postCharonOverduePanel } = await schedulerModule;

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
    const { sendCharonNotifications } = await schedulerModule;

    await expect(sendCharonNotifications(client as any, services as any)).rejects.toThrow("charon_notifications_failed");
    expect([...values.keys()].some((key) => key.startsWith("charon:notified:dm:user1"))).toBe(false);

    dmSend.mockImplementation(async () => undefined);
    await expect(sendCharonNotifications(client as any, services as any)).resolves.toBeUndefined();
    expect([...values.keys()].filter((key) => key.startsWith("charon:notified:dm:user1"))).toHaveLength(1);
    await expect(sendCharonNotifications(client as any, services as any)).resolves.toBeUndefined();
    expect(dmSend).toHaveBeenCalledTimes(2);
  });
});
