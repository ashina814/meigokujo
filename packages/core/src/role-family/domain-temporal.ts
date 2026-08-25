import type Database from "better-sqlite3";
import { ROLE_FAMILY_TAGS, type RoleFamilyTag } from "./temporal.js";

export interface TrustedRoleFamilyInterval {
  /** Restricted semantic identity. Domain safe payloads must never expose it. */
  readonly familyKey: string;
  readonly start: number;
  readonly end: number;
}

export interface TrustedEligiblePublicRoleContext extends TrustedRoleFamilyInterval {
  /** Restricted assignment taxonomy. Safe payloads expose only classified Castle families. */
  readonly assignedFamilies: readonly string[];
}

const SESSION_END_QUALITIES = new Set([
  "disconnect",
  "guild_unavailable",
  "guild_delete",
  "manifest_change",
  "shutdown",
  "crash_recovered",
]);
const PRESENCE_END_REASONS = new Set([
  "role_removed",
  "member_unknown",
  "member_left",
  ...SESSION_END_QUALITIES,
  "session_replaced",
]);

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

/**
 * F3aのimmutable manifest revision + trusted observation coverageだけから、要求domain
 * tagのknown role intervalsを読むrestricted helper。current Discord role/current
 * departmentsは参照しない。transition secondは順序不明なのでstartを1秒後へ送る。
 */
