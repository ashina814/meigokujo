import type Database from "better-sqlite3";
import {
  TEXT_TIERS,
  VOICE_TIERS,
  tierFor,
  textLevel,
  textProgress,
  voiceLevel,
  voiceProgress,
  nextTier as _nextTier,
  type RankTier,
} from "./tiers.js";

/**
 * 発言・ボイスのランク（レベル・称号）を管理するサービス。
 * XPはメッセージ投稿とVC滞在で溜まる。
 * XP付与ロジック(クールダウン・除外判定)はここで一括、除外チャンネル判定はbot側で行う。
 */

export interface RankSnapshot {
  userId: string;
  xp: number;
  level: number;
  tier: RankTier;
  progress: { inLevel: number; toNext: number };
}

export interface RankAward {
  awarded: number;                       // 付与されたXP
  before: RankSnapshot;
  after: RankSnapshot;
  tierUp: boolean;                       // 称号が変わったか
}

const now = () => Math.floor(Date.now() / 1000);

export class RankEngine {
  constructor(private readonly db: Database.Database) {}

  // ---- テキスト ----

  /** 発言XPの付与（クールダウン内はスキップして0を返す）*/
  awardText(userId: string, xp: number, cooldownSec: number): RankAward | null {
    const row = this.getText(userId);
    const ts = now();
    if (row.last_award_at + cooldownSec > ts) return null;

    const before = this.snapshotText(row.xp);
    const newXp = row.xp + xp;
    this.db
      .prepare(
        `INSERT INTO rank_text (user_id, xp, messages, last_award_at, last_tier, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           xp = excluded.xp, messages = rank_text.messages + 1,
           last_award_at = excluded.last_award_at,
           last_tier = excluded.last_tier,
           updated_at = excluded.updated_at`,
      )
      .run(userId, newXp, ts, tierIndex(textLevel(newXp), TEXT_TIERS), ts);
    const after = this.snapshotText(newXp);
    return { awarded: xp, before, after, tierUp: before.tier.name !== after.tier.name };
  }

  /** 単に発言回数だけ増やしたい場合（クールダウン中でも記録したいなら別途） */
  bumpTextMessages(userId: string): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO rank_text (user_id, xp, messages, updated_at)
         VALUES (?, 0, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           messages = rank_text.messages + 1, updated_at = excluded.updated_at`,
      )
      .run(userId, ts);
  }

  getText(userId: string): {
    user_id: string; xp: number; messages: number; last_award_at: number; last_tier: number;
  } {
    const row = this.db.prepare("SELECT * FROM rank_text WHERE user_id = ?").get(userId) as
      | { user_id: string; xp: number; messages: number; last_award_at: number; last_tier: number; updated_at: number }
      | undefined;
    return row ?? { user_id: userId, xp: 0, messages: 0, last_award_at: 0, last_tier: 0 };
  }

  snapshotText(xp: number): RankSnapshot {
    const p = textProgress(xp);
    return {
      userId: "",
      xp,
      level: p.level,
      tier: tierFor(p.level, TEXT_TIERS),
      progress: { inLevel: p.inLevel, toNext: p.toNext },
    };
  }

  // ---- ボイス ----

  /** ボイスXPの付与（VCスキャンから、対象条件を満たす人へ）*/
  awardVoice(userId: string, xp: number, minutes: number): RankAward {
    const row = this.getVoice(userId);
    const ts = now();
    const before = this.snapshotVoice(row.xp);
    const newXp = row.xp + xp;
    this.db
      .prepare(
        `INSERT INTO rank_voice (user_id, xp, minutes, last_award_at, last_tier, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           xp = excluded.xp,
           minutes = rank_voice.minutes + ?,
           last_award_at = excluded.last_award_at,
           last_tier = excluded.last_tier,
           updated_at = excluded.updated_at`,
      )
      .run(userId, newXp, minutes, ts, tierIndex(voiceLevel(newXp), VOICE_TIERS), ts, minutes);
    const after = this.snapshotVoice(newXp);
    return { awarded: xp, before, after, tierUp: before.tier.name !== after.tier.name };
  }

  getVoice(userId: string): {
    user_id: string; xp: number; minutes: number; last_award_at: number; last_tier: number;
  } {
    const row = this.db.prepare("SELECT * FROM rank_voice WHERE user_id = ?").get(userId) as
      | { user_id: string; xp: number; minutes: number; last_award_at: number; last_tier: number; updated_at: number }
      | undefined;
    return row ?? { user_id: userId, xp: 0, minutes: 0, last_award_at: 0, last_tier: 0 };
  }

  snapshotVoice(xp: number): RankSnapshot {
    const p = voiceProgress(xp);
    return {
      userId: "",
      xp,
      level: p.level,
      tier: tierFor(p.level, VOICE_TIERS),
      progress: { inLevel: p.inLevel, toNext: p.toNext },
    };
  }

  // ---- 総合 ----

  /** 総合レベル = テキストLv + ボイスLv */
  totalLevel(userId: string): { text: number; voice: number; total: number } {
    const t = textLevel(this.getText(userId).xp);
    const v = voiceLevel(this.getVoice(userId).xp);
    return { text: t, voice: v, total: t + v };
  }

  // ---- ランキング用 ----

  topByText(limit = 10): Array<{ user_id: string; xp: number; messages: number }> {
    return this.db
      .prepare("SELECT user_id, xp, messages FROM rank_text ORDER BY xp DESC LIMIT ?")
      .all(limit) as Array<{ user_id: string; xp: number; messages: number }>;
  }
  topByVoice(limit = 10): Array<{ user_id: string; xp: number; minutes: number }> {
    return this.db
      .prepare("SELECT user_id, xp, minutes FROM rank_voice ORDER BY xp DESC LIMIT ?")
      .all(limit) as Array<{ user_id: string; xp: number; minutes: number }>;
  }

  /** 発言XPでの自分の順位（1始まり） */
  positionByText(userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM rank_text WHERE xp > (SELECT xp FROM rank_text WHERE user_id = ?)",
      )
      .get(userId) as { c: number } | undefined;
    return (row?.c ?? 0) + 1;
  }
  positionByVoice(userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM rank_voice WHERE xp > (SELECT xp FROM rank_voice WHERE user_id = ?)",
      )
      .get(userId) as { c: number } | undefined;
    return (row?.c ?? 0) + 1;
  }

  /** ランキング参加中人数（textとvoiceの和集合） */
  populationCount(): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM (SELECT user_id FROM rank_text UNION SELECT user_id FROM rank_voice)",
      )
      .get() as { c: number };
    return r.c;
  }
}

function tierIndex(level: number, tiers: RankTier[]): number {
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) if (level >= tiers[i]!.minLevel) idx = i;
  return idx;
}

export { TEXT_TIERS, VOICE_TIERS, textLevel, voiceLevel, textProgress, voiceProgress, tierFor, _nextTier as nextTier };
export type { RankTier };
