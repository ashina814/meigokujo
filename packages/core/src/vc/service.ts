import type Database from "better-sqlite3";

/**
 * VC計測（ボット設計.md VC浮上報酬）。
 * 「計測は全VC・支給はホワイトリストのみ」の計測側。生のセグメント
 * （誰が・どのVCに・いつからいつまで・ミュート状態）を追記し、
 * 報酬計算・浮上実績・死亡判定は全部この記録の読み出し方の違いで実現する。
 */
export interface VcSegment {
  id: number;
  user_id: string;
  channel_id: string;
  started_at: number;
  ended_at: number | null;
  self_muted: number;
  self_deafened: number;
}

export interface PresenceSummary {
  totalSeconds: number;
  daysSeen: number;
  perChannel: Array<{ channelId: string; seconds: number }>;
}

const now = () => Math.floor(Date.now() / 1000);

export class VcTracker {
  constructor(private readonly db: Database.Database) {}

  /** 入室 or 状態変化: 開いているセグメントを閉じて新しく開く */
  open(userId: string, channelId: string, muted: boolean, deafened: boolean): void {
    const ts = now();
    this.closeAt(userId, ts);
    this.db
      .prepare(
        "INSERT INTO vc_segments (user_id, channel_id, started_at, self_muted, self_deafened) VALUES (?, ?, ?, ?, ?)",
      )
      .run(userId, channelId, ts, muted ? 1 : 0, deafened ? 1 : 0);
  }

  /** 退出 */
  close(userId: string): void {
    this.closeAt(userId, now());
  }

  private closeAt(userId: string, ts: number): void {
    this.db
      .prepare("UPDATE vc_segments SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL")
      .run(ts, userId);
  }

  /**
   * 起動時の後始末: クラッシュ等で閉じ損ねたセグメントを閉じる。
   * 実際の退出時刻は分からないため、開始+上限（既定6時間）と現在時刻の早い方で打ち切る。
   */
  closeAllDangling(capSeconds = 6 * 3600): number {
    const ts = now();
    const result = this.db
      .prepare(
        `UPDATE vc_segments
         SET ended_at = MIN(?, started_at + ?)
         WHERE ended_at IS NULL`,
      )
      .run(ts, capSeconds);
    return result.changes;
  }

  /** 浮上実績: 期間内の合計時間・出現日数・チャンネル別内訳（評価スレへの自動添付用） */
  presence(userId: string, sinceDays: number, channelIds?: string[]): PresenceSummary {
    const since = now() - sinceDays * 86_400;
    const rows = this.db
      .prepare(
        `SELECT channel_id, started_at, COALESCE(ended_at, ?) AS ended_at
         FROM vc_segments
         WHERE user_id = ? AND COALESCE(ended_at, ?) > ?`,
      )
      .all(now(), userId, now(), since) as Array<{ channel_id: string; started_at: number; ended_at: number }>;

    const filtered = channelIds ? rows.filter((r) => channelIds.includes(r.channel_id)) : rows;
    const perChannelMap = new Map<string, number>();
    const days = new Set<string>();
    let total = 0;
    for (const r of filtered) {
      const start = Math.max(r.started_at, since);
      const seconds = Math.max(0, r.ended_at - start);
      total += seconds;
      perChannelMap.set(r.channel_id, (perChannelMap.get(r.channel_id) ?? 0) + seconds);
      // 出現日（JST）
      const d = new Date((start + 9 * 3600) * 1000).toISOString().slice(0, 10);
      days.add(d);
    }
    return {
      totalSeconds: total,
      daysSeen: days.size,
      perChannel: [...perChannelMap.entries()]
        .map(([channelId, seconds]) => ({ channelId, seconds }))
        .sort((a, b) => b.seconds - a.seconds),
    };
  }

  /** 全ユーザーの累計VC時間（全VC対象・位階の判定用）。多い順 */
  totalsByUser(sinceDays: number): Array<{ userId: string; seconds: number }> {
    const since = now() - sinceDays * 86_400;
    const rows = this.db
      .prepare(
        `SELECT user_id, started_at, COALESCE(ended_at, ?) AS ended_at
         FROM vc_segments
         WHERE COALESCE(ended_at, ?) > ?`,
      )
      .all(now(), now(), since) as Array<{ user_id: string; started_at: number; ended_at: number }>;
    const totals = new Map<string, number>();
    for (const r of rows) {
      const start = Math.max(r.started_at, since);
      const seconds = Math.max(0, r.ended_at - start);
      totals.set(r.user_id, (totals.get(r.user_id) ?? 0) + seconds);
    }
    return [...totals.entries()]
      .map(([userId, seconds]) => ({ userId, seconds }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  /** 最終浮上時刻（死亡判定＝非アクティブ検知の材料） */
  lastSeen(userId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(COALESCE(ended_at, started_at)) AS t FROM vc_segments WHERE user_id = ?")
      .get(userId) as { t: number | null };
    return row.t;
  }
}
