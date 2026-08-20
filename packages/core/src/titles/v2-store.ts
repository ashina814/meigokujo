import type Database from "better-sqlite3";
import {
  TITLE_SOURCES,
  type TitleSourceDefinition,
  type TitleSourceKey,
} from "./v2-contract.js";

const now = () => Math.floor(Date.now() / 1000);

const V2_DDL = `
CREATE TABLE IF NOT EXISTS title_system_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  system_epoch   INTEGER NOT NULL,
  established_at INTEGER NOT NULL,
  actor          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS title_catalog_epochs (
  catalog_key TEXT PRIMARY KEY,
  epoch       INTEGER NOT NULL,
  applied_at  INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS title_source_baselines (
  user_id     TEXT NOT NULL,
  source      TEXT NOT NULL,
  metric      TEXT NOT NULL,
  catalog_key TEXT NOT NULL REFERENCES title_catalog_epochs(catalog_key),
  value       INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (user_id, source, metric, catalog_key)
);
CREATE INDEX IF NOT EXISTS idx_title_source_baselines_catalog
  ON title_source_baselines(catalog_key, source, metric);

-- 0行だったsnapshotと「snapshot自体を忘れた」を区別する施行証跡。
CREATE TABLE IF NOT EXISTS title_source_baseline_runs (
  catalog_key TEXT NOT NULL REFERENCES title_catalog_epochs(catalog_key),
  source      TEXT NOT NULL,
  metric      TEXT NOT NULL,
  row_count   INTEGER NOT NULL CHECK (row_count >= 0),
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (catalog_key, source, metric)
);

CREATE TABLE IF NOT EXISTS title_awards (
  user_id    TEXT NOT NULL,
  title_key  TEXT NOT NULL,
  scope_key  TEXT NOT NULL,
  earned_at  INTEGER,
  awarded_at INTEGER NOT NULL,
  CHECK (earned_at IS NULL OR earned_at <= awarded_at),
  PRIMARY KEY (user_id, title_key, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_title_awards_user
  ON title_awards(user_id, awarded_at);
CREATE INDEX IF NOT EXISTS idx_title_awards_title_scope
  ON title_awards(title_key, scope_key);

CREATE TABLE IF NOT EXISTS title_equips (
  user_id   TEXT NOT NULL,
  slot      INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  title_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  PRIMARY KEY (user_id, slot),
  UNIQUE (user_id, title_key),
  FOREIGN KEY (user_id, title_key, scope_key)
    REFERENCES title_awards(user_id, title_key, scope_key)
    ON DELETE CASCADE
);
`;

export interface TitleSystemStateRow {
  id: 1;
  system_epoch: number;
  established_at: number;
  actor: string;
}

export interface TitleCatalogEpochRow {
  catalog_key: string;
  epoch: number;
  applied_at: number;
  actor: string;
  note: string | null;
}

export interface TitleBaselineRow {
  user_id: string;
  source: string;
  metric: string;
  catalog_key: string;
  value: number;
}

export interface TitleBaselineRunRow {
  catalog_key: string;
  source: string;
  metric: string;
  row_count: number;
  captured_at: number;
}

export interface TitleAwardRow {
  user_id: string;
  title_key: string;
  scope_key: string;
  /** 達成時刻を証明できないawardはNULLのままにする。 */
  earned_at: number | null;
  awarded_at: number;
}

export interface TitleEquipRow {
  user_id: string;
  slot: number;
  title_key: string;
  scope_key: string;
}

export interface ApplyCatalogInput {
  catalogKey: string;
  actor: string;
  note?: string;
}

export interface AwardTitleInput {
  userId: string;
  titleKey: string;
  scopeKey: string;
  /** 正確に証明できない場合はnull。reconcile時刻で代用しない。 */
  earnedAt: number | null;
  awardedAt?: number;
}

type CounterSnapshotRow = { user_id: string; value: number };
type CounterBaselineSnapshotter = (db: Database.Database) => readonly CounterSnapshotRow[];

/**
 * counter sourceのbaseline取得はStore自身が所有する。
 * applyCatalog() の呼び出し側に任意配列を渡させないことで、一部ユーザー漏れ・metric typoを防ぐ。
 */
