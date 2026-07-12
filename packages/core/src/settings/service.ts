import type Database from "better-sqlite3";

/**
 * 運営セルフサービス設定の土台（ボット設計.md 設定パネル）。
 * チャンネルID・ロールID・数値パラメータをすべてここに置き、コード変更なしで調整できるようにする。
 * 変更は outbox(audit_log) に記録される。
 */
export const SETTING_DEFAULTS = {
  // 経済
  approval_threshold: 1_000_000, // これを超える取引は #決裁 承認が必要
  initial_grant: 30_000, // 入城時の初期発行
  // VC浮上報酬（経済設計.md / ボット設計.md VC浮上報酬）
  vc_reward_rate_per_10min: 100,
  vc_reward_sleep_rate_per_10min: 30,
  vc_reward_daily_cap: 3_000,
  vc_reward_min_session_min: 10,
  // 評価・カロン（換算値はすべて可変にするのが決定事項）
  eval_base_period_days: 14,
  invite_mark_per_person: 0.5,
  invite_mark_cap: 1.0,
  invite_extend_days_male: 1,
  invite_extend_days_female: 2,
  invite_extend_cap_days: 15,
  promotion_marks_required: 5,
  demotion_marks_threshold: 4,
  // 部屋システム
  room_slot_price: 5_000, // 通常宿の人数枠+1
  room_mitsugetsu_price: 5_000,
  room_oborozuki_price: 30_000,
  room_recruit_expire_hours: 5, // 蜜月の無応募失効
  room_recruit_refund: 2_500, // 失効時の半額返金
  room_empty_grace_min: 1, // 全員退出からの削除猶予
  // bump/up 報酬
  bump_reward: 0, // 金額は運営が設定パネルで決める（0 = 支給しない）
  // マモンの賭場（エテル為替）
  ether_rate_base: 10, // 準備プールが空のときの初期レート（1 Land = 何エテル）
  ether_fuku_scale: 10, // 福の重み（勝ち分の累進奉納）しきい値のスケール
  // 移行（経済設計.md §9）
  migration_cap: 5_000_000, // これを超える旧残高は /移行 承認 が必要（キャップ額は運営合意待ちの暫定値）
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

const now = () => Math.floor(Date.now() / 1000);

export class Settings {
  constructor(private readonly db: Database.Database) {}

  /** 数値設定。未設定なら既定値（SETTING_DEFAULTS）を返す */
  getNumber(key: SettingKey): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return SETTING_DEFAULTS[key];
    const n = Number(row.value);
    return Number.isFinite(n) ? n : SETTING_DEFAULTS[key];
  }

  /** 自由キーの文字列設定（チャンネルID・ロールIDなど）。未設定は undefined */
  getString(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** JSON設定（VCホワイトリスト等の配列・オブジェクト） */
  getJson<T>(key: string, fallback: T): T {
    const raw = this.getString(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: string | number | object, actor: string): void {
    const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, serialized, ts);
      // 設定変更も監査対象（誰がいつ何を変えたか）
      this.db
        .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
        .run(JSON.stringify({ event: "setting_changed", key, value: serialized, actor }), ts);
    });
    tx();
  }

  /** キーを削除。監査ログに setting_deleted を残す */
  delete(key: string, actor: string = "system"): void {
    const ts = now();
    const tx = this.db.transaction(() => {
      const r = this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      if (r.changes > 0) {
        this.db
          .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
          .run(JSON.stringify({ event: "setting_deleted", key, actor }), ts);
      }
    });
    tx();
  }
}
