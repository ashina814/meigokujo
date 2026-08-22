import type Database from "better-sqlite3";

/**
 * 公開イベント運営ドメイン（PR E3）。
 *
 * これは称号v2専用の監視ログではない。God Field大会・ビンゴ・ファッションショー等、
 * 冥獄城の公開イベントについて「運営が確定した参加roster」を保持する、独立した
 * event-ops正本——将来のevent history/UI等にも使える。称号v2は、この確定rosterを
 * safe sourceとして読む1 consumerに過ぎない。
 *
 * generic `events`（EventLog）は使わない——confession/evaluation/entry/shop/rooms/casino
 * 等が共用する汎用事件録であり、`actor_id`/`target_id`/`payload_json`/`type`から
 * 公開イベント参加者を推測することはこのserviceの責務ではない（§2-3）。
 *
 * 一発finalize設計（§14-16）: draft/participant add-remove/event finalizeという
 * 複雑なstate machineをDBへ持たない。Bot UI側でpreview→confirmし、
 * `recordFinalizedEvent()`という単一atomic writeだけをこのserviceへ渡す。
 * confirm前はDB mutationが0件——このserviceはpreview状態を一切知らない。
 *
 * finalized rosterはimmutable（§22）: 一度確定したevent_key/participantsをUPDATEしない。
 * 同一event_keyの再送は、内容が完全一致すれば冪等成功（§23）、一部でも違えばconflict
 * error（§24）——「新しい入力の方が正しそうだから上書き」は行わない。
 */

export interface PublicEventRow {
  readonly eventKey: string;
  readonly name: string;
  readonly eventDate: string;
  readonly recordedBy: string;
  readonly recordedAt: number;
}

export interface RecordFinalizedEventInput {
  readonly eventKey: string;
  readonly name: string;
  /** JSTのイベント開催日 'YYYY-MM-DD'。Title source timingには使わない（recordedAtだけを使う）。 */
  readonly eventDate: string;
  readonly participantUserIds: readonly string[];
  /** 記録した運営userId。audit用——safe source payloadへは絶対に出さない。 */
  readonly recordedBy: string;
}

export interface RecordFinalizedEventResult {
  readonly eventKey: string;
  readonly participantCount: number;
  readonly recordedAt: number;
  readonly alreadyRecorded: boolean;
}

export type PublicEventsErrorCode =
  | "invalid_event_key"
  | "invalid_name"
  | "invalid_event_date"
  | "invalid_participant"
  | "empty_participants"
  | "conflict";

export class PublicEventsError extends Error {
  constructor(
    readonly code: PublicEventsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicEventsError";
  }
}

const EVENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 200;

