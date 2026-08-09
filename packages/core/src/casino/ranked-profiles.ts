import type Database from "better-sqlite3";
import { canonicalStringify } from "./opening-canonical.js";
import {
  RANKED_TABLE_TIERS,
  RankedTableError,
  validateRankProfile,
  type GenericRankProfile,
} from "./ranked-tables.js";

/**
 * 汎用順位卓の「運営が登録した信頼プロファイル」の台帳（PR24）。
 *
 * ## なぜ登録制なのか
 *
 * GF・三麻・四麻は core に正本の順位配分（`RANKED_PROFILES`）がある。それ以外の
 * 汎用順位卓は `profileForGame()` が **explicit な信頼プロファイル**を要求する設計で、
 * 「誰がその配分を決めてよいか」だけがコード上で未定義だった。
 *
 * 順位配分は**配当の分配式そのもの**なので、賭博場従業員に決めさせるわけにはいかない
 * （PR24 の「従業員は金銭を操作しない」に反する）。かといって仕様に無い配分式を
 * コードで新しく発明するのも禁止。そこで「運営が登録し、従業員は登録済みのものから
 * 選ぶだけ」にする。
 *
 * ## 安全性
 *
 * 配分の妥当性判定は既存の {@link validateRankProfile} をそのまま使う。
 * ゼロ和・整数Land・受取非負・プール保存はすべてそこで検査済みで、ここでは
 * **新しい判定規則を一切足していない**。登録時に全ランクの基準額で検査するので、
 * 従業員がどの卓ランクを選んでも卓作成時の再検査に落ちない。
 */

export type RankedProfileErrorCode = "ERR_RANKED_PROFILE_CONFLICT" | "ERR_RANKED_PROFILE_NOT_FOUND" | "ERR_RANKED_PROFILE_RESERVED";

export class RankedProfileError extends Error {
  constructor(
    readonly code: RankedProfileErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RankedProfileError";
  }
}

export interface RankedProfileRow {
  profileKey: string;
  label: string;
  participantCount: number;
  rankDeltaBps: number[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterRankedProfileInput {
  profileKey: string;
  label: string;
  participantCount: number;
  rankDeltaBps: number[];
  actorId: string;
  operationId: string;
}

export interface RankedProfilesOptions {
  now?: () => number;
}

/** core が正本を持つゲーム。登録名として奪えないようにする */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["gf", "sanma", "yonma"]);

export class RankedProfiles {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    options: RankedProfilesOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  ensureSchemaForTesting(): void {
    this.ensureSchema();
  }

