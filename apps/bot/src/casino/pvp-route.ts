import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { Services } from "../services.js";
import { runFundedBjDuel } from "./bj-duel.js";
import { runFundedChinchiroDuel } from "./chinchiro-duel.js";
import { runFundedIndian } from "./indian.js";
import { acceptPvpChallenge, type AcceptDeps, type FundedRunner } from "./pvp-accept.js";
import { PVP_ACCEPT, PVP_CANCEL, closeChallengeCard } from "./pvp-card.js";
import { cancelChallenge, getChallenge } from "./pvp-challenge.js";
import type { PvpGameKey } from "./pvp-games.js";
import { handlePvpOpenSetupButton, isPvpOpenSetupButton, renderPvpOpenGameSelect } from "./pvp-open-ui.js";
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

/**
 * casino-home の先頭にある既存フック。名前は互換のため残すが、
 * 募集カードだけでなく「みんなで勝負」のセットアップ画面もここで拾う。
 */
export function isPvpCardButton(customId: string): boolean {
  return (
    customId === "casino:home:pvp" ||
    isPvpOpenSetupButton(customId) ||
    customId.startsWith(`${PVP_ACCEPT}:`) ||
    customId.startsWith(`${PVP_CANCEL}:`)
  );
}

/**
 * 公開1v1のセットアップ・受諾・取消を1本のルートへ閉じる。
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
  if (interaction.customId === "casino:home:pvp") {
    await interaction.reply({ ...renderPvpOpenGameSelect(), flags: MessageFlags.Ephemeral });
    return;
  }
  if (isPvpOpenSetupButton(interaction.customId)) {
    await handlePvpOpenSetupButton(interaction, services);
    return;
  }

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
