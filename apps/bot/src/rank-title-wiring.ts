import type { RankAward, RankTrack } from "@meigokujo/core";
import type { Services } from "./services.js";
import { runSchedulerTaskOnce } from "./scheduler-utils.js";

/**
 * 位名（rank title）unlockを、実際のRankEngine XP付与へlive接続するorchestration
 * （PR D2）。細かいTitleV2Storeロジックをrank-tracker.tsへ直接散らさず、ここへ集約する。
 *
 * **live best-effort + historical reconcileによる自己修復**というモデル。RankEngineの
 * XP付与（既存production機能）とTitleV2Storeのunlock persistenceを1つの外側
 * transactionへ結合しない——v2 sidecarの失敗が既存のXP付与・rank-up通知を壊さないように
 * 意図的に分離する。
 */

/**
 * live observed transition。`award.tierUp`（実際にtierを跨いだ）か、現在tierの
 * unlock行がまだ無い（pre-v2 userのcurrent tier欠損・新規userのLv0欠損）場合にだけ
 * `recordRankTitleTransition()`を呼ぶ——普通の同tier内XP増加ではno-op（不要な
 * writeを避ける）。
 *
 * caller supplied timestampは一切渡さない——`unlockedAt`の正本は常にTitleV2Store
 * clock（既存B3契約）。
 *
 * v2 unlock persistenceが失敗しても、ここでcatchしてlogだけする——呼び出し元の
 * 既存XP付与・rank-up通知処理を継続させる（v2 sidecar failureで本体機能を壊さない）。
 * 失敗した分は後続のhistorical reconcile（daily/startup）が`unlockedAt=NULL`で
 * 自己修復する——「本当はlive crossingだったはず」と現在時刻を捏造しない。
 *
 * **track/award整合性guard**（PR #159レビュー§4）: `track`と`award`は呼び出し側が
 * 別々に渡す2引数——将来のwiring typo（例: text awardなのに`"voice"`を渡す）で、
 * text levelの数値をvoice tierとして誤unlockしてしまう事故を防ぐ。`award.before.tier.track`
 * /`award.after.tier.track`が指定`track`と一致しない場合は、wrong-track unlockを
 * 一切作らずerror logだけしてreturnする——現在のproduction callsite（text/text・
 * voice/voiceで一致）では発火しない、将来のtypo防止のためのfail-closed guard。
 */
export function recordLiveRankTitleUnlock(
  services: Pick<Services, "titleV2">,
  userId: string,
  track: RankTrack,
  award: RankAward,
): void {
  try {
    if (award.before.tier.track !== track || award.after.tier.track !== track) {
      console.error(
        `[rank-title-v2] track mismatch: called with track=${track} but award tiers are ` +
          `before=${award.before.tier.track} after=${award.after.tier.track} userId=${userId}`,
      );
      return;
    }
    const currentTierKey = award.after.tier.key;
    if (award.tierUp || !services.titleV2.hasRankTitleUnlock(userId, currentTierKey)) {
      services.titleV2.recordRankTitleTransition(userId, track, award.before.level, award.after.level);
    }
  } catch (e) {
    console.error(`[rank-title-v2] live unlock persistence failed track=${track} userId=${userId}`, e);
  }
}

/** identity-freeな要約統計（§29-30、PR D1のTitlePrefetchSummaryと同じ思想）。 */
export interface RankTitleReconcileSummary {
  readonly usersScanned: number;
  readonly tracksReconciled: number;
  readonly newlyUnlocked: number;
}

