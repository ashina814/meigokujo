import type Database from "better-sqlite3";
import { rankTierByKey, rankTiersForTrack, type RankTitleKey, type RankTrack } from "../rank/tiers.js";

/**
 * Rank title unlock / Profile Identity 3-slot persistence（PR B3）。
 *
 * 現在の文位・声位（`RankTier`）へstable identity keyを与え、一度到達した位名を
 * 永久unlockとして保存する（`rank_title_unlocks`）。印（v2 title ownership）と
 * 位名（rank title unlock）を同じ3枠へ装備できるようにする（`profile_identity_equips`）。
 *
 * **historical reconcile vs live observed transitionの区別（§9）**:
 *
 * - live observed transition（`recordRankTitleTransition()`）: 今まさに観測した
 *   levelの変化。跨いだtierは`unlocked_at = Store clock`（正確な到達時刻として扱える）。
 * - historical reconcile（`reconcileRankTitleUnlocks()`）: 現在levelから逆算して
 *   「過去のいつか到達したはず」のtierを補完する。`unlocked_at = NULL`——
 *   「今Lv75だから過去のLv50到達時刻も今だったことにする」という捏造は絶対にしない。
 *
 * 一度unlockしたら永久。XP低下・rank計算変更等で削除しない。既存のunlock行
 * （`unlocked_at`がNULLであれnon-nullであれ）は、後続のtransition/reconcileで
 * 一切UPDATEしない——first persisted truthをimmutableに保つ。
 */
export const IDENTITY_V2_DDL = `
-- 「一度到達した位名は永久unlock」の正本（PR B3）。unlocked_atは正確な到達時刻を
-- 観測できた場合だけnon-null。recorded_atはBotがこの行を初めて記録した時刻。
CREATE TABLE IF NOT EXISTS rank_title_unlocks (
  user_id         TEXT NOT NULL,
  rank_title_key  TEXT NOT NULL,
  unlocked_at     INTEGER,
  recorded_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, rank_title_key),
  CHECK (unlocked_at IS NULL OR unlocked_at >= 0),
  CHECK (recorded_at >= 0),
  CHECK (unlocked_at IS NULL OR unlocked_at <= recorded_at)
);

-- 印（title）と位名（rank_title）を共通の3枠へ装備する正本（PR B3）。旧
-- title_equips（scope-bound）とは別の正本——今回のPRでは自動migrationしない。
CREATE TABLE IF NOT EXISTS profile_identity_equips (
  user_id         TEXT NOT NULL,
  slot            INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  identity_kind   TEXT NOT NULL CHECK (identity_kind IN ('title', 'rank_title')),
  title_key       TEXT,
  rank_title_key  TEXT,
  PRIMARY KEY (user_id, slot),
  CHECK (
    (identity_kind = 'title' AND title_key IS NOT NULL AND rank_title_key IS NULL)
    OR
    (identity_kind = 'rank_title' AND title_key IS NULL AND rank_title_key IS NOT NULL)
  ),
  FOREIGN KEY (user_id, title_key)
    REFERENCES title_ownerships(user_id, title_key),
  FOREIGN KEY (user_id, rank_title_key)
    REFERENCES rank_title_unlocks(user_id, rank_title_key)
);
-- 同じidentityを複数slotへ重複装備できない（partial unique index。
-- 該当columnがNULLの行はindex対象外になるので、title/rank_titleどちらか
-- 一方だけを見る形で自然に成立する）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_identity_equips_title
  ON profile_identity_equips(user_id, title_key) WHERE title_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_identity_equips_rank_title
  ON profile_identity_equips(user_id, rank_title_key) WHERE rank_title_key IS NOT NULL;
`;

export interface RankTitleUnlockRow {
  readonly userId: string;
  readonly rankTitleKey: RankTitleKey;
  readonly unlockedAt: number | null;
  readonly recordedAt: number;
}

export interface NewlyUnlockedRankTitle {
  readonly rankTitleKey: RankTitleKey;
  readonly unlockedAt: number | null;
  readonly recordedAt: number;
}

export interface RankTitleUnlockResult {
  readonly newlyUnlocked: readonly NewlyUnlockedRankTitle[];
}

export type ProfileIdentity =
  | { readonly kind: "title"; readonly titleKey: `v2.${string}` }
  | { readonly kind: "rank_title"; readonly rankTitleKey: RankTitleKey };

export interface ProfileIdentityEquip {
  readonly userId: string;
  readonly slot: 1 | 2 | 3;
  readonly identity: ProfileIdentity;
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireUnix(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative unix timestamp`);
  return value;
}

function requireLevel(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer level`);
  return value;
}

