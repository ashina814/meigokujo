/**
 * 1v1 の公開募集（マッチングだけを担う軽い一時状態）。
 *
 * ## 設計の要点
 *
 * - **募集中は資金を1 Ld も拘束しない。** 募集は「意思表示」でしかなく、
 *   資金の確認と確保は受諾が成立した瞬間に `collectStakes([challenger, accepter])`
 *   で一括して行う。「募集を出しただけで3分間 Land を人質に取られる」を避けるため
 * - **永続化しない。** 再起動したら古いカードを押した人に「この募集は終了しています」と
 *   返して終わり。ここで復旧できる募集を作り始めると、11,000行消した永続卓の世界へ戻る
 * - **`open` からの遷移は一度きり。** 受諾・取消・期限切れが競っても、
 *   最初の1つだけが通る
 * - **1人が同時に出せる募集は1件。** 資金を拘束しないからこそ、同じ挑戦者が
 *   公開カードを量産して「どれか1件だけ成立、残りは不成立」というゴミを作らない
 *
 * ## なぜ同期で確定させるか
 *
 * Discord は各コンポーネント操作を独立した interaction として送るので、
 * 2人がほぼ同時に「受ける」を押しうる。状態確定を `await` の後ろに置くと、
 * **両方が `collectStakes()` へ入りうる**。Node の同一プロセス内 Map なら、
 * 最初の `await` より前に `open → claimed` を書き換えれば十分防げる。
 *
 * 同じ理由で、claim 時に timeout も**その場で**解除する。解除し忘れると、
 * 募集カードがそのまま対戦盤になった後で「⌛ 募集終了」に書き換えられ、
 * 進行中の盤面を破壊する。
 */
import type { PvpGameKey } from "./pvp-games.js";

export type ChallengeState = "open" | "claimed" | "cancelled" | "expired";

export interface PvpChallenge {
  id: string;
  challengerId: string;
  game: PvpGameKey;
  bet: number;
  channelId: string;
  state: ChallengeState;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

/** 受付時間。1v1 は相手1人を見つけるだけなので、ポーカーの多人数ロビー（5分）より短くていい */
export const CHALLENGE_WINDOW_MS = 3 * 60_000;

const challenges = new Map<string, PvpChallenge>();

export function createChallenge(input: {
  id: string;
  challengerId: string;
  game: PvpGameKey;
  bet: number;
  channelId: string;
  onExpire: (challenge: PvpChallenge) => void | Promise<void>;
}): PvpChallenge {
  // 同じ ID を二度使うと、古い timer が新しい challenge を expire させられる。
  // 実運用では randomUUID なので起きないが、状態機械の不変条件として塞ぐ
  if (challenges.has(input.id)) throw new Error(`Duplicate challenge id: ${input.id}`);
  // 募集は資金も席も拘束しないため、ここを塞がないと1人で公開カードを量産できる。
  // Map には open しか残らない（終端は finish/expiry で削除）ので、存在だけ見ればよい。
  if (getOpenChallengeForChallenger(input.challengerId)) {
    throw new Error(`Challenger already has an open challenge: ${input.challengerId}`);
  }
  const challenge: PvpChallenge = {
    id: input.id,
    challengerId: input.challengerId,
    game: input.game,
    bet: input.bet,
    channelId: input.channelId,
    state: "open",
    expiresAt: Date.now() + CHALLENGE_WINDOW_MS,
  };
  challenge.timer = setTimeout(() => {
    // claim 側が timer を解除し損ねても、ここで状態を二重に確認して
    // 進行中の対戦盤を「募集終了」で潰さないようにする。
    // 同一性まで見るのは、同じ ID の別 challenge を巻き込まないため
    const current = challenges.get(input.id);
    if (current !== challenge || current.state !== "open") return;
    current.state = "expired";
    challenges.delete(input.id);
    // **expired への遷移自体は成功扱い。** 期限切れカードの更新（Discord API）が
    // 失敗しても challenge を復活させず、timer 由来の未処理例外で
    // Bot プロセスを巻き込まない
    void Promise.resolve()
      .then(() => input.onExpire(current))
      .catch((e) => console.error(`[pvp] 募集の期限切れ表示に失敗 id=${input.id}:`, e));
  }, CHALLENGE_WINDOW_MS);
  challenges.set(input.id, challenge);
  return challenge;
}

export type ClaimResult =
  | { ok: true; challenge: PvpChallenge }
  | { ok: false; reason: "gone" | "self" | "bot" };

/**
 * 最初に押した1人だけが募集を取る。**`await` を挟まずに状態を確定させること。**
 * 資金の確認はこの後に呼び出し側が行う。
 */
export function claimChallenge(id: string, accepterId: string, accepterIsBot: boolean): ClaimResult {
  const challenge = challenges.get(id);
  if (!challenge || challenge.state !== "open") return { ok: false, reason: "gone" };
  if (accepterIsBot) return { ok: false, reason: "bot" };
  if (accepterId === challenge.challengerId) return { ok: false, reason: "self" };
  challenge.state = "claimed";
  finish(challenge);
  return { ok: true, challenge };
}

/** 取消は挑戦者だけ */
export function cancelChallenge(id: string, actorId: string): PvpChallenge | null {
  const challenge = challenges.get(id);
  if (!challenge || challenge.state !== "open") return null;
  if (challenge.challengerId !== actorId) return null;
  challenge.state = "cancelled";
  finish(challenge);
  return challenge;
}

export function getChallenge(id: string): PvpChallenge | undefined {
  return challenges.get(id);
}

/** 同じ挑戦者が同時に公開募集を量産しないための読み取り。 */
export function getOpenChallengeForChallenger(challengerId: string): PvpChallenge | undefined {
  for (const challenge of challenges.values()) {
    if (challenge.challengerId === challengerId && challenge.state === "open") return challenge;
  }
  return undefined;
}

/** 状態を終端へ倒したら、必ず timer を解除して表から外す */
function finish(challenge: PvpChallenge): void {
  if (challenge.timer) clearTimeout(challenge.timer);
  challenge.timer = undefined;
  challenges.delete(challenge.id);
}

/** テスト専用 */
export function resetChallengesForTesting(): void {
  for (const c of challenges.values()) if (c.timer) clearTimeout(c.timer);
  challenges.clear();
}
