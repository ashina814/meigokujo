import type Database from "better-sqlite3";

/**
 * マモンの賭場の消耗品（お守り）システム。casino-bot 準拠。
 * 装備制: 賭場商店で購入 → 「装備」→ 発動条件を満たした瞬間に消費。
 *
 *   armed_win     … 次に勝った時に発動（勝利金 × (1 + power)）
 *   armed_loss    … 次に負けた時に発動（賭け金 × power を返金）
 *                   複数あれば power 降順で優先（庇護1.0 > 保険0.5）
 *   game_reroll   … チンチロ振り直しの権（プレイ中に消費）
 */
export type ItemKind = "armed_win" | "armed_loss" | "game_reroll";

export interface ConsumableDef {
  key: string;
  name: string;
  desc: string;
  price: number; // エテル価格
  kind: ItemKind;
  /** 効果率（0.05 = +5%、0.5 = 50%返金、1.0 = 全額返金） */
  power: number;
  /**
   * 追加払戻・返金の絶対上限（エテル）。0 or 未設定なら上限なし。
   *
   * ## cap < price を厳守する理由（PR#6 レビュー指摘）
   * お守りは「発動するまで装備が残る」仕様（次に勝つ／負けるまで消えない）。
   * したがってプレイヤーが「未装備なら買う・装備中は買わない・発動したら買い直す」戦略を取ると、
   * 1装備サイクルの期待損益は本質的に `発動時効果額 − 購入価格` になる。
   * cap >= price だと、発動が保証される（＝いつか必ず勝つ／負ける）以上、
   * 1サイクルあたり必ず (cap − price) >= 0 の利益が出る裁定になる。
   * これを防ぐため cap は price より必ず小さくする（下の CONSUMABLES で検証）。
   */
  cap?: number;
}

/**
 * お守りの効果上限は「価格未満」に固定する（cap < price）。
 * これで「発動まで装備が残る」仕様のまま、毎サイクル買い直しても
 * 期待損益が (cap − price) < 0 となり、胴元が構造的赤字にならない。
 *
 * 価格・上限（PR#6 レビュー指摘の推奨値 A）:
 *   福のお守り price=4,000  cap=3,000
 *   保険符     price=3,000  cap=2,000
 *   庇護の札   price=12,000 cap=10,000
 */
export const CONSUMABLES: readonly ConsumableDef[] = [
  {
    key: "omamori", name: "福のお守り",
    desc: "次に勝った時、勝利金が +5%（最大 +3,000◈）になる。",
    price: 4_000, kind: "armed_win", power: 0.05, cap: 3_000,
  },
  {
    key: "hoken", name: "保険符",
    desc: "次に負けた時、賭け金の半分（最大 2,000◈）が戻る。",
    price: 3_000, kind: "armed_loss", power: 0.5, cap: 2_000,
  },
  {
    key: "higo", name: "庇護の札",
    desc: "次の敗北を無効化（賭け金の全額、最大 10,000◈ が戻る）。",
    price: 12_000, kind: "armed_loss", power: 1.0, cap: 10_000,
  },
  { key: "reroll", name: "二度振りの権", desc: "チンチロでもう一度振り直せる（1回）。", price: 5_000, kind: "game_reroll", power: 0 },
];

// 不変条件を起動時に検査: 効果を持つお守りは cap < price（cap > 0 のとき）
for (const c of CONSUMABLES) {
  if (c.cap !== undefined && c.cap > 0 && c.cap >= c.price) {
    throw new Error(`ConsumableDef invariant violated: ${c.key} cap(${c.cap}) must be < price(${c.price})`);
  }
}

const BY_KEY = new Map(CONSUMABLES.map((c) => [c.key, c]));
export function getConsumableDef(key: string): ConsumableDef | undefined {
  return BY_KEY.get(key);
}

export type ArmResult = { ok: true } | { ok: false; reason: "NO_STOCK" | "ALREADY_ARMED" | "UNKNOWN_ITEM" };

