import type Database from "better-sqlite3";
import type { VcTracker } from "../vc/service.js";
import { TitleHelper, type TitleCategory, type TitleRule } from "./helper.js";
import { SECRET_TITLE_COUNT, TITLE_RULES } from "./catalog.js";
import { buildSnapshot } from "./snapshot.js";

export { TitleHelper, TITLE_RULES, SECRET_TITLE_COUNT, buildSnapshot };
export type { TitleCategory, TitleRule };
export type { TitleSnapshot } from "./snapshot.js";

/**
 * 称号機関（システム設計.md ④）。
 * 判定は buildSnapshot が作る1人分のスナップショットに対して行う。称号が何個あっても
 * DBに当たる回数は変わらない（catalog.ts / snapshot.ts の各先頭コメント参照）。
 */

const now = () => Math.floor(Date.now() / 1000);

/** カードに掲げられる称号の数 */
export const EQUIP_SLOTS = 3;

export interface GrantedTitle {
  key: string;
  name: string;
  emoji: string;
  desc: string;
  granted_at: number;
  category: TitleCategory;
  secret?: boolean;
}

/**
 * 旧称号キーの引き継ぎ表。カタログ刷新でキーが変わっても、既に付与された実績は失わせない。
 * 付与済みレコードを新キーへ書き換える（一度きり・冪等）。
 */
const LEGACY_KEY_MAP: Record<string, string> = {
  recruiter: "recruiter_1",
  recruiter_gold: "recruiter_5",
  matchmaker: "mitsugetsu",
  innkeeper: "dan_room_2",
  veteran: "dan_days_2",
  elder: "dan_days_3",
};

/**
 * 廃止したルール。新規付与はしないが、既に持っている人の一覧には出し続ける。
 * 「累計VC時間」はランク（rank_voice）の領分と整理したため称号からは外したが、
 * 過去に獲得した人の記録まで消す理由はない。
 */
const RETIRED_RULES: TitleRule[] = [
  {
    key: "nightwalker",
    category: "toki",
    name: "不眠の魂",
    emoji: "🌙",
    desc: "累計100時間 城に浮上した（現在は廃止された称号）",
    check: () => false,
  },
];

export class TitleEngine {
  private readonly ruleMap = new Map<string, TitleRule>(
    [...TITLE_RULES, ...RETIRED_RULES].map((r) => [r.key, r]),
  );

  constructor(
    private readonly db: Database.Database,
    private readonly vc: VcTracker,
  ) {
    this.migrateLegacyKeys();
  }

