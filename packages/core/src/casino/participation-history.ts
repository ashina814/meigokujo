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

export type CasinoParticipationErrorCode =
  | "invalid_participation_key"
  | "invalid_activity_key"
  | "invalid_participant"
  | "empty_participants"
  | "conflict";

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
}
