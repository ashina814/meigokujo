import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { openDb } from "../src/db/bootstrap.js";

describe("reward_boost pending schema", () => {
  it("Ledger初期化で未解決Boostの永続tableと順序indexを作る", () => {
    registerDefaultTxTypes();
    const db = openDb(":memory:");
    new Ledger(db);

    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='boost_reward_pending'").get() as { name: string })
        .name,
    ).toBe("boost_reward_pending");
    expect(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_boost_reward_pending_user_event'")
          .get() as { name: string }
      ).name,
    ).toBe("idx_boost_reward_pending_user_event");
  });
});
