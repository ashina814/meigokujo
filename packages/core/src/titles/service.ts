import type Database from "better-sqlite3";
import type { VcTracker } from "../vc/service.js";

/**
 * 称号機関（システム設計.md ④ / 構想マップの実績エンジン）。
 * 「事件録に X が N 回記録されたら称号 Y を付与」をルールとして定義する。
 * 新しい称号 = TITLE_RULES に1行足すだけ。判定材料は事件録・魂台帳・VC計測から導出。
 */
export interface TitleRule {
  key: string;
  name: string;
  emoji: string;
  desc: string;
  /** 城の別軸実績。ネタ枠込み。true を返したら付与 */
  check: (h: TitleHelper) => boolean;
}

export interface GrantedTitle {
  key: string;
  name: string;
  emoji: string;
  desc: string;
  granted_at: number;
}

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** ルールの判定に使うヘルパ（DBアクセスを隠蔽） */
export class TitleHelper {
  constructor(
    private readonly db: Database.Database,
    private readonly vc: VcTracker,
    readonly userId: string,
  ) {}

  /** 自分が actor（行為者）として type を記録された回数 */
  asActor(type: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE type = ? AND actor_id = ?")
        .get(type, this.userId) as { c: number }
    ).c;
  }

  /** 自分が target（対象）として type を記録された回数 */
  asTarget(type: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE type = ? AND target_id = ?")
        .get(type, this.userId) as { c: number }
    ).c;
  }

  /** 亡霊化してからの在城日数（未亡霊化なら0） */
  daysInCastle(): number {
    const row = this.db.prepare("SELECT ghost_at FROM souls WHERE user_id = ?").get(this.userId) as
      | { ghost_at: number | null }
      | undefined;
    if (!row?.ghost_at) return 0;
    return Math.floor((now() - row.ghost_at) / DAY);
  }

  status(): string | null {
    const row = this.db.prepare("SELECT status FROM souls WHERE user_id = ?").get(this.userId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  /** 累計VC浮上時間（秒）。全期間・全VC */
  totalVcSeconds(): number {
    return this.vc.presence(this.userId, 36_500).totalSeconds; // 約100年 = 全期間
  }
}

/** 称号ルール定義。ここに1行足すだけで新しい称号が増える。 */
export const TITLE_RULES: TitleRule[] = [
  { key: "newborn", name: "生まれし魂", emoji: "🕯", desc: "冥獄城に亡霊として迎えられた", check: (h) => h.asTarget("ghosted") >= 1 },
  { key: "risen", name: "魔人への道", emoji: "⚔️", desc: "審判を越えて魔人へ昇格した", check: (h) => h.asTarget("promotion") >= 1 },
  { key: "recruiter", name: "勧誘者", emoji: "📣", desc: "1人以上を城へ導いた", check: (h) => h.asActor("invite_credited") >= 1 },
  { key: "recruiter_gold", name: "冥獄の伝道師", emoji: "🔥", desc: "5人以上を城へ導いた", check: (h) => h.asActor("invite_credited") >= 5 },
  { key: "matchmaker", name: "月下氷人", emoji: "🌸", desc: "蜜月の縁を結んだ", check: (h) => h.asActor("recruit_matched") >= 1 },
  { key: "innkeeper", name: "宿の常連", emoji: "🛏", desc: "10回以上 部屋を開いた", check: (h) => h.asActor("room_created") >= 10 },
  { key: "veteran", name: "古参の魂", emoji: "🏰", desc: "在城30日を超えた", check: (h) => h.daysInCastle() >= 30 },
  { key: "elder", name: "百年の亡霊", emoji: "👑", desc: "在城100日を超えた", check: (h) => h.daysInCastle() >= 100 },
  { key: "nightwalker", name: "不眠の魂", emoji: "🌙", desc: "累計100時間 城に浮上した", check: (h) => h.totalVcSeconds() >= 100 * 3600 },
];

export class TitleEngine {
  private readonly ruleMap = new Map(TITLE_RULES.map((r) => [r.key, r]));

  constructor(
    private readonly db: Database.Database,
    private readonly vc: VcTracker,
  ) {}

  /** 全ルールを判定し、新規に満たした称号を付与する。付与した新称号を返す */
  evaluate(userId: string): GrantedTitle[] {
    const helper = new TitleHelper(this.db, this.vc, userId);
    const owned = new Set(this.ownedKeys(userId));
    const newlyGranted: GrantedTitle[] = [];
    const ts = now();
    for (const rule of TITLE_RULES) {
      if (owned.has(rule.key)) continue;
      let ok = false;
      try {
        ok = rule.check(helper);
      } catch {
        ok = false; // 判定中の例外は「未達」扱い（付与漏れは次回拾える）
      }
      if (!ok) continue;
      this.db
        .prepare("INSERT INTO titles (user_id, title_key, granted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .run(userId, rule.key, ts);
      newlyGranted.push({ key: rule.key, name: rule.name, emoji: rule.emoji, desc: rule.desc, granted_at: ts });
    }
    return newlyGranted;
  }

  ownedKeys(userId: string): string[] {
    return (
      this.db.prepare("SELECT title_key FROM titles WHERE user_id = ?").all(userId) as Array<{ title_key: string }>
    ).map((r) => r.title_key);
  }

  /** 獲得済み称号（獲得順）。ルール定義にないキーは無視 */
  list(userId: string): GrantedTitle[] {
    const rows = this.db
      .prepare("SELECT title_key, granted_at FROM titles WHERE user_id = ? ORDER BY granted_at")
      .all(userId) as Array<{ title_key: string; granted_at: number }>;
    return rows.flatMap((r) => {
      const rule = this.ruleMap.get(r.title_key);
      return rule ? [{ key: rule.key, name: rule.name, emoji: rule.emoji, desc: rule.desc, granted_at: r.granted_at }] : [];
    });
  }
}
