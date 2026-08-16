/**
 * 一時参加状態の正本（正本 §15.1「同時参加は1卓まで。ソロゲームの席とも排他」）。
 *
 * ## なぜプロセス内なのか
 *
 * ソロゲーム・ルーレット卓・`/勝負` の対人卓・競馬は**永続テーブルを持たない**。
 * 進行中の状態は Discord のコレクタとプロセス内の Map にしかなく、再起動すれば
 * 卓ごと消える（預り金は起動時の掃除が返す）。だからこの4種類の一時参加は
 * プロセス内で管理する。
 *
 * 常設順位卓を廃止したので、DB 側に「生きている参加」を持つ卓はもう無い。
 * 排他の判定はこの Map だけで閉じる。
 *
 * ## 排他の全方向
 *
 * ```text
 * ソロ live        → 対人卓 / ルーレット / 競馬 すべて拒否
 * ルーレット live  → ソロ / 対人卓 / 競馬      すべて拒否
 * 対人卓 live      → ソロ / ルーレット / 競馬  すべて拒否
 * 競馬 live        → ソロ / ルーレット / 対人卓 すべて拒否
 * ```
 */
export type TransientParticipationKind = "solo" | "roulette" | "pvp" | "keiba";

interface TransientHolding {
  kind: TransientParticipationKind;
  key: string;
}

/** userId → いま押さえている卓。1人1卓なので値は単数 */
const held = new Map<string, TransientHolding>();

export interface AcquireParticipationOptions {
  /**
   * 同じ卓（同じ `key`）からの再取得を許すか。
   *
   * ルーレットの張り直しや多人数丁半の増し賭けは「同じ卓の同じ人」がもう一度
   * 徴収経路へ入ってくるので `true`。ソロゲームの席は1回の操作につき1回きりなので
   * `false`（`true` にすると同時プレイ防止が効かなくなる）。
   */
  reentrant?: boolean;
}

/**
 * 一時参加を取る。取れなければ `false`（資金は1 Ld も動かさないうちに断る）。
 */
export function acquireTransientParticipation(
  userId: string,
  kind: TransientParticipationKind,
  key: string,
  options: AcquireParticipationOptions = {},
): boolean {
  if (!userId || !key) return false;
  const current = held.get(userId);
  if (current) {
    // 同じ卓の続き（張り直し・増し賭け）だけ通す。別の卓なら 1人1卓 で断る
    return options.reentrant === true && current.kind === kind && current.key === key;
  }
  held.set(userId, { kind, key });
  return true;
}

/**
 * 一時参加を解く。**自分が取った卓のときだけ**解く（別の卓の参加を巻き込まない）。
 *
 * 資金がまだエスクローに残っている状態で解いてはならない。返金・精算が終わってから、
 * あるいは資金を1 Ld も動かさずに中断したときに呼ぶ。
 */
export function releaseTransientParticipation(userId: string, kind: TransientParticipationKind, key: string): void {
  const current = held.get(userId);
  if (current && current.kind === kind && current.key === key) held.delete(userId);
}

/** いずれかの一時卓に着いているか（払戻ゲートの判定に使う） */
export function hasTransientParticipation(userId: string): boolean {
  return held.has(userId);
}

/** テスト専用: プロセス内の一時参加を全部落とす */
export function resetTransientParticipationForTesting(): void {
  held.clear();
}