function requireSlot(slot: number): 1 | 2 | 3 {
  if (slot !== 1 && slot !== 2 && slot !== 3) throw new Error(`slot must be 1..3: ${slot}`);
  return slot;
}

function requireV2TitleKey(key: string): `v2.${string}` {
  const normalized = requireText(key, "titleKey");
  if (!normalized.startsWith("v2.") || normalized.length <= 3) {
    throw new Error(`titleKey must use v2.* namespace: ${normalized}`);
  }
  return normalized as `v2.${string}`;
}

/**
 * `beforeLevel`〜`afterLevel`の間でtierに到達したのに、まだunlock行が無いtierを
 * 埋める共通ロジック。`recordRankTitleTransition()`（beforeLevel !== afterLevel、
 * upward transition限定）と `reconcileRankTitleUnlocks()`
 * （beforeLevel === afterLevel === currentLevel）の両方がこれを使う。
 *
 * - `minLevel <= beforeLevel` のtier: 既に到達していたはずなのに欠けている
 *   ——historical missingとして `unlocked_at = NULL`
 * - `beforeLevel < minLevel <= afterLevel` のtier: 今回のtransitionで初めて
 *   到達した——live crossingとして `unlocked_at = now`
 * - 既にunlock行があるtierは一切UPDATEしない
 */
function applyRankTitleTierUnlocks(
  db: Database.Database,
  clock: () => number,
  userId: string,
  track: RankTrack,
  beforeLevel: number,
  afterLevel: number,
): RankTitleUnlockResult {
  if (db.inTransaction) {
    throw new Error("rank title unlock persistence must start outside an existing transaction");
  }

  if (track !== "text" && track !== "voice") throw new Error(`invalid rank track: ${String(track)}`);
  const tiers = rankTiersForTrack(track);
  const relevant = tiers.filter((t) => t.minLevel <= afterLevel);
  if (relevant.length === 0) return { newlyUnlocked: [] };

  const tx = db.transaction((): RankTitleUnlockResult => {
    const now = requireUnix(clock(), "recordedAt");
    const getExisting = db.prepare(`SELECT 1 FROM rank_title_unlocks WHERE user_id = ? AND rank_title_key = ?`);
    const insert = db.prepare(
      `INSERT INTO rank_title_unlocks (user_id, rank_title_key, unlocked_at, recorded_at) VALUES (?, ?, ?, ?)`,
    );

    const newlyUnlocked: NewlyUnlockedRankTitle[] = [];
    for (const t of relevant) {
      const existing = getExisting.get(userId, t.key);
      if (existing) continue; // 既存unlock行は一切UPDATEしない。

      const unlockedAt = t.minLevel <= beforeLevel ? null : now;
      insert.run(userId, t.key, unlockedAt, now);
      newlyUnlocked.push({ rankTitleKey: t.key, unlockedAt, recordedAt: now });
    }
    return { newlyUnlocked };
  });

  return tx.immediate();
}

/**
 * live observed transition。今まさに観測した`beforeLevel`→`afterLevel`のlevel変化
 * から、跨いだtierをunlockする。caller supplied timestampは禁止——時刻は必ず
 * `clock()`のsnapshot。downward transition（`afterLevel < beforeLevel`）はreject。
 *
 * `beforeLevel=50, afterLevel=75`のようにDBに過去unlock（Lv0/5/15/30/50）が
 * 欠損している場合でも、それらを「今回75になった時刻」にはしない——
 * `minLevel<=beforeLevel`のtierはhistorical missingとして`unlocked_at=NULL`になる。
 */
export function recordRankTitleTransition(
  db: Database.Database,
  clock: () => number,
  userIdRaw: string,
  track: RankTrack,
  beforeLevelRaw: number,
  afterLevelRaw: number,
): RankTitleUnlockResult {
  const userId = requireText(userIdRaw, "userId");
  const beforeLevel = requireLevel(beforeLevelRaw, "beforeLevel");
  const afterLevel = requireLevel(afterLevelRaw, "afterLevel");
  if (afterLevel < beforeLevel) {
    throw new Error(`recordRankTitleTransition: afterLevel (${afterLevel}) cannot be less than beforeLevel (${beforeLevel})`);
  }
  return applyRankTitleTierUnlocks(db, clock, userId, track, beforeLevel, afterLevel);
}

/**
 * historical reconcile / backfill。現在levelから、まだunlock行が無い
 * （`minLevel <= currentLevel`な）tierをすべて`unlocked_at=NULL`で補完する。
 * 既存unlock行は変更しない。`currentLevel`より高い既存unlockがあっても削除しない
 * ——XPが将来下がっても「一度到達した位名」は永久unlockだから。
 */
