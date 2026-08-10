/**
 * 既存データの階級不整合を回収するための判定（純粋関数）。
 *
 * 2026-08-11 の監査で、Discord のロールと `souls.status` が食い違う既存メンバーが
 * 13件見つかった。どれも通常の導線（`/審判` → `/昇格`）を今から流すと
 * **評価期間・初期発行・公開の昇格告知を新規に発生させてしまう**ため、
 * 「既に起きていたことを台帳へ追認する」ための専用判定をここへ置く。
 *
 * 汎用の「任意の status を書く口」にしないため、次を守る。
 * - 遷移は用途ごとに1本だけ許す（waiting→majin の追認、など）
 * - 対象は呼び出し側が固定した ID 許可リストに限る
 * - 追認の根拠（ロール保有・昇格印など）を実行時にもう一度確かめる
 * - 何を根拠にしたかを payload へ残す
 */
import type { SoulStatus } from "./sync.js";

/** 追認できるか／できないなら理由 */
export type RecoveryVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 履歴追認（historical rank backfill）: `waiting → majin` の1本だけ。
 *
 * 対象は「実運用では既に魔人として扱われている（ロールがあり給与も出ている）が、
 * 台帳だけ入城前のまま」という人。評価期間も初期発行も**新規に発生させない**。
 */
export function canBackfillHistoricalMajin(input: {
  allowlist: readonly string[];
  userId: string;
  currentStatus: SoulStatus | null;
  hasMajinRole: boolean;
}): RecoveryVerdict {
  if (!input.allowlist.includes(input.userId)) return { ok: false, reason: "not_in_allowlist" };
  if (input.currentStatus === null) return { ok: false, reason: "no_soul_row" };
  // 既に majin ならやることが無い（冪等に成功とせず、無操作と分かる理由を返す）
  if (input.currentStatus === "majin") return { ok: false, reason: "already_majin" };
  if (input.currentStatus !== "waiting") return { ok: false, reason: `unexpected_status:${input.currentStatus}` };
  if (!input.hasMajinRole) return { ok: false, reason: "majin_role_missing" };
  return { ok: true };
}

/**
 * 昇格記録の追いつき: `ghost → majin`。
 *
 * 面談・ロール付与まで終わっているのに `/昇格` がbot上で実行されず、
 * 台帳だけ亡霊のまま残っている人を対象にする。**公開告知はしない**（既に済んでいるため）。
 *
 * ガードは3つとも必須:
 * - DB が `ghost`
 * - Discord に魔人ロールがある
 * - 有効な昇格印が**その人自身のスナップショット要求数**に達している
 */
export function canCatchUpPromotion(input: {
  currentStatus: SoulStatus | null;
  hasMajinRole: boolean;
  promotionScore: number;
  promotionRequired: number;
}): RecoveryVerdict {
  if (input.currentStatus === null) return { ok: false, reason: "no_soul_row" };
  if (input.currentStatus !== "ghost") return { ok: false, reason: `unexpected_status:${input.currentStatus}` };
  if (!input.hasMajinRole) return { ok: false, reason: "majin_role_missing" };
  if (input.promotionScore < input.promotionRequired) {
    return { ok: false, reason: `promotion_score_short:${input.promotionScore}/${input.promotionRequired}` };
  }
  return { ok: true };
}

/**
 * 台帳の階級に合わせて**不足しているロールを足す**（DBが正・ロールが欠落）。
 *
 * 一括移行で status を持っているのに、再参加などでロールを失った人が対象。
 * ロールを**外す**判断はここではしない（余分なロールの剥奪は人が見て決める）。
 */
export function roleToRestoreForStatus(status: SoulStatus | null): SoulStatus | null {
  if (status === null) return null;
  // 入城前・離脱済みには何も足さない。迷霊は懲罰なので自動復元の対象にしない
  if (status === "waiting" || status === "departed" || status === "meirei") return null;
  return status;
}
