import type { ButtonInteraction, Message } from "discord.js";
import type { Services } from "../services.js";
import { claimChallenge, type PvpChallenge } from "./pvp-challenge.js";
import { collectStakes, pvpViewFromMessage, stakeFailureText, type FundedPvpContext } from "./pvp-common.js";
import { pvpGame, type PvpGameKey } from "./pvp-games.js";

/**
 * 公開募集の受諾。**順序そのものがこの機能の本体**なので、経路を1本に閉じる。
 *
 * ```text
 * claimChallenge()          ← await を挟まない。最初の1人だけが通る
 * deferUpdate()             ← ここが最初の await
 * collectStakes([両者])      ← 1回。誰か駄目なら資金は動かない
 * pvpViewFromMessage(card)  ← 募集カードがそのまま対戦盤になる
 * runFundedX()              ← 資金保全は runFundedSession に任せる
 * ```
 *
 * ## Discord 側が落ちても募集を復活させない
 *
 * claim した時点で募集ライフサイクルは終了している。`deferUpdate()` や不成立表示が
 * 失敗しても、状態は戻さない——戻すと「再 open」と「別の accept」が競合する
 * 状態機械を新たに作ることになる。資金は一括徴収なので、失敗時は1 Ld も動いていない。
 * 見た目が古いカードとして残るだけで、後続の accept は `gone` で止まる。
 */
export type FundedRunner = (services: Services, ctx: FundedPvpContext) => Promise<void>;

export interface AcceptDeps {
  /** ゲーム種別 → 徴収済み本体。テストから差し替える */
  runners: Record<PvpGameKey, FundedRunner>;
  /**
   * 両者ぶんの徴収。本番は {@link collectStakes} をそのまま渡す。
   * 注入にしてあるのは、**順序（claim → defer → 徴収 → 本体）そのものを
   * テストで固定したい**から。
   */
  collect?: typeof collectStakes;
  /** カードのボタンを外して文面を差し替える。失敗しても募集は戻さない */
  closeCard: (card: Message, text: string) => Promise<unknown>;
}

export type AcceptOutcome =
  | { ok: true }
  | { ok: false; reason: "gone" | "self" | "bot" | "defer_failed" | "stakes_failed" };

export async function acceptPvpChallenge(
  interaction: ButtonInteraction,
  services: Services,
  challengeId: string,
  deps: AcceptDeps,
): Promise<AcceptOutcome> {
  // ── 1. 所有権を同期で確定させる（await を挟まない）──
  const claim = claimChallenge(challengeId, interaction.user.id, interaction.user.bot);
  if (!claim.ok) {
    await replyQuietly(interaction, claimFailureText(claim.reason));
    return { ok: false, reason: claim.reason };
  }
  const challenge = claim.challenge;

  // ── 2. 最初の await ──
  try {
    await interaction.deferUpdate();
  } catch (e) {
    // 募集は既に終了済み。復活させず、可能ならカードだけ閉じる
    console.error(`[pvp] 受諾の応答に失敗 id=${challengeId}:`, e);
    await closeQuietly(deps, interaction.message, "この募集は終了しました。");
    return { ok: false, reason: "defer_failed" };
  }

  // ── 3. 両者を1回で徴収（誰か駄目なら資金は動かない）──
  const session = `pvpopen:${challengeId}`;
  const stakes = (deps.collect ?? collectStakes)(
    services,
    [challenge.challengerId, interaction.user.id],
    challenge.bet,
    `${session}:collect`,
    session,
    gameLabel(challenge.game),
  );
  if (!stakes.ok) {
    await closeQuietly(deps, interaction.message, `${stakeFailureText(stakes)}この募集は不成立です。`);
    return { ok: false, reason: "stakes_failed" };
  }

  // ── 4. 募集カードをそのまま対戦盤にして本体へ渡す ──
  const challenger = await interaction.client.users.fetch(challenge.challengerId);
  await deps.runners[challenge.game](services, {
    challenger,
    opponent: interaction.user,
    bet: challenge.bet,
    session,
    view: pvpViewFromMessage(interaction.message),
    rematchInteraction: interaction,
  });
  return { ok: true };
}

function claimFailureText(reason: "gone" | "self" | "bot"): string {
  if (reason === "self") return "自分の募集は受けられません。";
  if (reason === "bot") return "ボットは参加できません。";
  return "この募集は終了しています。";
}

function gameLabel(game: PvpGameKey): string {
  return pvpGame(game)?.label ?? game;
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