export function loadTrustedRoleFamilyIntervals(
  db: Database.Database,
  userIds: readonly string[],
  domainTag: RoleFamilyTag,
  window: { readonly start: number; readonly end: number },
): ReadonlyMap<string, readonly TrustedRoleFamilyInterval[]> {
  const requested = new Set(userIds.filter(nonEmpty));
  const result = new Map<string, readonly TrustedRoleFamilyInterval[]>();
  for (const userId of userIds) result.set(userId, []);
  if (requested.size === 0 || window.end <= window.start) return result;

  // A role mapped to multiple semantic families makes the whole revision ambiguous. This is
  // rejected on normal writes too; the check here keeps direct/corrupt DB mutation fail-closed.
  const roleRows = db.prepare(
    `SELECT r.id AS revision_id, mr.role_id, mr.family_key
       FROM role_family_manifest_revisions r
       JOIN role_family_manifest_roles mr ON mr.revision_id = r.id
      WHERE r.activated_at < ?
      ORDER BY r.id, mr.role_id, mr.family_key`,
  ).all(window.end) as Array<{ revision_id: unknown; role_id: unknown; family_key: unknown }>;
  const invalidRevisions = new Set<number>();
  const ownerByRevisionRole = new Map<string, string>();
  for (const row of roleRows) {
    if (!safeInteger(row.revision_id) || !nonEmpty(row.role_id) || !nonEmpty(row.family_key)) {
      if (safeInteger(row.revision_id)) invalidRevisions.add(row.revision_id);
      continue;
    }
    const key = `${row.revision_id}\u0000${row.role_id}`;
    const owner = ownerByRevisionRole.get(key);
    if (owner && owner !== row.family_key) invalidRevisions.add(row.revision_id);
    ownerByRevisionRole.set(key, row.family_key);
  }

  const placeholders = [...requested].map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT p.id, p.guild_id, p.session_id, p.manifest_revision_id, p.user_id,
            p.family_key, p.started_at, p.ended_at, p.end_reason,
            s.guild_id AS session_guild_id, s.manifest_revision_id AS session_revision_id,
            s.started_at AS session_started_at, s.last_checkpoint_at,
            s.ended_at AS session_ended_at, s.end_quality,
            r.guild_id AS revision_guild_id, r.activated_at,
            tag.tag AS domain_tag,
            (SELECT COUNT(*) FROM role_family_manifest_roles mr
              WHERE mr.revision_id = p.manifest_revision_id
                AND mr.family_key = p.family_key) AS mapped_roles
       FROM role_family_member_presence p
       JOIN role_observation_sessions s ON s.id = p.session_id
       JOIN role_family_manifest_revisions r ON r.id = p.manifest_revision_id
       JOIN role_family_manifest_family_tags tag
         ON tag.revision_id = p.manifest_revision_id
        AND tag.family_key = p.family_key
        AND tag.tag = ?
      WHERE p.user_id IN (${placeholders})
        AND p.started_at < ?
      ORDER BY p.user_id, p.started_at, p.id`,
  ).all(domainTag, ...requested, window.end) as Array<Record<string, unknown>>;

  const byUser = new Map<string, TrustedRoleFamilyInterval[]>();
  const corruptUsers = new Set<string>();
  for (const row of rows) {
    const userId = row.user_id;
    if (!nonEmpty(userId) || !requested.has(userId)) continue;
    const revisionId = row.manifest_revision_id;
    const startedAt = row.started_at;
    const endedAt = row.ended_at;
    const sessionEndedAt = row.session_ended_at;
    const lastCheckpointAt = row.last_checkpoint_at;
    const coverageEnd = sessionEndedAt ?? lastCheckpointAt;
    const validSessionEnd =
      (sessionEndedAt === null && row.end_quality === null)
      || (safeInteger(sessionEndedAt)
        && typeof row.end_quality === "string"
        && SESSION_END_QUALITIES.has(row.end_quality));
    const validPresenceEnd =
      (endedAt === null && row.end_reason === null)
      || (safeInteger(endedAt)
        && typeof row.end_reason === "string"
        && PRESENCE_END_REASONS.has(row.end_reason));
    const valid =
      safeInteger(row.id) && safeInteger(row.session_id) && safeInteger(revisionId)
      && !invalidRevisions.has(revisionId)
      && nonEmpty(row.guild_id)
      && row.guild_id === row.session_guild_id
      && row.guild_id === row.revision_guild_id
      && row.session_revision_id === revisionId
      && nonEmpty(row.family_key)
      && row.domain_tag === domainTag
      && safeInteger(startedAt)
      && safeInteger(row.session_started_at)
      && safeInteger(row.activated_at)
      && (row.session_started_at as number) >= (row.activated_at as number)
      && startedAt >= (row.session_started_at as number)
      && startedAt >= (row.activated_at as number)
      && safeInteger(lastCheckpointAt)
      && lastCheckpointAt >= (row.session_started_at as number)
      && validSessionEnd
      && validPresenceEnd
      && safeInteger(coverageEnd)
      && (sessionEndedAt === null || lastCheckpointAt >= sessionEndedAt)
      && (row.mapped_roles as number) > 0
      && coverageEnd >= startedAt
      && (endedAt === null || (endedAt as number) <= coverageEnd);
    if (!valid) {
      corruptUsers.add(userId);
      continue;
    }

    const knownStart = Math.max(window.start, (startedAt as number) + 1);
    const knownEnd = Math.min(window.end, (endedAt ?? coverageEnd) as number);
    if (knownEnd <= knownStart) continue;
    const intervals = byUser.get(userId);
    const interval = { familyKey: row.family_key as string, start: knownStart, end: knownEnd };
    if (intervals) intervals.push(interval);
    else byUser.set(userId, [interval]);
  }

  for (const userId of requested) {
    if (corruptUsers.has(userId)) {
      result.set(userId, []);
      continue;
    }
    const intervals = (byUser.get(userId) ?? []).sort((a, b) =>
      a.familyKey.localeCompare(b.familyKey) || a.start - b.start || a.end - b.end,
    );
    const merged: TrustedRoleFamilyInterval[] = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous?.familyKey === interval.familyKey && interval.start <= previous.end) {
        merged[merged.length - 1] = {
          familyKey: previous.familyKey,
          start: previous.start,
          end: Math.max(previous.end, interval.end),
        };
      } else merged.push(interval);
    }
    result.set(userId, merged);
  }
  return result;
}

/**
 * 同一immutable revision / 同一role familyにpublic_departmentとbridge可能domain tagが
 * 共存する場合だけeligibleにするbulk restricted loader。別familyのtagは合成しない。
 */
export function loadTrustedEligiblePublicRoleContexts(
  db: Database.Database,
  userIds: readonly string[],
  assignments: readonly { readonly sourceTag: RoleFamilyTag; readonly targetFamily: string }[],
  window: { readonly start: number; readonly end: number },
): ReadonlyMap<string, readonly TrustedEligiblePublicRoleContext[]> {
  const requested = new Set(userIds.filter(nonEmpty));
  const result = new Map<string, readonly TrustedEligiblePublicRoleContext[]>();
  for (const userId of userIds) result.set(userId, []);
  if (requested.size === 0 || window.end <= window.start) return result;

  const bridge = new Map<RoleFamilyTag, string>();
  for (const assignment of assignments) {
    if (assignment.sourceTag === "public_department" || bridge.has(assignment.sourceTag) || !nonEmpty(assignment.targetFamily)) {
      throw new TypeError("invalid eligible public role assignment bridge");
    }
    bridge.set(assignment.sourceTag, assignment.targetFamily);
  }

  const invalidRevisions = new Set<number>();
  const ownerByRevisionRole = new Map<string, string>();
  const roleRows = db.prepare(
    `SELECT r.id AS revision_id, mr.role_id, mr.family_key
       FROM role_family_manifest_revisions r
       JOIN role_family_manifest_roles mr ON mr.revision_id = r.id
      WHERE r.activated_at < ?
      ORDER BY r.id, mr.role_id, mr.family_key`,
  ).all(window.end) as Array<{ revision_id: unknown; role_id: unknown; family_key: unknown }>;
  for (const row of roleRows) {
    if (!safeInteger(row.revision_id) || !nonEmpty(row.role_id) || !nonEmpty(row.family_key)) {
      if (safeInteger(row.revision_id)) invalidRevisions.add(row.revision_id);
      continue;
    }
    const key = `${row.revision_id}\u0000${row.role_id}`;
    const owner = ownerByRevisionRole.get(key);
    if (owner && owner !== row.family_key) invalidRevisions.add(row.revision_id);
    ownerByRevisionRole.set(key, row.family_key);
  }

  const familyRows = db.prepare(
    `SELECT r.id AS revision_id, f.family_key, t.tag,
            (SELECT COUNT(*) FROM role_family_manifest_roles mr
              WHERE mr.revision_id = r.id AND mr.family_key = f.family_key) AS mapped_roles
       FROM role_family_manifest_revisions r
       JOIN role_family_manifest_families f ON f.revision_id = r.id
       LEFT JOIN role_family_manifest_family_tags t
         ON t.revision_id = r.id AND t.family_key = f.family_key
      WHERE r.activated_at < ?
      ORDER BY r.id, f.family_key, t.tag`,
  ).all(window.end) as Array<Record<string, unknown>>;
  const tagsByFamily = new Map<string, Set<RoleFamilyTag>>();
  for (const row of familyRows) {
    const revisionId = row.revision_id;
    if (!safeInteger(revisionId) || !nonEmpty(row.family_key) || !safeInteger(row.mapped_roles) || row.mapped_roles === 0) {
      if (safeInteger(revisionId)) invalidRevisions.add(revisionId);
      continue;
    }
    const key = `${revisionId}\u0000${row.family_key}`;
    const tags = tagsByFamily.get(key) ?? new Set<RoleFamilyTag>();
    if (row.tag !== null) {
      if (!nonEmpty(row.tag) || !(ROLE_FAMILY_TAGS as readonly string[]).includes(row.tag)) {
        invalidRevisions.add(revisionId);
        continue;
      }
      tags.add(row.tag as RoleFamilyTag);
    }
    tagsByFamily.set(key, tags);
  }
  const eligibleByFamily = new Map<string, readonly string[]>();
  for (const [key, tags] of tagsByFamily) {
    if (!tags.has("public_department")) continue;
    const assigned = [...new Set([...tags].flatMap((tag) => bridge.get(tag) ?? []))].sort();
    if (assigned.length > 0) eligibleByFamily.set(key, assigned);
  }

  const placeholders = [...requested].map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT p.id, p.guild_id, p.session_id, p.manifest_revision_id, p.user_id,
            p.family_key, p.started_at, p.ended_at, p.end_reason,
            s.guild_id AS session_guild_id, s.manifest_revision_id AS session_revision_id,
            s.started_at AS session_started_at, s.last_checkpoint_at,
            s.ended_at AS session_ended_at, s.end_quality,
            r.guild_id AS revision_guild_id, r.activated_at
       FROM role_family_member_presence p
       JOIN role_observation_sessions s ON s.id = p.session_id
       JOIN role_family_manifest_revisions r ON r.id = p.manifest_revision_id
      WHERE p.user_id IN (${placeholders}) AND p.started_at < ?
      ORDER BY p.user_id, p.started_at, p.id`,
  ).all(...requested, window.end) as Array<Record<string, unknown>>;
  const byUser = new Map<string, TrustedEligiblePublicRoleContext[]>();
  const corruptUsers = new Set<string>();
  for (const row of rows) {
    const userId = row.user_id;
    if (!nonEmpty(userId) || !requested.has(userId)) continue;
    const revisionId = row.manifest_revision_id;
    const familyKey = row.family_key;
    const startedAt = row.started_at;
    const endedAt = row.ended_at;
    const sessionEndedAt = row.session_ended_at;
    const lastCheckpointAt = row.last_checkpoint_at;
    const coverageEnd = sessionEndedAt ?? lastCheckpointAt;
    const validSessionEnd =
      (sessionEndedAt === null && row.end_quality === null)
      || (safeInteger(sessionEndedAt) && typeof row.end_quality === "string" && SESSION_END_QUALITIES.has(row.end_quality));
    const validPresenceEnd =
      (endedAt === null && row.end_reason === null)
      || (safeInteger(endedAt) && typeof row.end_reason === "string" && PRESENCE_END_REASONS.has(row.end_reason));
    const valid =
      safeInteger(row.id) && safeInteger(row.session_id) && safeInteger(revisionId)
      && !invalidRevisions.has(revisionId)
      && nonEmpty(row.guild_id) && row.guild_id === row.session_guild_id && row.guild_id === row.revision_guild_id
      && row.session_revision_id === revisionId
      && nonEmpty(familyKey) && tagsByFamily.has(`${revisionId}\u0000${familyKey}`)
      && safeInteger(startedAt) && safeInteger(row.session_started_at) && safeInteger(row.activated_at)
      && row.session_started_at >= row.activated_at && startedAt >= row.session_started_at && startedAt >= row.activated_at
      && safeInteger(lastCheckpointAt) && lastCheckpointAt >= row.session_started_at
      && validSessionEnd && validPresenceEnd && safeInteger(coverageEnd)
      && (sessionEndedAt === null || lastCheckpointAt >= sessionEndedAt)
      && coverageEnd >= startedAt && (endedAt === null || endedAt <= coverageEnd);
    if (!valid) {
      corruptUsers.add(userId);
      continue;
    }
    const assignedFamilies = eligibleByFamily.get(`${revisionId}\u0000${familyKey}`);
    if (!assignedFamilies) continue;
    const start = Math.max(window.start, startedAt + 1);
    const end = Math.min(window.end, (endedAt ?? coverageEnd) as number);
    if (end <= start) continue;
    const list = byUser.get(userId) ?? [];
    list.push({ familyKey, start, end, assignedFamilies });
    byUser.set(userId, list);
  }

  for (const userId of requested) {
    if (corruptUsers.has(userId)) {
      result.set(userId, []);
      continue;
    }
    const ordered = (byUser.get(userId) ?? []).sort((a, b) =>
      a.familyKey.localeCompare(b.familyKey)
      || a.assignedFamilies.join("\u0000").localeCompare(b.assignedFamilies.join("\u0000"))
      || a.start - b.start || a.end - b.end);
    const merged: TrustedEligiblePublicRoleContext[] = [];
    for (const interval of ordered) {
      const previous = merged.at(-1);
      if (previous?.familyKey === interval.familyKey
        && previous.assignedFamilies.join("\u0000") === interval.assignedFamilies.join("\u0000")
        && interval.start <= previous.end) {
        merged[merged.length - 1] = { ...previous, end: Math.max(previous.end, interval.end) };
      } else merged.push(interval);
    }
    result.set(userId, merged);
  }
  return result;
}

/** Point occurrences use the already-fenced [start,end) intervals without another +/-1. */
export function pointInTrustedRoleFamilyInterval(
  intervals: readonly TrustedRoleFamilyInterval[],
  occurredAt: number,
): boolean {
  return safeInteger(occurredAt) && intervals.some((interval) => interval.start <= occurredAt && occurredAt < interval.end);
}

/** Interval activities only retain positive-duration overlap with trusted role coverage. */
export function intersectTrustedRoleFamilyIntervals(
  intervals: readonly TrustedRoleFamilyInterval[],
  activityStart: number,
  activityEnd: number,
): readonly TrustedRoleFamilyInterval[] {
  if (!safeInteger(activityStart) || !safeInteger(activityEnd) || activityEnd <= activityStart) return [];
  return intervals.flatMap((interval) => {
    const start = Math.max(interval.start, activityStart);
    const end = Math.min(interval.end, activityEnd);
    return end > start ? [{ familyKey: interval.familyKey, start, end }] : [];
  });
}