/**
 * historical reconcile runner。`RankEngine.listTrackedLevels()`（rank DBのuser
 * union、Discord guild.membersには依存しない）を正本に、各userのtext/voice両trackを
 * `TitleV2Store.reconcileRankTitleUnlocks()`で補完する。
 *
 * - 通知しない（DM・rank通知channel・event、いずれも一切送らない——大量historical
 *   unlockでも無言）。
 * - auto-equipしない（`profile_identity_equips`は3枠UIでuser自身が選ぶ、後続PR）。
 * - 削除・downgradeしない（`reconcileRankTitleUnlocks()`自体が既存unlockを保持する
 *   既存B3契約——ここでは追加の削除ロジックを一切書かない）。
 * - 何もmutationしないrelated state: title_awards / title_ownerships / series
 *   mastery / collection edition / relationship evidence / profile_identity_equips
 *   ——触るのは`rank_title_unlocks`だけ。
 * - SYSTEM_EPOCH/CATALOG_EPOCHの施行有無に依存しない（`reconcileRankTitleUnlocks()`
 *   自体がcatalog epochを一切参照しない）。
 *
 * 各userにつき1回でも`reconcileRankTitleUnlocks()`がthrowすれば、この関数もそのまま
 * throwする——外側でtry/catchするのは呼び出し側（startup/daily scheduler）の責務。
 * 個々の`reconcileRankTitleUnlocks()`呼び出しはそれぞれ独立したtransactionなので、
 * 途中で失敗しても、それまでに成功したuserのunlockはrollbackされず残る——次回の
 * reconcileはidempotentなので、再実行すれば失敗地点から自然に再開できる。
 */
export function reconcileTrackedRankTitles(services: Pick<Services, "ranks" | "titleV2">): RankTitleReconcileSummary {
  const tracked = services.ranks.listTrackedLevels();
  let tracksReconciled = 0;
  let newlyUnlocked = 0;
  for (const t of tracked) {
    const text = services.titleV2.reconcileRankTitleUnlocks(t.userId, "text", t.textLevel);
    tracksReconciled += 1;
    newlyUnlocked += text.newlyUnlocked.length;

    const voice = services.titleV2.reconcileRankTitleUnlocks(t.userId, "voice", t.voiceLevel);
    tracksReconciled += 1;
    newlyUnlocked += voice.newlyUnlocked.length;
  }
  return { usersScanned: tracked.length, tracksReconciled, newlyUnlocked };
}

/**
 * Bot起動時のrank title reconcile（ClientReady、外部Discord APIは使わない）。
 *
 * startup repairとdaily scheduled repairは別概念——ここではdaily markerを立てない
 * （startupが成功したからといって、その日のdaily reconcileをskipしない）。
 *
 * 完全に同期処理（`reconcileTrackedRankTitles()`はDBだけを読み書きする）。失敗しても
 * Bot自体の起動を止めない——呼び出し側でtry/catchを書かなくて済むよう、この関数自身が
 * catchしてlogする（index.tsのClientReadyから直接呼べる形にする）。
 */
export function startupReconcileRankTitles(services: Pick<Services, "ranks" | "titleV2">): void {
  try {
    const summary = reconcileTrackedRankTitles(services);
    console.log(
      `[rank-title-v2] startup reconcile users=${summary.usersScanned} tracksReconciled=${summary.tracksReconciled} newlyUnlocked=${summary.newlyUnlocked}`,
    );
  } catch (e) {
    console.error("[rank-title-v2] startup reconcile failed", e);
  }
}

/**
 * 1日1回のrank title reconcile（scheduler tick、JST 04:30〜04:32の3分retry window
 * から`dateStr`を渡して呼ぶ想定）。marker: `rank_title_v2:reconciled:${dateStr}`。
 *
 * 成功時だけmarkerを立てる（`runSchedulerTaskOnce()`の既存契約）——途中失敗した日は
 * markerが付かず、次のtickで自然にretryされる。reconcileはidempotentなので、
 * retryで既存unlock行がUPDATEされることはない。全user×2trackを1つの外側DB
 * transactionへ包まない——`reconcileRankTitleUnlocks()`自体が各mutationの
 * transaction境界を持つ。
 */
export async function runDailyRankTitleReconcile(
  services: Pick<Services, "ranks" | "titleV2" | "settings">,
  dateStr: string,
): Promise<boolean> {
  const marker = `rank_title_v2:reconciled:${dateStr}`;
  if (services.settings.getString(marker)) return false;
  return runSchedulerTaskOnce(services, marker, "system:scheduler", () => {
    const summary = reconcileTrackedRankTitles(services);
    console.log(
      `[rank-title-v2] daily reconcile users=${summary.usersScanned} tracksReconciled=${summary.tracksReconciled} newlyUnlocked=${summary.newlyUnlocked}`,
    );
  });
}
