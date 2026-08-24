import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";

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
 * finalized eventはimmutable（§22）: 一度確定したevent_key/participants/involvementsをUPDATEしない。
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
  /** JSTのイベント開催日 'YYYY-MM-DD'。calendar dimensionには使うがtitle occurrenceをbackdateしない。 */
  readonly eventDate: string;
  readonly participantUserIds: readonly string[];
  /** event-ops上の共同organizer。primary organizerは別fieldでexactに1人指定する。 */
  readonly organizerUserIds: readonly string[];
  /** event-ops上のstaff。participant/organizerとの重複は許可する。 */
  readonly staffUserIds: readonly string[];
  /** eventごとにexactに1人のprimary organizer。 */
  readonly primaryOrganizerUserId: string;
  /** 記録した運営userId。audit用——safe source payloadへは絶対に出さない。 */
  readonly recordedBy: string;
}

export interface RecordFinalizedEventResult {
  readonly eventKey: string;
  readonly participantCount: number;
  /** primary organizerを含むsemantic organizer総数。 */
  readonly organizerCount: number;
  readonly staffCount: number;
  readonly recordedAt: number;
  readonly alreadyRecorded: boolean;
}

export interface RecordCompletedEventInput {
  readonly eventKey: string;
  /** completionを明示確認した運営userId。audit専用でsafe source/resultへは出さない。 */
  readonly completedBy: string;
}

export interface RecordCompletedEventResult {
  readonly eventKey: string;
  readonly participantCount: number;
  readonly completedAt: number;
  readonly alreadyRecorded: boolean;
}

/** 運営向けpreviewだけが使うread model。Title safe sourceへは接続しない。 */
export interface PublicEventCompletionSummary {
  readonly eventKey: string;
  readonly name: string;
  readonly eventDate: string;
  readonly participantCount: number;
}

export type PublicEventsErrorCode =
  | "invalid_event_key"
  | "invalid_name"
  | "invalid_event_date"
  | "invalid_participant"
  | "invalid_involvement"
  | "missing_primary_organizer"
  | "empty_participants"
  | "conflict"
  | "invalid_completed_by"
  | "invalid_completion_time"
  | "missing_event"
  | "missing_roster"
  | "completion_before_roster"
  | "future_event_date"
  | "corrupt_completion";

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

