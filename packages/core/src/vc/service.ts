import type Database from "better-sqlite3";

/**
 * VC計測（ボット設計.md VC浮上報酬）。
 * 「計測は全VC・支給はホワイトリストのみ」の計測側。生のセグメント
 * （誰が・どのVCに・いつからいつまで・ミュート状態）を追記し、
 * 報酬計算・浮上実績・死亡判定は全部この記録の読み出し方の違いで実現する。
 */
/**
 * ended_at の出自。
 *
 * - null: まだ開いている、またはこの列を追加する前のlegacy行（品質不明）
 * - 'observed': 通常のVoiceStateUpdate処理（open/close）で閉じた
 * - 'recovered_estimate': closeAllDangling() がクラッシュ復旧時に推定値で閉じた
 *
 * 既存のclosed行を 'observed' と推測してはいけない。称号の取得順証明（derived layer）が
 * この区別に依存するため、不明なものは不明のまま残す。
 */
export type VcSegmentEndQuality = "observed" | "recovered_estimate" | null;

/**
 * この行が開いた理由。
 *
 * - null: この列を追加する前のlegacy行（理由不明）
 * - 'join': 切断状態（どこにも接続していない）からの新規入室
 * - 'move': 別チャンネルからの移動
 * - 'state_change': 同一チャンネル内でのmute/deafen状態変化による分割
 *
 * derived layer（vc/derived.ts）が「退出→再入室」と「mute/deafen変化による分割」を
 * 区別するために使う。前者は別visit、後者は同一visitの継続。
 */
export type VcSegmentStartReason = "join" | "move" | "state_change" | null;

export interface VcSegment {
  id: number;
  user_id: string;
  channel_id: string;
  parent_id: string | null;
  started_at: number;
  ended_at: number | null;
  self_muted: number;
  self_deafened: number;
  end_quality: VcSegmentEndQuality;
  start_reason: VcSegmentStartReason;
}

export interface PresenceSummary {
  totalSeconds: number;
  daysSeen: number;
  perChannel: Array<{ channelId: string; seconds: number }>;
}

const now = () => Math.floor(Date.now() / 1000);

export class VcTracker {
  constructor(private readonly db: Database.Database) {}

  /**
   * 入室 or 移動 or 状態変化: 開いているセグメントを閉じて新しく開く。
   * @param parentId 親カテゴリID（浮上報酬のカテゴリ除外判定に使う）。不明なら null。
   * @param reason この行が開いた理由（join/move/state_change）。derived layerの
   *   coalesceが「退出→再入室」と「mute/deafen変化」を区別するために使う。
   */
  open(
    userId: string,
    channelId: string,
    parentId: string | null,
    muted: boolean,
    deafened: boolean,
    reason: VcSegmentStartReason,
  ): void {
    const ts = now();
    this.closeAt(userId, ts);
    this.db
      .prepare(
        "INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, self_muted, self_deafened, start_reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(userId, channelId, parentId, ts, muted ? 1 : 0, deafened ? 1 : 0, reason);
  }

  /** 退出 */
  close(userId: string): void {
    this.closeAt(userId, now());
  }

  /**
   * 通常のVoiceStateUpdate処理（open()の前段・close()）による終了。
   * 実際にDiscordのイベントを観測して閉じているので 'observed'。
   */
  private closeAt(userId: string, ts: number): void {
    this.db
      .prepare("UPDATE vc_segments SET ended_at = ?, end_quality = 'observed' WHERE user_id = ? AND ended_at IS NULL")
      .run(ts, userId);
  }

  /**
   * 起動時の後始末: クラッシュ等で閉じ損ねたセグメントを閉じる。
   * 実際の退出時刻は分からないため、開始+上限（既定6時間）と現在時刻の早い方で打ち切る。
   * 'observed' ではなく 'recovered_estimate' として記録し、正確な終了時刻を主張しない。
   */
  closeAllDangling(capSeconds = 6 * 3600): number {
    const ts = now();
    const result = this.db
      .prepare(
        `UPDATE vc_segments
         SET ended_at = MIN(?, started_at + ?), end_quality = 'recovered_estimate'
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