  /**
   * 信頼プロファイルを登録する（運営専用。呼び出し側で権限を確認すること）。
   *
   * 同じ `operationId` の再実行は保存済みの内容を返す。内容だけ違う再実行は取り違えとして拒否。
   * 既存の `profileKey` を別内容で登録し直すのも拒否する（進行中の卓が参照する配分を
   * 後から書き換えられないようにする。卓側は作成時点の配分を `casino_tables` へ写している）。
   */
  register(input: RegisterRankedProfileInput): RankedProfileRow {
    const profileKey = requiredKey(input.profileKey);
    const label = requiredLabel(input.label);
    const actorId = requiredText(input.actorId, "actorId");
    const operationId = requiredText(input.operationId, "operationId");
    if (RESERVED_KEYS.has(profileKey)) {
      throw new RankedProfileError("ERR_RANKED_PROFILE_RESERVED", "this profile key is owned by core", { profileKey });
    }
    const profile: GenericRankProfile = {
      key: profileKey,
      participantCount: input.participantCount,
      rankDeltaBps: input.rankDeltaBps,
    };
    // 既存の検査をそのまま使う。全ランクの基準額で通ることを確かめておけば、
    // 従業員がどのランクを選んでも卓作成時に落ちない（最小の見習卓が最も厳しい）
    for (const tier of RANKED_TABLE_TIERS) validateRankProfile(profile, tier.baseAmount);
    const rankDeltaBps = [...input.rankDeltaBps];
    const fingerprint = canonicalStringify({ profileKey, label, participantCount: input.participantCount, rankDeltaBps });
    const tx = this.db.transaction((): RankedProfileRow => {
      this.ensureSchema();
      const replay = this.db
        .prepare("SELECT profile_key, request_fingerprint FROM casino_ranked_profiles WHERE operation_id=?")
        .get(operationId) as { profile_key: string; request_fingerprint: string } | undefined;
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) {
          throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile operation replay conflict", { operationId });
        }
        return this.required(replay.profile_key);
      }
      const existing = this.db
        .prepare("SELECT request_fingerprint FROM casino_ranked_profiles WHERE profile_key=?")
        .get(profileKey) as { request_fingerprint: string } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile key already exists with a different distribution", {
            profileKey,
          });
        }
        return this.required(profileKey);
      }
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO casino_ranked_profiles
             (profile_key, label, participant_count, rank_delta_bps_json, created_by, operation_id, request_fingerprint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(profileKey, label, input.participantCount, canonicalStringify(rankDeltaBps), actorId, operationId, fingerprint, at, at);
      return this.required(profileKey);
    });
    return tx.immediate();
  }

  /** 登録済みプロファイルを削除する（運営専用）。既に開いた卓の配分は卓側に写してあるので影響しない */
  remove(profileKey: string, actorId: string): boolean {
    const key = requiredKey(profileKey);
    requiredText(actorId, "actorId");
    this.ensureSchema();
    return this.db.prepare("DELETE FROM casino_ranked_profiles WHERE profile_key=?").run(key).changes > 0;
  }

  list(): RankedProfileRow[] {
    if (!this.tableExists()) return [];
    const rows = this.db.prepare("SELECT * FROM casino_ranked_profiles ORDER BY profile_key").all() as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  get(profileKey: string): RankedProfileRow | null {
    if (!this.tableExists()) return null;
    const row = this.db.prepare("SELECT * FROM casino_ranked_profiles WHERE profile_key=?").get(requiredKey(profileKey)) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** 卓作成へ渡す形。登録が無ければ fail-closed（勝手に既定配分を作らない） */
  requiredProfile(profileKey: string): GenericRankProfile {
    const row = this.get(profileKey);
    if (!row) {
      throw new RankedProfileError("ERR_RANKED_PROFILE_NOT_FOUND", "ranked profile is not registered", { profileKey });
    }
    return { key: row.profileKey, participantCount: row.participantCount, rankDeltaBps: row.rankDeltaBps };
  }

  private required(profileKey: string): RankedProfileRow {
    const row = this.get(profileKey);
    if (!row) throw new RankedProfileError("ERR_RANKED_PROFILE_NOT_FOUND", "ranked profile was not stored", { profileKey });
    return row;
  }

  private tableExists(): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_ranked_profiles'").get();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_ranked_profiles (
        profile_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        participant_count INTEGER NOT NULL CHECK(participant_count >= 2),
        rank_delta_bps_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
}

function mapRow(row: Record<string, unknown>): RankedProfileRow {
  const raw = row.rank_delta_bps_json;
  if (typeof raw !== "string") throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile vector is corrupt", { row });
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((v) => Number.isSafeInteger(v))) {
    throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile vector is corrupt", { row });
  }
  return {
    profileKey: String(row.profile_key),
    label: String(row.label),
    participantCount: Number(row.participant_count),
    rankDeltaBps: parsed as number[],
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function requiredKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_-]{2,40}$/.test(value)) {
    throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile key must be 2-40 chars of [a-z0-9_-]", { value });
  }
  return value;
}

function requiredLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 60) {
    throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile label must be 1-60 chars", { value });
  }
  return value.trim();
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RankedProfileError("ERR_RANKED_PROFILE_CONFLICT", "ranked profile text field is invalid", { field });
  }
  return value;
}

/** 汎用順位卓かどうか（core が正本を持つ3種以外） */
export function isGenericRankedGame(gameKey: string): boolean {
  return !RESERVED_KEYS.has(gameKey);
}
