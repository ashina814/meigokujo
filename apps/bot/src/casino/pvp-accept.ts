import type { ButtonInteraction, Message, User } from "discord.js";
import type { Services } from "../services.js";
import { acquireTransientParticipation, releaseTransientParticipation } from "./participation.js";
import { claimChallenge, getChallenge, type PvpChallenge } from "./pvp-challenge.js";
import {
  collectStakes,
  pvpRiskScope,
  pvpViewFromMessage,
  stakeFailureText,
  type FundedPvpContext,
} from "./pvp-common.js";
import { pvpGame, type PvpGameKey } from "./pvp-games.js";

/**
 * 公開募集の受諾。**順序そのものがこの機能の本体**なので、経路を1本に閉じる。
 *
 * ```text
 * 両者の参加席を同期確保      ← 他卓参加者が募集だけ食うのを防ぐ
 * claimChallenge()          ← await を挟まない。最初の1人だけが通る
 * deferUpdate()             ← ここが最初の await
 * 挑戦者 User を解決         ← 徴収より前
 * collectStakes([両者])      ← 1回。同じ席へ reentrant に入る
 * pvpViewFromMessage(card)  ← 募集カードがそのまま対戦盤になる
 * runFundedX()              ← 資金保全は runFundedSession に任せる
 * ```
 *
 * ## なぜ claim より前に参加席を取るか
 *
 * `claimChallenge()` を先に確定すると、その後 `collectStakes()` で「別の卓に参加中」と
 * 弾かれる人でも募集を消せてしまう。さらに同じ人が別々の challenge をほぼ同時に押すと、
 * 2件とも claim した後で片方だけ徴収失敗になり、複数人の募集を食える。
 *
 * そこで challenge を読む → 両者の一時参加席を同じ `pvpRiskScope(session)` で確保 →
 * claim までを **await なし**で行う。資格のない受諾者は challenge を open のまま残す。
 * `collectStakes()` は同じ scope を `{ reentrant: true }` で取り直すため、この仮確保を
 * そのまま正式な参加状態へ引き継げる。
 *
 * ## Discord 側が落ちても募集を復活させない
 *
 * claim した時点で募集ライフサイクルは終了している。`deferUpdate()` や不成立表示が
 * 失敗しても、状態は戻さない——戻すと「再 open」と「別の accept」が競合する
 * 状態機械を新たに作ることになる。資金を動かす前に落ちた場合は、claim 前に確保した
 * 一時参加席だけを解放する。
 */
export type FundedRunner = (services: Services, ctx: FundedPvpContext) => Promise<void>;

export interface AcceptDeps {
  /** ゲーム種別 → 徴収済み本体。テストから差し替える */
  runners: Record<PvpGameKey, FundedRunner>;
  /**
   * 両者ぶんの徴収。本番は {@link collectStakes} をそのまま渡す。
   * 注入にしてあるのは、**順序（席確保 → claim → defer → 徴収 → 本体）そのものを
   * テストで固定したい**から。
   */
  collect?: typeof collectStakes;
  /** 挑戦者の解決。**徴収より前**に呼ぶ（fund 後の Discord API 失敗を作らないため） */
  fetchUser?: (interaction: ButtonInteraction, userId: string) => Promise<User>;
  /** カードのボタンを外して文面を差し替える。失敗しても募集は戻さない */
  closeCard: (card: Message, text: string) => Promise<unknown>;
}

export type AcceptOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "gone"
        | "self"
        | "bot"
        | "challenger_busy"
        | "accepter_busy"
        | "defer_failed"
        | "challenger_unresolved"
        | "stakes_failed";
    };

type ReservedClaimFailureReason = "gone" | "self" | "bot" | "challenger_busy" | "accepter_busy";
type ReservedClaimResult =
  | { ok: true; challenge: PvpChallenge; session: string }
  | { ok: false; reason: ReservedClaimFailureReason };

export async function acceptPvpChallenge(
  interaction: ButtonInteraction,
  services: Services,
  challengeId: string,
  deps: AcceptDeps,
): Promise<AcceptOutcome> {
  // ── 1. 両者の参加席と challenge 所有権を同期で確定させる（await を挟まない）──
  const claim = reserveSeatsAndClaim(challengeId, interaction.user.id, interaction.user.bot);
  if (!claim.ok) {
    await replyQuietly(interaction, claimFailureText(claim.reason));
    return { ok: false, reason: claim.reason };
  }
  const { challenge, session } = claim;

  // ── 2. 最初の await ──
  try {
    await interaction.deferUpdate();
  } catch (e) {
    // 募集は既に終了済み。復活させず、資金を動かす前なので仮確保した席だけ解く
    releaseReservedSeats(session, challenge.challengerId, interaction.user.id);
    console.error(`[pvp] 受諾の応答に失敗 id=${challengeId}:`, e);
    await closeQuietly(deps, interaction.message, "この募集は終了しました。");
    return { ok: false, reason: "defer_failed" };
  }

  // ── 3. 挑戦者を解決する。**徴収より前**であること ──
  // 徴収後にここを置くと、Discord API の失敗で runFundedX() へ到達できず、
  // runFundedSession() の保護区間にも入らないまま資金と露出が残る
  let challenger: User;
  try {
    challenger = await (deps.fetchUser ?? defaultFetchUser)(interaction, challenge.challengerId);
  } catch (e) {
    releaseReservedSeats(session, challenge.challengerId, interaction.user.id);
    console.error(`[pvp] 挑戦者を解決できず不成立 id=${challengeId}:`, e);
    await closeQuietly(deps, interaction.message, "挑戦者を確認できないため、この募集は不成立です。");
    return { ok: false, reason: "challenger_unresolved" };
  }

  // ── 4-5. 徴収と本体開始（下の non-async helper が両者を直結させる）──
  const started = collectAndStartFunded(services, deps, {
    session,
    challenge,
    challenger,
    interaction,
  });
  if (!started.ok) {
    // 本番 collectStakes も失敗時に席を戻すが、この入口が確保した分も明示的に解く。
    // 同じ key の release は冪等なので二重解放にはならない。
    releaseReservedSeats(session, challenge.challengerId, interaction.user.id);
    await closeQuietly(deps, interaction.message, `${stakeFailureText(started.stakes)}この募集は不成立です。`);
    return { ok: false, reason: "stakes_failed" };
  }
  await started.completion;
  return { ok: true };
}

