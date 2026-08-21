import type Database from "better-sqlite3";
import { assertSlug, type BehaviorTitleDefinition } from "./v2-contract.js";
import {
  assertNoOverlappingSeriesMembership,
  assertValidSeriesManifest,
  computeSeriesManifestHash,
  type TitleSeriesManifest,
} from "./v2-series.js";

/**
 * Series Manifest / Series Mastery persistence（PR B2）。
 *
 * released seriesのimmutable manifest（`v2-series.ts`）を実際にDBへ保存し、
 * userのseries mastery（一門完遂）をownershipから永続化する。
 *
 * `title_series_manifests` / `title_series_members` はcatalog/seriesKey単位の
 * immutable manifest snapshot——一度registerしたら書き換える公開APIを作らない
 * （書き換えたい場合は新しい (catalog, seriesKey) を使うという既存契約はDB化後も
 * そのまま）。`manifest_hash` は `computeSeriesManifestHash()`（DB member snapshotから
 * 直接再計算できる形）で、後から中身が書き換えられていないかをconstruction-time
 * integrityで検出する。
 *
 * `title_series_masteries.recorded_at` は**達成時刻ではない**——「Botがseries mastery
 * 成立を初めて確認して永続化した時刻」でしかない。member titleの一部が
 * non-orderable（`earnedAt===null`）だったり、historical repairで後から追加された
 * 場合があるため、真の完遂時刻を安全に一意決定できない。将来《一門皆伝》meta title
 * のearnedAtが必要になった場合は、title_awardsから別途proofを組み立てる（このPRの
 * 範囲外）。
 */
export const SERIES_V2_DDL = `
CREATE TABLE IF NOT EXISTS title_series_manifests (
  catalog_key      TEXT NOT NULL,
  series_key       TEXT NOT NULL,
  label_snapshot   TEXT NOT NULL,
  mastery_eligible INTEGER NOT NULL CHECK (mastery_eligible IN (0, 1)),
  manifest_hash    TEXT NOT NULL,
  registered_at    INTEGER NOT NULL,
  PRIMARY KEY (catalog_key, series_key)
);

CREATE TABLE IF NOT EXISTS title_series_members (
  catalog_key TEXT NOT NULL,
  series_key  TEXT NOT NULL,
  title_key   TEXT NOT NULL,
  stage       INTEGER NOT NULL CHECK (stage >= 1),
  PRIMARY KEY (catalog_key, series_key, title_key),
  -- 1 titleはDB上でも複数seriesへ所属できない。
  UNIQUE (title_key),
  UNIQUE (catalog_key, series_key, stage),
  FOREIGN KEY (catalog_key, series_key)
    REFERENCES title_series_manifests(catalog_key, series_key)
);

-- 「userがそのseriesを完遂した事実」。mastered_at/earned_atは持たない
-- ——recorded_atは「Botが初めて確認して永続化した時刻」であって達成時刻ではない
-- （module doc comment参照）。
CREATE TABLE IF NOT EXISTS title_series_masteries (
  user_id     TEXT NOT NULL,
  catalog_key TEXT NOT NULL,
  series_key  TEXT NOT NULL,
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (user_id, catalog_key, series_key),
  FOREIGN KEY (catalog_key, series_key)
    REFERENCES title_series_manifests(catalog_key, series_key)
);
`;

export interface TitleSeriesManifestSummary {
  readonly catalogKey: string;
  readonly seriesKey: string;
  readonly label: string;
  readonly masteryEligible: boolean;
  readonly manifestHash: string;
  readonly registeredAt: number;
  readonly members: ReadonlyArray<{ readonly titleKey: string; readonly stage: number }>;
}

export interface TitleSeriesMasteryRow {
  readonly userId: string;
  readonly catalogKey: string;
  readonly seriesKey: string;
  readonly recordedAt: number;
}

export interface RegisterSeriesManifestsResult {
  readonly registered: ReadonlyArray<{ readonly catalogKey: string; readonly seriesKey: string }>;
  readonly idempotent: ReadonlyArray<{ readonly catalogKey: string; readonly seriesKey: string }>;
}

export interface NewlyMasteredSeries {
  readonly catalogKey: string;
  readonly seriesKey: string;
  readonly memberCount: number;
  readonly recordedAt: number;
}

