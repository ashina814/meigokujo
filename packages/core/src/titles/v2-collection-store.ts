import type Database from "better-sqlite3";
import { assertSlug, type TitleDefinition } from "./v2-contract.js";
import {
  assertCollectionEditionActivatable,
  computeCollectionEditionHash,
  type TitleCollectionEdition,
  type TitleCollectionMilestonePolicy,
} from "./v2-collection.js";

/**
 * Collection Edition persistence / lifecycle（PR B2）。
 *
 * activateされたeditionのmanifest snapshotをimmutableにDB保存し、activeなeditionを
 * 最大1件に制限し、closeされたeditionをhistorical repairのために保持し続ける。
 *
 * **historical repair proof契約（§16）** — closed editionのmemberを「close時点で
 * 持っていたと証明できる」とみなす条件は次のいずれか:
 *
 * A. そのuser/titleのawardに `earned_at IS NOT NULL AND earned_at < edition.closed_at`
 *    が1件以上ある（正確な達成時刻がclose以前だと証明できる——historical repairでも可）
 * B. そのuser/titleのawardに `awarded_at < edition.closed_at` が1件以上ある
 *    （close前にBotが既にaward記録済み——earnedAtが不明でも、その時点でownership
 *    済みだったこと自体は証明できる）
 *
 * **`<` であって `<=` ではない**（same-second tieはfail-closed）。Store clockは
 * Unix秒精度（`Math.floor(Date.now()/1000)`）のため、`close at T` と
 * `close直後の通常award at T`（同じ秒に丸められる）は`awarded_at === closed_at`
 * になり得る。秒精度のままでは同秒内の前後関係を証明できないため、
 * `earned_at === closed_at` / `awarded_at === closed_at` はどちらも「close時点で
 * 持っていた証明」として扱わず、保守的に対象外とする——`<=`のままだと、
 * close直後（同じ秒内）の通常取得を誤って旧editionへcreditしてしまう。
 *
 * close後にhistorical repairされたawardは、earnedAtが正確にclose**より前**だと
 * 証明できる場合だけ（条件A）旧editionへcreditされる。close後に普通に取得した
 * `awardedAt>=closedAt` かつ `earnedAt=NULL` のtitleは、close以前に持っていた証明が
 * 無いため旧editionへは一切creditしない——`collectionEditionProgress()` がこの契約を
 * 直接実装する。
 */
export const COLLECTION_V2_DDL = `
CREATE TABLE IF NOT EXISTS title_collection_editions (
  edition_key                TEXT PRIMARY KEY,
  manifest_hash               TEXT NOT NULL,
  started_collecting          INTEGER NOT NULL,
  collector_habit              INTEGER NOT NULL,
  still_collecting             INTEGER NOT NULL,
  thousand_marks_count         INTEGER NOT NULL,
  thousand_marks_domains       INTEGER NOT NULL,
  almost_complete_remaining    INTEGER NOT NULL,
  activated_at                 INTEGER NOT NULL,
  activated_by                 TEXT NOT NULL,
  activation_note              TEXT,
  closed_at                    INTEGER,
  closed_by                    TEXT,
  close_note                   TEXT,
  CHECK (closed_at IS NULL OR closed_at >= activated_at),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

CREATE TABLE IF NOT EXISTS title_collection_members (
  edition_key            TEXT NOT NULL,
  title_key               TEXT NOT NULL,
  collection_domain_key    TEXT NOT NULL,
  collection_credit        INTEGER NOT NULL CHECK (collection_credit IN (0, 1)),
  full_clear_required      INTEGER NOT NULL CHECK (full_clear_required IN (0, 1)),
  PRIMARY KEY (edition_key, title_key),
  FOREIGN KEY (edition_key) REFERENCES title_collection_editions(edition_key)
);

-- singleton row。activeなeditionを最大1件に制限する（PR B2）。
CREATE TABLE IF NOT EXISTS title_collection_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  active_edition_key  TEXT,
  FOREIGN KEY (active_edition_key) REFERENCES title_collection_editions(edition_key)
);
INSERT OR IGNORE INTO title_collection_state (id, active_edition_key) VALUES (1, NULL);
`;

