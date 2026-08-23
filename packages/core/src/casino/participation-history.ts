import type Database from "better-sqlite3";

/**
 * 賭場のneutral participation正本（PR E4）。
 *
 * `CasinoMetrics`（wager/payout/net/resultを持つanalytics正本）とは完全に別module。
 * ここに保存するのは「このuserが、このcasino activityへのsuccessful funded
 * participation commitmentを行った」という事実だけ——何回賭けたか・いくら賭けたか・
 * 勝敗のいずれも保存しない。
 *
 * `activityKey`はstable machine identityのallowlist——表示名やmode文字列をそのまま
 * 保存しない（PVP BJもsolo blackjackも同じ`"blackjack"`へ正規化する）。writer/reader
 * 両方がこの同じallowlistを参照する（single source of truth、E2の
 * `SAFE_PEER_ECONOMY_TYPES`と同じ考え方）。
 */
export const CASINO_ACTIVITY_KEYS = [
  "slots",
  "chohan",
  "crash",
  "chinchiro",
  "blackjack",
  "poker",
  "holdem",
  "roulette",
  "keiba",
  "sashi",
  "indian",
] as const;

export type CasinoActivityKey = (typeof CASINO_ACTIVITY_KEYS)[number];

const VALID_CASINO_ACTIVITY_KEYS: ReadonlySet<string> = new Set(CASINO_ACTIVITY_KEYS);

export function isCasinoActivityKey(value: string): value is CasinoActivityKey {
  return VALID_CASINO_ACTIVITY_KEYS.has(value);
}

export interface RecordCommittedParticipationInput {
  /**
   * 内部のidempotency identity。同じ実参加のretryは同じparticipationKeyになる
   * （例: solo = game + stable operation id、roulette/keiba = session + user、
   * PVP = funded session + user）。Title source payloadへは絶対に出さない。
   */
  readonly participationKey: string;
  readonly activityKey: CasinoActivityKey;
  readonly participantUserIds: readonly string[];
}

export interface RecordCommittedParticipationResult {
  readonly participationKey: string;
  readonly activityKey: CasinoActivityKey;
  readonly participantCount: number;
  readonly occurredAt: number;
  readonly alreadyRecorded: boolean;
}

/**
 * PR F2b: そのfunded participationについて、ゲーム固有のcanonical financial
 * resolution primitive（正常なsettlement、またはゲームルール上の正常な
 * draw/push等の解決）が成功したことを直接観測したという事実。inputの識別子は
 * commitment writerと同じidentity——`recordCompletedParticipation()`は必ず
 * 既存`casino_participations`を照合してから書く（commitment無しのcompletion
 * は成立しない）。
 */
export interface RecordCompletedParticipationInput {
  readonly participationKey: string;
  readonly activityKey: CasinoActivityKey;
  readonly participantUserIds: readonly string[];
}

export interface RecordCompletedParticipationResult {
  readonly participationKey: string;
  readonly activityKey: CasinoActivityKey;
  readonly participantCount: number;
  readonly completedAt: number;
  readonly alreadyRecorded: boolean;
}

export type CasinoParticipationErrorCode =
  | "invalid_participation_key"
  | "invalid_activity_key"
  | "invalid_participant"
  | "empty_participants"
  | "conflict"
  | "missing_commitment"
  | "completed_before_committed";

export class CasinoParticipationError extends Error {
  constructor(
    readonly code: CasinoParticipationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CasinoParticipationError";
  }
}

function assertParticipationKey(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new CasinoParticipationError("invalid_participation_key", "participationKey must be a non-empty string");
  return trimmed;
}

function assertActivityKey(value: string): CasinoActivityKey {
  if (typeof value !== "string" || !isCasinoActivityKey(value)) {
    throw new CasinoParticipationError("invalid_activity_key", `unknown activityKey: ${JSON.stringify(value)}`);
  }
  return value;
}

/** 最初の出現順を保ったままdedupeする。空/非string idはfail-closedでreject。 */
function dedupeParticipants(userIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of userIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) throw new CasinoParticipationError("invalid_participant", "participant userId must be a non-empty string");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 入力順をsemanticにしない同値比較: sortしてから比較する。 */
function sameParticipantSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

const defaultClock = () => Math.floor(Date.now() / 1000);

