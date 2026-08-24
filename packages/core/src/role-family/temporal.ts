import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const ROLE_FAMILY_TAGS = ["public_department", "inn", "economy", "shop", "casino"] as const;
export type RoleFamilyTag = (typeof ROLE_FAMILY_TAGS)[number];

export interface RoleFamilyManifestFamily {
  readonly familyKey: string;
  readonly roleIds: readonly string[];
  readonly tags: readonly RoleFamilyTag[];
}

export interface RoleFamilyManifest {
  readonly provenance: "departments_snapshot" | "explicit_manifest";
  readonly families: readonly RoleFamilyManifestFamily[];
}

export interface RoleFamilyObservedMember {
  readonly userId: string;
  readonly roleIds: readonly string[];
  readonly bot: boolean;
}

/**
 * Domain tags backed by actual production authorization checks.
 *
 * `冥界商館` is the exact department key used by `/商館`'s canOperate() permission
 * boundary. No inn/economy/casino mapping is inferred from department/role names or
 * notification/benefit role slots.
 */
export const CANONICAL_DEPARTMENT_DOMAIN_TAGS: Readonly<Record<string, readonly RoleFamilyTag[]>> = Object.freeze({
  "冥界商館": Object.freeze(["shop"] as const),
});

export type RoleObservationEndQuality =
  | "disconnect"
  | "guild_unavailable"
  | "guild_delete"
  | "manifest_change"
  | "shutdown"
  | "crash_recovered";

type PresenceEndReason = RoleObservationEndQuality | "role_removed" | "member_unknown" | "member_left" | "session_replaced";

interface CanonicalManifest {
  readonly provenance: RoleFamilyManifest["provenance"];
  readonly families: readonly {
    readonly familyKey: string;
    readonly roleIds: readonly string[];
    readonly tags: readonly RoleFamilyTag[];
  }[];
  readonly fingerprint: string;
}

function requireId(value: string, label: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id !== value) throw new TypeError(`${label} must be a non-empty trimmed string`);
  return id;
}

function requireObservedAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("observedAt must be a non-negative safe integer");
  return value;
}

