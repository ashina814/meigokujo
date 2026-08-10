/**
 * Discord の階級ロール → `souls.status` の同期判定（純粋関数）。
 *
 * 判定だけをここに置き、Discord API・DB・タイマーには触れない。
 * 「いま付いているロール一式」と「いまのDB status」を渡すと、
 * どうすべきか（書く / 何もしない / 異常として記録する）を返す。
 *
 * ## なぜイベントの add/remove を見ないか
 *
 * Discord のロール変更は 1操作 = 1イベントとは限らず、付与と剥奪が別々に届く。
 * 途中状態を正本にすると「魔人へ上げる途中の、亡霊が外れただけの瞬間」を
 * 見て入城前へ巻き戻す、といった破壊が起きる（実際に旧実装はその防護に
 * 追われていた）。ここでは最終状態だけを入力にする。
 *
 * ## 階級の意味論
 *
 * 迷霊は「最上位の階級」ではなく、通常階級を上書きする懲罰・別状態。
 * そのため通常階級と同時に付いていても迷霊を採る。ただしロール構成としては
 * 異常なので、呼び出し側が監査ログを残せるよう `anomalies` で報せる。
 */

/** souls.status が取り得る値 */
export type SoulStatus = "waiting" | "ghost" | "majin" | "kenma" | "mazoku" | "meirei" | "departed";

/** 通常の昇格系列（下から上）。迷霊はここに入らない */
export const RANK_LADDER = ["ghost", "majin", "kenma", "mazoku"] as const;
export type LadderRank = (typeof RANK_LADDER)[number];

/** 設定キー → 階級。ロールIDの解決は呼び出し側（bot）が行う */
export const RANK_ROLE_SETTING_KEYS: Readonly<Record<LadderRank, string>> = {
  ghost: "role:ghost",
  majin: "role:majin",
  kenma: "role:kenma",
  mazoku: "role:mazoku",
};
export const MEIREI_ROLE_SETTING_KEY = "role:meirei";

/** いま付いている階級ロールの内訳 */
export interface RankRoleSnapshot {
  /** 付いている通常階級（順不同） */
  ladder: readonly LadderRank[];
  /** 迷霊ロールが付いているか */
  meirei: boolean;
}

export type RankSyncDecision =
  | { kind: "noop"; reason: string }
  | { kind: "update"; to: SoulStatus; from: SoulStatus; anomalies: string[] }
  | { kind: "ambiguous"; reason: string; desired: SoulStatus | null; from: SoulStatus };

/**
 * ロール構成から「あるべき status」を決める。
 *
 * 優先順位:
 *   1. 迷霊（懲罰）… 通常階級より優先
 *   2. 通常階級は上位優先 mazoku > kenma > majin > ghost
 *
 * 階級ロールが1つも無ければ null（＝判定材料が無い）。
 */
export function desiredStatusFromRoles(snapshot: RankRoleSnapshot): { status: SoulStatus | null; anomalies: string[] } {
  const anomalies: string[] = [];
  const ladder = RANK_LADDER.filter((r) => snapshot.ladder.includes(r));

  if (snapshot.meirei) {
    // 迷霊は上書き。ただし通常階級が残っているのは剥がし漏れなので記録する
    if (ladder.length > 0) anomalies.push(`meirei_with_ladder:${ladder.join("+")}`);
    return { status: "meirei", anomalies };
  }
  if (ladder.length === 0) return { status: null, anomalies };
  if (ladder.length > 1) anomalies.push(`multiple_ladder_roles:${ladder.join("+")}`);
  // RANK_LADDER は下から上の順。最後尾が最上位
  return { status: ladder[ladder.length - 1]!, anomalies };
}

/**
 * その遷移を自動同期してよいか。
 *
 * 階級には業務上の意味があるので、ロールから読めた値を無条件に SET しない。
 *
 * - `waiting → ghost` は入城処理（ghostify）の担当。ここでは扱わない
 * - `ghost → majin` は昇格の意味論（評価締切のクリアなど）を持つので専用経路へ
 * - `majin / kenma / mazoku` 間は横移動。ここで合わせてよい
 * - 通常階級 → `meirei` は降格の意味論。ここで合わせてよい（懲罰の反映漏れの方が危険）
 * - `meirei → 通常階級` は復帰。最終ロールが明確なら合わせてよい
 * - 上位階級 → `ghost` は差し戻し。評価ライフサイクルを伴うので自動ではやらない
 * - `waiting` / `departed` → 上位階級は入城処理の迂回になるのでやらない
 */
export function isAutoSyncableTransition(from: SoulStatus, to: SoulStatus): boolean {
  if (from === to) return false;
  const upper = new Set<SoulStatus>(["majin", "kenma", "mazoku"]);

  // 入城前・離脱済みから階級を生やさない（入城処理を迂回する）
  if (from === "waiting" || from === "departed") return false;
  // 亡霊への差し戻しは評価期間の再設定を伴うので自動ではやらない
  if (to === "ghost") return false;
  // 亡霊からの昇格は昇格の意味論を持つ専用経路の担当
  if (from === "ghost" && to !== "meirei") return false;

  if (upper.has(from) && upper.has(to)) return true; // 横移動
  if (upper.has(from) && to === "meirei") return true; // 降格
  if (from === "ghost" && to === "meirei") return true; // 降格
  if (from === "meirei" && upper.has(to)) return true; // 復帰
  return false;
}

/**
 * 同期判定の本体。DBもDiscordも触らない。
 *
 * `to` が現状と同じなら noop を返すので、Bot 自身のロール操作でイベントが来ても
 * 二重処理にならない（抑止フラグに正しさを依存させない）。
 */
export function decideRankSync(current: SoulStatus, snapshot: RankRoleSnapshot): RankSyncDecision {
  const { status: desired, anomalies } = desiredStatusFromRoles(snapshot);

  if (desired === null) {
    // 階級ロールが1つも無い。ロール事故・一括変更の途中で入城状態を消さない
    return { kind: "ambiguous", reason: "no_rank_role", desired: null, from: current };
  }
  if (desired === current) {
    return { kind: "noop", reason: anomalies.length > 0 ? `already_in_sync(${anomalies.join(",")})` : "already_in_sync" };
  }
  if (!isAutoSyncableTransition(current, desired)) {
    return { kind: "ambiguous", reason: `transition_not_auto_syncable:${current}->${desired}`, desired, from: current };
  }
  return { kind: "update", to: desired, from: current, anomalies };
}