export class Items {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_items (
        user_id  TEXT NOT NULL,
        item_key TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
        PRIMARY KEY (user_id, item_key)
      );
      CREATE TABLE IF NOT EXISTS casino_active_effects (
        user_id    TEXT NOT NULL,
        effect_key TEXT NOT NULL,
        PRIMARY KEY (user_id, effect_key)
      );
    `);
  }

  grant(userId: string, key: string, n = 1): void {
    this.db
      .prepare(
        `INSERT INTO casino_items (user_id, item_key, quantity) VALUES (?, ?, ?)
         ON CONFLICT(user_id, item_key) DO UPDATE SET quantity = quantity + ?`,
      )
      .run(userId, key, n, n);
  }

  qty(userId: string, key: string): number {
    const r = this.db.prepare("SELECT quantity FROM casino_items WHERE user_id = ? AND item_key = ?").get(userId, key) as
      | { quantity: number }
      | undefined;
    return r?.quantity ?? 0;
  }

  inventory(userId: string): Array<{ key: string; quantity: number }> {
    return this.db
      .prepare("SELECT item_key AS key, quantity FROM casino_items WHERE user_id = ? AND quantity > 0 ORDER BY item_key")
      .all(userId) as Array<{ key: string; quantity: number }>;
  }

  isArmed(userId: string, key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM casino_active_effects WHERE user_id = ? AND effect_key = ?").get(userId, key);
  }

  armedList(userId: string): string[] {
    return (this.db.prepare("SELECT effect_key FROM casino_active_effects WHERE user_id = ?").all(userId) as Array<{ effect_key: string }>).map(
      (r) => r.effect_key,
    );
  }

  arm(userId: string, key: string): ArmResult {
    const def = getConsumableDef(key);
    if (!def) return { ok: false, reason: "UNKNOWN_ITEM" };
    return this.db.transaction((): ArmResult => {
      if (this.isArmed(userId, key)) return { ok: false, reason: "ALREADY_ARMED" };
      const q = this.qty(userId, key);
      if (q <= 0) return { ok: false, reason: "NO_STOCK" };
      this.db.prepare("UPDATE casino_items SET quantity = quantity - 1 WHERE user_id = ? AND item_key = ?").run(userId, key);
      this.db.prepare("INSERT INTO casino_active_effects (user_id, effect_key) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, key);
      return { ok: true };
    })();
  }

  private disarm(userId: string, key: string): void {
    this.db.prepare("DELETE FROM casino_active_effects WHERE user_id = ? AND effect_key = ?").run(userId, key);
  }

  /**
   * 勝利時: armed_win を消費して "実際に加算するボーナス額（エテル・整数）" を返す。
   *
   * @param rawPayout   ゲーム側の raw payout（bet + 利益、エッジ適用後）
   * @returns bonus     加算するべき額（cap で頭打ち）。呼び出し側は adjustedPayout = rawPayout + bonus を使う
   *
   * 旧 API は倍率 (1 + power) を返していたが、高額ベット時に無制限にスケールするため
   * ユーザーの裁定を許してしまった。新 API は cap で頭打ちにする。
   * ペイアウトから bet を差し引いた「利益部分」に対して power を掛けるので、
   * 引き分けや負けでの発動はしない（呼び出し側で rawPayout > bet の場合のみ呼ぶ想定）。
   */
  consumeWinBonus(userId: string, rawPayout: number, bet: number): { bonus: number; note?: string } {
    for (const def of CONSUMABLES.filter((c) => c.kind === "armed_win")) {
      if (this.isArmed(userId, def.key)) {
        this.disarm(userId, def.key);
        const profit = Math.max(0, rawPayout - bet);
        const raw = Math.floor(profit * def.power);
        const capped = def.cap && def.cap > 0 ? Math.min(raw, def.cap) : raw;
        return { bonus: capped, note: `${def.name} 発動（+${capped.toLocaleString()}◈）` };
      }
    }
    return { bonus: 0 };
  }

  /**
   * 敗北時: armed_loss を消費して "返金額（エテル・整数）" を返す。
   *
   * @param bet   賭け額
   * @returns refund  返金額（cap で頭打ち）。呼び出し側は payout = refund を使う
   *
   * 旧 API は refundRate（率）を返していたが、高額ベット時に無制限にスケールするため
   * ユーザーの裁定を許してしまった。新 API は cap で頭打ちにする。
   * 庇護（power 1.0）と保険（power 0.5）が両方装備されている場合、庇護を優先して消費。
   */
  consumeLossProtection(userId: string, bet: number): { refund: number; note?: string } {
    const losses = CONSUMABLES.filter((c) => c.kind === "armed_loss").sort((a, b) => b.power - a.power);
    for (const def of losses) {
      if (this.isArmed(userId, def.key)) {
        this.disarm(userId, def.key);
        const raw = Math.floor(bet * def.power);
        const capped = def.cap && def.cap > 0 ? Math.min(raw, def.cap) : raw;
        return { refund: capped, note: `${def.name} 発動（${capped.toLocaleString()}◈ 返金）` };
      }
    }
    return { refund: 0 };
  }

  /** チンチロ振り直し */
  consumeReroll(userId: string): boolean {
    if (this.isArmed(userId, "reroll")) {
      this.disarm(userId, "reroll");
      return true;
    }
    return false;
  }
}