function canonicalManifest(input: RoleFamilyManifest): CanonicalManifest {
  if (input.provenance !== "departments_snapshot" && input.provenance !== "explicit_manifest") {
    throw new TypeError("invalid role-family manifest provenance");
  }
  const seenFamilies = new Set<string>();
  const roleOwner = new Map<string, string>();
  const tagSet = new Set<string>(ROLE_FAMILY_TAGS);
  const families = input.families.map((family) => {
    const familyKey = requireId(family.familyKey, "familyKey");
    if (seenFamilies.has(familyKey)) throw new TypeError(`duplicate role-family ${familyKey}`);
    seenFamilies.add(familyKey);
    const roleIds = [...new Set(family.roleIds.map((roleId) => requireId(roleId, "roleId")))].sort();
    if (roleIds.length === 0) throw new TypeError(`role-family ${familyKey} must contain at least one role`);
    for (const roleId of roleIds) {
      const owner = roleOwner.get(roleId);
      if (owner && owner !== familyKey) {
        throw new TypeError(`role ${roleId} belongs to multiple semantic families (${owner}, ${familyKey})`);
      }
      roleOwner.set(roleId, familyKey);
    }
    const tags = [...new Set(family.tags)].sort() as RoleFamilyTag[];
    if (tags.some((tag) => !tagSet.has(tag))) throw new TypeError(`role-family ${familyKey} has an invalid tag`);
    return { familyKey, roleIds, tags };
  }).sort((a, b) => a.familyKey.localeCompare(b.familyKey));
  const canonical = JSON.stringify({ provenance: input.provenance, families });
  return {
    provenance: input.provenance,
    families,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}

/**
 * `departments` is the existing canonical department↔Discord-role mapping. F3a snapshots that
 * mapping without inferring anything from department names. Only mappings backed by an actual
 * production authorization boundary receive a domain tag; all rows remain public departments.
 */
export function buildPublicDepartmentRoleFamilyManifest(db: Database.Database): RoleFamilyManifest {
  const rows = db.prepare(
    `SELECT key, role_id FROM departments
      WHERE role_id IS NOT NULL AND length(trim(role_id)) > 0
      ORDER BY key`,
  ).all() as Array<{ key: string; role_id: string }>;
  return {
    provenance: "departments_snapshot",
    families: rows.map((row) => ({
      familyKey: `department:${requireId(row.key, "department key")}`,
      roleIds: [requireId(row.role_id, "department roleId")],
      tags: ["public_department", ...(CANONICAL_DEPARTMENT_DOMAIN_TAGS[row.key] ?? [])],
    })),
  };
}

function familySetForRoles(
  db: Database.Database,
  revisionId: number,
  roleIds: readonly string[],
): Set<string> {
  const roles = new Set(roleIds.map((roleId) => requireId(roleId, "member roleId")));
  if (roles.size === 0) return new Set();
  const rows = db.prepare(
    `SELECT family_key, role_id
       FROM role_family_manifest_roles
      WHERE revision_id = ?
      ORDER BY family_key, role_id`,
  ).all(revisionId) as Array<{ family_key: string; role_id: string }>;
  return new Set(rows.filter((row) => roles.has(row.role_id)).map((row) => row.family_key));
}

/**
 * departments.role_idのcanonical mappingが変わった瞬間に全open coverageを閉じる。
 * Discordのfresh full snapshotが完了するまでUNKNOWNなので、旧manifestを現在へ延長しない。
 */
export function invalidateRoleObservationCoverageForManifestChange(
  db: Database.Database,
  observedAtInput: number,
): number {
  const observedAt = requireObservedAt(observedAtInput);
  const sessions = db.prepare(
    `SELECT id, guild_id, started_at FROM role_observation_sessions WHERE ended_at IS NULL`,
  ).all() as Array<{ id: number; guild_id: string; started_at: number }>;
  const invalidate = db.transaction(() => {
    for (const session of sessions) {
      const endedAt = Math.max(session.started_at, observedAt);
      db.prepare(
        `UPDATE role_family_member_presence
            SET ended_at = CASE WHEN started_at > ? THEN started_at ELSE ? END,
                end_reason = 'manifest_change'
          WHERE session_id = ? AND ended_at IS NULL`,
      ).run(endedAt, endedAt, session.id);
      db.prepare(
        `UPDATE role_observation_sessions
            SET last_checkpoint_at = CASE WHEN last_checkpoint_at > ? THEN last_checkpoint_at ELSE ? END,
                ended_at = ?, end_quality = 'manifest_change'
          WHERE id = ? AND ended_at IS NULL`,
      ).run(endedAt, endedAt, endedAt, session.id);
    }
  });
  invalidate.immediate();
  return sessions.length;
}

/** Neutral trusted role-at-time infrastructure. It never reads current roles during title evaluation. */
export class RoleFamilyTemporal {
  constructor(private readonly db: Database.Database) {}

  latestRevision(guildId: string): { id: number; fingerprint: string; activatedAt: number } | null {
    const row = this.db.prepare(
      `SELECT id, fingerprint, activated_at
         FROM role_family_manifest_revisions
        WHERE guild_id = ?
        ORDER BY activated_at DESC, id DESC LIMIT 1`,
    ).get(requireId(guildId, "guildId")) as { id: number; fingerprint: string; activated_at: number } | undefined;
    return row ? { id: row.id, fingerprint: row.fingerprint, activatedAt: row.activated_at } : null;
  }

  activateManifest(
    guildIdInput: string,
    manifestInput: RoleFamilyManifest,
    observedAtInput: number,
  ): { revisionId: number; changed: boolean; fingerprint: string } {
    const guildId = requireId(guildIdInput, "guildId");
    const observedAt = requireObservedAt(observedAtInput);
    const manifest = canonicalManifest(manifestInput);
    const latest = this.latestRevision(guildId);
    if (latest?.fingerprint === manifest.fingerprint) {
      return { revisionId: latest.id, changed: false, fingerprint: manifest.fingerprint };
    }
    const write = this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT INTO role_family_manifest_revisions
           (guild_id, activated_at, fingerprint, provenance)
         VALUES (?, ?, ?, ?)`,
      ).run(guildId, observedAt, manifest.fingerprint, manifest.provenance);
      const revisionId = Number(result.lastInsertRowid);
      const insertFamily = this.db.prepare(
        `INSERT INTO role_family_manifest_families (revision_id, family_key) VALUES (?, ?)`,
      );
      const insertRole = this.db.prepare(
        `INSERT INTO role_family_manifest_roles (revision_id, family_key, role_id) VALUES (?, ?, ?)`,
      );
      const insertTag = this.db.prepare(
        `INSERT INTO role_family_manifest_family_tags (revision_id, family_key, tag) VALUES (?, ?, ?)`,
      );
      for (const family of manifest.families) {
        insertFamily.run(revisionId, family.familyKey);
        for (const roleId of family.roleIds) insertRole.run(revisionId, family.familyKey, roleId);
        for (const tag of family.tags) insertTag.run(revisionId, family.familyKey, tag);
      }
      return revisionId;
    });
    const revisionId = write.immediate();
    return { revisionId, changed: true, fingerprint: manifest.fingerprint };
  }

  private closeOpenSession(
    guildId: string,
    endedAt: number,
    quality: RoleObservationEndQuality,
    presenceReason: PresenceEndReason = quality,
  ): boolean {
    const session = this.db.prepare(
      `SELECT id, started_at FROM role_observation_sessions
        WHERE guild_id = ? AND ended_at IS NULL`,
    ).get(guildId) as { id: number; started_at: number } | undefined;
    if (!session) return false;
    const safeEnd = Math.max(session.started_at, endedAt);
    const close = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE role_family_member_presence
            SET ended_at = CASE WHEN started_at > ? THEN started_at ELSE ? END,
                end_reason = ?
          WHERE guild_id = ? AND ended_at IS NULL`,
      ).run(safeEnd, safeEnd, presenceReason, guildId);
      this.db.prepare(
        `UPDATE role_observation_sessions
            SET last_checkpoint_at = CASE WHEN last_checkpoint_at > ? THEN last_checkpoint_at ELSE ? END,
                ended_at = ?, end_quality = ?
          WHERE id = ? AND ended_at IS NULL`,
      ).run(safeEnd, safeEnd, safeEnd, quality, session.id);
    });
    close.immediate();
    return true;
  }

  /** Previous-process open coverage ends at its persisted checkpoint, never at restart time. */
  recoverDangling(guildIdInput: string): number {
    const guildId = requireId(guildIdInput, "guildId");
    const sessions = this.db.prepare(
      `SELECT id, started_at, last_checkpoint_at
         FROM role_observation_sessions WHERE guild_id = ? AND ended_at IS NULL`,
    ).all(guildId) as Array<{ id: number; started_at: number; last_checkpoint_at: number }>;
    for (const session of sessions) {
      const trustedEnd = Math.max(session.started_at, session.last_checkpoint_at);
      const close = this.db.transaction(() => {
        this.db.prepare(
          `UPDATE role_family_member_presence
              SET ended_at = CASE WHEN started_at > ? THEN started_at ELSE ? END,
                  end_reason = 'crash_recovered'
            WHERE guild_id = ? AND session_id = ? AND ended_at IS NULL`,
        ).run(trustedEnd, trustedEnd, guildId, session.id);
        this.db.prepare(
          `UPDATE role_observation_sessions
              SET ended_at = ?, end_quality = 'crash_recovered'
            WHERE id = ? AND ended_at IS NULL`,
        ).run(trustedEnd, session.id);
      });
      close.immediate();
    }
    return sessions.length;
  }

  startObservationSession(
    guildIdInput: string,
    manifest: RoleFamilyManifest,
    members: readonly RoleFamilyObservedMember[],
    observedAtInput: number,
  ): { sessionId: number; revisionId: number; manifestChanged: boolean } {
    const guildId = requireId(guildIdInput, "guildId");
    const observedAt = requireObservedAt(observedAtInput);
    const activated = this.activateManifest(guildId, manifest, observedAt);
    this.closeOpenSession(
      guildId,
      observedAt,
      activated.changed ? "manifest_change" : "shutdown",
      activated.changed ? "manifest_change" : "session_replaced",
    );
    const uniqueMembers = new Map<string, RoleFamilyObservedMember>();
    for (const member of members) uniqueMembers.set(requireId(member.userId, "member userId"), member);
    const start = this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT INTO role_observation_sessions
           (guild_id, manifest_revision_id, started_at, last_checkpoint_at)
         VALUES (?, ?, ?, ?)`,
      ).run(guildId, activated.revisionId, observedAt, observedAt);
      const sessionId = Number(result.lastInsertRowid);
      const insertPresence = this.db.prepare(
        `INSERT INTO role_family_member_presence
           (guild_id, session_id, manifest_revision_id, user_id, family_key, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const member of uniqueMembers.values()) {
        if (member.bot) continue;
        for (const familyKey of familySetForRoles(this.db, activated.revisionId, member.roleIds)) {
          insertPresence.run(guildId, sessionId, activated.revisionId, member.userId, familyKey, observedAt);
        }
      }
      return sessionId;
    });
    return { sessionId: start.immediate(), revisionId: activated.revisionId, manifestChanged: activated.changed };
  }

  checkpoint(guildIdInput: string, observedAtInput: number): boolean {
    const guildId = requireId(guildIdInput, "guildId");
    const observedAt = requireObservedAt(observedAtInput);
    return this.db.prepare(
      `UPDATE role_observation_sessions
          SET last_checkpoint_at = ?
        WHERE guild_id = ? AND ended_at IS NULL AND last_checkpoint_at <= ?`,
    ).run(observedAt, guildId, observedAt).changes > 0;
  }

  suspendGuild(guildIdInput: string, observedAtInput: number, quality: RoleObservationEndQuality): boolean {
    const guildId = requireId(guildIdInput, "guildId");
    return this.closeOpenSession(guildId, requireObservedAt(observedAtInput), quality);
  }

  invalidateManifest(guildId: string, observedAt: number): boolean {
    return this.suspendGuild(guildId, observedAt, "manifest_change");
  }

  observeMemberSnapshot(
    guildIdInput: string,
    member: RoleFamilyObservedMember,
    observedAtInput: number,
  ): boolean {
    const guildId = requireId(guildIdInput, "guildId");
    const userId = requireId(member.userId, "member userId");
    const observedAt = requireObservedAt(observedAtInput);
    const session = this.db.prepare(
      `SELECT id, manifest_revision_id, started_at
         FROM role_observation_sessions
        WHERE guild_id = ? AND ended_at IS NULL`,
    ).get(guildId) as { id: number; manifest_revision_id: number; started_at: number } | undefined;
    if (!session || observedAt < session.started_at) return false;
    const nextFamilies = member.bot ? new Set<string>() : familySetForRoles(this.db, session.manifest_revision_id, member.roleIds);
    const current = this.db.prepare(
      `SELECT id, family_key FROM role_family_member_presence
        WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL`,
    ).all(guildId, userId) as Array<{ id: number; family_key: string }>;
    const currentFamilies = new Set(current.map((row) => row.family_key));
    const change = this.db.transaction(() => {
      const close = this.db.prepare(
        `UPDATE role_family_member_presence
            SET ended_at = ?, end_reason = ?
          WHERE id = ? AND ended_at IS NULL`,
      );
      for (const row of current) {
        if (!nextFamilies.has(row.family_key)) close.run(observedAt, member.bot ? "member_unknown" : "role_removed", row.id);
      }
      const insert = this.db.prepare(
        `INSERT INTO role_family_member_presence
           (guild_id, session_id, manifest_revision_id, user_id, family_key, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const familyKey of nextFamilies) {
        if (!currentFamilies.has(familyKey)) {
          insert.run(guildId, session.id, session.manifest_revision_id, userId, familyKey, observedAt);
        }
      }
      this.db.prepare(
        `UPDATE role_observation_sessions SET last_checkpoint_at = ?
          WHERE id = ? AND last_checkpoint_at <= ?`,
      ).run(observedAt, session.id, observedAt);
    });
    change.immediate();
    return true;
  }

  markMemberUnknown(guildIdInput: string, userIdInput: string, observedAtInput: number): boolean {
    const guildId = requireId(guildIdInput, "guildId");
    const userId = requireId(userIdInput, "userId");
    const observedAt = requireObservedAt(observedAtInput);
    const change = this.db.transaction(() => {
      const closed = this.db.prepare(
        `UPDATE role_family_member_presence
            SET ended_at = ?, end_reason = 'member_unknown'
          WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL`,
      ).run(observedAt, guildId, userId).changes;
      this.db.prepare(
        `UPDATE role_observation_sessions SET last_checkpoint_at = ?
          WHERE guild_id = ? AND ended_at IS NULL AND last_checkpoint_at <= ?`,
      ).run(observedAt, guildId, observedAt);
      return closed;
    });
    return change.immediate() > 0;
  }

  removeMember(guildIdInput: string, userIdInput: string, observedAtInput: number): boolean {
    const guildId = requireId(guildIdInput, "guildId");
    const userId = requireId(userIdInput, "userId");
    const observedAt = requireObservedAt(observedAtInput);
    const change = this.db.transaction(() => {
      const closed = this.db.prepare(
        `UPDATE role_family_member_presence
            SET ended_at = ?, end_reason = 'member_left'
          WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL`,
      ).run(observedAt, guildId, userId).changes;
      this.db.prepare(
        `UPDATE role_observation_sessions SET last_checkpoint_at = ?
          WHERE guild_id = ? AND ended_at IS NULL AND last_checkpoint_at <= ?`,
      ).run(observedAt, guildId, observedAt);
      return closed;
    });
    return change.immediate() > 0;
  }
}
