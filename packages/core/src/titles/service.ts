import type Database from "better-sqlite3";
import type { VcTracker } from "../vc/service.js";
import { TitleHelper, type TitleCategory, type TitleRule } from "./helper.js";
import { SECRET_TITLE_COUNT, TITLE_RULES } from "./catalog.js";
import { buildSnapshot } from "./snapshot.js";
import { SENSITIVE_SOURCES, findSensitiveReference } from "./privacy.js";

export { TitleHelper, TITLE_RULES, SECRET_TITLE_COUNT, buildSnapshot, SENSITIVE_SOURCES, findSensitiveReference };
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
 * 旧称号キーの対応表（旧キー → 新キー）。
 *
 * 移行は「旧行を消して書き換える」のではなく「旧行を残したまま新キー行を足す」方式を取る。
 * 理由: 前回の本番投入でコードのロールバックが必要になった実績があるため、
 * DBだけ新形式へ進んだ状態で旧コードに戻っても称号表示が壊れないことを優先する。
 *   - 旧コードは旧キー行をそのまま読めるので表示が欠落しない
 *   - 旧コードは知らない新キー行を無視する（list が未知キーを飛ばす実装）
 *   - 新コードは読み取り時に旧キーを新キーへ解決し、重複を潰す
 * 旧行の削除は「旧コードへ戻す可能性が無くなってから」別途行う（docs/titles-migration.md）。
 */
const LEGACY_KEY_MAP: Record<string, string> = {
  recruiter: "recruiter_1",
  recruiter_gold: "recruiter_5",
  innkeeper: "dan_room_2",
  veteran: "dan_days_2",
  elder: "dan_days_3",
};

/**
 * 移行先を持たせない旧キー。DBの行は残すが、新コードの公開面には一切出さない。
 *
 * `matchmaker`（旧「月下氷人」＝蜜月の縁を結んだ）は秘匿対象（titles/privacy.ts）。
 * 表示用の廃止称号として移行すると、自動装備や将来の装備UI経由で
 * 「蜜月を使って成立させた」事実がプロフィールに出てしまう。
 *
 * 「DBに行が残ること」と「新コードで公開表示すること」は別物として扱う。
 *   - 行は残す      → 旧コードへロールバックしたときに旧称号がそのまま見える
 *   - 移行先を作らない → 新コードでは未知キーになり list / 装備 / カードに出ない
 * `mitsugetsu_retired` は本ブランチの途中のコミットで一度作った表示用キー。
 * 同じ理由で公開しないため、こちらも非公開として明示的に列挙しておく。
 */
const NON_PUBLIC_LEGACY_KEYS = new Set(["matchmaker", "mitsugetsu_retired"]);

/**
 * 廃止したルール。新規付与はしないが、既に持っている人の一覧には出し続ける。
 *   nightwalker : 「累計VC時間」はランク（rank_voice）の領分と整理したため称号から外した。
 * 秘匿対象に由来する称号はここに置かない（置くと公開面に戻ってしまう）。
 */
const RETIRED_RULES: TitleRule[] = [
  {
    key: "nightwalker",
    category: "toki",
    name: "不眠の魂",
    emoji: "🌙",
    desc: "累計100時間 城に浮上した（廃止された称号）",
    check: () => false,
  },
];

/** 表示してよいルールの全体（現行 + 廃止）。公開面に出せるキーの唯一の定義 */
export const DISPLAYABLE_RULES: TitleRule[] = [...TITLE_RULES, ...RETIRED_RULES];

/** 非公開の旧キー一覧（テストと運用手順の参照用） */
export const NON_PUBLIC_TITLE_KEYS: readonly string[] = [...NON_PUBLIC_LEGACY_KEYS];

export class TitleEngine {
  private readonly ruleMap = new Map<string, TitleRule>(DISPLAYABLE_RULES.map((r) => [r.key, r]));

  constructor(
    private readonly db: Database.Database,
    private readonly vc: VcTracker,
  ) {
    this.migrateLegacyKeys();
  }