export interface ReconcileSeriesMasteriesResult {
  readonly newlyMastered: readonly NewlyMasteredSeries[];
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

/**
 * 検証済みmanifestをatomicにDB永続化する。
 *
 * - `assertValidSeriesManifest()` / `assertNoOverlappingSeriesMembership()` を
 *   バッチ全体へ通す（バッチ内だけの検証で終わらせない——後述）。
 * - 既にDBへ登録済みの (catalog, seriesKey) は、semantic hashが一致すれば
 *   idempotent（何もしない）、不一致ならfail-closed（released seriesは書き換えない）。
 * - 新規登録の場合、バッチ**外**（既にDBへ登録済みの他series）とのtitle overlap
 *   も確認する——`assertNoOverlappingSeriesMembership()` は渡された配列内だけしか
 *   見ないため、DB上の既存seriesとの重複はここで別途確認する
 *   （`title_series_members.title_key` のUNIQUE制約が最終防御）。
 * - `registered_at` はStore clockのsnapshot（呼び出し1回につき1回だけ`clock()`を呼ぶ）。
 *   callerが任意timestampを注入できない。
 * - manifest + 全memberをこの呼び出し全体で単一の`BEGIN IMMEDIATE` transaction内に
 *   確定する——manifest insertが成功してもmember insertが失敗すればmanifestごと
 *   rollbackする。
 */
export function registerSeriesManifests(
  db: Database.Database,
  clock: () => number,
  manifests: readonly TitleSeriesManifest[],
  behaviorDefinitions: readonly BehaviorTitleDefinition[],
): RegisterSeriesManifestsResult {
  if (db.inTransaction) {
    throw new Error("series manifest registration must start outside an existing transaction");
  }
  if (manifests.length === 0) {
    throw new Error("registerSeriesManifests: at least one manifest is required");
  }

  for (const manifest of manifests) assertValidSeriesManifest(manifest, behaviorDefinitions);
  assertNoOverlappingSeriesMembership(manifests);

  const byKey = new Map(behaviorDefinitions.map((d) => [d.key, d]));

  const tx = db.transaction((): RegisterSeriesManifestsResult => {
    const registeredAt = requireUnix(clock(), "registeredAt");
    const registered: Array<{ catalogKey: string; seriesKey: string }> = [];
    const idempotent: Array<{ catalogKey: string; seriesKey: string }> = [];

    const getExisting = db.prepare(
      `SELECT manifest_hash FROM title_series_manifests WHERE catalog_key = ? AND series_key = ?`,
    );
    const getOwner = db.prepare(`SELECT catalog_key, series_key FROM title_series_members WHERE title_key = ?`);
    const insertManifest = db.prepare(
      `INSERT INTO title_series_manifests (catalog_key, series_key, label_snapshot, mastery_eligible, manifest_hash, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMember = db.prepare(
      `INSERT INTO title_series_members (catalog_key, series_key, title_key, stage) VALUES (?, ?, ?, ?)`,
    );

    for (const manifest of manifests) {
      const hashInput = {
        catalog: manifest.catalog,
        seriesKey: manifest.seriesKey,
        masteryEligible: manifest.masteryEligible,
        members: manifest.members.map((key) => ({ titleKey: key, stage: byKey.get(key)!.progression!.stage })),
      };
      const hash = computeSeriesManifestHash(hashInput);

      const existing = getExisting.get(manifest.catalog, manifest.seriesKey) as { manifest_hash: string } | undefined;
      if (existing) {
        if (existing.manifest_hash !== hash) {
          throw new Error(
            `series manifest (${manifest.catalog}, ${manifest.seriesKey}) is already registered with a different ` +
              `semantic hash — released series are immutable; use a new (catalog, seriesKey) instead of changing content`,
          );
        }
        idempotent.push({ catalogKey: manifest.catalog, seriesKey: manifest.seriesKey });
        continue;
      }

      // バッチ内の重複はassertNoOverlappingSeriesMembership()が既に見ているが、
      // DBに既に登録済みの他seriesとのoverlapは別途ここで確認する。
      for (const memberKey of manifest.members) {
        const owner = getOwner.get(memberKey) as { catalog_key: string; series_key: string } | undefined;
        if (owner && (owner.catalog_key !== manifest.catalog || owner.series_key !== manifest.seriesKey)) {
          throw new Error(
            `title ${memberKey} already belongs to a different registered series: ${owner.catalog_key}/${owner.series_key}`,
          );
        }
      }

      insertManifest.run(
        manifest.catalog,
        manifest.seriesKey,
        manifest.label,
        manifest.masteryEligible ? 1 : 0,
        hash,
        registeredAt,
      );
      for (const memberKey of manifest.members) {
        const def = byKey.get(memberKey)!;
        insertMember.run(manifest.catalog, manifest.seriesKey, memberKey, def.progression!.stage);
      }
      registered.push({ catalogKey: manifest.catalog, seriesKey: manifest.seriesKey });
    }

    return { registered, idempotent };
  });

  return tx.immediate();
}

/**
 * userの、まだmastery未成立な mastery_eligible=true series を対象に、
 * 全member titleのownershipが揃っているかを確認し、揃っていれば
 * `title_series_masteries` へ永続化する。
 *
 * 既に成立済みのseriesは何もしない（idempotent）。ownershipは永久なので
 * masteryも永久——title lifecycleが後からretiredになってもmasteryを消さない。
 * 新しくseries manifestを登録した時点で既に全member ownership済みのuserは、
 * 後日このreconcileでmastery可能になる。
 */
export function reconcileSeriesMasteriesForUser(
  db: Database.Database,
  clock: () => number,
  userIdRaw: string,
): ReconcileSeriesMasteriesResult {
  if (db.inTransaction) {
    throw new Error("series mastery reconcile must start outside an existing transaction");
  }
  const userId = requireText(userIdRaw, "userId");

  const tx = db.transaction((): ReconcileSeriesMasteriesResult => {
    const candidates = db
      .prepare(
        `SELECT m.catalog_key, m.series_key, m.registered_at, COUNT(sm.title_key) AS member_count,
                SUM(CASE WHEN o.title_key IS NOT NULL THEN 1 ELSE 0 END) AS owned_count,
                MAX(o.first_awarded_at) AS max_first_awarded_at
           FROM title_series_manifests m
           JOIN title_series_members sm ON sm.catalog_key = m.catalog_key AND sm.series_key = m.series_key
           LEFT JOIN title_ownerships o ON o.user_id = ? AND o.title_key = sm.title_key
           LEFT JOIN title_series_masteries tm
             ON tm.user_id = ? AND tm.catalog_key = m.catalog_key AND tm.series_key = m.series_key
          WHERE m.mastery_eligible = 1 AND tm.user_id IS NULL
          GROUP BY m.catalog_key, m.series_key`,
      )
      .all(userId, userId) as Array<{
      catalog_key: string;
      series_key: string;
      registered_at: number;
      member_count: number;
      owned_count: number;
      max_first_awarded_at: number | null;
    }>;

    const eligible = candidates.filter((c) => c.member_count > 0 && c.owned_count === c.member_count);
    if (eligible.length === 0) return { newlyMastered: [] };

    // recorded_atはachievement timeではなく「Botがmasteryを初めてpersistした処理
    // 時刻」——したがって正常状態では必ず、series manifestがregisterされた後、かつ
    // 全member ownershipが成立した後になる。clock snapshotがこれより前なら
    // （clockの逆行・誤ったclock注入等）fail-closedする——historical achievement
    // time（earned_at）とは比較しない。既存の「達成時刻を推測しない」契約を維持する。
    const recordedAt = requireUnix(clock(), "recordedAt");
    for (const c of eligible) {
      const requiredMinAt = Math.max(c.registered_at, c.max_first_awarded_at ?? 0);
      if (recordedAt < requiredMinAt) {
        throw new Error(
          `series mastery chronology violation: recordedAt (${recordedAt}) is before the required minimum ` +
            `(${requiredMinAt} = max(manifest.registered_at=${c.registered_at}, ` +
            `MAX(member ownership.first_awarded_at)=${c.max_first_awarded_at ?? "n/a"})) for ${c.catalog_key}/${c.series_key}`,
        );
      }
    }

    const insert = db.prepare(
      `INSERT INTO title_series_masteries (user_id, catalog_key, series_key, recorded_at) VALUES (?, ?, ?, ?)`,
    );
    const newlyMastered: NewlyMasteredSeries[] = [];
    for (const c of eligible) {
      insert.run(userId, c.catalog_key, c.series_key, recordedAt);
      newlyMastered.push({
        catalogKey: c.catalog_key,
        seriesKey: c.series_key,
        memberCount: c.member_count,
        recordedAt,
      });
    }
    return { newlyMastered };
  });

  return tx.immediate();
}

/**
 * series manifest / mastery の semantic integrity をfail-closedで検証する
 * （`TitleV2Store` construction時に呼ぶ）。
 *
 * - mastery行が参照するmanifestが存在し、`mastery_eligible=1`である
 * - mastery userが実際にそのseriesの全member titleをownershipしている
 * - `recorded_at` が非負整数
 * - 同一titleが複数series memberになっていない（`UNIQUE(title_key)`の
 *   defense-in-depth再確認）
 * - 各seriesのstageが1..N contiguous
 * - 保存済み`manifest_hash`が、DB member snapshotから再計算したhashと一致する
 *   （runtimeのBehaviorTitleDefinition mapを使わず、DBの値だけから再計算できる）
 *
 * 偽mastery/manifestを自動生成して修復しない——欠損・矛盾はfail-closedするだけ。
 */
export function assertSeriesPersistenceIntegrity(db: Database.Database): void {
  const badEligibility = db
    .prepare(
      `SELECT tm.user_id, tm.catalog_key, tm.series_key
         FROM title_series_masteries tm
         JOIN title_series_manifests m ON m.catalog_key = tm.catalog_key AND m.series_key = tm.series_key
        WHERE m.mastery_eligible = 0
        LIMIT 1`,
    )
    .get() as { user_id: string; catalog_key: string; series_key: string } | undefined;
  if (badEligibility) {
    throw new Error(
      `series mastery integrity violation: mastery recorded for a non-mastery-eligible series ` +
        `(${badEligibility.user_id}, ${badEligibility.catalog_key}/${badEligibility.series_key})`,
    );
  }

  const incompleteMastery = db
    .prepare(
      `SELECT tm.user_id, tm.catalog_key, tm.series_key, COUNT(sm.title_key) AS member_count,
              SUM(CASE WHEN o.title_key IS NOT NULL THEN 1 ELSE 0 END) AS owned_count
         FROM title_series_masteries tm
         JOIN title_series_members sm ON sm.catalog_key = tm.catalog_key AND sm.series_key = tm.series_key
         LEFT JOIN title_ownerships o ON o.user_id = tm.user_id AND o.title_key = sm.title_key
        GROUP BY tm.user_id, tm.catalog_key, tm.series_key
       HAVING owned_count < member_count
        LIMIT 1`,
    )
    .get() as { user_id: string; catalog_key: string; series_key: string } | undefined;
  if (incompleteMastery) {
    throw new Error(
      `series mastery integrity violation: mastery recorded for ` +
        `(${incompleteMastery.user_id}, ${incompleteMastery.catalog_key}/${incompleteMastery.series_key}) ` +
        `without owning all series member titles`,
    );
  }

  const masteryRows = db
    .prepare(`SELECT user_id, catalog_key, series_key, recorded_at FROM title_series_masteries`)
    .all() as Array<{ user_id: string; catalog_key: string; series_key: string; recorded_at: number }>;
  for (const row of masteryRows) {
    if (!Number.isInteger(row.recorded_at) || row.recorded_at < 0) {
      throw new Error(
        `series mastery integrity violation: invalid recorded_at for (${row.user_id}, ${row.catalog_key}/${row.series_key})`,
      );
    }
  }

  // recorded_atは「Botがmasteryを初めてpersistした処理時刻」であり、正常状態では
  // 必ずmanifest registrationの後・全member ownership成立の後になる。earned_atとは
  // 比較しない——historical achievement timeを推測しない既存契約を維持する。
  const chronologyRows = db
    .prepare(
      `SELECT tm.user_id, tm.catalog_key, tm.series_key, tm.recorded_at, m.registered_at,
              MAX(o.first_awarded_at) AS max_first_awarded_at
         FROM title_series_masteries tm
         JOIN title_series_manifests m ON m.catalog_key = tm.catalog_key AND m.series_key = tm.series_key
         JOIN title_series_members sm ON sm.catalog_key = tm.catalog_key AND sm.series_key = tm.series_key
         LEFT JOIN title_ownerships o ON o.user_id = tm.user_id AND o.title_key = sm.title_key
        GROUP BY tm.user_id, tm.catalog_key, tm.series_key`,
    )
    .all() as Array<{
    user_id: string;
    catalog_key: string;
    series_key: string;
    recorded_at: number;
    registered_at: number;
    max_first_awarded_at: number | null;
  }>;
  for (const row of chronologyRows) {
    const requiredMinAt = Math.max(row.registered_at, row.max_first_awarded_at ?? 0);
    if (row.recorded_at < requiredMinAt) {
      throw new Error(
        `series mastery integrity violation: recorded_at (${row.recorded_at}) for ` +
          `(${row.user_id}, ${row.catalog_key}/${row.series_key}) is before the required minimum ` +
          `(${requiredMinAt} = max(manifest.registered_at=${row.registered_at}, ` +
          `MAX(member ownership.first_awarded_at)=${row.max_first_awarded_at ?? "n/a"}))`,
      );
    }
  }

  const duplicateTitleOwners = db
    .prepare(`SELECT title_key, COUNT(*) AS n FROM title_series_members GROUP BY title_key HAVING COUNT(*) > 1 LIMIT 1`)
    .get() as { title_key: string; n: number } | undefined;
  if (duplicateTitleOwners) {
    throw new Error(
      `series membership integrity violation: title ${duplicateTitleOwners.title_key} belongs to more than one series row`,
    );
  }

  const stageRows = db
    .prepare(
      `SELECT catalog_key, series_key, COUNT(*) AS member_count, MIN(stage) AS min_stage,
              MAX(stage) AS max_stage, COUNT(DISTINCT stage) AS distinct_stages
         FROM title_series_members
        GROUP BY catalog_key, series_key`,
    )
    .all() as Array<{
    catalog_key: string;
    series_key: string;
    member_count: number;
    min_stage: number;
    max_stage: number;
    distinct_stages: number;
  }>;
  for (const row of stageRows) {
    if (row.distinct_stages !== row.member_count || row.min_stage !== 1 || row.max_stage !== row.member_count) {
      throw new Error(
        `series stage integrity violation: ${row.catalog_key}/${row.series_key} stages are not a contiguous ` +
          `1..N sequence (member_count=${row.member_count}, min=${row.min_stage}, max=${row.max_stage}, distinct=${row.distinct_stages})`,
      );
    }
  }

  const manifestRows = db
    .prepare(`SELECT catalog_key, series_key, mastery_eligible, manifest_hash, registered_at FROM title_series_manifests`)
    .all() as Array<{
    catalog_key: string;
    series_key: string;
    mastery_eligible: number;
    manifest_hash: string;
    registered_at: number;
  }>;
  for (const m of manifestRows) {
    const label = `${m.catalog_key}/${m.series_key}`;
    const fail = (message: string): never => {
      throw new Error(`series manifest integrity violation: ${label}: ${message}`);
    };

    // structural integrity（hashとは独立して再検証する）。runtime definitionsは
    // ここには無いため、title existence / behavior-vs-meta種別 / lifecycle /
    // definition側のcollectionDomainKey一致まではここで証明できない——それは
    // registerSeriesManifests()呼び出し時の`assertValidSeriesManifest()`と
    // `Store`外のcaller責務。
    try {
      assertSlug(m.catalog_key, "catalog_key");
    } catch {
      fail(`catalog_key is not a valid slug: ${JSON.stringify(m.catalog_key)}`);
    }
    try {
      assertSlug(m.series_key, "series_key");
    } catch {
      fail(`series_key is not a valid slug: ${JSON.stringify(m.series_key)}`);
    }
    if (m.mastery_eligible !== 0 && m.mastery_eligible !== 1) {
      fail(`mastery_eligible must be 0 or 1, got ${m.mastery_eligible}`);
    }
    if (!Number.isInteger(m.registered_at) || m.registered_at < 0) {
      fail(`invalid registered_at (${m.registered_at})`);
    }

    const members = db
      .prepare(`SELECT title_key, stage FROM title_series_members WHERE catalog_key = ? AND series_key = ?`)
      .all(m.catalog_key, m.series_key) as Array<{ title_key: string; stage: number }>;
    if (members.length < 2) {
      fail(`must have at least 2 members, has ${members.length}`);
    }
    for (const member of members) {
      if (!member.title_key.startsWith("v2.") || member.title_key.length <= 3) {
        fail(`member titleKey must use v2.* namespace: ${member.title_key}`);
      }
      if (!Number.isInteger(member.stage) || member.stage < 1) {
        fail(`member ${member.title_key} has an invalid stage (${member.stage}; must be a positive integer)`);
      }
    }
    // stageの連番性（1..N contiguous）は上のsequenceRows走査で既に別途検証済み。

    const recomputed = computeSeriesManifestHash({
      catalog: m.catalog_key,
      seriesKey: m.series_key,
      masteryEligible: m.mastery_eligible === 1,
      members: members.map((r) => ({ titleKey: r.title_key, stage: r.stage })),
    });
    if (recomputed !== m.manifest_hash) {
      // manifest_hashの一致確認はstructural validationの代替ではない——上の
      // structural checkを独立して先に通した上で、さらにhashの改竄も検出する。
      fail(`stored manifest_hash does not match the hash recomputed from its DB member snapshot (mutated out of band)`);
    }
  }
}

function toSummary(
  row: { catalog_key: string; series_key: string; label_snapshot: string; mastery_eligible: number; manifest_hash: string; registered_at: number },
  members: ReadonlyArray<{ titleKey: string; stage: number }>,
): TitleSeriesManifestSummary {
  return {
    catalogKey: row.catalog_key,
    seriesKey: row.series_key,
    label: row.label_snapshot,
    masteryEligible: row.mastery_eligible === 1,
    manifestHash: row.manifest_hash,
    registeredAt: row.registered_at,
    members,
  };
}

function readMembers(db: Database.Database, catalogKey: string, seriesKey: string): Array<{ titleKey: string; stage: number }> {
  const rows = db
    .prepare(
      `SELECT title_key, stage FROM title_series_members WHERE catalog_key = ? AND series_key = ? ORDER BY stage`,
    )
    .all(catalogKey, seriesKey) as Array<{ title_key: string; stage: number }>;
  return rows.map((r) => ({ titleKey: r.title_key, stage: r.stage }));
}

export function listSeriesManifests(db: Database.Database): TitleSeriesManifestSummary[] {
  const rows = db
    .prepare(
      `SELECT catalog_key, series_key, label_snapshot, mastery_eligible, manifest_hash, registered_at
         FROM title_series_manifests
        ORDER BY catalog_key, series_key`,
    )
    .all() as Array<{
    catalog_key: string;
    series_key: string;
    label_snapshot: string;
    mastery_eligible: number;
    manifest_hash: string;
    registered_at: number;
  }>;
  return rows.map((row) => toSummary(row, readMembers(db, row.catalog_key, row.series_key)));
}

export function seriesManifest(db: Database.Database, catalogKey: string, seriesKey: string): TitleSeriesManifestSummary | null {
  const row = db
    .prepare(
      `SELECT catalog_key, series_key, label_snapshot, mastery_eligible, manifest_hash, registered_at
         FROM title_series_manifests
        WHERE catalog_key = ? AND series_key = ?`,
    )
    .get(catalogKey, seriesKey) as
    | {
        catalog_key: string;
        series_key: string;
        label_snapshot: string;
        mastery_eligible: number;
        manifest_hash: string;
        registered_at: number;
      }
    | undefined;
  if (!row) return null;
  return toSummary(row, readMembers(db, catalogKey, seriesKey));
}

export function listSeriesMasteries(db: Database.Database, userIdRaw: string): TitleSeriesMasteryRow[] {
  const userId = requireText(userIdRaw, "userId");
  const rows = db
    .prepare(
      `SELECT user_id, catalog_key, series_key, recorded_at
         FROM title_series_masteries
        WHERE user_id = ?
        ORDER BY recorded_at, catalog_key, series_key`,
    )
    .all(userId) as Array<{ user_id: string; catalog_key: string; series_key: string; recorded_at: number }>;
  return rows.map((r) => ({ userId: r.user_id, catalogKey: r.catalog_key, seriesKey: r.series_key, recordedAt: r.recorded_at }));
}

export function hasSeriesMastery(db: Database.Database, userIdRaw: string, catalogKey: string, seriesKey: string): boolean {
  const userId = requireText(userIdRaw, "userId");
  const row = db
    .prepare(`SELECT 1 FROM title_series_masteries WHERE user_id = ? AND catalog_key = ? AND series_key = ?`)
    .get(userId, catalogKey, seriesKey);
  return row !== undefined;
}