export interface TitleCollectionEditionRow {
  readonly editionKey: string;
  readonly manifestHash: string;
  readonly milestones: TitleCollectionMilestonePolicy;
  readonly members: ReadonlyArray<{
    readonly titleKey: string;
    readonly collectionDomainKey: string;
    readonly collectionCredit: boolean;
    readonly fullClearRequired: boolean;
  }>;
  readonly activatedAt: number;
  readonly activatedBy: string;
  readonly activationNote: string | null;
  readonly closedAt: number | null;
  readonly closedBy: string | null;
  readonly closeNote: string | null;
}

export type ActivateCollectionEditionStatus = "activated" | "already_active";
export interface ActivateCollectionEditionResult {
  readonly status: ActivateCollectionEditionStatus;
  readonly edition: TitleCollectionEditionRow;
}

export type CloseCollectionEditionStatus = "closed" | "already_closed";
export interface CloseCollectionEditionResult {
  readonly status: CloseCollectionEditionStatus;
  readonly edition: TitleCollectionEditionRow;
}

/**
 * `collectionEditionProgress()` の返却。**hidden title leak防止（§18）**——ここには
 * count/domain/completeしか含めない。member titleKey・hidden title名・未取得hidden
 * 条件は一切含まない。meta evaluatorが必要とするのはこの集計値だけ。
 */
