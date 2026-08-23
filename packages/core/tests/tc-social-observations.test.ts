import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/bootstrap.js";
import { TcSocialObservations } from "../src/tc-social/service.js";

const CREATED = 1_787_270_400_000;

function setup() {
  const db = openDb(":memory:");
  return { db, observations: new TcSocialObservations(db) };
}

function record(observations: TcSocialObservations, overrides: Partial<Parameters<TcSocialObservations["recordMessage"]>[0]> = {}) {
  return observations.recordMessage({
    messageId: "message-secret-marker",
    authorId: "author-secret-marker",
    surfaceId: "channel-secret-marker",
    areaId: "area-secret-marker",
    surfaceKind: "channel",
    replyToMessageId: null,
    createdAtMs: CREATED,
    observedAtMs: CREATED + 100,
    ...overrides,
  });
}

describe("canonical TC observation persistence", () => {
  it("既存file DBを再openするとlegacy dataを保ったままTC tables/indexesを追加する", () => {
    const dir = mkdtempSync(join(process.cwd(), "tc-social-migration-"));
    const path = join(dir, "legacy.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL); INSERT INTO legacy_marker VALUES ('kept')");
      legacy.close();

      const migrated = openDb(path);
      expect(migrated.prepare("SELECT value FROM legacy_marker").get()).toEqual({ value: "kept" });
      const names = (migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND (name LIKE 'tc_%' OR name LIKE 'idx_tc_%') ORDER BY name",
        )
        .all() as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual([
        "idx_tc_message_area_created",
        "idx_tc_message_author_created",
        "idx_tc_message_reply",
        "idx_tc_message_surface_created",
        "idx_tc_reaction_observed_message",
        "tc_message_observations",
        "tc_reaction_observations",
      ]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("public message metadataを1行保存し、schemaにcontent系columnを持たない", () => {
    const { db, observations } = setup();
    expect(record(observations).recorded).toBe(true);
    const columns = (db.prepare("PRAGMA table_info(tc_message_observations)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual([
      "message_id",
      "author_id",
      "surface_id",
      "area_id",
      "surface_kind",
      "reply_to_message_id",
      "created_at_ms",
      "observed_at_ms",
      "thread_owner_id",
      "thread_created_at_ms",
    ]);
    expect(columns.join(" ")).not.toMatch(/content|attachment|embed|sticker|mention|emoji|length|word/i);
  });

  it("duplicate MessageCreate replayはfirst observationを不変保持する", () => {
    const { db, observations } = setup();
    expect(record(observations).recorded).toBe(true);
    expect(record(observations, { authorId: "forged-later", observedAtMs: CREATED + 9_999 }).recorded).toBe(false);
    expect(db.prepare("SELECT author_id, observed_at_ms FROM tc_message_observations").get()).toEqual({
      author_id: "author-secret-marker",
      observed_at_ms: CREATED + 100,
    });
  });

  it("thread provenanceとreply edgeだけを保存する", () => {
    const { db, observations } = setup();
    record(observations, {
      surfaceKind: "forum_post",
      surfaceId: "thread-secret-marker",
      areaId: "forum-secret-marker",
      replyToMessageId: "parent-message-secret-marker",
      threadOwnerId: "thread-owner-secret-marker",
      threadCreatedAtMs: CREATED - 10,
    });
    expect(db.prepare("SELECT * FROM tc_message_observations").get()).toMatchObject({
      surface_kind: "forum_post",
      reply_to_message_id: "parent-message-secret-marker",
      thread_owner_id: "thread-owner-secret-marker",
      thread_created_at_ms: CREATED - 10,
    });
  });
});

describe("canonical TC reaction observation persistence", () => {
  it("other humanのfirst reactionだけを1 post × 1 reactorで保存する", () => {
    const { db, observations } = setup();
    record(observations);
    expect(observations.recordReaction("message-secret-marker", "reactor-secret-marker", CREATED + 200).recorded).toBe(true);
    expect(observations.recordReaction("message-secret-marker", "reactor-secret-marker", CREATED + 300).recorded).toBe(false);
    expect(db.prepare("SELECT * FROM tc_reaction_observations").all()).toEqual([
      {
        message_id: "message-secret-marker",
        reactor_id: "reactor-secret-marker",
        observed_at_ms: CREATED + 200,
      },
    ]);
  });

  it("self reactionとpre-feature/unobserved messageを0件にし、message backfillしない", () => {
    const { db, observations } = setup();
    record(observations);
    expect(observations.recordReaction("message-secret-marker", "author-secret-marker", CREATED + 200).recorded).toBe(false);
    expect(observations.recordReaction("unknown-message", "reactor-secret-marker", CREATED + 200).recorded).toBe(false);
    expect(db.prepare("SELECT COUNT(*) count FROM tc_reaction_observations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM tc_message_observations").get()).toEqual({ count: 1 });
  });

  it("reaction schemaはemoji/author/channelを重複保存しない", () => {
    const { db } = setup();
    const columns = (db.prepare("PRAGMA table_info(tc_reaction_observations)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(["message_id", "reactor_id", "observed_at_ms"]);
  });
});

describe("TC observation query-plan indexes", () => {
  it("author/area/surface/reply/reaction-range queryが専用indexを使う", () => {
    const { db } = setup();
    const details = (sql: string, ...params: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
    expect(details("SELECT message_id FROM tc_message_observations WHERE author_id = ? AND created_at_ms >= ?", "a", 0)).toContain(
      "idx_tc_message_author_created",
    );
    expect(details("SELECT message_id FROM tc_message_observations WHERE area_id = ? AND created_at_ms >= ?", "x", 0)).toContain(
      "idx_tc_message_area_created",
    );
    expect(details("SELECT message_id FROM tc_message_observations WHERE surface_id = ? AND created_at_ms >= ?", "x", 0)).toContain(
      "idx_tc_message_surface_created",
    );
    expect(details("SELECT message_id FROM tc_message_observations WHERE reply_to_message_id = ?", "m")).toContain("idx_tc_message_reply");
    expect(details("SELECT message_id FROM tc_reaction_observations WHERE observed_at_ms >= ?", 0)).toContain(
      "idx_tc_reaction_observed_message",
    );
  });
});