  /** 旧キーを新キーへ寄せる。衝突（新旧どちらも所持）した場合は旧行を捨てる */
  private migrateLegacyKeys(): void {
    const update = this.db.prepare(
      "UPDATE OR IGNORE titles SET title_key = ? WHERE user_id = ? AND title_key = ?",
    );
    const remove = this.db.prepare("DELETE FROM titles WHERE user_id = ? AND title_key = ?");
    const rows = this.db
      .prepare(
        `SELECT user_id, title_key FROM titles WHERE title_key IN (${Object.keys(LEGACY_KEY_MAP)
          .map(() => "?")
          .join(",")})`,
      )
      .all(...Object.keys(LEGACY_KEY_MAP)) as Array<{ user_id: string; title_key: string }>;
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const r of rows) {
        update.run(LEGACY_KEY_MAP[r.title_key]!, r.user_id, r.title_key);
        remove.run(r.user_id, r.title_key);
      }
    })();
  }

  /** 全ルールを判定し、新規に満たした称号を付与する。付与した新称号を返す */
  evaluate(userId: string): GrantedTitle[] {
    const snapshot = buildSnapshot(this.db, this.vc, userId);
    const helper = new TitleHelper(snapshot);
    const owned = new Set(this.ownedKeys(userId));
    const newlyGranted: GrantedTitle[] = [];
    const ts = now();
    const insert = this.db.prepare(
      "INSERT INTO titles (user_id, title_key, granted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    );

    for (const rule of TITLE_RULES) {
      if (owned.has(rule.key)) continue;
      let ok = false;
      try {
        ok = rule.check(helper);
      } catch {
        ok = false; // 判定中の例外は「未達」扱い（付与漏れは次回拾える）
      }
      if (!ok) continue;
      insert.run(userId, rule.key, ts);
      newlyGranted.push({ ...toGranted(rule, ts) });
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
      .prepare("SELECT title_key, granted_at FROM titles WHERE user_id = ? ORDER BY granted_at, title_key")
      .all(userId) as Array<{ title_key: string; granted_at: number }>;
    return rows.flatMap((r) => {
      const rule = this.ruleMap.get(r.title_key);
      return rule ? [toGranted(rule, r.granted_at)] : [];
    });
  }

  /** 収集の進捗。分母は現行ルールのみ（廃止称号は含めない） */
  progress(userId: string): { owned: number; total: number; secretOwned: number; secretTotal: number } {
    const owned = new Set(this.ownedKeys(userId));
    let ownedCount = 0;
    let secretOwned = 0;
    for (const rule of TITLE_RULES) {
      if (!owned.has(rule.key)) continue;
      ownedCount += 1;
      if (rule.secret) secretOwned += 1;
    }
    return { owned: ownedCount, total: TITLE_RULES.length, secretOwned, secretTotal: SECRET_TITLE_COUNT };
  }

  // ── 装備 ────────────────────────────────────────────────

  /**
   * カードに掲げる称号。未設定なら「獲得が新しい順」で自動的に埋める
   * （何も装備していない人のカードが空にならないように）。
   */
  equipped(userId: string): GrantedTitle[] {
    const rows = this.db
      .prepare("SELECT title_key FROM title_equips WHERE user_id = ? ORDER BY slot")
      .all(userId) as Array<{ title_key: string }>;

    if (rows.length > 0) {
      const ownedKeys = new Set(this.ownedKeys(userId));
      const picked = rows
        .filter((r) => ownedKeys.has(r.title_key))
        .flatMap((r) => {
          const rule = this.ruleMap.get(r.title_key);
          return rule ? [rule] : [];
        });
      if (picked.length > 0) {
        const grantedAt = new Map(
          (
            this.db.prepare("SELECT title_key, granted_at FROM titles WHERE user_id = ?").all(userId) as Array<{
              title_key: string;
              granted_at: number;
            }>
          ).map((r) => [r.title_key, r.granted_at]),
        );
        return picked.map((rule) => toGranted(rule, grantedAt.get(rule.key) ?? 0));
      }
    }

    return this.list(userId).slice(-EQUIP_SLOTS).reverse();
  }

  /**
   * 装備を差し替える。所持していないキー・重複・上限超過は弾く。
   * 空配列を渡すと「自動（新しい順）」へ戻る。
   */
  equip(userId: string, keys: string[]): { ok: true } | { ok: false; reason: string } {
    if (keys.length > EQUIP_SLOTS) return { ok: false, reason: `掲げられるのは${EQUIP_SLOTS}つまで` };
    const unique = [...new Set(keys)];
    if (unique.length !== keys.length) return { ok: false, reason: "同じ称号は一度しか掲げられない" };
    const owned = new Set(this.ownedKeys(userId));
    for (const k of unique) {
      if (!owned.has(k)) return { ok: false, reason: "持っていない称号は掲げられない" };
    }

    const ts = now();
    const del = this.db.prepare("DELETE FROM title_equips WHERE user_id = ?");
    const ins = this.db.prepare(
      "INSERT INTO title_equips (user_id, slot, title_key, updated_at) VALUES (?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      del.run(userId);
      unique.forEach((k, i) => ins.run(userId, i, k, ts));
    })();
    return { ok: true };
  }
}

function toGranted(rule: TitleRule, grantedAt: number): GrantedTitle {
  return {
    key: rule.key,
    name: rule.name,
    emoji: rule.emoji,
    desc: rule.desc,
    granted_at: grantedAt,
    category: rule.category,
    secret: rule.secret,
  };
}