export class CasinoParticipationHistory {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => number = defaultClock,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_participations (
        participation_key TEXT NOT NULL,
        user_id            TEXT NOT NULL,
        activity_key       TEXT NOT NULL,
        occurred_at        INTEGER NOT NULL CHECK(occurred_at >= 0),
        PRIMARY KEY(participation_key, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_casino_participations_user
        ON casino_participations(user_id, occurred_at);

      -- PR F2b: commitment（上記casino_participations）とは別のimmutable正本。
      -- 「funded participationを開始した」ではなく「そのparticipationのゲーム固有
      -- canonical financial resolution primitiveが成功した」ことだけを表す。
      -- activity_keyはここへ複製しない——activity identityは常にparent commitment
      -- rowを正本にする（recordCompletedParticipation()が必ず照合する）。
      CREATE TABLE IF NOT EXISTS casino_participation_completions (
        participation_key TEXT NOT NULL,
        user_id            TEXT NOT NULL,
        completed_at       INTEGER NOT NULL CHECK(completed_at >= 0),
        PRIMARY KEY(participation_key, user_id),
        FOREIGN KEY(participation_key, user_id)
          REFERENCES casino_participations(participation_key, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_casino_participation_completions_user
        ON casino_participation_completions(user_id, completed_at);
    `);
  }

  /**
   * successful funded participation commitmentを1 atomic writeで記録する。
   *
   * - `occurredAt`はこのservice自身のclockが正本——callerが渡すtimestampは一切
   *   受け取らない。同一呼び出し内の全participantは1 clock snapshot。
   * - 同一participationKeyの再送で、activityKey/participant set（集合比較、
   *   入力順に依存しない）が完全一致するときだけ`alreadyRecorded:true`の冪等成功を
   *   返す。occurred_atは既存値を維持し更新しない。1件でも違えばconflict error——
   *   既存rowを上書きしない。
   * - 全participant rowを単一transactionで書く——途中の1件が失敗すれば全rollback。
   */
  recordCommittedParticipation(input: RecordCommittedParticipationInput): RecordCommittedParticipationResult {
    const participationKey = assertParticipationKey(input.participationKey);
    const activityKey = assertActivityKey(input.activityKey);
    const participantUserIds = dedupeParticipants(input.participantUserIds);
    if (participantUserIds.length === 0) {
      throw new CasinoParticipationError("empty_participants", "participantUserIds must contain at least one participant");
    }

    const existingRows = this.db
      .prepare(`SELECT user_id, activity_key, occurred_at FROM casino_participations WHERE participation_key = ?`)
      .all(participationKey) as Array<{ user_id: string; activity_key: string; occurred_at: number }>;

    if (existingRows.length > 0) {
      const existingUserIds = existingRows.map((r) => r.user_id);
      const existingActivityKey = existingRows[0]!.activity_key;
      const existingOccurredAt = existingRows[0]!.occurred_at;
      // 同一participation_key内でactivity_key/occurred_atが割れていたらDB corruption
      // ——先頭行だけを代表値として信用せずfail-closedする（immutable evidence storeの
      // 堅牢性、PR #163レビュー§7）。
      const rowsConsistent = existingRows.every(
        (r) => r.activity_key === existingActivityKey && r.occurred_at === existingOccurredAt,
      );
      if (!rowsConsistent) {
        throw new CasinoParticipationError(
          "conflict",
          `participation ${participationKey} has inconsistent stored rows (mixed activity_key/occurred_at) — refusing to treat as idempotent`,
        );
      }
      const identical =
        existingActivityKey === activityKey && sameParticipantSet(existingUserIds, participantUserIds);

      if (identical) {
        return {
          participationKey,
          activityKey,
          participantCount: existingUserIds.length,
          occurredAt: existingRows[0]!.occurred_at,
          alreadyRecorded: true,
        };
      }
      throw new CasinoParticipationError(
        "conflict",
        `participation ${participationKey} was already recorded with a different activity/participant set — participation history is immutable`,
      );
    }

    const occurredAt = this.clock();
    const insertParticipant = this.db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      for (const userId of participantUserIds) insertParticipant.run(participationKey, userId, activityKey, occurredAt);
    });
    run();

    return { participationKey, activityKey, participantCount: participantUserIds.length, occurredAt, alreadyRecorded: false };
  }

  /**
   * PR F2b: そのfunded participationについて、canonical financial resolution
   * primitiveの成功を1 atomic writeで記録する。
   *
   * - commitment無しのcompletionは成立しない——`participationKey`に対応する
   *   `casino_participations`行が実在しない場合は`missing_commitment`でreject。
   * - 渡された`activityKey`/`participantUserIds`はparent commitment行と
   *   完全一致していなければならない（1件でも違えばconflict）——commitment writer
   *   と別のidentityでcompletionを書けない。
   * - parent commitment行自身のactivity_key/occurred_atが割れているDB corruption
   *   （`recordCommittedParticipation()`のfail-closed guardと同じ考え方）も
   *   `conflict`でreject。
   * - `completedAt`はこのservice自身のclockが正本——callerが渡すtimestampは一切
   *   受け取らない。commitmentの`occurredAt`より前にはできない
   *   （`completed_before_committed`）。
   * - 同一participationKeyの再送で、既存completion行が committed participant set
   *   と完全一致するときだけ`alreadyRecorded:true`の冪等成功を返す。1人分だけ
   *   completion行がある等の部分/破損状態は idempotent 扱いせず`conflict`で
   *   fail-closedする（§7 partial corruption guardと同じ考え方）。
   * - commitment行自体はここでUPDATEしない——読むだけ。
   * - 全participant行を単一transactionで書く——途中の1件が失敗すれば全rollback。
   */
  recordCompletedParticipation(input: RecordCompletedParticipationInput): RecordCompletedParticipationResult {
    const participationKey = assertParticipationKey(input.participationKey);
    const activityKey = assertActivityKey(input.activityKey);
    const participantUserIds = dedupeParticipants(input.participantUserIds);
    if (participantUserIds.length === 0) {
      throw new CasinoParticipationError("empty_participants", "participantUserIds must contain at least one participant");
    }

    const commitmentRows = this.db
      .prepare(`SELECT user_id, activity_key, occurred_at FROM casino_participations WHERE participation_key = ?`)
      .all(participationKey) as Array<{ user_id: string; activity_key: string; occurred_at: number }>;
    if (commitmentRows.length === 0) {
      throw new CasinoParticipationError(
        "missing_commitment",
        `no committed participation found for ${participationKey} — completion cannot be recorded without a prior commitment`,
      );
    }
    const commitmentUserIds = commitmentRows.map((r) => r.user_id);
    const commitmentActivityKey = commitmentRows[0]!.activity_key;
    const commitmentOccurredAt = commitmentRows[0]!.occurred_at;
    const commitmentRowsConsistent = commitmentRows.every(
      (r) => r.activity_key === commitmentActivityKey && r.occurred_at === commitmentOccurredAt,
    );
    if (!commitmentRowsConsistent) {
      throw new CasinoParticipationError(
        "conflict",
        `participation ${participationKey} has inconsistent commitment rows (mixed activity_key/occurred_at) — refusing to record completion`,
      );
    }
    if (commitmentActivityKey !== activityKey || !sameParticipantSet(commitmentUserIds, participantUserIds)) {
      throw new CasinoParticipationError(
        "conflict",
        `completion for ${participationKey} does not match the committed activity/participant set`,
      );
    }

    const existingCompletionRows = this.db
      .prepare(`SELECT user_id, completed_at FROM casino_participation_completions WHERE participation_key = ?`)
      .all(participationKey) as Array<{ user_id: string; completed_at: number }>;
    if (existingCompletionRows.length > 0) {
      const existingCompletedAt = existingCompletionRows[0]!.completed_at;
      const existingUserIds = existingCompletionRows.map((r) => r.user_id);
      const completionRowsConsistent = existingCompletionRows.every((r) => r.completed_at === existingCompletedAt);
      if (!completionRowsConsistent || !sameParticipantSet(existingUserIds, participantUserIds)) {
        throw new CasinoParticipationError(
          "conflict",
          `completion ${participationKey} has inconsistent or partial stored rows — refusing to treat as idempotent`,
        );
      }
      if (existingCompletedAt < commitmentOccurredAt) {
        throw new CasinoParticipationError(
          "completed_before_committed",
          `stored completedAt (${existingCompletedAt}) precedes commitment occurredAt (${commitmentOccurredAt}) for ${participationKey} — refusing to treat as idempotent`,
        );
      }
      return {
        participationKey,
        activityKey,
        participantCount: existingUserIds.length,
        completedAt: existingCompletedAt,
        alreadyRecorded: true,
      };
    }

    const completedAt = this.clock();
    if (completedAt < commitmentOccurredAt) {
      throw new CasinoParticipationError(
        "completed_before_committed",
        `completedAt (${completedAt}) precedes commitment occurredAt (${commitmentOccurredAt}) for ${participationKey}`,
      );
    }
    const insertCompletion = this.db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      for (const userId of participantUserIds) insertCompletion.run(participationKey, userId, completedAt);
    });
    run();

    return { participationKey, activityKey, participantCount: participantUserIds.length, completedAt, alreadyRecorded: false };
  }
}
