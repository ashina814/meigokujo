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
  /** 隠し二つ名。獲得条件を明かさない収集要素。獲得すると映える */
  secret?: boolean;
}

export interface GrantedTitle {
  key: string;
  name: string;
  emoji: string;
  desc: string;
  granted_at: number;
  secret?: boolean;
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

  /** 自分が actor として台帳(transactions)に type を記録された回数（tip/reward_bump 等） */
  txAsActor(type: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM transactions WHERE type = ? AND actor_id = ?")
        .get(type, this.userId) as { c: number }
    ).c;
  }

  /** 賭場の戦績(casino_stats)の1フィールドを読む。行が無ければ0 */
  casinoStat(field: "games" | "wins" | "biggest_win" | "total_wagered" | "best_win_streak"): number {
    const row = this.db.prepare(`SELECT ${field} AS v FROM casino_stats WHERE user_id = ?`).get(this.userId) as
      | { v: number }
      | undefined;
    return row?.v ?? 0;
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

  // ── 隠し二つ名（条件は明かさない収集要素） ──────────────────────
  // 賭場
  { key: "s_jackpot", name: "一攫千金", emoji: "💎", desc: "ジャックポットを射止めた", secret: true, check: (h) => h.asActor("casino_jackpot") >= 1 },
  { key: "s_gambler", name: "賭場の主", emoji: "🎰", desc: "賭場で200戦を刻んだ", secret: true, check: (h) => h.asActor("casino_game") >= 200 },
  { key: "s_streak", name: "連勝の覇者", emoji: "⚡", desc: "10連勝を成し遂げた", secret: true, check: (h) => h.casinoStat("best_win_streak") >= 10 },
  { key: "s_bigwin", name: "大博打", emoji: "🔥", desc: "一度の勝負で50万エテルを掴んだ", secret: true, check: (h) => h.casinoStat("biggest_win") >= 500_000 },
  { key: "s_abyss", name: "深淵を賭した者", emoji: "🕳", desc: "賭場に累計100万エテルを投じた", secret: true, check: (h) => h.casinoStat("total_wagered") >= 1_000_000 },
  { key: "s_agitator", name: "扇動者", emoji: "📋", desc: "板を5回立てた", secret: true, check: (h) => h.asActor("market_create") >= 5 },
  // 経済・社交
  { key: "s_spender", name: "浪費の美学", emoji: "🌹", desc: "投げ銭を20回投じた", secret: true, check: (h) => h.txAsActor("tip") >= 20 },
  { key: "s_bless", name: "福の申し子", emoji: "🍀", desc: "マモンの福分けを30回受けた", secret: true, check: (h) => h.asActor("casino_daily") >= 30 },
  { key: "s_bumper", name: "城の目覚まし", emoji: "🔔", desc: "城の宣伝(bump/up)を50回果たした", secret: true, check: (h) => h.txAsActor("reward_bump") >= 50 },
  // 献身・時
  { key: "s_courtier", name: "不眠の廷臣", emoji: "🌌", desc: "累計300時間 城に浮上した", secret: true, check: (h) => h.totalVcSeconds() >= 300 * 3600 },
  { key: "s_chronicle", name: "城の生き字引", emoji: "📜", desc: "在城200日を超えた", secret: true, check: (h) => h.daysInCastle() >= 200 },
  { key: "s_matchmaker", name: "冥界の縁結び", emoji: "🕊", desc: "蜜月の縁を5組 結んだ", secret: true, check: (h) => h.asActor("recruit_matched") >= 5 },
];

/** 隠し二つ名の総数（プロフィールの「X/N 発見」表示用） */
export const SECRET_TITLE_COUNT = TITLE_RULES.filter((r) => r.secret).length;

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
      newlyGranted.push({ key: rule.key, name: rule.name, emoji: rule.emoji, desc: rule.desc, granted_at: ts, secret: rule.secret });
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
      return rule ? [{ key: rule.key, name: rule.name, emoji: rule.emoji, desc: rule.desc, granted_at: r.granted_at, secret: rule.secret }] : [];
    });
  }
}
