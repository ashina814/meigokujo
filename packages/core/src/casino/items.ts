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
  power: number;
}

export const CONSUMABLES: readonly ConsumableDef[] = [
  { key: "omamori", name: "福のお守り", desc: "次に勝った時、勝利金が +5% になる。", price: 4_000, kind: "armed_win", power: 0.05 },
  { key: "hoken", name: "保険符", desc: "次に負けた時、賭け金の半分が戻る。", price: 3_000, kind: "armed_loss", power: 0.5 },
  { key: "higo", name: "庇護の札", desc: "次の敗北を無効化（賭け金が全額戻る）。", price: 12_000, kind: "armed_loss", power: 1.0 },
  { key: "reroll", name: "二度振りの権", desc: "チンチロでもう一度振り直せる（1回）。", price: 5_000, kind: "game_reroll", power: 0 },
];

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

  /** 勝利時: armed_win を消費して倍率を返す */
  consumeWinBonus(userId: string): { mult: number; note?: string } {
    for (const def of CONSUMABLES.filter((c) => c.kind === "armed_win")) {
      if (this.isArmed(userId, def.key)) {
        this.disarm(userId, def.key);
        return { mult: 1 + def.power, note: `${def.name} 発動（+${Math.round(def.power * 100)}%）` };
      }
    }
    return { mult: 1 };
  }

  /** 敗北時: armed_loss を消費して返金率を返す（庇護優先） */
  consumeLossProtection(userId: string): { refundRate: number; note?: string } {
    const losses = CONSUMABLES.filter((c) => c.kind === "armed_loss").sort((a, b) => b.power - a.power);
    for (const def of losses) {
      if (this.isArmed(userId, def.key)) {
        this.disarm(userId, def.key);
        return { refundRate: def.power, note: `${def.name} 発動（${def.power >= 1 ? "敗北無効・全額返金" : `${Math.round(def.power * 100)}%返金`}）` };
      }
    }
    return { refundRate: 0 };
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
