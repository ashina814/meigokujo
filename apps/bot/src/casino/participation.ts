import type { Services } from "../services.js";

/**
 * 一時参加状態の正本（正本 §15.1「同時参加は1卓まで。ソロゲームの席とも排他」）。
 *
 * ## なぜプロセス内なのか
 *
 * ソロゲーム・ルーレット卓・`/勝負` の対人卓は**永続テーブルを持たない**。
 * 進行中の状態は Discord のコレクタとプロセス内の Map にしかなく、再起動すれば
 * 卓ごと消える（預り金は起動時の掃除が返す）。だからこの3種類の一時参加は
 * プロセス内で管理する。
 *
 * ## 常設順位卓（永続卓）との関係
 *
 * 常設順位卓の参加正本は **DB**（`casino_tables` / `casino_table_participants`）であって、
 * ここではない。プロセス内へ写すと再起動で「参加していないこと」になってしまう。
 * そのため一時参加を取るときは毎回 `persistentTables.participantHasLiveTable()` を
 * 引いて、生きている順位卓があれば断る。逆向き（一時参加中の順位卓参加）は
 * `RankedTables` の `isSoloSeatOccupied` フックが {@link hasTransientParticipation} を
 * 読むことで塞がる。
 *
 * ## 排他の全方向
 *
 * ```text
 * 順位卓 live      → ソロ / ルーレット / 対人卓  すべて拒否
 * ソロ live        → 順位卓 / 対人卓 / ルーレット すべて拒否
 * ルーレット live  → 順位卓 / ソロ / 対人卓      すべて拒否
 * 対人卓 live      → 順位卓 / ソロ / ルーレット  すべて拒否
 * ```
 */
export type TransientParticipationKind = "solo" | "roulette" | "pvp";

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
 *
 * 永続卓の確認が例外になった場合は fail-closed で `false`。「確認できないから通す」は
 * しない（正本 §15.1 の排他は安全上限なので、不明なら断る）。
 */
export function acquireTransientParticipation(
  services: Pick<Services, "persistentTables">,
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
  try {
    if (services.persistentTables.participantHasLiveTable(userId)) return false;
  } catch {
    return false;
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

/** いずれかの一時卓に着いているか（順位卓参加・払戻ゲートの判定に使う） */
export function hasTransientParticipation(userId: string): boolean {
  return held.has(userId);
}

/** テスト専用: プロセス内の一時参加を全部落とす */
export function resetTransientParticipationForTesting(): void {
  held.clear();
}
