import type Database from "better-sqlite3";
import { TITLE_SOURCES, type TitleSourceKey } from "./v2-contract.js";

const now = () => Math.floor(Date.now() / 1000);

const V2_DDL = `
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
  value       INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, metric, catalog_key)
);
CREATE INDEX IF NOT EXISTS idx_title_source_baselines_catalog
  ON title_source_baselines(catalog_key, source, metric);

CREATE TABLE IF NOT EXISTS title_awards (
  user_id    TEXT NOT NULL,
  title_key  TEXT NOT NULL,
  scope_key  TEXT NOT NULL,
  earned_at  INTEGER,
  awarded_at INTEGER NOT NULL,
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

export interface TitleCatalogEpochRow {
  catalog_key: string;
  epoch: number;
  applied_at: number;
  actor: string;
  note: string | null;
}

export interface TitleBaseline {
  userId: string;
  source: TitleSourceKey;
  metric: string;
  value: number;
}

export interface TitleBaselineRow {
  user_id: string;
  source: string;
  metric: string;
  catalog_key: string;
  value: number;
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
  /**
   * BEGIN IMMEDIATE取得後に呼ばれる。
   * counter値は必ずこのcallback内でDBから読む。外で読んだ値を渡す設計にしない。
   */
  snapshotBaselines: (db: Database.Database) => readonly TitleBaseline[];
}

export interface AwardTitleInput {
  userId: string;
  titleKey: string;
  scopeKey: string;
  /** 正確に証明できない場合はnull。reconcile時刻で代用しない。 */
  earnedAt: number | null;
  awardedAt?: number;
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

function requireV2Key(key: string): string {
  const normalized = requireText(key, "titleKey");
  if (!normalized.startsWith("v2.") || normalized.length <= 3) {
    throw new Error(`titleKey must use v2.* namespace: ${normalized}`);
  }
  return normalized;
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
    ensureTitleV2Schema(db);
  }

  /**
   * カタログ紀元とcounter baselineを単一のBEGIN IMMEDIATE内で確定する。
   * snapshotBaselinesはロック取得後に実行されるので「baseline取得中に1回増えた」が起きない。
   */
  applyCatalog(input: ApplyCatalogInput): TitleCatalogEpochRow {
    const catalogKey = requireText(input.catalogKey, "catalogKey");
    const actor = requireText(input.actor, "actor");

    const apply = this.db.transaction(() => {
      const existing = this.catalogEpoch(catalogKey);
      if (existing) throw new Error(`title catalog already applied: ${catalogKey}`);

      const epoch = requireUnix(this.clock(), "epoch");
      const baselines = input.snapshotBaselines(this.db);
      const insertEpoch = this.db.prepare(
        `INSERT INTO title_catalog_epochs (catalog_key, epoch, applied_at, actor, note)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertEpoch.run(catalogKey, epoch, epoch, actor, input.note ?? null);

      const insertBaseline = this.db.prepare(
        `INSERT INTO title_source_baselines (user_id, source, metric, catalog_key, value)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const baseline of baselines) {
        const source = TITLE_SOURCES[baseline.source];
        if (source.kind !== "counter" || source.epochPolicy.type !== "baseline") {
          throw new Error(`title source does not use a baseline: ${baseline.source}`);
        }
        const userId = requireText(baseline.userId, "baseline.userId");
        const metric = requireText(baseline.metric, "baseline.metric");
        if (!Number.isInteger(baseline.value) || baseline.value < 0) {
          throw new Error(`baseline.value must be a non-negative integer: ${baseline.source}/${metric}`);
        }
        insertBaseline.run(userId, baseline.source, metric, catalogKey, baseline.value);
      }

      return {
        catalog_key: catalogKey,
        epoch,
        applied_at: epoch,
        actor,
        note: input.note ?? null,
      };
    });

    // better-sqlite3のBEGIN IMMEDIATE。baseline snapshot中の他writerを直列化する。
    return apply.immediate();
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

  /** 最初に施行されたcatalog epochがSYSTEM_EPOCH。後から動かさない。 */
  systemEpoch(): number | null {
    const row = this.db
      .prepare("SELECT MIN(epoch) AS epoch FROM title_catalog_epochs")
      .get() as { epoch: number | null };
    return row.epoch;
  }

  baseline(userId: string, source: TitleSourceKey, metric: string, catalogKey: string): number | null {
    const row = this.db
      .prepare(
        `SELECT value
           FROM title_source_baselines
          WHERE user_id = ? AND source = ? AND metric = ? AND catalog_key = ?`,
      )
      .get(userId, source, metric, catalogKey) as { value: number } | undefined;
    return row?.value ?? null;
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
      // 同じ印を別slotへ動かす場合も1操作で済ませる。
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
