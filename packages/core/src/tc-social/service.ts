import type Database from "better-sqlite3";

export const TC_SURFACE_KINDS = ["channel", "public_thread", "announcement_thread", "forum_post"] as const;
export type TcSurfaceKind = (typeof TC_SURFACE_KINDS)[number];

export interface RecordTcMessageObservationInput {
  readonly messageId: string;
  readonly authorId: string;
  readonly surfaceId: string;
  readonly areaId: string;
  readonly surfaceKind: TcSurfaceKind;
  readonly replyToMessageId: string | null;
  readonly createdAtMs: number;
  readonly observedAtMs: number;
  readonly threadOwnerId?: string | null;
  readonly threadCreatedAtMs?: number | null;
}

/**
 * 公開TCのcanonical metadata observation writer。
 *
 * APIにもtableにもmessage content・attachment・embed・emojiを受け取る入口を持たない。
 * replay/edit/delete/reaction removeでfirst observationを書き換えず、historical factを保持する。
 */
export class TcSocialObservations {
  constructor(private readonly db: Database.Database) {}

  recordMessage(input: RecordTcMessageObservationInput): { readonly recorded: boolean } {
    const messageId = requireText(input.messageId, "messageId");
    const authorId = requireText(input.authorId, "authorId");
    const surfaceId = requireText(input.surfaceId, "surfaceId");
    const areaId = requireText(input.areaId, "areaId");
    if (!TC_SURFACE_KINDS.includes(input.surfaceKind)) throw new RangeError(`invalid surfaceKind: ${input.surfaceKind}`);
    const replyToMessageId = optionalText(input.replyToMessageId, "replyToMessageId");
    if (replyToMessageId === messageId) throw new RangeError("message cannot reply to itself");
    const createdAtMs = requireTimestamp(input.createdAtMs, "createdAtMs");
    const observedAtMs = requireTimestamp(input.observedAtMs, "observedAtMs");
    const threadOwnerId = optionalText(input.threadOwnerId ?? null, "threadOwnerId");
    const threadCreatedAtMs =
      input.threadCreatedAtMs === undefined || input.threadCreatedAtMs === null
        ? null
        : requireTimestamp(input.threadCreatedAtMs, "threadCreatedAtMs");

    const result = this.db
      .prepare(
        `INSERT INTO tc_message_observations
           (message_id, author_id, surface_id, area_id, surface_kind, reply_to_message_id,
            created_at_ms, observed_at_ms, thread_owner_id, thread_created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(
        messageId,
        authorId,
        surfaceId,
        areaId,
        input.surfaceKind,
        replyToMessageId,
        createdAtMs,
        observedAtMs,
        threadOwnerId,
        threadCreatedAtMs,
      );
    return { recorded: result.changes > 0 };
  }

  /**
   * 既にcanonical message metadataがあるpostへのfirst human reaction observationだけを記録する。
   * self reactionはSQLで除外し、message historyをreactionからbackfillしない。
   */
  recordReaction(messageIdRaw: string, reactorIdRaw: string, observedAtMsRaw: number): { readonly recorded: boolean } {
    const messageId = requireText(messageIdRaw, "messageId");
    const reactorId = requireText(reactorIdRaw, "reactorId");
    const observedAtMs = requireTimestamp(observedAtMsRaw, "observedAtMs");
    const result = this.db
      .prepare(
        `INSERT INTO tc_reaction_observations (message_id, reactor_id, observed_at_ms)
         SELECT message_id, ?, ?
           FROM tc_message_observations
          WHERE message_id = ? AND author_id <> ?
         ON CONFLICT(message_id, reactor_id) DO NOTHING`,
      )
      .run(reactorId, observedAtMs, messageId, reactorId);
    return { recorded: result.changes > 0 };
  }
}

function requireText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalText(value: string | null, label: string): string | null {
  if (value === null) return null;
  return requireText(value, label);
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer unix millisecond: ${value}`);
  }
  return value;
}
