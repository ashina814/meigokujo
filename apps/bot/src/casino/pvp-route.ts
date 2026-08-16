import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { Services } from "../services.js";
import { runFundedBjDuel } from "./bj-duel.js";
import { runFundedChinchiroDuel } from "./chinchiro-duel.js";
import { runFundedIndian } from "./indian.js";
import { acceptPvpChallenge, type AcceptDeps, type FundedRunner } from "./pvp-accept.js";
import { PVP_ACCEPT, PVP_CANCEL, closeChallengeCard } from "./pvp-card.js";
import { cancelChallenge, getChallenge } from "./pvp-challenge.js";
import type { PvpGameKey } from "./pvp-games.js";
import { runFundedSashiDuel } from "./sashi.js";

export const PVP_RUNNERS: Record<PvpGameKey, FundedRunner> = {
  chinchiro: runFundedChinchiroDuel,
  bj: runFundedBjDuel,
  sashi: runFundedSashiDuel,
  indian: runFundedIndian,
};

interface PvpCardRouteDeps {
  accept: typeof acceptPvpChallenge;
  get: typeof getChallenge;
  cancel: typeof cancelChallenge;
  closeCard: typeof closeChallengeCard;
  runners: Record<PvpGameKey, FundedRunner>;
}

const DEFAULT_DEPS: PvpCardRouteDeps = {
  accept: acceptPvpChallenge,
  get: getChallenge,
  cancel: cancelChallenge,
  closeCard: closeChallengeCard,
  runners: PVP_RUNNERS,
};

/** `casino:home:` のうち、公開募集カード由来の操作だけを拾う。 */
export function isPvpCardButton(customId: string): boolean {
  return customId.startsWith(`${PVP_ACCEPT}:`) || customId.startsWith(`${PVP_CANCEL}:`);
}

/**
 * 公開募集カードの受諾・取消を処理する。
 *
 * accept は {@link acceptPvpChallenge} の「最初の await より前に同期 claim」を壊さないため、
 * この関数でも呼び出し前に await を置かない。cancel も同じく、所有者確認から
 * `cancelChallenge()` までを同期で終わらせて accept / expire との競合を確定させる。
 */
export async function handlePvpCardButton(
  interaction: ButtonInteraction,
  services: Services,
  deps: PvpCardRouteDeps = DEFAULT_DEPS,
): Promise<void> {
  const acceptId = actionId(interaction.customId, PVP_ACCEPT);
  if (acceptId !== null) {
    if (!acceptId) {
      await replyQuietly(interaction, "募集情報が壊れています。");
      return;
    }
    // ここより前に await を置かない。acceptPvpChallenge 内で同期 claim する。
    await deps.accept(interaction, services, acceptId, {
      runners: deps.runners,
      closeCard: deps.closeCard,
    } satisfies AcceptDeps);
    return;
  }

  const cancelId = actionId(interaction.customId, PVP_CANCEL);
  if (cancelId === null) return;
  if (!cancelId) {
    await replyQuietly(interaction, "募集情報が壊れています。");
    return;
  }

  const current = deps.get(cancelId);
  if (!current) {
    await replyQuietly(interaction, "この募集は終了しています。");
    return;
  }
  if (current.challengerId !== interaction.user.id) {
    await replyQuietly(interaction, "この募集を取り消せるのは挑戦者だけです。");
    return;
  }

  // 所有者確認から状態遷移まで await を挟まない。同一 Node プロセスではここが競合の確定点。
  const cancelled = deps.cancel(cancelId, interaction.user.id);
  if (!cancelled) {
    await replyQuietly(interaction, "この募集は終了しています。");
    return;
  }

  try {
    await interaction.deferUpdate();
  } catch (e) {
    // 状態は既に cancelled。復活させず、可能ならカードだけ閉じる。
    console.error(`[pvp] 募集取消の応答に失敗 id=${cancelId}:`, e);
    await closeQuietly(deps, interaction, "募集は取り消されました。");
    return;
  }
  await closeQuietly(deps, interaction, "募集は取り消されました。");
}

/**
 * prefix 自体には一致したが ID が空、という壊れた customId も区別する。
 * UUID に `:` は入らないので余分な segment も不正扱いにする。
 */
function actionId(customId: string, prefix: string): string | null {
  const marker = `${prefix}:`;
  if (!customId.startsWith(marker)) return null;
  const id = customId.slice(marker.length);
  return id && !id.includes(":") ? id : "";
}

async function replyQuietly(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    /* 期限切れ等。状態を変える処理ではないので握り潰す */
  }
}

async function closeQuietly(deps: PvpCardRouteDeps, interaction: ButtonInteraction, text: string): Promise<void> {
  try {
    await deps.closeCard(interaction.message, text);
  } catch (e) {
    console.error("[pvp] 募集取消カードの更新に失敗:", e);
  }
}
