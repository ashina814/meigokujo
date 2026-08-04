import { LedgerError } from "./errors.js";

export type AccountKind = "user" | "system";

export interface TxTypePolicy {
  /** from 口座に許される種別 */
  fromKinds: readonly AccountKind[];
  /** to 口座に許される種別 */
  toKinds: readonly AccountKind[];
  /** 未成年（16〜17）を弾くか。UIではなくデータ層で弾く（経済設計.md 横断要件） */
  minorBlocked?: boolean;
  /** 公開ログ（指定チャンネル）へ流すか。設定で上書き可能な初期値 */
  publicLog?: boolean;
}

const registry = new Map<string, TxTypePolicy>();

export function registerTxType(type: string, policy: TxTypePolicy): void {
  registry.set(type, policy);
}

export function getTxType(type: string): TxTypePolicy {
  const policy = registry.get(type);
  if (!policy) throw new LedgerError("ERR_UNKNOWN_TYPE", { type });
  return policy;
}

export function knownTxTypes(): string[] {
  return [...registry.keys()];
}

/** 経済設計.md §4 の取引タイプ登録簿。新機能の追加＝ここに1エントリ足すこと。 */
export function registerDefaultTxTypes(): void {
  const sysToUser = { fromKinds: ["system"], toKinds: ["user"] } as const;
  const userToSys = { fromKinds: ["user"], toKinds: ["system"] } as const;
  const userToUser = { fromKinds: ["user"], toKinds: ["user"] } as const;

  // 発行（国庫→住人）
  registerTxType("opening", { ...sysToUser });
  registerTxType("initial", { ...sysToUser });
  registerTxType("salary", { ...sysToUser });
  registerTxType("pension", { ...sysToUser });
  registerTxType("vc_reward", { ...sysToUser });
  registerTxType("reward_boost", { ...sysToUser });
  registerTxType("reward_bump", { ...sysToUser });
  registerTxType("event_prize", { ...sysToUser });
  registerTxType("harvest", { ...sysToUser });
  registerTxType("insurance_payout", { ...sysToUser });
  registerTxType("room_refund", { ...sysToUser });

  // 循環（住人⇄住人）
  registerTxType("transfer", { ...userToUser, publicLog: true });
  registerTxType("shop_personal", { ...userToUser });
  registerTxType("fanclub", { ...userToUser });
  registerTxType("inheritance", { ...userToUser });
  registerTxType("tip", { ...userToUser, publicLog: true }); // 投げ銭

  // 部署口座（sys:dept:*）— 業務資金の分離（経済設計.md §5）
  registerTxType("dept_in", { ...userToSys }); // 住人→部署（原資積み立て・売上入金）
  registerTxType("dept_out", { ...sysToUser }); // 部署→住人（払い戻し・釣り銭・賞金）
  registerTxType("commission", { ...sysToUser }); // 部署→従業員（歩合分配）

  // 回収（住人→国庫）
  registerTxType("fine", { ...userToSys });
  registerTxType("tax", { ...userToSys });
  registerTxType("shop_official", { ...userToSys });
  registerTxType("tip_burn", { ...userToSys, publicLog: true }); // 冥獄ボットへの投げ銭＝Land焼却シンク
  registerTxType("event_fee", { ...userToSys });
  registerTxType("insurance_premium", { ...userToSys });
  registerTxType("room_fee", { ...userToSys });

  // 運営調整（方向自由・最終手段）
  registerTxType("adjust", { fromKinds: ["user", "system"], toKinds: ["user", "system"] });

  // 賭け系（新カジノ実装用に汎用型として保持・未成年ゲート対象）
  registerTxType("bet", { fromKinds: ["user"], toKinds: ["system"], minorBlocked: true });
  registerTxType("prize", { fromKinds: ["system"], toKinds: ["user"], minorBlocked: true });

  // 旧エテル為替（変動レート・二割奉納・焼却）の**歴史データ専用**の型（PR8監査・項目9）。
  // PR8 以降このボットが新しく作ることはなく、legacy_pre_reset の窓に残る過去の行を
  // 読めるようにするためだけに残してある（検算Bの LEGACY_ETHER_TX_RULES が同じ前提で監査する）。
  // 新しい預入・返還・元手投入・売上精算は下の chip_* を使う。
  registerTxType("ether_buy", { ...userToSys, minorBlocked: true }); // 旧: 住人→準備プール（入場）
  registerTxType("ether_sell", { ...sysToUser, minorBlocked: true }); // 旧: 準備プール→住人（退場・80%着地）
  registerTxType("ether_burn", { fromKinds: ["system"], toKinds: ["system"] }); // 旧: プール→国庫（10%焼却＝シンク）
  registerTxType("ether_settle", { fromKinds: ["system"], toKinds: ["system"] }); // 旧: プール→部署口座（胴元精算）
  // 賭場チップ（PR8）。預入・返還とも常に 1:1 で、奉納も焼却も無い
  registerTxType("chip_deposit", { ...userToSys, minorBlocked: true });
  registerTxType("chip_redeem", { ...sysToUser, minorBlocked: true });
  registerTxType("chip_fund", { fromKinds: ["system"], toKinds: ["system"] });
  registerTxType("chip_settle", { fromKinds: ["system"], toKinds: ["system"] });
  registerTxType("ether_house_fund", { fromKinds: ["system"], toKinds: ["system"] }); // 部署口座→プール（胴元の元手）
}
