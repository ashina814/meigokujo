import { describe, expect, it } from "vitest";
import { Confessions } from "../src/confession/service.js";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";

describe("トートの耳・受領確認クローズ", () => {
  it("voice_received を終了理由として保存できる", () => {
    const db = openDb(":memory:");
    const confessions = new Confessions(db, new EventLog(db));
    const row = confessions.create("poster", {
      type: "iken",
      replyWish: "no",
      body: "返信は不要ですが、伝えておきたいことです。",
    });

    const result = confessions.close(row.id, "staff", "voice_received", 7);
    expect(result.ok).toBe(true);
    const closed = confessions.get(row.id);

    expect(closed?.status).toBe("closed");
    expect(closed?.close_reason).toBe("voice_received");
    expect(closed?.closed_by).toBe("staff");
    expect(closed?.body_purge_at).not.toBeNull();
    db.close();
  });

  it("専用クローズは原子的で、二人目は既に閉じられている扱いになりイベントを二重記録しない", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const confessions = new Confessions(db, events);
    const row = confessions.create("poster", {
      type: "iken",
      replyWish: "no",
      body: "返信不要です。",
    });

    const first = confessions.closeVoiceReceivedAtomic(row.id, "staff1", 7);
    const second = confessions.closeVoiceReceivedAtomic(row.id, "staff2", 7);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok ? undefined : second.code).toBe("already_closed");
    expect(confessions.get(row.id)?.closed_by).toBe("staff1");
    const closeEvents = db.prepare("SELECT * FROM events WHERE type='confession_close'").all();
    expect(closeEvents).toHaveLength(1);
    db.close();
  });

  it("reply_wish が no 以外なら専用クローズしない", () => {
    const db = openDb(":memory:");
    const confessions = new Confessions(db, new EventLog(db));
    const row = confessions.create("poster", {
      type: "iken",
      replyWish: "yes",
      body: "返信ほしいです。",
    });

    const result = confessions.closeVoiceReceivedAtomic(row.id, "staff", 7);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.code).toBe("reply_wish_not_no");
    expect(confessions.get(row.id)?.status).toBe("open");
    db.close();
  });
});