export function reconcileRankTitleUnlocks(
  db: Database.Database,
  clock: () => number,
  userIdRaw: string,
  track: RankTrack,
  currentLevelRaw: number,
): RankTitleUnlockResult {
  const userId = requireText(userIdRaw, "userId");
  const currentLevel = requireLevel(currentLevelRaw, "currentLevel");
  return applyRankTitleTierUnlocks(db, clock, userId, track, currentLevel, currentLevel);
}

function toRankTitleUnlockRow(row: {
  user_id: string;
  rank_title_key: string;
  unlocked_at: number | null;
  recorded_at: number;
}): RankTitleUnlockRow {
  return {
    userId: row.user_id,
    rankTitleKey: row.rank_title_key as RankTitleKey,
    unlockedAt: row.unlocked_at,
    recordedAt: row.recorded_at,
  };
}

export function hasRankTitleUnlock(db: Database.Database, userIdRaw: string, rankTitleKeyRaw: string): boolean {
  const userId = requireText(userIdRaw, "userId");
  const rankTitleKey = requireText(rankTitleKeyRaw, "rankTitleKey");
  const row = db
    .prepare(`SELECT 1 FROM rank_title_unlocks WHERE user_id = ? AND rank_title_key = ?`)
    .get(userId, rankTitleKey);
  return row !== undefined;
}

export function rankTitleUnlock(db: Database.Database, userIdRaw: string, rankTitleKeyRaw: string): RankTitleUnlockRow | null {
  const userId = requireText(userIdRaw, "userId");
  const rankTitleKey = requireText(rankTitleKeyRaw, "rankTitleKey");
  const row = db
    .prepare(`SELECT user_id, rank_title_key, unlocked_at, recorded_at FROM rank_title_unlocks WHERE user_id = ? AND rank_title_key = ?`)
    .get(userId, rankTitleKey) as
    | { user_id: string; rank_title_key: string; unlocked_at: number | null; recorded_at: number }
    | undefined;
  return row ? toRankTitleUnlockRow(row) : null;
}

export function listRankTitleUnlocks(db: Database.Database, userIdRaw: string): RankTitleUnlockRow[] {
  const userId = requireText(userIdRaw, "userId");
  const rows = db
    .prepare(
      `SELECT user_id, rank_title_key, unlocked_at, recorded_at
         FROM rank_title_unlocks
        WHERE user_id = ?
        ORDER BY recorded_at, rank_title_key`,
    )
    .all(userId) as Array<{ user_id: string; rank_title_key: string; unlocked_at: number | null; recorded_at: number }>;
  return rows.map(toRankTitleUnlockRow);
}

/**
 * `rank_title_unlocks`のsemantic integrityをfail-closedで検証する（`TitleV2Store`
 * construction時）。current rank XP/levelとは一切比較しない——過去にLv100へ到達して
 * 現在Lv50相当へ下がっていても、Lv100位名unlockは正当だから。
 */