const COUNTER_BASELINE_SNAPSHOTTERS: Record<string, Record<string, CounterBaselineSnapshotter>> = {
  bump_counts: {
    count: (db) =>
      db.prepare("SELECT user_id, count AS value FROM bump_counts ORDER BY user_id").all() as CounterSnapshotRow[],
  },
};

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireUnix(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative unix timestamp`);
  return value;
}

function requireV2Key(key: string): string {
  const normalized = requireText(key, "titleKey");
  if (!normalized.startsWith("v2.") || normalized.length <= 3) {
    throw new Error(`titleKey must use v2.* namespace: ${normalized}`);
  }
  return normalized;
}

function baselineSourceEntries(): Array<[TitleSourceKey, TitleSourceDefinition]> {
  const entries: Array<[TitleSourceKey, TitleSourceDefinition]> = [];
  for (const key of Object.keys(TITLE_SOURCES) as TitleSourceKey[]) {
    const source: TitleSourceDefinition = TITLE_SOURCES[key];
    if (source.privacy === "forbidden") continue;
    if (source.kind !== "counter" || source.epochPolicy.type !== "baseline") continue;
    entries.push([key, source]);
  }
  return entries;
}

/** registryへbaseline sourceを足したらsnapshotterも同時に実装させる。 */
function assertCounterBaselineSnapshotterCoverage(): void {
  for (const [sourceKey, source] of baselineSourceEntries()) {
    if (source.epochPolicy.type !== "baseline") continue;
    const snapshotters = COUNTER_BASELINE_SNAPSHOTTERS[sourceKey];
    if (!snapshotters) throw new Error(`missing baseline snapshotter for title source: ${sourceKey}`);

    const expected = [...source.epochPolicy.metrics].sort();
    const actual = Object.keys(snapshotters).sort();
    if (expected.length !== actual.length || expected.some((metric, i) => metric !== actual[i])) {
      throw new Error(
        `baseline snapshotter metrics mismatch for ${sourceKey}: expected=${expected.join(",")} actual=${actual.join(",")}`,
      );
    }
  }
}

/**
 * v2称号の永続化だけを担当する。
 *
 * 旧 titles / TitleEngine は移行が終わるまで触らない。PR1ではこのStoreを本番経路へ
 * 接続しないため、deployしても既存称号・プロフィールの挙動は変わらない。
 */
export class TitleV2Store {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => number = now,
  ) {
    assertCounterBaselineSnapshotterCoverage();
    ensureTitleV2Schema(db);
  }

  /**
   * CATALOG_EPOCHと、登録済みの全counter baselineを単一のBEGIN IMMEDIATE内で確定する。
   * 外側transaction内から呼ぶとIMMEDIATEの保証がsavepointへ弱まるためfail-closedする。
   */
  applyCatalog(input: ApplyCatalogInput): TitleCatalogEpochRow {
    if (this.db.inTransaction) {
      throw new Error("title catalog apply must start outside an existing transaction");
    }

    const catalogKey = requireText(input.catalogKey, "catalogKey");
    const actor = requireText(input.actor, "actor");

    const apply = this.db.transaction(() => {
      const existing = this.catalogEpoch(catalogKey);
      if (existing) throw new Error(`title catalog already applied: ${catalogKey}`);

      const epoch = requireUnix(this.clock(), "epoch");
      const latestEpoch = this.latestCatalogEpoch();
      if (latestEpoch !== null && epoch < latestEpoch) {
        throw new Error(`title catalog epoch cannot move backwards: latest=${latestEpoch} next=${epoch}`);
      }

      const system = this.systemState();
      if (!system) {
        this.db
          .prepare(
            `INSERT INTO title_system_state (id, system_epoch, established_at, actor)
             VALUES (1, ?, ?, ?)`,
          )
          .run(epoch, epoch, actor);
      }

      this.db
        .prepare(
          `INSERT INTO title_catalog_epochs (catalog_key, epoch, applied_at, actor, note)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(catalogKey, epoch, epoch, actor, input.note ?? null);

      this.snapshotAllCounterBaselines(catalogKey, epoch);

      return {
        catalog_key: catalogKey,
        epoch,
        applied_at: epoch,
        actor,
        note: input.note ?? null,
      };
    });

    return apply.immediate();
  }

  private snapshotAllCounterBaselines(catalogKey: string, capturedAt: number): void {
    const insertBaseline = this.db.prepare(
      `INSERT INTO title_source_baselines (user_id, source, metric, catalog_key, value)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertRun = this.db.prepare(
      `INSERT INTO title_source_baseline_runs (catalog_key, source, metric, row_count, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const [sourceKey, source] of baselineSourceEntries()) {
      if (source.epochPolicy.type !== "baseline") continue;
      const snapshotters = COUNTER_BASELINE_SNAPSHOTTERS[sourceKey];
      if (!snapshotters) throw new Error(`missing baseline snapshotter for title source: ${sourceKey}`);

      for (const metric of source.epochPolicy.metrics) {
        const snapshotter = snapshotters[metric];
        if (!snapshotter) throw new Error(`missing baseline metric snapshotter: ${sourceKey}/${metric}`);
        const rows = snapshotter(this.db);
        const seenUsers = new Set<string>();

        for (const row of rows) {
          const userId = requireText(row.user_id, `${sourceKey}.${metric}.user_id`);
          if (seenUsers.has(userId)) throw new Error(`duplicate baseline user: ${sourceKey}/${metric}/${userId}`);
          seenUsers.add(userId);
          if (!Number.isInteger(row.value) || row.value < 0) {
            throw new Error(`baseline value must be a non-negative integer: ${sourceKey}/${metric}/${userId}`);
          }
          insertBaseline.run(userId, sourceKey, metric, catalogKey, row.value);
        }

        insertRun.run(catalogKey, sourceKey, metric, rows.length, capturedAt);
      }
    }
  }

  systemState(): TitleSystemStateRow | null {
    const row = this.db
      .prepare("SELECT id, system_epoch, established_at, actor FROM title_system_state WHERE id = 1")
      .get() as TitleSystemStateRow | undefined;
    return row ?? null;
  }

  systemEpoch(): number | null {
    return this.systemState()?.system_epoch ?? null;
  }

  catalogEpoch(catalogKey: string): TitleCatalogEpochRow | null {
    const row = this.db
      .prepare(
        `SELECT catalog_key, epoch, applied_at, actor, note
           FROM title_catalog_epochs
          WHERE catalog_key = ?`,
      )
      .get(catalogKey) as TitleCatalogEpochRow | undefined;
    return row ?? null;
  }

  private latestCatalogEpoch(): number | null {
    const row = this.db.prepare("SELECT MAX(epoch) AS epoch FROM title_catalog_epochs").get() as { epoch: number | null };
    return row.epoch;
  }

  /**
   * counter baselineはfail-closedで読む。
   * 正常にsnapshot済みで、その時点にuser行が無かった場合だけ0を返す。
   * source/metricの誤指定やsnapshot run欠損を0扱いしてはいけない。
   */
  baseline(userIdRaw: string, source: TitleSourceKey, metricRaw: string, catalogKeyRaw: string): number {
    const userId = requireText(userIdRaw, "baseline.userId");
    const metric = requireText(metricRaw, "baseline.metric");
    const catalogKey = requireText(catalogKeyRaw, "baseline.catalogKey");
    const sourceDefinition = (TITLE_SOURCES as Record<string, TitleSourceDefinition>)[source];
    if (!sourceDefinition) throw new Error(`unknown title source: ${String(source)}`);
    if (sourceDefinition.kind !== "counter" || sourceDefinition.epochPolicy.type !== "baseline") {
      throw new Error(`title source does not use a counter baseline: ${String(source)}`);
    }
    if (!sourceDefinition.epochPolicy.metrics.includes(metric)) {
      throw new Error(`unknown baseline metric for ${String(source)}: ${metric}`);
    }

    const run = this.baselineRun(catalogKey, source, metric);
    if (!run) {
      throw new Error(`missing baseline run: ${catalogKey}/${String(source)}/${metric}`);
    }

    const row = this.db
      .prepare(
        `SELECT value
           FROM title_source_baselines
          WHERE user_id = ? AND source = ? AND metric = ? AND catalog_key = ?`,
      )
      .get(userId, source, metric, catalogKey) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  baselineRun(catalogKey: string, source: TitleSourceKey, metric: string): TitleBaselineRunRow | null {
    const row = this.db
      .prepare(
        `SELECT catalog_key, source, metric, row_count, captured_at
           FROM title_source_baseline_runs
          WHERE catalog_key = ? AND source = ? AND metric = ?`,
      )
      .get(catalogKey, source, metric) as TitleBaselineRunRow | undefined;
    return row ?? null;
  }

  listBaselines(catalogKey: string): TitleBaselineRow[] {
    return this.db
      .prepare(
        `SELECT user_id, source, metric, catalog_key, value
           FROM title_source_baselines
          WHERE catalog_key = ?
          ORDER BY source, metric, user_id`,
      )
      .all(catalogKey) as TitleBaselineRow[];
  }

  listBaselineRuns(catalogKey: string): TitleBaselineRunRow[] {
    return this.db
      .prepare(
        `SELECT catalog_key, source, metric, row_count, captured_at
           FROM title_source_baseline_runs
          WHERE catalog_key = ?
          ORDER BY source, metric`,
      )
      .all(catalogKey) as TitleBaselineRunRow[];
  }

  /**
   * awardは(user,title,scope)で冪等。
   * 即時判定と日次reconcileが同時に走っても1行だけ残る。
   */
  award(input: AwardTitleInput): boolean {
    const userId = requireText(input.userId, "userId");
    const titleKey = requireV2Key(input.titleKey);
    const scopeKey = requireText(input.scopeKey, "scopeKey");
    const earnedAt = input.earnedAt === null ? null : requireUnix(input.earnedAt, "earnedAt");
    const awardedAt = requireUnix(input.awardedAt ?? this.clock(), "awardedAt");
    if (earnedAt !== null && earnedAt > awardedAt) {
      throw new Error(`earnedAt cannot be after awardedAt: earnedAt=${earnedAt} awardedAt=${awardedAt}`);
    }

    const result = this.db
      .prepare(
        `INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, title_key, scope_key) DO NOTHING`,
      )
      .run(userId, titleKey, scopeKey, earnedAt, awardedAt);
    return result.changes === 1;
  }

  listAwards(userId: string): TitleAwardRow[] {
    return this.db
      .prepare(
        `SELECT user_id, title_key, scope_key, earned_at, awarded_at
           FROM title_awards
          WHERE user_id = ?
          ORDER BY COALESCE(earned_at, awarded_at), awarded_at, title_key, scope_key`,
      )
      .all(userId) as TitleAwardRow[];
  }

  /**
   * 公開するのは装備した0〜3印だけ。
   * 同じtitle_keyの別scopeを複数枠へ並べることはできない。
   */
  equip(userIdRaw: string, slot: number, titleKeyRaw: string, scopeKeyRaw: string): void {
    const userId = requireText(userIdRaw, "userId");
    const titleKey = requireV2Key(titleKeyRaw);
    const scopeKey = requireText(scopeKeyRaw, "scopeKey");
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error(`slot must be 1..3: ${slot}`);

    const awarded = this.db
      .prepare(
        `SELECT 1
           FROM title_awards
          WHERE user_id = ? AND title_key = ? AND scope_key = ?`,
      )
      .get(userId, titleKey, scopeKey);
    if (!awarded) throw new Error(`cannot equip unowned title: ${titleKey}/${scopeKey}`);

    const move = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM title_equips WHERE user_id = ? AND (slot = ? OR title_key = ?)")
        .run(userId, slot, titleKey);
      this.db
        .prepare("INSERT INTO title_equips (user_id, slot, title_key, scope_key) VALUES (?, ?, ?, ?)")
        .run(userId, slot, titleKey, scopeKey);
    });
    move();
  }

  unequip(userId: string, slot: number): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error(`slot must be 1..3: ${slot}`);
    this.db.prepare("DELETE FROM title_equips WHERE user_id = ? AND slot = ?").run(userId, slot);
  }

  listEquips(userId: string): TitleEquipRow[] {
    return this.db
      .prepare(
        `SELECT user_id, slot, title_key, scope_key
           FROM title_equips
          WHERE user_id = ?
          ORDER BY slot`,
      )
      .all(userId) as TitleEquipRow[];
  }
}

export function ensureTitleV2Schema(db: Database.Database): void {
  db.exec(V2_DDL);
}
