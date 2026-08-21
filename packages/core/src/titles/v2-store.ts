import type Database from "better-sqlite3";
import {
  TITLE_SOURCES,
  assertDerivedSourceDependenciesResolve,
  type TitleSourceDefinition,
  type TitleSourceKey,
} from "./v2-contract.js";
import { assertSourceReaderCoverage } from "./v2-sources.js";
import { assertResolvedTitleScopeForTitle, resolvedScopeEffectiveEnd, type ResolvedTitleScope } from "./v2-scope.js";
import {
  assertValidAwardFacts,
  assertValidFactsVersion,
  serializeAwardFacts,
  type TitleAwardFacts,
} from "./v2-award-facts.js";

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

-- 「このscopeでこのtitleを獲得した」という出来事の正本。scopeごとに複数行持てる
-- （月次titleを毎月award等）。所持そのもの（title_ownerships）とは別概念（PR B1）。
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

-- 「そのawardがなぜ成立したか」というaward時点のsafe snapshot（PR B1）。immutable
-- ——一度INSERTしたfactsをUPDATEしない（同じawardの再評価はfactsを書き換えない、
-- award()の冪等性の一部）。title_awardsの行が消えるならfactsも一緒に消えてよい
-- （通常のaward削除APIは今回作らない）。
CREATE TABLE IF NOT EXISTS title_award_facts (
  user_id       TEXT NOT NULL,
  title_key     TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  facts_version INTEGER NOT NULL CHECK (facts_version >= 1),
  facts_json    TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, title_key, scope_key),
  FOREIGN KEY (user_id, title_key, scope_key)
    REFERENCES title_awards(user_id, title_key, scope_key)
    ON DELETE CASCADE
);

-- titleKeyごとにfirst ownershipを確定した「刻印順」を安全に発番するcounter（PR B1）。
-- SELECT MAX(...)+1のような素朴な処理ではなく、単一rowをUPDATEすることでIMMEDIATE
-- transaction下のシリアライズに乗せる。
CREATE TABLE IF NOT EXISTS title_rarity_sequences (
  title_key     TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1)
);

-- 「このuserはこのtitleそのものを持っている」という所持の正本（PR B1）。titleKeyが
-- 複数scopeで繰り返しawardされても(user_id, title_key)は1行だけ——awardとownershipを
-- 混同しない。acquisition_sequenceはBotがfirst ownershipを確定した処理順であって、
-- 真の達成順の証明ではない（v2-rarity.ts参照）。
CREATE TABLE IF NOT EXISTS title_ownerships (
  user_id                     TEXT NOT NULL,
  title_key                   TEXT NOT NULL,
  first_scope_key             TEXT NOT NULL,
  first_earned_at             INTEGER,
  first_awarded_at            INTEGER NOT NULL,
  acquisition_sequence        INTEGER NOT NULL CHECK (acquisition_sequence >= 1),
  holder_count_at_acquisition INTEGER NOT NULL CHECK (holder_count_at_acquisition >= 1),
  CHECK (first_earned_at IS NULL OR first_earned_at <= first_awarded_at),
  PRIMARY KEY (user_id, title_key),
  -- titleKeyごとにacquisition_sequenceは重複しない。title_key prefixのindexとしても
  -- 使える（「あるtitleのN番目は誰か」のqueryに使う）。
  UNIQUE (title_key, acquisition_sequence),
  FOREIGN KEY (user_id, title_key, first_scope_key)
    REFERENCES title_awards(user_id, title_key, scope_key)
);

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

export interface TitleAwardFactsRow {
  user_id: string;
  title_key: string;
  scope_key: string;
  facts_version: number;
  data: TitleAwardFacts;
  captured_at: number;
}

