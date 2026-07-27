import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";

const ROOM_MIGRATION_COLUMNS = [
  "pending_delete",
  "delete_attempts",
  "next_delete_retry_at",
  "close_reason",
  "close_actor_id",
  "closed_at",
  "unused_refund_tx_id",
];

const ROOM_INDEXES = ["idx_rooms_owner_normal_open", "idx_rooms_owner_special_open", "idx_rooms_pending_delete"];

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can keep a failed SQLite open attempt locked briefly. The migration assertion above is the test target.
    }
  }
  tempDirs = [];
});

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-room-migration-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function createPreRoomMigrationDb(path: string, rows: Array<{ kind: string; channelId: string; ownerId: string; status?: string }> = []): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE rooms (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT NOT NULL CHECK (kind IN ('normal','mitsugetsu','oborozuki','game')),
      channel_id   TEXT NOT NULL UNIQUE,
      owner_id     TEXT NOT NULL,
      capacity     INTEGER NOT NULL DEFAULT 2,
      expires_at   INTEGER,
      warned_at    INTEGER,
      activated_at INTEGER,
      empty_since  INTEGER,
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    `INSERT INTO rooms (kind, channel_id, owner_id, capacity, status, created_at, updated_at)
     VALUES (?, ?, ?, 2, ?, 100, 100)`,
  );
  for (const row of rows) insert.run(row.kind, row.channelId, row.ownerId, row.status ?? "open");
  db.close();
}

function roomColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map((row) => row.name);
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name);
}

describe("rooms schema migration", () => {
  it("旧roomsスキーマの既存DBへ新規列と必要indexを追加し、2回目openDbも成功する", () => {
    const path = tempDbPath("legacy.db");
    createPreRoomMigrationDb(path, [{ kind: "normal", channelId: "legacy-vc", ownerId: "owner" }]);

    const db = openDb(path);
    expect(roomColumns(db)).toEqual(expect.arrayContaining(ROOM_MIGRATION_COLUMNS));
    expect(indexNames(db)).toEqual(expect.arrayContaining(ROOM_INDEXES));
    expect(db.prepare("SELECT COUNT(*) AS count FROM rooms WHERE channel_id = ?").get("legacy-vc")).toEqual({ count: 1 });
    db.close();

    const reopened = openDb(path);
    expect(roomColumns(reopened)).toEqual(expect.arrayContaining(ROOM_MIGRATION_COLUMNS));
    expect(indexNames(reopened)).toEqual(expect.arrayContaining(ROOM_INDEXES));
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM rooms WHERE channel_id = ?").get("legacy-vc")).toEqual({ count: 1 });
    reopened.close();
  });

  it("新規DBでもrooms新規列と必要indexを作成し、2回目openDbも成功する", () => {
    const path = tempDbPath("fresh.db");

    const db = openDb(path);
    expect(roomColumns(db)).toEqual(expect.arrayContaining(ROOM_MIGRATION_COLUMNS));
    expect(indexNames(db)).toEqual(expect.arrayContaining(ROOM_INDEXES));
    db.close();

    const reopened = openDb(path);
    expect(roomColumns(reopened)).toEqual(expect.arrayContaining(ROOM_MIGRATION_COLUMNS));
    expect(indexNames(reopened)).toEqual(expect.arrayContaining(ROOM_INDEXES));
    reopened.close();
  });

  it("既存DBに同一ownerのopen部屋重複がある場合はownerと枠種別が分かるエラーで止める", () => {
    const path = tempDbPath("duplicate.db");
    createPreRoomMigrationDb(path, [
      { kind: "normal", channelId: "normal-a", ownerId: "owner-dup" },
      { kind: "normal", channelId: "normal-b", ownerId: "owner-dup" },
    ]);

    expect(() => openDb(path)).toThrowError(/rooms migration blocked: duplicate open room ownership.*owner=owner-dup.*slot=normal.*normal-a.*normal-b/);
  });
});