  /**
   * 旧キーに対応する新キー行を追加する（旧行は消さない）。
   * granted_at は旧行の値を引き継ぐので「いつ獲得したか」を失わない。
   * INSERT OR IGNORE と移行台帳のPKで、何度走っても同じ結果になる。
   */
  private migrateLegacyKeys(): void {
    const legacyKeys = Object.keys(LEGACY_KEY_MAP);
    const placeholders = legacyKeys.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT user_id, title_key, granted_at FROM titles WHERE title_key IN (${placeholders})`)
      .all(...legacyKeys) as Array<{ user_id: string; title_key: string; granted_at: number }>;
    if (rows.length === 0) return;

    const insertTitle = this.db.prepare(
      "INSERT INTO titles (user_id, title_key, granted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    );
    const recordMigration = this.db.prepare(
      `INSERT INTO title_key_migrations (user_id, legacy_key, new_key, migrated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    const ts = now();
    this.db.transaction(() => {
      for (const r of rows) {
        const newKey = LEGACY_KEY_MAP[r.title_key]!;
        insertTitle.run(r.user_id, newKey, r.granted_at);
        recordMigration.run(r.user_id, r.title_key, newKey, ts);
      }
    })();
  }

  /** 旧キーを新キーに読み替える */
  private resolveKey(key: string): string {
    return LEGACY_KEY_MAP[key] ?? key;
  }

  /**
   * 所持している称号を「解決後のキー → 最古の獲得時刻」で返す。
   * 旧キーと新キーの両方を持っていても1件に潰れる。
   * 非公開の旧キーはここで落とすので、以降のどの経路にも現れない。
   */
  private ownedMap(userId: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT title_key, granted_at FROM titles WHERE user_id = ?")
      .all(userId) as Array<{ title_key: string; granted_at: number }>;
    const owned = new Map<string, number>();
    for (const r of rows) {
      if (NON_PUBLIC_LEGACY_KEYS.has(r.title_key)) continue;
      const key = this.resolveKey(r.title_key);
      if (NON_PUBLIC_LEGACY_KEYS.has(key)) continue;
      const existing = owned.get(key);
      if (existing === undefined || r.granted_at < existing) owned.set(key, r.granted_at);
    }
    return owned;
  }

  /**
   * 収集数の唯一の定義: 解決・重複排除した上で、現行カタログに存在するものだけを数える。
   * titles の COUNT(*) を使うと、旧キー移行で並存する行が二重に数えられ
   * 「称号をN個集めた」系が本来より早く解除されてしまう。
   * 廃止称号（nightwalker 等）は分母にも分子にも含めない。
   */
  private currentOwnedCount(owned: Map<string, number>): number {
    let count = 0;
    for (const rule of TITLE_RULES) if (owned.has(rule.key)) count += 1;
    return count;
  }

  /** 全ルールを判定し、新規に満たした称号を付与する。付与した新称号を返す */
  evaluate(userId: string): GrantedTitle[] {
    const owned = this.ownedMap(userId);
    const snapshot = buildSnapshot(this.db, this.vc, userId, {
      ownedTitles: this.currentOwnedCount(owned),
    });
    const helper = new TitleHelper(snapshot);
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
      newlyGranted.push(toGranted(rule, ts));
    }
    return newlyGranted;
  }

  /** 所持キー（解決後）。旧キーは新キーとして返る */
  ownedKeys(userId: string): string[] {
    return [...this.ownedMap(userId).keys()];
  }

  /** 獲得済み称号（獲得順）。ルール定義にないキーは無視 */
  list(userId: string): GrantedTitle[] {
    return [...this.ownedMap(userId).entries()]
      .flatMap(([key, grantedAt]) => {
        const rule = this.ruleMap.get(key);
        return rule ? [toGranted(rule, grantedAt)] : [];
      })
      .sort((a, b) => a.granted_at - b.granted_at || a.key.localeCompare(b.key));
  }

  /** 収集の進捗。分母・分子とも現行ルールのみ（廃止称号は含めない） */
  progress(userId: string): { owned: number; total: number; secretOwned: number; secretTotal: number } {
    const owned = this.ownedMap(userId);
    let secretOwned = 0;
    for (const rule of TITLE_RULES) {
      if (owned.has(rule.key) && rule.secret) secretOwned += 1;
    }
    return {
      owned: this.currentOwnedCount(owned),
      total: TITLE_RULES.length,
      secretOwned,
      secretTotal: SECRET_TITLE_COUNT,
    };
  }

  // ── 装備 ────────────────────────────────────────────────

  /**
   * カードに掲げる称号。未設定なら「獲得が新しい順」で自動的に埋める
   * （何も装備していない人のカードが空にならないように）。
   *
   * 秘匿対象の機能は称号自体を作らない方針なので、自動装備で意図せず
   * 露出する称号は存在しない（titles/privacy.ts）。
   */
  equipped(userId: string): GrantedTitle[] {
    const owned = this.ownedMap(userId);
    const rows = this.db
      .prepare("SELECT title_key FROM title_equips WHERE user_id = ? ORDER BY slot")
      .all(userId) as Array<{ title_key: string }>;

    const picked: GrantedTitle[] = [];
    for (const r of rows) {
      const key = this.resolveKey(r.title_key);
      const grantedAt = owned.get(key);
      const rule = this.ruleMap.get(key);
      if (grantedAt === undefined || !rule) continue; // 失効・未知キーは黙って落とす
      picked.push(toGranted(rule, grantedAt));
    }
    if (picked.length > 0) return picked.slice(0, EQUIP_SLOTS);

    return this.list(userId).slice(-EQUIP_SLOTS).reverse();
  }

  /**
   * 装備を差し替える。所持していないキー・重複・上限超過は弾く。
   * 空配列を渡すと「自動（新しい順）」へ戻る。
   */
  equip(userId: string, keys: string[]): { ok: true } | { ok: false; reason: string } {
    if (keys.length > EQUIP_SLOTS) return { ok: false, reason: `掲げられるのは${EQUIP_SLOTS}つまで` };
    const resolved = keys.map((k) => this.resolveKey(k));
    const unique = [...new Set(resolved)];
    if (unique.length !== resolved.length) return { ok: false, reason: "同じ称号は一度しか掲げられない" };
    const owned = this.ownedMap(userId);
    for (const k of unique) {
      // 非公開の旧キーは ownedMap から落ちているのでここで弾かれる。
      // 表示定義を持たないキーも掲げさせない（掲げても描画されず、無言で消えるのを防ぐ）
      if (!this.ruleMap.has(k)) return { ok: false, reason: "この称号は掲げられない" };
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