export interface CollectionEditionProgress {
  readonly editionKey: string;
  readonly state: "active" | "closed";
  readonly collectionOwnedCount: number;
  readonly collectionTotalCount: number;
  readonly collectionOwnedDomainCount: number;
  readonly collectionTotalDomainCount: number;
  readonly fullClearOwnedCount: number;
  readonly fullClearRequiredCount: number;
  readonly fullClearRemainingCount: number;
  readonly fullClearComplete: boolean;
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

interface EditionDbRow {
  edition_key: string;
  manifest_hash: string;
  started_collecting: number;
  collector_habit: number;
  still_collecting: number;
  thousand_marks_count: number;
  thousand_marks_domains: number;
  almost_complete_remaining: number;
  activated_at: number;
  activated_by: string;
  activation_note: string | null;
  closed_at: number | null;
  closed_by: string | null;
  close_note: string | null;
}

interface MemberDbRow {
  title_key: string;
  collection_domain_key: string;
  collection_credit: number;
  full_clear_required: number;
}

/**
 * singleton state rowの欠損は「activeなeditionが無い」という正常状態ではなく、
 * integrity violation——`ensureTitleV2Schema()`（`COLLECTION_V2_DDL`の
 * `INSERT OR IGNORE`）が必ずid=1行を作るため、通常運用でこの行が消えることは
 * あり得ない。欠損時に`{active_edition_key:null}`を返すfail-openにすると、
 * 「out-of-bandにstate rowが削除された」状態を「activeなし」の正常状態と
 * 区別できなくなる——fail-closedする。
 */
function requireState(db: Database.Database): { active_edition_key: string | null } {
  const row = db.prepare(`SELECT active_edition_key FROM title_collection_state WHERE id = 1`).get() as
    | { active_edition_key: string | null }
    | undefined;
  if (!row) {
    throw new Error("collection state integrity violation: title_collection_state singleton row (id=1) is missing");
  }
  return row;
}

function getEditionRow(db: Database.Database, editionKey: string): EditionDbRow | null {
  const row = db.prepare(`SELECT * FROM title_collection_editions WHERE edition_key = ?`).get(editionKey) as
    | EditionDbRow
    | undefined;
  return row ?? null;
}

function getMemberRows(db: Database.Database, editionKey: string): MemberDbRow[] {
  return db
    .prepare(
      `SELECT title_key, collection_domain_key, collection_credit, full_clear_required
         FROM title_collection_members
        WHERE edition_key = ?
        ORDER BY title_key`,
    )
    .all(editionKey) as MemberDbRow[];
}

function toPublicEdition(db: Database.Database, row: EditionDbRow): TitleCollectionEditionRow {
  const members = getMemberRows(db, row.edition_key);
  return {
    editionKey: row.edition_key,
    manifestHash: row.manifest_hash,
    milestones: {
      startedCollecting: row.started_collecting,
      collectorHabit: row.collector_habit,
      stillCollecting: row.still_collecting,
      thousandMarks: { count: row.thousand_marks_count, domains: row.thousand_marks_domains },
      almostComplete: { remaining: row.almost_complete_remaining },
    },
    members: members.map((m) => ({
      titleKey: m.title_key,
      collectionDomainKey: m.collection_domain_key,
      collectionCredit: m.collection_credit === 1,
      fullClearRequired: m.full_clear_required === 1,
    })),
    activatedAt: row.activated_at,
    activatedBy: row.activated_by,
    activationNote: row.activation_note,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closeNote: row.close_note,
  };
}

/**
 * editionをactivateする。`assertCollectionEditionActivatable()`（構造契約 +
 * 現在時点のactivation eligibility）を必ず先に通す。
 *
 * - activeなeditionが既に別に存在する → reject
 * - editionKey未登録 → edition + membersをatomic insert、active pointerを設定
 * - 同editionKeyが既にactiveかつsemantic hash一致 → idempotentな"already_active"
 * - 同editionKeyだがhash不一致 → reject（editionは書き換えない）
 * - 同editionKeyがclosed済み → reject（reopen禁止）
 *
 * `activatedAt` はStore clockのsnapshot（呼び出しごとに1回だけ`clock()`を呼ぶ）。
 * callerが任意timestampを注入できない。
 */
export function activateCollectionEdition(
  db: Database.Database,
  clock: () => number,
  edition: TitleCollectionEdition,
  definitions: ReadonlyMap<string, TitleDefinition>,
  actorRaw: string,
  note?: string,
): ActivateCollectionEditionResult {
  if (db.inTransaction) {
    throw new Error("collection edition activation must start outside an existing transaction");
  }
  const actor = requireText(actorRaw, "actor");
  assertCollectionEditionActivatable(edition, definitions);
  const hash = computeCollectionEditionHash(edition);

  const tx = db.transaction((): ActivateCollectionEditionResult => {
    const state = requireState(db);
    const existing = getEditionRow(db, edition.editionKey);

    if (existing) {
      if (existing.closed_at !== null) {
        throw new Error(`collection edition ${edition.editionKey} is already closed; cannot reopen/reactivate it`);
      }
      if (existing.manifest_hash !== hash) {
        throw new Error(
          `collection edition ${edition.editionKey} is already registered with a different semantic hash — ` +
            `editions are immutable; use a new editionKey instead of changing content`,
        );
      }
      if (state.active_edition_key === edition.editionKey) {
        return { status: "already_active", edition: toPublicEdition(db, existing) };
      }
      // 存在してunclosedだがactive pointerと一致しない——通常運用では起こり得ない
      // state不整合（activate/close以外の経路でstateが操作された可能性）。
      throw new Error(
        `collection edition ${edition.editionKey} exists and is unclosed but is not the active edition ` +
          `(state inconsistency; active=${state.active_edition_key ?? "none"})`,
      );
    }

    if (state.active_edition_key !== null) {
      throw new Error(
        `cannot activate ${edition.editionKey}: another edition is already active (${state.active_edition_key})`,
      );
    }

    const activatedAt = requireUnix(clock(), "activatedAt");
    db.prepare(
      `INSERT INTO title_collection_editions
         (edition_key, manifest_hash, started_collecting, collector_habit, still_collecting,
          thousand_marks_count, thousand_marks_domains, almost_complete_remaining,
          activated_at, activated_by, activation_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      edition.editionKey,
      hash,
      edition.milestones.startedCollecting,
      edition.milestones.collectorHabit,
      edition.milestones.stillCollecting,
      edition.milestones.thousandMarks.count,
      edition.milestones.thousandMarks.domains,
      edition.milestones.almostComplete.remaining,
      activatedAt,
      actor,
      note ?? null,
    );

    const insertMember = db.prepare(
      `INSERT INTO title_collection_members
         (edition_key, title_key, collection_domain_key, collection_credit, full_clear_required)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const member of edition.members) {
      insertMember.run(
        edition.editionKey,
        member.titleKey,
        member.collectionDomainKey,
        member.collectionCredit ? 1 : 0,
        member.fullClearRequired ? 1 : 0,
      );
    }

    const pointerUpdate = db
      .prepare(`UPDATE title_collection_state SET active_edition_key = ? WHERE id = 1`)
      .run(edition.editionKey);
    if (pointerUpdate.changes !== 1) {
      throw new Error(
        `collection state integrity violation: failed to set active pointer to ${edition.editionKey} ` +
          `(expected exactly 1 row updated, got ${pointerUpdate.changes})`,
      );
    }

    const inserted = getEditionRow(db, edition.editionKey)!;
    return { status: "activated", edition: toPublicEdition(db, inserted) };
  });

  return tx.immediate();
}

/**
 * 現在activeなeditionをcloseする。close後はactive pointerがNULLになり、
 * 別のeditionをactivateできるようになる。closed editionは削除せず、historical
 * repairのために保持し続ける。
 *
 * - 存在しないeditionKey → throw
 * - 既にclosed済みで、かつ他に何もactiveでない → idempotentな"already_closed"
 *   （metadataは書き換えない）
 * - 既にclosed済みだが、別editionが現在active → reject（stale close request——
 *   このeditionKey自体は正しくclosed済みでも、その後の状態遷移を踏まえると
 *   今のこの呼び出しはもう意味を持たない、という区別をstateより先に確認する）
 * - closed済みではないが、別editionが現在active（このeditionはそもそもactiveに
 *   なったことが無い、等） → reject
 *
 * `closedAt` はStore clockのsnapshot。一度closedになったeditionは再open不可
 * （`activateCollectionEdition()` 側がreopenを拒否する）。
 */
export function closeCollectionEdition(
  db: Database.Database,
  clock: () => number,
  editionKeyRaw: string,
  actorRaw: string,
  note?: string,
): CloseCollectionEditionResult {
  if (db.inTransaction) {
    throw new Error("collection edition close must start outside an existing transaction");
  }
  const editionKey = requireText(editionKeyRaw, "editionKey");
  const actor = requireText(actorRaw, "actor");

  const tx = db.transaction((): CloseCollectionEditionResult => {
    const existing = getEditionRow(db, editionKey);
    if (!existing) throw new Error(`collection edition not found: ${editionKey}`);

    // stateを先に確認する——closed判定をstateより先に行うと、「targetは既にclosed済み
    // だが、別editionが現在active」というstale close requestを、単なる冪等な
    // already_closedとして誤って受理してしまう（このeditionKeyへのcloseが今
    // 意味を持つかどうかは、現在のactive pointerと合わせて見ないと判断できない）。
    const state = requireState(db);

    if (existing.closed_at !== null) {
      if (state.active_edition_key === null) {
        // 既にclosed済みで、かつ他に何もactiveでない——素直な冪等呼び出し。
        return { status: "already_closed", edition: toPublicEdition(db, existing) };
      }
      // 既にclosed済みだが、別editionが現在active——このclose要求はstale。
      throw new Error(
        `cannot close ${editionKey}: it is already closed and a different edition ` +
          `(${state.active_edition_key}) is now active (stale close request)`,
      );
    }

    if (state.active_edition_key !== editionKey) {
      throw new Error(`cannot close ${editionKey}: it is not the active edition (active=${state.active_edition_key ?? "none"})`);
    }

    const closedAt = requireUnix(clock(), "closedAt");
    db.prepare(`UPDATE title_collection_editions SET closed_at = ?, closed_by = ?, close_note = ? WHERE edition_key = ?`).run(
      closedAt,
      actor,
      note ?? null,
      editionKey,
    );
    const pointerClear = db
      .prepare(`UPDATE title_collection_state SET active_edition_key = NULL WHERE id = 1 AND active_edition_key = ?`)
      .run(editionKey);
    if (pointerClear.changes !== 1) {
      throw new Error(
        `collection state integrity violation: failed to clear active pointer for ${editionKey} ` +
          `(expected exactly 1 row updated, got ${pointerClear.changes})`,
      );
    }

    const closed = getEditionRow(db, editionKey)!;
    return { status: "closed", edition: toPublicEdition(db, closed) };
  });

  return tx.immediate();
}

/**
 * PR #152で決めた「active editionのpersisted manifestとruntime contractがズレて
 * いたらfail-closed」を実行可能にするAPI（PR B2）。まだbot startupへwiringしない
 * ——ここではAPIとtestsだけを用意する。
 *
 * runtime edition manifestを構造/activatable validationした上で、DB上のactive
 * editionとeditionKey・semantic hashの両方が一致することを確認する。どちらかが
 * 食い違えばfail-closedする。
 */
export function assertActiveCollectionEditionMatchesRuntime(
  db: Database.Database,
  runtimeEdition: TitleCollectionEdition,
  definitions: ReadonlyMap<string, TitleDefinition>,
): void {
  assertCollectionEditionActivatable(runtimeEdition, definitions);

  const state = requireState(db);
  if (state.active_edition_key === null) {
    throw new Error(
      `no active collection edition persisted in DB, but runtime expects ${runtimeEdition.editionKey} to be active`,
    );
  }
  if (state.active_edition_key !== runtimeEdition.editionKey) {
    throw new Error(
      `active collection edition mismatch: persisted=${state.active_edition_key}, runtime=${runtimeEdition.editionKey}`,
    );
  }
  const persisted = getEditionRow(db, state.active_edition_key);
  if (!persisted) {
    throw new Error(`active collection edition ${state.active_edition_key} pointer references a missing edition row`);
  }
  const runtimeHash = computeCollectionEditionHash(runtimeEdition);
  if (persisted.manifest_hash !== runtimeHash) {
    throw new Error(
      `active collection edition ${runtimeEdition.editionKey}: persisted manifest hash does not match the ` +
        `runtime contract (drift between DB snapshot and current code)`,
    );
  }
}

/**
 * userのcollection/full-clear進捗を返す（PR B2）。active editionは現在の
 * `title_ownerships` を使う。closed editionは module doc comment の
 * historical repair proof契約（§16）だけをowned扱いする——close後に通常取得した
 * titleはold edition progressを増やさない。
 */
export function collectionEditionProgress(
  db: Database.Database,
  userIdRaw: string,
  editionKeyRaw: string,
): CollectionEditionProgress {
  const userId = requireText(userIdRaw, "userId");
  const editionKey = requireText(editionKeyRaw, "editionKey");
  const edition = getEditionRow(db, editionKey);
  if (!edition) throw new Error(`collection edition not found: ${editionKey}`);
  const members = getMemberRows(db, editionKey);

  const ownedSet = new Set<string>();
  if (edition.closed_at === null) {
    if (members.length > 0) {
      const placeholders = members.map(() => "?").join(",");
      const owned = db
        .prepare(`SELECT title_key FROM title_ownerships WHERE user_id = ? AND title_key IN (${placeholders})`)
        .all(userId, ...members.map((m) => m.title_key)) as Array<{ title_key: string }>;
      for (const o of owned) ownedSet.add(o.title_key);
    }
  } else {
    const closedAt = edition.closed_at;
    if (members.length > 0) {
      const placeholders = members.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT title_key FROM title_awards
            WHERE user_id = ? AND title_key IN (${placeholders})
              AND ((earned_at IS NOT NULL AND earned_at < ?) OR awarded_at < ?)
            GROUP BY title_key`,
        )
        .all(userId, ...members.map((m) => m.title_key), closedAt, closedAt) as Array<{ title_key: string }>;
      for (const r of rows) ownedSet.add(r.title_key);
    }
  }

  let collectionOwnedCount = 0;
  let collectionTotalCount = 0;
  let fullClearOwnedCount = 0;
  let fullClearRequiredCount = 0;
  const totalDomains = new Set<string>();
  const ownedDomains = new Set<string>();

  for (const m of members) {
    if (m.collection_credit === 1) {
      collectionTotalCount += 1;
      totalDomains.add(m.collection_domain_key);
      if (ownedSet.has(m.title_key)) {
        collectionOwnedCount += 1;
        ownedDomains.add(m.collection_domain_key);
      }
    }
    if (m.full_clear_required === 1) {
      fullClearRequiredCount += 1;
      if (ownedSet.has(m.title_key)) fullClearOwnedCount += 1;
    }
  }

  return {
    editionKey,
    state: edition.closed_at === null ? "active" : "closed",
    collectionOwnedCount,
    collectionTotalCount,
    collectionOwnedDomainCount: ownedDomains.size,
    collectionTotalDomainCount: totalDomains.size,
    fullClearOwnedCount,
    fullClearRequiredCount,
    fullClearRemainingCount: fullClearRequiredCount - fullClearOwnedCount,
    fullClearComplete: fullClearOwnedCount === fullClearRequiredCount,
  };
}

export function activeCollectionEdition(db: Database.Database): TitleCollectionEditionRow | null {
  const state = requireState(db);
  if (state.active_edition_key === null) return null;
  const row = getEditionRow(db, state.active_edition_key);
  if (!row) {
    // pointerが指すedition行が無い——「activeなeditionが無い」正常状態と混同しない。
    // FK自体は満たしていても（例えば行が別途削除された等）integrity violation。
    throw new Error(
      `collection state integrity violation: active pointer (${state.active_edition_key}) references a missing edition row`,
    );
  }
  return toPublicEdition(db, row);
}

/**
 * editionKey指定でmanifestを読む管理用API。member titleKeyを含む——**ユーザー向け
 * progress rendererへそのまま渡してよいAPIではない**（hidden titleを漏らし得る）。
 * ユーザー向け表示には `collectionEditionProgress()` を使うこと。
 */
export function collectionEdition(db: Database.Database, editionKeyRaw: string): TitleCollectionEditionRow | null {
  const editionKey = requireText(editionKeyRaw, "editionKey");
  const row = getEditionRow(db, editionKey);
  return row ? toPublicEdition(db, row) : null;
}

/** 全editionの一覧（管理用）。§`collectionEdition()`と同じhidden title leak注意。 */
export function listCollectionEditions(db: Database.Database): TitleCollectionEditionRow[] {
  const rows = db.prepare(`SELECT edition_key FROM title_collection_editions ORDER BY activated_at`).all() as Array<{
    edition_key: string;
  }>;
  return rows.map((r) => toPublicEdition(db, getEditionRow(db, r.edition_key)!));
}

/**
 * collection edition persistenceのsemantic integrityをfail-closedで検証する
 * （`TitleV2Store` construction時に呼ぶ）。construction時点ではruntimeの
 * `TitleDefinition` mapが無いため、「現在title lifecycle=activeか」はここで判定
 * しない（それはactivation/`assertActiveCollectionEditionMatchesRuntime()`の責務）。
 *
 * - active pointerがNULLならunclosed editionは0件
 * - active pointerが非NULLなら対応editionが存在しclosed_at IS NULL
 * - unclosed editionはexactly 1件
 * - closed metadata chronology valid（closed_at>=activated_at、closed_by整合）
 * - members/milestones構造整合（DB member snapshotから再計算した値がmilestoneの
 *   不等式契約を満たす）
 * - 保存済みmanifest_hashが、DB snapshotから再計算したhashと一致する
 */
export function assertCollectionPersistenceIntegrity(db: Database.Database): void {
  const state = requireState(db);
  const unclosedEditions = db
    .prepare(`SELECT edition_key FROM title_collection_editions WHERE closed_at IS NULL`)
    .all() as Array<{ edition_key: string }>;

  if (state.active_edition_key === null) {
    if (unclosedEditions.length > 0) {
      throw new Error(
        `collection state integrity violation: active pointer is NULL but ${unclosedEditions.length} unclosed ` +
          `edition(s) exist (e.g. ${unclosedEditions[0]!.edition_key})`,
      );
    }
  } else {
    const found = unclosedEditions.some((e) => e.edition_key === state.active_edition_key);
    if (!found) {
      throw new Error(
        `collection state integrity violation: active pointer (${state.active_edition_key}) does not reference ` +
          `an existing unclosed edition`,
      );
    }
  }
  if (unclosedEditions.length > 1) {
    throw new Error(
      `collection state integrity violation: ${unclosedEditions.length} unclosed editions exist ` +
        `(expected at most 1): ${unclosedEditions.map((e) => e.edition_key).join(", ")}`,
    );
  }

  const allEditions = db.prepare(`SELECT * FROM title_collection_editions`).all() as EditionDbRow[];
  for (const row of allEditions) {
    const fail = (message: string): never => {
      throw new Error(`collection edition integrity violation: ${row.edition_key}: ${message}`);
    };

    // structural integrity（manifest_hashとは独立して再検証する）。runtime
    // definitionsはここには無いため、title existence / behavior-vs-meta種別 /
    // lifecycle / definition側のcollectionDomainKey一致まではここで証明できない
    // ——それはactivateCollectionEdition()呼び出し時の
    // assertCollectionEditionActivatable()の責務。
    try {
      assertSlug(row.edition_key, "edition_key");
    } catch {
      fail(`edition_key is not a valid slug: ${JSON.stringify(row.edition_key)}`);
    }

    if (!Number.isInteger(row.activated_at) || row.activated_at < 0) fail("invalid activated_at");
    if (row.closed_at !== null) {
      if (!Number.isInteger(row.closed_at) || row.closed_at < row.activated_at) fail("closed_at chronology invalid");
      if (row.closed_by === null) fail("closed_at set but closed_by is NULL");
    } else if (row.closed_by !== null) {
      fail("closed_by is set but closed_at is NULL");
    }

    const members = getMemberRows(db, row.edition_key);
    if (members.length === 0) fail("has no members");

    let countableCount = 0;
    let fullClearCount = 0;
    const countableDomains = new Set<string>();
    for (const m of members) {
      if (!m.title_key.startsWith("v2.") || m.title_key.length <= 3) {
        fail(`member titleKey must use v2.* namespace: ${m.title_key}`);
      }
      try {
        assertSlug(m.collection_domain_key, "collectionDomainKey");
      } catch {
        fail(`member ${m.title_key} has an invalid collectionDomainKey: ${JSON.stringify(m.collection_domain_key)}`);
      }
      if (m.collection_credit !== 0 && m.collection_credit !== 1) {
        fail(`member ${m.title_key} has an invalid collection_credit (${m.collection_credit}; must be 0 or 1)`);
      }
      if (m.full_clear_required !== 0 && m.full_clear_required !== 1) {
        fail(`member ${m.title_key} has an invalid full_clear_required (${m.full_clear_required}; must be 0 or 1)`);
      }
      if (m.collection_credit !== 1 && m.full_clear_required !== 1) {
        fail(`member ${m.title_key} is neither collectionCredit nor fullClearRequired (meaningless edition member)`);
      }
      if (m.collection_credit === 1) {
        countableCount += 1;
        countableDomains.add(m.collection_domain_key);
      }
      if (m.full_clear_required === 1) fullClearCount += 1;
    }
    if (fullClearCount === 0) fail("no fullClearRequired member");

    const milestoneEntries: ReadonlyArray<readonly [string, number]> = [
      ["startedCollecting", row.started_collecting],
      ["collectorHabit", row.collector_habit],
      ["stillCollecting", row.still_collecting],
      ["thousandMarks.count", row.thousand_marks_count],
      ["thousandMarks.domains", row.thousand_marks_domains],
      ["almostComplete.remaining", row.almost_complete_remaining],
    ];
    for (const [label, value] of milestoneEntries) {
      if (!Number.isInteger(value) || value < 0) fail(`milestone ${label} must be a non-negative integer, got ${value}`);
    }

    if (!(row.started_collecting >= 1)) fail("startedCollecting must be >= 1");
    if (!(row.started_collecting < row.collector_habit)) fail("startedCollecting must be < collectorHabit");
    if (!(row.collector_habit < row.still_collecting)) fail("collectorHabit must be < stillCollecting");
    if (!(row.still_collecting <= row.thousand_marks_count)) fail("stillCollecting must be <= thousandMarks.count");
    if (!(row.thousand_marks_count <= countableCount)) fail("thousandMarks.count exceeds countable collection count");
    if (!(row.thousand_marks_domains >= 1)) fail("thousandMarks.domains must be >= 1");
    if (!(row.thousand_marks_domains <= countableDomains.size)) fail("thousandMarks.domains exceeds countable domain count");
    if (!(row.thousand_marks_domains <= row.thousand_marks_count)) fail("thousandMarks.domains must be <= thousandMarks.count");
    if (!(row.almost_complete_remaining >= 1)) fail("almostComplete.remaining must be >= 1");
    if (!(row.almost_complete_remaining < fullClearCount)) fail("almostComplete.remaining must be < fullClearRequired count");

    const recomputed = computeCollectionEditionHash({
      editionKey: row.edition_key,
      members: members.map((m) => ({
        titleKey: m.title_key as `v2.${string}`,
        collectionDomainKey: m.collection_domain_key,
        collectionCredit: m.collection_credit === 1,
        fullClearRequired: m.full_clear_required === 1,
      })),
      milestones: {
        startedCollecting: row.started_collecting,
        collectorHabit: row.collector_habit,
        stillCollecting: row.still_collecting,
        thousandMarks: { count: row.thousand_marks_count, domains: row.thousand_marks_domains },
        almostComplete: { remaining: row.almost_complete_remaining },
      },
    });
    if (recomputed !== row.manifest_hash) {
      fail("stored manifest_hash does not match the hash recomputed from its DB snapshot (mutated out of band)");
    }
  }
}
