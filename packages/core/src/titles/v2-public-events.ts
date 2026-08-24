import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";

export interface CompletedPublicEventParticipationFact {
  readonly userId: string;
  readonly eventKey: string;
  readonly completedAt: number;
}

/**
 * requested usersについて、明示的なstaff completion正本と同一roster revisionへ
 * 結び付く参加だけを返す。bind数はuserIds + window境界2個だけに依存する。
 */
export function computeCompletedPublicEventParticipations(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly CompletedPublicEventParticipationFact[] {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT p.user_id, p.event_key, c.completed_at
         FROM public_event_participations p
         JOIN public_event_completions c
           ON c.event_key = p.event_key
          AND c.roster_recorded_at = p.recorded_at
        WHERE p.user_id IN (${placeholders})
          AND c.completed_at >= c.roster_recorded_at
          AND c.completed_at >= ?
          AND c.completed_at < ?
        ORDER BY p.user_id ASC, c.completed_at ASC, p.event_key ASC`,
    )
    .all(...userIds, window.start, window.end) as Array<{
    user_id: string;
    event_key: string;
    completed_at: number;
  }>;
  return rows.map((row) => ({ userId: row.user_id, eventKey: row.event_key, completedAt: row.completed_at }));
}

export interface PublicEventCalendarInvolvementProfile {
  readonly eventDate: string;
  readonly generalParticipant: boolean;
  readonly staff: boolean;
  /** primary organizerもsemantic organizerに含む。 */
  readonly organizer: boolean;
  readonly primaryOrganizer: boolean;
}

export interface PublicEventCalendarInvolvementSafePayload {
  /** 1 profile = 1 distinct completed event。event identity自体は公開しない。 */
  readonly events: readonly PublicEventCalendarInvolvementProfile[];
}

export interface PublicEventCalendarInvolvementSafeRow {
  readonly userId: string;
  readonly payload: PublicEventCalendarInvolvementSafePayload;
}

const EVENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidEventDate(value: unknown): value is string {
  if (typeof value !== "string" || !EVENT_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * completion snapshot fenceとactual JST event calendarを分離し、subject自身の
 * involvement flagsだけをanonymous distinct-event profileへsanitizeする。
 *
 * 1 chunk = 1 SQL。event/userごとの追加queryは行わない。legacy eventはrevision markerが
 * 無い場合だけparticipant-only profileとして許可し、roleを推測しない。新protocol eventは
 * revision marker・exactly one primary・全role/participantの同一roster anchorを要求する。
 */
export function computePublicEventCalendarInvolvementSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly PublicEventCalendarInvolvementSafeRow[] {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => "?").join(",");
  const rows = db.prepare(`
    WITH requested_facts AS (
      SELECT p.user_id AS subject_user_id, p.event_key, 'general_participant' AS fact_role
        FROM public_event_participations p
       WHERE p.user_id IN (${placeholders})
      UNION ALL
      SELECT i.user_id AS subject_user_id, i.event_key, i.role AS fact_role
        FROM public_event_involvements i
       WHERE i.user_id IN (${placeholders})
    ),
    subject_events AS (
      SELECT subject_user_id, event_key,
             MAX(fact_role = 'general_participant') AS general_participant,
             MAX(fact_role = 'staff') AS staff,
             MAX(fact_role IN ('organizer', 'primary_organizer')) AS organizer,
             MAX(fact_role = 'primary_organizer') AS primary_organizer
        FROM requested_facts
       GROUP BY subject_user_id, event_key
    ),
    participant_integrity AS (
      SELECT p.event_key,
             COUNT(*) AS participant_row_count,
             SUM(typeof(p.user_id) <> 'text' OR length(trim(p.user_id)) = 0) AS invalid_participant_count,
             SUM(p.recorded_at <> e.recorded_at) AS wrong_participant_revision_count
        FROM public_event_participations p
        JOIN public_events e USING(event_key)
       GROUP BY p.event_key
    ),
    role_integrity AS (
      SELECT i.event_key,
             COUNT(*) AS role_row_count,
             SUM(i.role = 'primary_organizer') AS primary_count,
             SUM(i.role NOT IN ('staff', 'organizer', 'primary_organizer')) AS invalid_role_count,
             SUM(typeof(i.user_id) <> 'text' OR length(trim(i.user_id)) = 0) AS invalid_role_user_count,
             SUM(i.roster_recorded_at <> e.recorded_at) AS wrong_role_revision_count
        FROM public_event_involvements i
        JOIN public_events e USING(event_key)
       GROUP BY i.event_key
    )
    SELECT se.subject_user_id, se.event_key, e.event_date, e.recorded_at,
           c.roster_recorded_at AS completion_roster_recorded_at, c.completed_at,
           r.roster_recorded_at AS involvement_roster_recorded_at,
           COALESCE(pi.participant_row_count, 0) AS participant_row_count,
           COALESCE(pi.invalid_participant_count, 0) AS invalid_participant_count,
           COALESCE(pi.wrong_participant_revision_count, 0) AS wrong_participant_revision_count,
           COALESCE(ri.role_row_count, 0) AS role_row_count,
           COALESCE(ri.primary_count, 0) AS primary_count,
           COALESCE(ri.invalid_role_count, 0) AS invalid_role_count,
           COALESCE(ri.invalid_role_user_count, 0) AS invalid_role_user_count,
           COALESCE(ri.wrong_role_revision_count, 0) AS wrong_role_revision_count,
           se.general_participant, se.staff, se.organizer, se.primary_organizer
      FROM subject_events se
      JOIN public_events e ON e.event_key = se.event_key
      JOIN public_event_completions c ON c.event_key = e.event_key
      LEFT JOIN public_event_involvement_revisions r ON r.event_key = e.event_key
      LEFT JOIN participant_integrity pi ON pi.event_key = e.event_key
      LEFT JOIN role_integrity ri ON ri.event_key = e.event_key
     WHERE c.completed_at >= ? AND c.completed_at < ?
     ORDER BY se.subject_user_id ASC, e.event_date ASC, c.completed_at ASC, se.event_key ASC
  `).all(...userIds, ...userIds, window.start, window.end) as Array<{
    subject_user_id: string;
    event_key: string;
    event_date: unknown;
    recorded_at: number;
    completion_roster_recorded_at: number;
    completed_at: number;
    involvement_roster_recorded_at: number | null;
    participant_row_count: number;
    invalid_participant_count: number;
    wrong_participant_revision_count: number;
    role_row_count: number;
    primary_count: number;
    invalid_role_count: number;
    invalid_role_user_count: number;
    wrong_role_revision_count: number;
    general_participant: number;
    staff: number;
    organizer: number;
    primary_organizer: number;
  }>;

  const requested = new Set(userIds);
  const byUser = new Map<string, PublicEventCalendarInvolvementProfile[]>();
  for (const row of rows) {
    if (!isValidEventDate(row.event_date)) continue;
    const eventDate = row.event_date;
    const baseIntegrity =
      requested.has(row.subject_user_id) && row.subject_user_id.trim().length > 0 &&
      typeof row.event_key === "string" && row.event_key.length > 0 &&
      Number.isSafeInteger(row.recorded_at) && row.recorded_at >= 0 &&
      Number.isSafeInteger(row.completed_at) && row.completed_at >= row.recorded_at &&
      row.completion_roster_recorded_at === row.recorded_at &&
      row.participant_row_count > 0 && row.invalid_participant_count === 0 &&
      row.wrong_participant_revision_count === 0 &&
      eventDate <= jstDateStr(new Date(row.completed_at * 1000));
    if (!baseIntegrity) continue;

    const legacyWithoutRoleProvenance = row.involvement_roster_recorded_at === null && row.role_row_count === 0;
    const exactInvolvementRevision =
      row.involvement_roster_recorded_at === row.recorded_at && row.role_row_count > 0 &&
      row.primary_count === 1 && row.invalid_role_count === 0 && row.invalid_role_user_count === 0 &&
      row.wrong_role_revision_count === 0;
    if (!legacyWithoutRoleProvenance && !exactInvolvementRevision) continue;

    const profile: PublicEventCalendarInvolvementProfile = {
      eventDate,
      generalParticipant: row.general_participant === 1,
      staff: exactInvolvementRevision && row.staff === 1,
      organizer: exactInvolvementRevision && row.organizer === 1,
      primaryOrganizer: exactInvolvementRevision && row.primary_organizer === 1,
    };
    const list = byUser.get(row.subject_user_id);
    if (list) list.push(profile);
    else byUser.set(row.subject_user_id, [profile]);
  }
  return [...byUser].map(([userId, events]) => ({ userId, payload: { events } }));
}