export interface TitleOwnershipRow {
  user_id: string;
  title_key: string;
  first_scope_key: string;
  first_earned_at: number | null;
  first_awarded_at: number;
  acquisition_sequence: number;
  holder_count_at_acquisition: number;
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

export interface AwardFactsInput {
  /** awardFacts JSONのschema version（TitleRule.awardFactsVersion）。 */
  readonly version: number;
  readonly data: TitleAwardFacts;
}

export interface AwardTitleInput {
  userId: string;
  titleKey: string;
  /**
   * callerがscopeKeyを直接組み立てることを禁止する（PR A/§7の境界をStore側でも
   * 完成させる）。resolveTitleScope()が作った branded ResolvedTitleScope だけを
   * 受け取る——入口で assertResolvedTitleScope() を必ず実行する。
   */
  scope: ResolvedTitleScope;
  /** 正確に証明できない場合はnull。reconcile時刻で代用しない。 */
  earnedAt: number | null;
  awardedAt?: number;
  /**
   * award時にpersistするsafe snapshot。matched awardでは必須（TitleRuleResultの
   * discriminated unionと同じ契約）——「award rowはあるがfacts rowが無い」という
   * 状態を作らない。
   */
  awardFacts: AwardFactsInput;
}

export type AwardResultStatus = "awarded" | "already_awarded";

export interface AwardResult {
  readonly status: AwardResultStatus;
  /** このaward呼び出しでtitleKeyのownershipが初めて作られたか（＝rarity sequenceを消費したか）。 */
  readonly ownershipCreated: boolean;
  readonly award: TitleAwardRow;
  readonly ownership: TitleOwnershipRow;
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
 * award/facts/ownershipの全体整合性をfail-closedで検証する。同じ(user,title,scope)を
 * 再award()した時だけ検出するlazy checkだと、Store constructionからそのタイミングまでの
 * 間、欠損facts/ownershipを抱えたaward行を（例えばretired titleのhasAward()経由で）
 * 正常データとして扱ってしまう。Store構築時に必ず一度、DB全体を見て検証する。
 *
 * 偽facts/ownershipを捏造してbackfillしない既存方針はここでも維持する——欠損が
 * あればfail-closedするだけで、埋めない。
 */
function assertAwardPersistenceIntegrity(db: Database.Database): void {
  const missingFacts = db
    .prepare(
      `SELECT a.user_id, a.title_key, a.scope_key
         FROM title_awards a
         LEFT JOIN title_award_facts f
           ON f.user_id = a.user_id AND f.title_key = a.title_key AND f.scope_key = a.scope_key
        WHERE f.user_id IS NULL
        LIMIT 1`,
    )
    .get() as { user_id: string; title_key: string; scope_key: string } | undefined;
  if (missingFacts) {
    throw new Error(
      `title award persistence integrity violation: award row exists for ` +
        `(${missingFacts.user_id}, ${missingFacts.title_key}, ${missingFacts.scope_key}) without award facts ` +
        `(legacy/foundation row, or facts were deleted out of band)`,
    );
  }

  const missingOwnership = db
    .prepare(
      `SELECT a.user_id, a.title_key
         FROM title_awards a
         LEFT JOIN title_ownerships o
           ON o.user_id = a.user_id AND o.title_key = a.title_key
        WHERE o.user_id IS NULL
        GROUP BY a.user_id, a.title_key
        LIMIT 1`,
    )
    .get() as { user_id: string; title_key: string } | undefined;
  if (missingOwnership) {
    throw new Error(
      `title ownership persistence integrity violation: award row(s) exist for ` +
        `(${missingOwnership.user_id}, ${missingOwnership.title_key}) without an ownership row ` +
        `(legacy/foundation row, or ownership was deleted out of band)`,
    );
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
    assertDerivedSourceDependenciesResolve();
    assertSourceReaderCoverage();
    ensureTitleV2Schema(db);
    assertAwardPersistenceIntegrity(db);
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
   * awardは(user,title,scope)で冪等。即時判定と日次reconcileが同時に走っても1行だけ残る。
   *
   * PR B1: 1回のaward操作で、同一transaction内に以下を確定する。
   *   1. title_awards（(user,title,scope)冪等insert）
   *   2. 新規awardならtitle_award_facts（award facts snapshot、immutable）
   *   3. titleKeyのownershipが初めてならtitle_ownerships + rarity sequence消費
   * 途中で1つでも失敗したら全部rollbackする。
   *
   * 冪等呼び出し（既にaward済みの(user,title,scope)への再award）は、facts・
   * ownership・rarity sequenceのいずれも一切変更しない——先に成立したsnapshotが勝つ。
   */
  award(input: AwardTitleInput): AwardResult {
    if (this.db.inTransaction) {
      throw new Error("title award must start outside an existing transaction");
    }

    const userId = requireText(input.userId, "userId");
    const titleKey = requireV2Key(input.titleKey);
    // brand（forgery）に加えて、このscopeが**このtitleKeyのために**resolveTitleScope()
    // されたことまで検証する。`global`のようなscopeKeyはpolicyを共有する全titleで
    // 同一文字列になり得るため、「title Aのために正規resolveしたscopeをtitle Bへ
    // そのまま渡す」substitutionはscopeKeyの一致だけでは検出できない。
    assertResolvedTitleScopeForTitle(input.scope, titleKey);
    const scopeKey = input.scope.scopeKey;
    const earnedAt = input.earnedAt === null ? null : requireUnix(input.earnedAt, "earnedAt");
    const awardedAt = requireUnix(input.awardedAt ?? this.clock(), "awardedAt");
    if (earnedAt !== null && earnedAt > awardedAt) {
      throw new Error(`earnedAt cannot be after awardedAt: earnedAt=${earnedAt} awardedAt=${awardedAt}`);
    }
    // awardedAtは、そのscopeを実際に観測した時刻（observedAt）より前にはできない
    // ——さもないと「まだ観測していない未来のデータを使って過去にawardした」という
    // 矛盾した状態を作れてしまう。captured_at（facts）もこのawardedAtと同じ
    // snapshotを使う。
    if (awardedAt < input.scope.observedAt) {
      throw new Error(
        `awardedAt (${awardedAt}) cannot be before the scope's observedAt (${input.scope.observedAt}) for scope=${scopeKey}`,
      );
    }
    // earnedAtは、resolveTitleScope()が確定したそのscopeの窓の中に収まっていること
    // （§13）。zero-width scope（start===effectiveEnd）では、この条件を満たす
    // earnedAtが存在しないため、常にrejectされる。
    if (earnedAt !== null) {
      const effectiveEnd = resolvedScopeEffectiveEnd(input.scope);
      if (earnedAt < input.scope.start || earnedAt >= effectiveEnd) {
        throw new Error(
          `earnedAt (${earnedAt}) is outside the resolved scope window [${input.scope.start}, ${effectiveEnd}) for scope=${scopeKey}`,
        );
      }
    }

    assertValidFactsVersion(input.awardFacts.version, "awardFacts.version");
    // validationとJSON serializationを単一passで行う——検証後に別途JSON.stringify()を
    // 呼ぶ2段階構成だと、forged/accessor objectで検証時と永続化時の値が食い違う
    // TOCTOUを作り得る（v2-award-facts.tsのdoc comment参照）。
    const factsJson = serializeAwardFacts(input.awardFacts.data, `title ${titleKey} awardFacts`);

    const tx = this.db.transaction((): AwardResult => {
      const insertResult = this.db
        .prepare(
          `INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, title_key, scope_key) DO NOTHING`,
        )
        .run(userId, titleKey, scopeKey, earnedAt, awardedAt);
      const isNewAward = insertResult.changes === 1;

      if (isNewAward) {
        this.db
          .prepare(
            `INSERT INTO title_award_facts (user_id, title_key, scope_key, facts_version, facts_json, captured_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(userId, titleKey, scopeKey, input.awardFacts.version, factsJson, awardedAt);
      } else {
        // 既存awardの再award（冪等呼び出し）。旧foundation形式のaward rowだけが
        // 存在するDB（facts無しでtitle_awardsだけ直接INSERTされた行）を、ここで
        // 偽のfactsを捏造してbackfillしない——明示的なintegrity errorとしてfail-closed
        // する方が、「本当の取得理由が無いのにあることにする」より安全。
        const existingFacts = this.getAwardFactsRow(userId, titleKey, scopeKey);
        if (!existingFacts) {
          throw new Error(
            `title award integrity violation: award row exists for (${userId}, ${titleKey}, ${scopeKey}) ` +
              `without award facts (legacy/foundation row, or facts were deleted out of band)`,
          );
        }
      }

      let ownershipCreated = false;
      let ownershipRow = this.getOwnershipRow(userId, titleKey);
      if (!ownershipRow) {
        if (!isNewAward) {
          // 既存awardがあるのにownershipが無い——本来award()が同一transaction内で
          // 必ず両方作るため、このコード自身が作った状態ではあり得ない。旧形式データ
          // か、out-of-bandな削除の痕跡として扱い、偽のownershipを捏造しない。
          throw new Error(
            `title ownership integrity violation: award row exists for (${userId}, ${titleKey}, ${scopeKey}) ` +
              `without an ownership row (legacy/foundation row, or ownership was deleted out of band)`,
          );
        }
        const sequence = this.allocateRaritySequence(titleKey);
        // 「そのtransaction時点でDBに記録されていたtitle ownership数（今回のfirst
        // ownershipを含む）」。current guild membership等を使ったfuture rarityとは
        // 別概念——active populationを勝手に実装しない（§10）。
        const holderCount = this.countOwnerships(titleKey) + 1;
        this.db
          .prepare(
            `INSERT INTO title_ownerships
               (user_id, title_key, first_scope_key, first_earned_at, first_awarded_at,
                acquisition_sequence, holder_count_at_acquisition)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(userId, titleKey, scopeKey, earnedAt, awardedAt, sequence, holderCount);
        ownershipCreated = true;
        ownershipRow = this.getOwnershipRow(userId, titleKey);
        if (!ownershipRow) throw new Error(`title ownership was not persisted: ${userId}/${titleKey}`);
      }
      // isNewAward && ownershipRow already existed: 同じtitleの2つ目以降のscopeへの
      // award。ownership/rarity sequenceは一切変更しない（先に成立したfirst ownership
      // のsnapshotが勝つ）。

      const awardRow = this.getAwardRow(userId, titleKey, scopeKey);
      if (!awardRow) throw new Error(`title award was not persisted: ${userId}/${titleKey}/${scopeKey}`);

      return {
        status: isNewAward ? "awarded" : "already_awarded",
        ownershipCreated,
        award: awardRow,
        ownership: ownershipRow,
      };
    });

    return tx.immediate();
  }

  private allocateRaritySequence(titleKey: string): number {
    this.db
      .prepare(
        `INSERT INTO title_rarity_sequences (title_key, last_sequence)
         VALUES (?, 1)
         ON CONFLICT(title_key) DO UPDATE SET last_sequence = last_sequence + 1`,
      )
      .run(titleKey);
    const row = this.db
      .prepare(`SELECT last_sequence FROM title_rarity_sequences WHERE title_key = ?`)
      .get(titleKey) as { last_sequence: number };
    return row.last_sequence;
  }

  private countOwnerships(titleKey: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM title_ownerships WHERE title_key = ?`).get(titleKey) as {
      n: number;
    };
    return row.n;
  }

  private getAwardRow(userId: string, titleKey: string, scopeKey: string): TitleAwardRow | null {
    const row = this.db
      .prepare(
        `SELECT user_id, title_key, scope_key, earned_at, awarded_at
           FROM title_awards
          WHERE user_id = ? AND title_key = ? AND scope_key = ?`,
      )
      .get(userId, titleKey, scopeKey) as TitleAwardRow | undefined;
    return row ?? null;
  }

  private getAwardFactsRow(userId: string, titleKey: string, scopeKey: string): { facts_version: number; facts_json: string } | null {
    const row = this.db
      .prepare(
        `SELECT facts_version, facts_json
           FROM title_award_facts
          WHERE user_id = ? AND title_key = ? AND scope_key = ?`,
      )
      .get(userId, titleKey, scopeKey) as { facts_version: number; facts_json: string } | undefined;
    return row ?? null;
  }

  private getOwnershipRow(userId: string, titleKey: string): TitleOwnershipRow | null {
    const row = this.db
      .prepare(
        `SELECT user_id, title_key, first_scope_key, first_earned_at, first_awarded_at,
                acquisition_sequence, holder_count_at_acquisition
           FROM title_ownerships
          WHERE user_id = ? AND title_key = ?`,
      )
      .get(userId, titleKey) as TitleOwnershipRow | undefined;
    return row ?? null;
  }

  /**
   * 既存awardの有無を確認する（読み取り専用）。retired titleが新規awardを作らず、
   * 既存awardだけ保持するかどうかの分岐に使う。
   *
   * Store構築時に `assertAwardPersistenceIntegrity()` がDB全体を検証済みだが、
   * construction後にout-of-bandな行が挿入される可能性もゼロではないため、
   * ここでも見つけたaward bundle（facts/ownership）のintegrityを確認する——
   * 欠損したfacts/ownershipを抱えたawardを黙って「あり」として返さない。
   */
  hasAward(userIdRaw: string, titleKeyRaw: string, scopeKeyRaw: string): boolean {
    const userId = requireText(userIdRaw, "userId");
    const titleKey = requireV2Key(titleKeyRaw);
    const scopeKey = requireText(scopeKeyRaw, "scopeKey");
    const row = this.getAwardRow(userId, titleKey, scopeKey);
    if (!row) return false;

    const facts = this.getAwardFactsRow(userId, titleKey, scopeKey);
    if (!facts) {
      throw new Error(
        `title award integrity violation: award row exists for (${userId}, ${titleKey}, ${scopeKey}) without award facts`,
      );
    }
    const ownership = this.getOwnershipRow(userId, titleKey);
    if (!ownership) {
      throw new Error(
        `title ownership integrity violation: award row exists for (${userId}, ${titleKey}, ${scopeKey}) without an ownership row`,
      );
    }
    return true;
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
   * award時点のsafe snapshotを読む。本人の印録・将来の説明rendererで使う想定。
   * DB内JSONが壊れている・awardFacts contract（v2-award-facts.ts）に違反している場合、
   * 空object扱いで誤魔化さずintegrity errorとして投げる。
   */
  awardFacts(userIdRaw: string, titleKeyRaw: string, scopeKeyRaw: string): TitleAwardFactsRow | null {
    const userId = requireText(userIdRaw, "userId");
    const titleKey = requireV2Key(titleKeyRaw);
    const scopeKey = requireText(scopeKeyRaw, "scopeKey");
    const row = this.db
      .prepare(
        `SELECT facts_version, facts_json, captured_at
           FROM title_award_facts
          WHERE user_id = ? AND title_key = ? AND scope_key = ?`,
      )
      .get(userId, titleKey, scopeKey) as { facts_version: number; facts_json: string; captured_at: number } | undefined;
    if (!row) return null;

    // 壊れたDB値をそのまま型付きrowとして返さない——version・timestamp・JSON本体を
    // すべてvalidateする。
    try {
      assertValidFactsVersion(row.facts_version, `award facts_version for ${userId}/${titleKey}/${scopeKey}`);
    } catch (err) {
      throw new Error(
        `award facts integrity violation: invalid facts_version for ${userId}/${titleKey}/${scopeKey}: ${(err as Error).message}`,
      );
    }
    if (!Number.isInteger(row.captured_at) || row.captured_at < 0) {
      throw new Error(`award facts integrity violation: invalid captured_at for ${userId}/${titleKey}/${scopeKey}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.facts_json);
    } catch {
      throw new Error(`award facts integrity violation: invalid JSON for ${userId}/${titleKey}/${scopeKey}`);
    }
    assertValidAwardFacts(parsed, `award facts for ${userId}/${titleKey}/${scopeKey}`);

    return {
      user_id: userId,
      title_key: titleKey,
      scope_key: scopeKey,
      facts_version: row.facts_version,
      data: parsed,
      captured_at: row.captured_at,
    };
  }

  /** titleKeyそのものを所持しているか（副作用なし）。scope単位のawardとは別の問い。 */
  hasOwnership(userIdRaw: string, titleKeyRaw: string): boolean {
    const userId = requireText(userIdRaw, "userId");
    const titleKey = requireV2Key(titleKeyRaw);
    const row = this.db.prepare(`SELECT 1 FROM title_ownerships WHERE user_id = ? AND title_key = ?`).get(userId, titleKey);
    return row !== undefined;
  }

  /** titleKeyの所持情報（初回獲得scope・刻印順・獲得時点の所持者数）を読む。 */
  ownership(userIdRaw: string, titleKeyRaw: string): TitleOwnershipRow | null {
    const userId = requireText(userIdRaw, "userId");
    const titleKey = requireV2Key(titleKeyRaw);
    return this.getOwnershipRow(userId, titleKey);
  }

  /** 本人が所持する全titleのownership一覧（scope別のaward historyではない）。 */
  listOwnerships(userId: string): TitleOwnershipRow[] {
    return this.db
      .prepare(
        `SELECT user_id, title_key, first_scope_key, first_earned_at, first_awarded_at,
                acquisition_sequence, holder_count_at_acquisition
           FROM title_ownerships
          WHERE user_id = ?
          ORDER BY acquisition_sequence, title_key`,
      )
      .all(userId) as TitleOwnershipRow[];
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
