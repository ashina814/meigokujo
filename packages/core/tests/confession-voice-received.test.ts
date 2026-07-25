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

    const closed = confessions.close(row.id, "staff", "voice_received" as never, 7);

    expect(closed?.status).toBe("closed");
    expect(closed?.close_reason).toBe("voice_received");
    expect(closed?.closed_by).toBe("staff");
    expect(closed?.body_purge_at).not.toBeNull();
    db.close();
  });
});