/**
 * challenge を消費する前に、挑戦者と受諾者の「1人1卓」を同じ scope で同期確保する。
 * この関数は意図的に non-async。ここへ await が入ると、別 interaction が割り込んで
 * 同じ人が複数 challenge を claim できる窓が復活する。
 */
function reserveSeatsAndClaim(challengeId: string, accepterId: string, accepterIsBot: boolean): ReservedClaimResult {
  const challenge = getChallenge(challengeId);
  if (!challenge || challenge.state !== "open") return { ok: false, reason: "gone" };
  if (accepterIsBot) return { ok: false, reason: "bot" };
  if (accepterId === challenge.challengerId) return { ok: false, reason: "self" };

  const session = `pvpopen:${challengeId}`;
  const scope = pvpRiskScope(session);

  // 挑戦者が募集後に別卓へ入っていたら、受諾者の席は触らず challenge を open のまま残す。
  if (!acquireTransientParticipation(challenge.challengerId, "pvp", scope)) {
    return { ok: false, reason: "challenger_busy" };
  }

  // 受諾者が別卓参加中なら challenge を消費しない。先に取った挑戦者の仮席だけ戻す。
  if (!acquireTransientParticipation(accepterId, "pvp", scope)) {
    releaseTransientParticipation(challenge.challengerId, "pvp", scope);
    return { ok: false, reason: "accepter_busy" };
  }

  const claim = claimChallenge(challengeId, accepterId, accepterIsBot);
  if (!claim.ok) {
    // 同一 Node プロセスでは通常ここまでに状態は変わらないが、最終チェックは state machine に任せる。
    releaseTransientParticipation(accepterId, "pvp", scope);
    releaseTransientParticipation(challenge.challengerId, "pvp", scope);
    return claim;
  }
  return { ok: true, challenge: claim.challenge, session };
}

function releaseReservedSeats(session: string, challengerId: string, accepterId: string): void {
  const scope = pvpRiskScope(session);
  releaseTransientParticipation(accepterId, "pvp", scope);
  releaseTransientParticipation(challengerId, "pvp", scope);
}

type StartFundedResult =
  | { ok: false; stakes: ReturnType<typeof collectStakes> }
  | { ok: true; completion: Promise<void> };

/**
 * 徴収してから本体を起動するまでの critical section。
 *
 * **この関数は意図的に non-async。** 徴収が成功した時点で両者の資金と露出が確保され、
 * そこから `runFundedX()`（＝`runFundedSession()` の保護区間）へ入るまでに
 * 失敗しうる処理を挟むと、返金も精算もされないまま資金が残る。
 *
 * 実際にこの穴を2回作った（`view.message()` と `users.fetch()`）ので、
 * 「fund 後に await を置かない」を人間が覚えるルールではなく、
 * **コードが破れないルール**へ昇格させる。non-async なので、ここへ `await` を
 * 書こうとすると typecheck が止める。
 */
function collectAndStartFunded(
  services: Services,
  deps: AcceptDeps,
  input: { session: string; challenge: PvpChallenge; challenger: User; interaction: ButtonInteraction },
): StartFundedResult {
  const { session, challenge, challenger, interaction } = input;
  const stakes = (deps.collect ?? collectStakes)(
    services,
    [challenge.challengerId, interaction.user.id],
    challenge.bet,
    `${session}:collect`,
    session,
    riskGameOf(challenge.game),
  );
  if (!stakes.ok) return { ok: false, stakes };

  // 徴収成功。ここから本体呼び出しまでの間に await を挟めない
  return {
    ok: true,
    completion: deps.runners[challenge.game](services, {
      challenger,
      opponent: interaction.user,
      bet: challenge.bet,
      session,
      view: pvpViewFromMessage(interaction.message),
      rematchInteraction: interaction,
    }),
  };
}

function claimFailureText(reason: ReservedClaimFailureReason): string {
  if (reason === "self") return "自分の募集は受けられません。";
  if (reason === "bot") return "ボットは参加できません。";
  if (reason === "challenger_busy") return "挑戦者がほかの卓に参加中です。終わってからもう一度受けてください。";
  if (reason === "accepter_busy") return "ほかの卓に参加中です。そちらを終えてから受けてください。";
  return "この募集は終了しています。";
}

/** 台帳へ入る内部識別子。指名導線と同じ値でなければならない */
function riskGameOf(game: PvpGameKey): string {
  return pvpGame(game)?.riskGame ?? game;
}

async function defaultFetchUser(interaction: ButtonInteraction, userId: string): Promise<User> {
  return interaction.client.users.fetch(userId);
}

/** 応答できない状況でも処理を止めないため握り潰す */
async function replyQuietly(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch {
    /* 期限切れ等 */
  }
}

async function closeQuietly(deps: AcceptDeps, card: Message, text: string): Promise<void> {
  try {
    await deps.closeCard(card, text);
  } catch (e) {
    console.error("[pvp] 募集カードの更新に失敗:", e);
  }
}

export type { PvpChallenge };
