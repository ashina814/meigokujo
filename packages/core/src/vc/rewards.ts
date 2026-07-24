import type Database from "better-sqlite3";
import { Settings } from "../settings/service.js";

/**
 * VC浮上報酬の日次計算（ブラックリスト方式・決定版）。
 *
 * ## 方式（2026-07 改修）
 * - 旧: ホワイトリスト方式（`vc_whitelist` + 巣穴 `vc_whitelist_den` に載ったVCだけ支給）。
 *   → 実際に人が使う自動生成VCがリスト外になり報酬が出ない不具合が多発したため撤廃。
 * - 新: **ブラックリスト方式**。計測された全VCを対象にし、除外リスト
 *   `xp_excluded_channels`（XPと共用・チャンネルIDまたは親カテゴリID）に入ったものだけ外す。
 *   これで外部botの自動生成VCを含め、浮上した場所すべてが対象になる。
 *
 * ## 維持しているルール
 * - 対象時間は「Bot以外2人以上が同時にいる区間」だけ（在室者はミュート中も人数に数える）
 * - 通常VC: 自分がミュート/デフンの区間は加算しない。寝落ちVC(`vc_sleep_list`)は減額レート・ミュート可
 * - 10分未満のセグメントは在室にも報酬にも数えない
 * - 日次上限あり。すべて設定値（`vc_reward_*`）
 *
 * 支払いは呼び出し側（冪等キー vc_reward:<date>:user:<id>）。
 */
export interface DailyReward {
  userId: string;
  normalSeconds: number;
  sleepSeconds: number;
  amount: number;
}

/** computeDay に渡す除外・寝落ち情報。呼び出し側（bot）が設定から組み立てる。 */
export interface RewardScope {
  /** 除外ID集合（チャンネルID または 親カテゴリID）。`xp_excluded_channels` をそのまま渡す。 */
  excludedIds?: Set<string>;
  /** 寝落ちVCのチャンネルID集合（減額レート・ミュート可）。`vc_sleep_list`。 */
  sleepChannelIds?: Set<string>;
}

interface Segment {
  user_id: string;
  started_at: number;
  ended_at: number;
  self_muted: number;
  self_deafened: number;
}

export class VcRewards {
  constructor(
    private readonly db: Database.Database,
    private readonly settings: Settings,
  ) {}

  /**
   * dateStr（JSTの1日 'YYYY-MM-DD'）の報酬を計算する。
   * @param scope 除外/寝落ちの集合。省略時は設定から自前で読む（テスト・単体利用向け）。
   */
  computeDay(dateStr: string, scope: RewardScope = {}): DailyReward[] {
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return [];
    const windowStart = Date.UTC(y, m - 1, d) / 1000 - 9 * 3600; // JST 00:00
    const windowEnd = windowStart + 86_400;

    const excludedIds = scope.excludedIds ?? new Set(this.settings.getJson<string[]>("xp_excluded_channels", []));
    const sleepChannelIds = scope.sleepChannelIds ?? new Set(this.settings.getJson<string[]>("vc_sleep_list", []));

    const rate = this.settings.getNumber("vc_reward_rate_per_10min");
    const sleepRate = this.settings.getNumber("vc_reward_sleep_rate_per_10min");
    const cap = this.settings.getNumber("vc_reward_daily_cap");
    const minSeconds = this.settings.getNumber("vc_reward_min_session_min") * 60;

    // その日にセグメントがあった全チャンネルを対象にする（ホワイトリストは使わない）。
    // 親カテゴリは代表値（そのチャンネルのセグメントに記録された parent_id）で判定する。
    const channels = this.db
      .prepare(
        `SELECT channel_id, MAX(parent_id) AS parent_id
         FROM vc_segments
         WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
         GROUP BY channel_id`,
      )
      .all(windowEnd, windowEnd, windowStart) as Array<{ channel_id: string; parent_id: string | null }>;

    const normal = new Map<string, number>();
    const sleep = new Map<string, number>();

    for (const { channel_id: channelId, parent_id: parentId } of channels) {
      // 除外: チャンネルID または 親カテゴリID が除外リストに入っていれば対象外
      if (excludedIds.has(channelId) || (parentId && excludedIds.has(parentId))) continue;
      const isSleep = sleepChannelIds.has(channelId);
      const eligible = this.eligibleSeconds(channelId, windowStart, windowEnd, minSeconds, isSleep);
      const bucket = isSleep ? sleep : normal;
      for (const [userId, seconds] of eligible) {
        bucket.set(userId, (bucket.get(userId) ?? 0) + seconds);
      }
    }

    const users = new Set([...normal.keys(), ...sleep.keys()]);
    const rewards: DailyReward[] = [];
    for (const userId of users) {
      const n = normal.get(userId) ?? 0;
      const s = sleep.get(userId) ?? 0;
      const amount = Math.min(Math.floor(n / 600) * rate + Math.floor(s / 600) * sleepRate, cap);
      if (amount > 0) rewards.push({ userId, normalSeconds: n, sleepSeconds: s, amount });
    }
    return rewards.sort((a, b) => b.amount - a.amount);
  }

  /** チャンネル1つ分: 「2人以上いる区間」×「本人の（通常VCなら非ミュート）セグメント」の重なり秒数 */
  private eligibleSeconds(
    channelId: string,
    windowStart: number,
    windowEnd: number,
    minSeconds: number,
    allowMuted: boolean,
  ): Map<string, number> {
    const raw = this.db
      .prepare(
        `SELECT user_id, started_at, COALESCE(ended_at, ?) AS ended_at, self_muted, self_deafened
         FROM vc_segments
         WHERE channel_id = ? AND started_at < ? AND COALESCE(ended_at, ?) > ?`,
      )
      .all(windowEnd, channelId, windowEnd, windowEnd, windowStart) as Segment[];

    // 10分未満のセグメント（出入りの連打）は在室にも報酬にも数えない
    const segments = raw
      .filter((s) => s.ended_at - s.started_at >= minSeconds)
      .map((s) => ({
        ...s,
        started_at: Math.max(s.started_at, windowStart),
        ended_at: Math.min(s.ended_at, windowEnd),
      }))
      .filter((s) => s.ended_at > s.started_at);
    if (segments.length === 0) return new Map();

    // 区間ごとの在室人数（ユニークユーザー数）を求め、2人以上の区間だけ加算
    const boundaries = [...new Set(segments.flatMap((s) => [s.started_at, s.ended_at]))].sort((a, b) => a - b);
    const result = new Map<string, number>();

    for (let i = 0; i < boundaries.length - 1; i++) {
      const t1 = boundaries[i]!;
      const t2 = boundaries[i + 1]!;
      const present = segments.filter((s) => s.started_at <= t1 && s.ended_at >= t2);
      const occupants = new Set(present.map((s) => s.user_id));
      if (occupants.size < 2) continue;

      for (const s of present) {
        if (!allowMuted && (s.self_muted === 1 || s.self_deafened === 1)) continue;
        result.set(s.user_id, (result.get(s.user_id) ?? 0) + (t2 - t1));
      }
    }
    return result;
  }
}