function assertCompletedBy(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new PublicEventsError("invalid_completed_by", "completedBy must be a non-empty string");
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

export type PublicEventInvolvementRole = "staff" | "organizer" | "primary_organizer";

function dedupeInvolvements(userIds: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of userIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) throw new PublicEventsError("invalid_involvement", `${label} userId must be a non-empty string`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function assertPrimaryOrganizer(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new PublicEventsError("missing_primary_organizer", "primaryOrganizerUserId must be a non-empty string");
  }
  return trimmed;
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_public_events_key_recorded_at
        ON public_events(event_key, recorded_at);
      CREATE TABLE IF NOT EXISTS public_event_completions (
        event_key           TEXT PRIMARY KEY,
        roster_recorded_at  INTEGER NOT NULL,
        completed_by        TEXT NOT NULL,
        completed_at        INTEGER NOT NULL,
        CHECK(completed_at >= roster_recorded_at),
        FOREIGN KEY(event_key, roster_recorded_at)
          REFERENCES public_events(event_key, recorded_at)
      );
      CREATE TABLE IF NOT EXISTS public_event_involvement_revisions (
        event_key           TEXT PRIMARY KEY,
        roster_recorded_at  INTEGER NOT NULL,
        UNIQUE(event_key, roster_recorded_at),
        FOREIGN KEY(event_key, roster_recorded_at)
          REFERENCES public_events(event_key, recorded_at)
      );
      CREATE TABLE IF NOT EXISTS public_event_involvements (
        event_key           TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        role                TEXT NOT NULL CHECK(role IN ('staff', 'organizer', 'primary_organizer')),
        roster_recorded_at  INTEGER NOT NULL,
        PRIMARY KEY(event_key, user_id, role),
        FOREIGN KEY(event_key, roster_recorded_at)
          REFERENCES public_event_involvement_revisions(event_key, roster_recorded_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_public_event_exactly_one_primary
        ON public_event_involvements(event_key) WHERE role = 'primary_organizer';
      CREATE INDEX IF NOT EXISTS idx_public_event_involvements_user
        ON public_event_involvements(user_id, roster_recorded_at);
    `);
  }

  /**
   * 運営が確定した公開イベントrosterを1 atomic writeで記録する（§14-16）。
   *
   * - `recordedAt`はこのservice自身のclockが正本（§10）——callerが渡すtimestampは
   *   一切受け取らない。過去イベントを後から登録しても、eventDateを使って
   *   backdateしない（§13）。
   * - 同一event_keyの再送で、name/eventDate/participant/involvement setが完全一致するときだけ
   *   `alreadyRecorded:true`の冪等成功を返す。recorded_at/recorded_byは既存値を維持し
   *   再実行しない（§23）。1件でも違えばconflict error——既存rowを上書きしない（§24）。
   * - event/participant/involvement revision/role INSERTは単一transaction——
   *   途中のINSERT失敗は先行rowも含めて丸ごとrollback
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
    const primaryOrganizerUserId = assertPrimaryOrganizer(input.primaryOrganizerUserId);
    const organizerUserIds = dedupeInvolvements(input.organizerUserIds, "organizer")
      .filter((id) => id !== primaryOrganizerUserId);
    const staffUserIds = dedupeInvolvements(input.staffUserIds, "staff");

    const existingEvent = this.db
      .prepare(`SELECT name, event_date, recorded_by, recorded_at FROM public_events WHERE event_key = ?`)
      .get(eventKey) as { name: string; event_date: string; recorded_by: string; recorded_at: number } | undefined;

    if (existingEvent) {
      const existingParticipantRows = this.db
        .prepare(`SELECT user_id, recorded_at FROM public_event_participations WHERE event_key = ?`)
        .all(eventKey) as Array<{ user_id: string; recorded_at: number }>;
      const existingParticipants = existingParticipantRows.map((r) => r.user_id);
      const participantIntegrity = existingParticipantRows.every((r) =>
        typeof r.user_id === "string" && r.user_id.trim().length > 0 && r.recorded_at === existingEvent.recorded_at);
      const existingRevision = this.db
        .prepare(`SELECT roster_recorded_at FROM public_event_involvement_revisions WHERE event_key = ?`)
        .get(eventKey) as { roster_recorded_at: number } | undefined;
      const existingInvolvements = this.db
        .prepare(`SELECT user_id, role, roster_recorded_at FROM public_event_involvements WHERE event_key = ?`)
        .all(eventKey) as Array<{ user_id: string; role: string; roster_recorded_at: number }>;
      const existingPrimary = existingInvolvements.filter((r) => r.role === "primary_organizer");
      const existingOrganizers = existingInvolvements.filter((r) => r.role === "organizer").map((r) => r.user_id);
      const existingStaff = existingInvolvements.filter((r) => r.role === "staff").map((r) => r.user_id);
      const involvementIntegrity =
        existingRevision?.roster_recorded_at === existingEvent.recorded_at &&
        existingInvolvements.every((r) =>
          r.roster_recorded_at === existingEvent.recorded_at &&
          typeof r.user_id === "string" && r.user_id.trim().length > 0 &&
          (r.role === "staff" || r.role === "organizer" || r.role === "primary_organizer")) &&
        existingPrimary.length === 1;

      const identical =
        existingEvent.name === name &&
        existingEvent.event_date === eventDate &&
        participantIntegrity &&
        sameParticipantSet(existingParticipants, participantUserIds) &&
        involvementIntegrity &&
        existingPrimary[0]!.user_id === primaryOrganizerUserId &&
        sameParticipantSet(existingOrganizers, organizerUserIds) &&
        sameParticipantSet(existingStaff, staffUserIds);

      if (identical) {
        return {
          eventKey,
          participantCount: existingParticipants.length,
          organizerCount: existingOrganizers.length + 1,
          staffCount: existingStaff.length,
          recordedAt: existingEvent.recorded_at,
          alreadyRecorded: true,
        };
      }
      throw new PublicEventsError(
        "conflict",
        `public event ${eventKey} was already recorded with a different name/date/participants/involvements — finalized events are immutable`,
      );
    }

    const recordedAt = this.clock();
    const insertEvent = this.db.prepare(
      `INSERT INTO public_events (event_key, name, event_date, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertParticipant = this.db.prepare(
      `INSERT INTO public_event_participations (event_key, user_id, recorded_at) VALUES (?, ?, ?)`,
    );
    const insertRevision = this.db.prepare(
      `INSERT INTO public_event_involvement_revisions (event_key, roster_recorded_at) VALUES (?, ?)`,
    );
    const insertInvolvement = this.db.prepare(
      `INSERT INTO public_event_involvements (event_key, user_id, role, roster_recorded_at) VALUES (?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      insertEvent.run(eventKey, name, eventDate, recordedBy, recordedAt);
      for (const userId of participantUserIds) insertParticipant.run(eventKey, userId, recordedAt);
      insertRevision.run(eventKey, recordedAt);
      insertInvolvement.run(eventKey, primaryOrganizerUserId, "primary_organizer", recordedAt);
      for (const userId of organizerUserIds) insertInvolvement.run(eventKey, userId, "organizer", recordedAt);
      for (const userId of staffUserIds) insertInvolvement.run(eventKey, userId, "staff", recordedAt);
    });
    run();

    return {
      eventKey,
      participantCount: participantUserIds.length,
      organizerCount: organizerUserIds.length + 1,
      staffCount: staffUserIds.length,
      recordedAt,
      alreadyRecorded: false,
    };
  }

  /** 保存済み正本からcompletion previewを作る。roster無しeventはfail-closed。 */
  getEventCompletionSummary(eventKeyInput: string): PublicEventCompletionSummary {
    const eventKey = assertEventKey(eventKeyInput);
    const row = this.db
      .prepare(
        `SELECT e.name, e.event_date, COUNT(p.user_id) AS participant_count
           FROM public_events e
           LEFT JOIN public_event_participations p ON p.event_key = e.event_key
          WHERE e.event_key = ?
          GROUP BY e.event_key, e.name, e.event_date`,
      )
      .get(eventKey) as { name: string; event_date: string; participant_count: number } | undefined;
    if (!row) throw new PublicEventsError("missing_event", `public event ${eventKey} does not exist`);
    if (row.participant_count < 1) {
      throw new PublicEventsError("missing_roster", `public event ${eventKey} has no participant roster`);
    }
    return { eventKey, name: row.name, eventDate: row.event_date, participantCount: row.participant_count };
  }

  /**
   * 運営がevent終了を明示確認した時点を、rosterとは別のimmutable正本へ追記する。
   * caller timestampは受け取らず、過去eventもevent_dateへbackdateしない。
   */
  recordCompletedEvent(input: RecordCompletedEventInput): RecordCompletedEventResult {
    const eventKey = assertEventKey(input.eventKey);
    const completedBy = assertCompletedBy(input.completedBy);
    const event = this.db
      .prepare(`SELECT event_date, recorded_at FROM public_events WHERE event_key = ?`)
      .get(eventKey) as { event_date: string; recorded_at: number } | undefined;
    if (!event) throw new PublicEventsError("missing_event", `public event ${eventKey} does not exist`);

    const participantCount = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM public_event_participations WHERE event_key = ?`).get(eventKey) as {
        count: number;
      }
    ).count;
    if (participantCount < 1) {
      throw new PublicEventsError("missing_roster", `public event ${eventKey} has no participant roster`);
    }

    const existing = this.db
      .prepare(
        `SELECT roster_recorded_at, completed_by, completed_at
           FROM public_event_completions WHERE event_key = ?`,
      )
      .get(eventKey) as { roster_recorded_at: number; completed_by: string; completed_at: number } | undefined;
    if (existing) {
      if (
        existing.roster_recorded_at !== event.recorded_at ||
        existing.completed_at < existing.roster_recorded_at ||
        !existing.completed_by
      ) {
        throw new PublicEventsError("corrupt_completion", `public event ${eventKey} has an inconsistent completion row`);
      }
      return { eventKey, participantCount, completedAt: existing.completed_at, alreadyRecorded: true };
    }

    const completedAt = this.clock();
    if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
      throw new PublicEventsError("invalid_completion_time", "service clock returned an invalid completion timestamp");
    }
    if (completedAt < event.recorded_at) {
      throw new PublicEventsError(
        "completion_before_roster",
        `public event ${eventKey} cannot be completed before its roster was recorded`,
      );
    }
    if (event.event_date > jstDateStr(new Date(completedAt * 1000))) {
      throw new PublicEventsError("future_event_date", `public event ${eventKey} has a future JST event date`);
    }

    this.db
      .prepare(
        `INSERT INTO public_event_completions (event_key, roster_recorded_at, completed_by, completed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(eventKey, event.recorded_at, completedBy, completedAt);
    return { eventKey, participantCount, completedAt, alreadyRecorded: false };
  }
}
