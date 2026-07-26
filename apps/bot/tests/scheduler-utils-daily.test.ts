import { describe, expect, it } from "vitest";
import { openDb } from "@meigokujo/core";
import { pendingChunkBatch } from "../src/scheduler-utils.js";

describe("日次分割バッチの期限処理", () => {
  it("前日以前のカロン期限一覧pendingを再送せず完了扱いにする", () => {
    const db = openDb(":memory:");
    pendingChunkBatch({ db } as any, "charon_due_list");
    db.prepare(
      `INSERT INTO scheduler_chunk_batches
       (batch_key, kind, status, target_ids_json, role_ids_json, chunks_json, sent_chunks_json, metadata_json, created_at, updated_at)
       VALUES (?, 'charon_due_list', 'pending', '[]', '[]', '["old"]', '[]', '{}', 1, 1)`,
    ).run("charon_due_list:2000-01-01");

    expect(pendingChunkBatch({ db } as any, "charon_due_list")).toBeUndefined();
    const row = db
      .prepare("SELECT status, chunks_json, completed_at FROM scheduler_chunk_batches WHERE batch_key=?")
      .get("charon_due_list:2000-01-01") as { status: string; chunks_json: string | null; completed_at: number | null };
    expect(row.status).toBe("completed");
    expect(row.chunks_json).toBeNull();
    expect(row.completed_at).not.toBeNull();
    db.close();
  });

  it("チケット通知のpendingは日付形式に関係なく維持する", () => {
    const db = openDb(":memory:");
    pendingChunkBatch({ db } as any, "ticket_stale_24h");
    db.prepare(
      `INSERT INTO scheduler_chunk_batches
       (batch_key, kind, status, target_ids_json, role_ids_json, chunks_json, sent_chunks_json, metadata_json, created_at, updated_at)
       VALUES (?, 'ticket_stale_24h', 'pending', '["thread"]', '[]', '["notice"]', '[]', '{}', 1, 1)`,
    ).run("ticket_stale_24h:old");

    expect(pendingChunkBatch({ db } as any, "ticket_stale_24h")?.batch_key).toBe("ticket_stale_24h:old");
    db.close();
  });
});
