import type { Guild, GuildMember } from "discord.js";
import {
  MEIREI_ROLE_SETTING_KEY,
  RANK_LADDER,
  RANK_ROLE_SETTING_KEYS,
  decideRankSync,
  type LadderRank,
  type RankRoleSnapshot,
} from "@meigokujo/core";
import type { Services } from "./services.js";

/**
 * Discord の階級ロール → `souls.status` の同期。
 *
 * ## 方式: debounce してから最終ロールを取り直す
 *
 * `GuildMemberUpdate` に付いてくる old/new は「その瞬間の途中状態」でしかない。
 * 階級変更は付与と剥奪が別イベントで届くので、そのまま status へ変換すると
 * 「魔人を付けた直後、まだ亡霊が外れていない」等の中間状態を正本にしてしまう。
 *
 * そこで利用者ごとに短い debounce を置き、静まってから **guild.members.fetch で
 * 現在のロールを取り直して**判定する。イベントの中身は「この人を見直せ」という
 * 合図としてしか使わない。
 *
 * ## Bot 自身の変更との関係
 *
 * `/昇格` などは Bot 自身がロールを2回動かすので、当然ここにもイベントが来る。
 * ただし判定は「最終ロール vs 現在のDB」なので、既に一致していれば
 * `noop` になる。抑止フラグは重複処理を減らす補助でしかなく、
 * **抑止が外れても正しさは崩れない**。
 */

/** 同じ人の連続したロール変更をまとめる待ち時間 */
const DEBOUNCE_MS = 2_000;
/** 反映が遅れて古いロールを読むのを避けるための取り直し猶予 */
const REFETCH_FORCE = true;

const pending = new Map<string, NodeJS.Timeout>();

/** テスト用。保留中のタイマーを捨てる */
export function resetRankSyncForTesting(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

/** 設定済みの階級ロールID一覧（未設定のものは持たない） */
function rankRoleIds(services: Services): { ladder: Array<[LadderRank, string]>; meirei: string | null } {
  const ladder: Array<[LadderRank, string]> = [];
  for (const rank of RANK_LADDER) {
    const id = services.settings.getString(RANK_ROLE_SETTING_KEYS[rank]);
    if (id) ladder.push([rank, id]);
  }
  return { ladder, meirei: services.settings.getString(MEIREI_ROLE_SETTING_KEY) ?? null };
}

/** メンバーのロールから階級スナップショットを作る */
export function snapshotOf(member: GuildMember, services: Services): RankRoleSnapshot {
  const { ladder, meirei } = rankRoleIds(services);
  return {
    ladder: ladder.filter(([, id]) => member.roles.cache.has(id)).map(([rank]) => rank),
    meirei: !!meirei && member.roles.cache.has(meirei),
  };
}

export interface ReconcileOutcome {
  kind: "noop" | "update" | "ambiguous" | "no_soul";
  detail: string;
  from?: string;
  to?: string;
}

/**
 * 1人ぶんの再判定を**いま**実行する。
 *
 * 自動同期（debounce の後）と、運営の明示同期の両方がここを通る。
 * 明示同期を「強制的に任意 status を書く」機能にしないため、判定は共通にしてある。
 */
export async function reconcileMemberRank(
  guild: Guild,
  services: Services,
  userId: string,
  actor: string,
): Promise<ReconcileOutcome> {
  const member = await guild.members.fetch({ user: userId, force: REFETCH_FORCE }).catch(() => null);
  if (!member) return { kind: "ambiguous", detail: "member_not_found" };
  if (member.user.bot) return { kind: "noop", detail: "bot" };

  const soul = services.entry.getSoul(userId);
  if (!soul) {
    // 台帳に居ない人へロールだけで階級を作らない（入城処理の迂回になる）
    services.events.log("rank_sync_ambiguous", { actor, target: userId, payload: { reason: "no_soul_row" } });
    return { kind: "no_soul", detail: "no_soul_row" };
  }

  const snapshot = snapshotOf(member, services);
  const decision = decideRankSync(soul.status, snapshot);

  if (decision.kind === "noop") return { kind: "noop", detail: decision.reason };

  if (decision.kind === "ambiguous") {
    // 階級ロールが無い・自動で越えてはいけない遷移。DBは触らず記録だけ残す
    services.events.log("rank_sync_ambiguous", {
      actor,
      target: userId,
      payload: { reason: decision.reason, from: decision.from, desired: decision.desired },
    });
    return { kind: "ambiguous", detail: decision.reason, from: decision.from, to: decision.desired ?? undefined };
  }

  for (const anomaly of decision.anomalies) {
    services.events.log("rank_sync_role_anomaly", { actor, target: userId, payload: { anomaly, to: decision.to } });
  }
  const applied = services.evaluation.syncStatusFromRoles(userId, decision.from, decision.to, actor, {
    anomalies: decision.anomalies,
  });
  return applied
    ? { kind: "update", detail: "applied", from: decision.from, to: decision.to }
    : { kind: "noop", detail: "stale_precondition", from: decision.from, to: decision.to };
}

/**
 * ロール変更を受けて再判定を予約する。
 * 同じ人の連続変更は最後の1回にまとめる。
 */
export function scheduleRankReconcile(guild: Guild, services: Services, userId: string, actor: string): void {
  const existing = pending.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(userId);
    void reconcileMemberRank(guild, services, userId, actor).catch((err) =>
      console.error("[rank-sync] 再判定に失敗:", err),
    );
  }, DEBOUNCE_MS);
  // Bot の終了を妨げない
  if (typeof timer.unref === "function") timer.unref();
  pending.set(userId, timer);
}

/** そのロール変更が階級に関係あるか（無関係な変更で毎回 fetch しない） */
export function touchesRankRoles(
  changed: readonly string[],
  services: Services,
): boolean {
  const { ladder, meirei } = rankRoleIds(services);
  const ids = new Set<string>(ladder.map(([, id]) => id));
  if (meirei) ids.add(meirei);
  return changed.some((id) => ids.has(id));
}