export function assertRankTitleUnlockIntegrity(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT user_id, rank_title_key, unlocked_at, recorded_at FROM rank_title_unlocks`)
    .all() as Array<{ user_id: string; rank_title_key: string; unlocked_at: number | null; recorded_at: number }>;
  for (const row of rows) {
    const label = `${row.user_id}/${row.rank_title_key}`;
    if (!rankTierByKey(row.rank_title_key)) {
      throw new Error(`rank title unlock integrity violation: unknown rank_title_key for ${label}`);
    }
    if (row.unlocked_at !== null && (!Number.isInteger(row.unlocked_at) || row.unlocked_at < 0)) {
      throw new Error(`rank title unlock integrity violation: invalid unlocked_at for ${label}`);
    }
    if (!Number.isInteger(row.recorded_at) || row.recorded_at < 0) {
      throw new Error(`rank title unlock integrity violation: invalid recorded_at for ${label}`);
    }
    if (row.unlocked_at !== null && row.unlocked_at > row.recorded_at) {
      throw new Error(`rank title unlock integrity violation: unlocked_at (${row.unlocked_at}) after recorded_at (${row.recorded_at}) for ${label}`);
    }
  }
}

/**
 * identity（title/rank_title）をslot 1..3へ装備する。
 *
 * - title: `title_ownerships`を持っていなければreject。scopeKeyは不要——印の
 *   identityはtitleKeyそのもの。retired titleでも既存holderなら引き続きequip可能
 *   （見る正本は`title_ownerships`だけ、runtime definitionのlifecycleは見ない）。
 * - rank_title: `rank_title_unlocks`を持っていなければreject。現在levelが
 *   `tier.minLevel`を満たしているかは要求しない——正本はunlock済みかどうかだけ。
 *
 * 同じidentityを複数slotへ重複させない: target slotに別identityがあればreplace、
 * 同identityが別slotにあればmove、同identityが既に同slotならidempotent no-op。
 * この一連の操作は単一transactionでatomicに行う。
 */
export function equipIdentity(
  db: Database.Database,
  clock: () => number,
  userIdRaw: string,
  slotRaw: number,
  identity: ProfileIdentity,
): ProfileIdentityEquip {
  const userId = requireText(userIdRaw, "userId");
  const slot = requireSlot(slotRaw);
  void clock; // equip自体はtimestampを持たない（equip操作にrecorded_at等は無い契約）。

  if (identity.kind === "title") {
    const titleKey = requireV2TitleKey(identity.titleKey);
    const owns = db.prepare(`SELECT 1 FROM title_ownerships WHERE user_id = ? AND title_key = ?`).get(userId, titleKey);
    if (!owns) throw new Error(`cannot equip unowned title: ${titleKey}`);
  } else if (identity.kind === "rank_title") {
    const rankTitleKey = requireText(identity.rankTitleKey, "rankTitleKey");
    if (!rankTierByKey(rankTitleKey)) throw new Error(`unknown rank title key: ${rankTitleKey}`);
    const unlocked = db
      .prepare(`SELECT 1 FROM rank_title_unlocks WHERE user_id = ? AND rank_title_key = ?`)
      .get(userId, rankTitleKey);
    if (!unlocked) throw new Error(`cannot equip locked rank title: ${rankTitleKey}`);
  } else {
    throw new Error(`invalid identity kind: ${JSON.stringify(identity)}`);
  }

  if (db.inTransaction) {
    throw new Error("identity equip must start outside an existing transaction");
  }

  const existingAtSlot = getIdentityAtSlot(db, userId, slot);
  if (existingAtSlot && identitiesEqual(existingAtSlot.identity, identity)) {
    return existingAtSlot; // 同identityが既に同slot——idempotent no-op。
  }

  const tx = db.transaction((): ProfileIdentityEquip => {
    db.prepare(`DELETE FROM profile_identity_equips WHERE user_id = ? AND slot = ?`).run(userId, slot);
    if (identity.kind === "title") {
      db.prepare(`DELETE FROM profile_identity_equips WHERE user_id = ? AND title_key = ?`).run(userId, identity.titleKey);
      db.prepare(
        `INSERT INTO profile_identity_equips (user_id, slot, identity_kind, title_key, rank_title_key) VALUES (?, ?, 'title', ?, NULL)`,
      ).run(userId, slot, identity.titleKey);
    } else {
      db.prepare(`DELETE FROM profile_identity_equips WHERE user_id = ? AND rank_title_key = ?`).run(
        userId,
        identity.rankTitleKey,
      );
      db.prepare(
        `INSERT INTO profile_identity_equips (user_id, slot, identity_kind, title_key, rank_title_key) VALUES (?, ?, 'rank_title', NULL, ?)`,
      ).run(userId, slot, identity.rankTitleKey);
    }
    return { userId, slot, identity };
  });

  return tx.immediate();
}

function identitiesEqual(a: ProfileIdentity, b: ProfileIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "title" && b.kind === "title") return a.titleKey === b.titleKey;
  if (a.kind === "rank_title" && b.kind === "rank_title") return a.rankTitleKey === b.rankTitleKey;
  return false;
}

export function unequipIdentity(db: Database.Database, userIdRaw: string, slotRaw: number): void {
  const userId = requireText(userIdRaw, "userId");
  const slot = requireSlot(slotRaw);
  db.prepare(`DELETE FROM profile_identity_equips WHERE user_id = ? AND slot = ?`).run(userId, slot);
}

interface IdentityEquipDbRow {
  user_id: string;
  slot: number;
  identity_kind: "title" | "rank_title";
  title_key: string | null;
  rank_title_key: string | null;
}

function toProfileIdentityEquip(row: IdentityEquipDbRow): ProfileIdentityEquip {
  const slot = requireSlot(row.slot);
  if (row.identity_kind === "title") {
    return { userId: row.user_id, slot, identity: { kind: "title", titleKey: requireV2TitleKey(row.title_key!) } };
  }
  return {
    userId: row.user_id,
    slot,
    identity: { kind: "rank_title", rankTitleKey: row.rank_title_key as RankTitleKey },
  };
}

function getIdentityAtSlot(db: Database.Database, userId: string, slot: number): ProfileIdentityEquip | null {
  const row = db
    .prepare(`SELECT user_id, slot, identity_kind, title_key, rank_title_key FROM profile_identity_equips WHERE user_id = ? AND slot = ?`)
    .get(userId, slot) as IdentityEquipDbRow | undefined;
  return row ? toProfileIdentityEquip(row) : null;
}

export function identityEquip(db: Database.Database, userIdRaw: string, slotRaw: number): ProfileIdentityEquip | null {
  const userId = requireText(userIdRaw, "userId");
  const slot = requireSlot(slotRaw);
  return getIdentityAtSlot(db, userId, slot);
}

export function listIdentityEquips(db: Database.Database, userIdRaw: string): ProfileIdentityEquip[] {
  const userId = requireText(userIdRaw, "userId");
  const rows = db
    .prepare(
      `SELECT user_id, slot, identity_kind, title_key, rank_title_key
         FROM profile_identity_equips
        WHERE user_id = ?
        ORDER BY slot`,
    )
    .all(userId) as IdentityEquipDbRow[];
  return rows.map(toProfileIdentityEquip);
}

/**
 * `profile_identity_equips`のsemantic integrityをfail-closedで検証する（`TitleV2Store`
 * construction時）。既存B1のPRAGMA foreign_key_checkは`title_`prefixのtableだけを
 * filterしていた——`rank_title_unlocks`/`profile_identity_equips`はこのprefixに
 * 当てはまらないため、ここで明示的にJOIN check + `PRAGMA foreign_key_check`
 * （このtableへ絞ったもの）の両方でdangling refを検出する。
 */
export function assertIdentityEquipIntegrity(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT user_id, slot, identity_kind, title_key, rank_title_key FROM profile_identity_equips`)
    .all() as IdentityEquipDbRow[];

  const seenTitles = new Set<string>();
  const seenRankTitles = new Set<string>();
  for (const row of rows) {
    const label = `${row.user_id}/slot${row.slot}`;
    if (!Number.isInteger(row.slot) || row.slot < 1 || row.slot > 3) {
      throw new Error(`identity equip integrity violation: invalid slot for ${label}`);
    }
    if (row.identity_kind === "title") {
      if (row.title_key === null || row.rank_title_key !== null) {
        throw new Error(`identity equip integrity violation: malformed title identity row for ${label}`);
      }
      if (!row.title_key.startsWith("v2.") || row.title_key.length <= 3) {
        throw new Error(`identity equip integrity violation: title_key must use v2.* namespace for ${label}`);
      }
      const owns = db
        .prepare(`SELECT 1 FROM title_ownerships WHERE user_id = ? AND title_key = ?`)
        .get(row.user_id, row.title_key);
      if (!owns) {
        throw new Error(`identity equip integrity violation: ${label} equips title ${row.title_key} without title_ownerships`);
      }
      const dupKey = `${row.user_id}::${row.title_key}`;
      if (seenTitles.has(dupKey)) {
        throw new Error(`identity equip integrity violation: duplicate title identity equip ${row.user_id}/${row.title_key}`);
      }
      seenTitles.add(dupKey);
    } else if (row.identity_kind === "rank_title") {
      if (row.rank_title_key === null || row.title_key !== null) {
        throw new Error(`identity equip integrity violation: malformed rank_title identity row for ${label}`);
      }
      if (!rankTierByKey(row.rank_title_key)) {
        throw new Error(`identity equip integrity violation: unknown rank_title_key for ${label}`);
      }
      const unlocked = db
        .prepare(`SELECT 1 FROM rank_title_unlocks WHERE user_id = ? AND rank_title_key = ?`)
        .get(row.user_id, row.rank_title_key);
      if (!unlocked) {
        throw new Error(
          `identity equip integrity violation: ${label} equips rank title ${row.rank_title_key} without rank_title_unlocks`,
        );
      }
      const dupKey = `${row.user_id}::${row.rank_title_key}`;
      if (seenRankTitles.has(dupKey)) {
        throw new Error(
          `identity equip integrity violation: duplicate rank title identity equip ${row.user_id}/${row.rank_title_key}`,
        );
      }
      seenRankTitles.add(dupKey);
    } else {
      throw new Error(`identity equip integrity violation: invalid identity_kind for ${label}`);
    }
  }

  const fkViolations = db.prepare(`PRAGMA foreign_key_check(profile_identity_equips)`).all() as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  if (fkViolations.length > 0) {
    const first = fkViolations[0]!;
    throw new Error(
      `identity equip integrity violation: foreign_key_check found ${fkViolations.length} violation(s) on ` +
        `profile_identity_equips, e.g. parent=${first.parent}`,
    );
  }
}
