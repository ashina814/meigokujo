import type Database from "better-sqlite3";
import { Settings } from "../settings/service.js";

/**
 * VC浮上報酬の日次計算（ボット設計.md VC浮上報酬 決定版）。
 * - 対象: ホワイトリストVC（通常レート・ミュート/デフンは対象外）と寝落ちVC（減額・ミュート可）
 * - どちらも「Bot以外2人以上が同時にいる時間」だけカウント（在室者にはミュート中の人も数える）
 * - 10分未満のセグメントは切り捨て、日次上限あり。すべて設定値
 */
export interface DailyReward {
  userId: string;
  normalSeconds: number;
  sleepSeconds: number;
  amount: number;
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

  /** dateStr（JSTの1日 'YYYY-MM-DD'）の報酬を計算する。支払いは呼び出し側（冪等キー vc_reward:<date>:user:<id>） */
  computeDay(dateStr: string): DailyReward[] {
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return [];
    const windowStart = Date.UTC(y, m - 1, d) / 1000 - 9 * 3600; // JST 00:00
    const windowEnd = windowStart + 86_400;

    // 手動の報酬対象 ＋ 巣穴の複製VC（自動登録）。動的に生まれた巣穴でも報酬が付く
    const whitelist = [
      ...this.settings.getJson<string[]>("vc_whitelist", []),
      ...this.settings.getJson<string[]>("vc_whitelist_den", []),
    ];
    const sleepList = this.settings.getJson<string[]>("vc_sleep_list", []);
    const rate = this.settings.getNumber("vc_reward_rate_per_10min");
    const sleepRate = this.settings.getNumber("vc_reward_sleep_rate_per_10min");
    const cap = this.settings.getNumber("vc_reward_daily_cap");
    const minSeconds = this.settings.getNumber("vc_reward_min_session_min") * 60;

    const normal = new Map<string, number>();
    const sleep = new Map<string, number>();

    for (const channelId of new Set([...whitelist, ...sleepList])) {
      const isSleep = sleepList.includes(channelId);
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