function assertEventKey(value: string): string {
  if (typeof value !== "string" || !EVENT_KEY_PATTERN.test(value)) {
    throw new PublicEventsError(
      "invalid_event_key",
      `eventKey must be a slug matching ${EVENT_KEY_PATTERN.source} (lowercase alnum, "-", "_", 1-64 chars): ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertName(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new PublicEventsError("invalid_name", "name must be a non-empty string");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new PublicEventsError("invalid_name", `name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/** 'YYYY-MM-DD'かつ実在する日付か（2026-02-30等はreject）。Date round-tripで検証する。 */
function assertEventDate(value: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!EVENT_DATE_PATTERN.test(text)) {
    throw new PublicEventsError("invalid_event_date", `eventDate must be YYYY-MM-DD: ${JSON.stringify(value)}`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new PublicEventsError("invalid_event_date", `eventDate is not a real calendar date: ${JSON.stringify(value)}`);
  }
  return text;
}

function assertRecordedBy(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new PublicEventsError("invalid_participant", "recordedBy must be a non-empty string");
  return trimmed;
}

/** 最初の出現順を保ったままdedupeする（§17）。空/非string idはfail-closedでreject。 */
function dedupeParticipants(userIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of userIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) throw new PublicEventsError("invalid_participant", "participant userId must be a non-empty string");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 入力順をsemanticにしない同値比較（§25）: sortしてから比較する。 */
function sameParticipantSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

const defaultClock = () => Math.floor(Date.now() / 1000);

export class PublicEvents {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => number = defaultClock,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS public_events (
        event_key    TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        event_date   TEXT NOT NULL,
        recorded_by  TEXT NOT NULL,
        recorded_at  INTEGER NOT NULL CHECK(recorded_at >= 0)
      );
      CREATE TABLE IF NOT EXISTS public_event_participations (
        event_key    TEXT NOT NULL REFERENCES public_events(event_key),
        user_id      TEXT NOT NULL,
        recorded_at  INTEGER NOT NULL CHECK(recorded_at >= 0),
        PRIMARY KEY(event_key, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_public_event_participations_user
        ON public_event_participations(user_id, recorded_at);
    `);
  }

  /**
   * 運営が確定した公開イベントrosterを1 atomic writeで記録する（§14-16）。
   *
   * - `recordedAt`はこのservice自身のclockが正本（§10）——callerが渡すtimestampは
   *   一切受け取らない。過去イベントを後から登録しても、eventDateを使って
   *   backdateしない（§13）。
   * - 同一event_keyの再送で、name/eventDate/participant setが完全一致するときだけ
   *   `alreadyRecorded:true`の冪等成功を返す。recorded_at/recorded_byは既存値を維持し
   *   再実行しない（§23）。1件でも違えばconflict error——既存rowを上書きしない（§24）。
   * - `public_events` INSERTと全participant INSERTは単一transaction——
   *   途中のparticipant INSERT失敗はevent row・先行participant行も含めて丸ごとrollback
   *   する（§16）。
   */
  recordFinalizedEvent(input: RecordFinalizedEventInput): RecordFinalizedEventResult {
    const eventKey = assertEventKey(input.eventKey);
    const name = assertName(input.name);
    const eventDate = assertEventDate(input.eventDate);
    const recordedBy = assertRecordedBy(input.recordedBy);
    const participantUserIds = dedupeParticipants(input.participantUserIds);
    if (participantUserIds.length === 0) {
      throw new PublicEventsError("empty_participants", "participantUserIds must contain at least one participant");
    }

    const existingEvent = this.db
      .prepare(`SELECT name, event_date, recorded_by, recorded_at FROM public_events WHERE event_key = ?`)
      .get(eventKey) as { name: string; event_date: string; recorded_by: string; recorded_at: number } | undefined;

    if (existingEvent) {
      const existingParticipants = (
        this.db
          .prepare(`SELECT user_id FROM public_event_participations WHERE event_key = ?`)
          .all(eventKey) as Array<{ user_id: string }>
      ).map((r) => r.user_id);

      const identical =
        existingEvent.name === name &&
        existingEvent.event_date === eventDate &&
        sameParticipantSet(existingParticipants, participantUserIds);

      if (identical) {
        return {
          eventKey,
          participantCount: existingParticipants.length,
          recordedAt: existingEvent.recorded_at,
          alreadyRecorded: true,
        };
      }
      throw new PublicEventsError(
        "conflict",
        `public event ${eventKey} was already recorded with a different name/date/roster — finalized rosters are immutable`,
      );
    }

    const recordedAt = this.clock();
    const insertEvent = this.db.prepare(
      `INSERT INTO public_events (event_key, name, event_date, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertParticipant = this.db.prepare(
      `INSERT INTO public_event_participations (event_key, user_id, recorded_at) VALUES (?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      insertEvent.run(eventKey, name, eventDate, recordedBy, recordedAt);
      for (const userId of participantUserIds) insertParticipant.run(eventKey, userId, recordedAt);
    });
    run();

    return { eventKey, participantCount: participantUserIds.length, recordedAt, alreadyRecorded: false };
  }
}
