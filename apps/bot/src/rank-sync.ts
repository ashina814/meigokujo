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
  /** ロール構成の異常。DBを書いたかに関わらず入る（運営へ提示するため） */
  anomalies?: string[];
}

/**
 * `/管理 → 階級の再同期` でだけ使う、取りこぼした「亡霊ロール付与」の再実行。
 *
 * 対象は **既に魂台帳に waiting として存在する人だけ**。
 * waiting → ghost は status を直接書くだけでは不十分で、評価サイクル開始・名前固定・
 * 初期発行など通常の入城処理を通す必要がある。そのため、GuildMemberUpdate を取りこぼした
 * ときだけ既存のロール付与ハンドラへ「亡霊ロールが今追加された」形を再現して委譲する。
 *
 * `no_soul` はここで復旧しない。古い移行漏れなのか本当に新規入城イベントを取りこぼしたのか
 * 判別できず、通常の ghostify を流すと joined_at / ghost_at / 評価サイクルや旧方式の初期発行まで
 * 「いま新規入城した」意味で作り直す可能性があるため、明示的なlegacy復旧へ分離する。
 * 自動同期からも呼ばない。
 */
async function recoverMissedGhostRoleAdd(member: GuildMember, services: Services): Promise<boolean> {
  const soul = services.entry.getSoul(member.id);
  if (soul?.status !== "waiting") return false;

  const ghostRoleId = services.settings.getString("role:ghost");
  if (!ghostRoleId || !member.roles.cache.has(ghostRoleId)) return false;

  // 「Discord上の階級が亡霊だけ」のときに限定し、上位階級・迷霊を亡霊へ巻き戻さない。
  const snapshot = snapshotOf(member, services);
  if (snapshot.meirei || snapshot.ladder.length !== 1 || snapshot.ladder[0] !== "ghost") return false;

  const beforeRoles = member.roles.cache.filter((role) => role.id !== ghostRoleId);
  const syntheticBefore = { roles: { cache: beforeRoles } } as unknown as GuildMember;
  const { handleMemberRoleUpdate } = await import("./commands/entry.js");
  await handleMemberRoleUpdate(syntheticBefore, member, services);
  return services.entry.getSoul(member.id)?.status === "ghost";
}

/**
 * 1人ぶんの再判定を**いま**実行する。
 *
 * 自動同期（debounce の後）と、運営の明示同期の両方がここを通る。
 * 明示同期を「強制的に任意 status を書く」機能にはしないため、判定は共通にしてある。
 * ただし、明示同期で waiting + 亡霊ロールの取りこぼしを見つけた場合だけは、
 * status の直書きではなく通常の亡霊化フローを再実行して復旧する。
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
    // 台帳に居ない人へロールだけで階級を作らない（入城処理の迂回になる）。
    // Discord上で亡霊に見えても、legacy移行漏れと新規イベント取りこぼしをここでは推測しない。
    services.events.log("rank_sync_ambiguous", { actor, target: userId, payload: { reason: "no_soul_row" } });
    return { kind: "no_soul", detail: "no_soul_row" };
  }

  const snapshot = snapshotOf(member, services);
  const decision = decideRankSync(soul.status, snapshot);

  // ロール構成の異常は**DBを書いたかどうかと無関係**に記録する。
  // status が既に一致している構成（DB迷霊 + ロール迷霊/魔族、DB眷魔 + ロール魔人/眷魔 など）や、
  // 自動同期を禁じた遷移こそ、誰も直さないまま残るので可視化の必要が高い。
  const desired = decision.kind === "update" ? decision.to : decision.kind === "ambiguous" ? decision.desired : soul.status;
  for (const anomaly of decision.anomalies) {
    services.events.log("rank_sync_role_anomaly", {
      actor,
      target: userId,
      payload: { anomaly, from: soul.status, desired, decision: decision.kind },
    });
  }

  if (decision.kind === "noop") return { kind: "noop", detail: decision.reason, anomalies: decision.anomalies };

  if (decision.kind === "ambiguous") {
    // `/管理 → 階級の再同期` は actor=user:<id> で来る。自動同期(system:*)では
    // waiting → ghost を勝手に入城扱いにせず、運営が明示した時だけ取りこぼしを回収する。
    if (actor.startsWith("user:") && decision.from === "waiting" && decision.desired === "ghost") {
      const recovered = await recoverMissedGhostRoleAdd(member, services);
      if (recovered) {
        services.events.log("rank_sync_entry_recovered", {
          actor,
          target: userId,
          payload: { from: decision.from, desired: decision.desired, reason: "missed_ghost_role_add" },
        });
        return {
          kind: "update",
          detail: "entry_recovered",
          from: decision.from,
          to: "ghost",
          anomalies: decision.anomalies,
        };
      }
      // 名前ゲート・出戻り・Discord API 失敗などで通常入城処理が成立しなかった。
      // status を直書きして迂回せず、そのまま曖昧として残す。
      services.events.log("rank_sync_ambiguous", {
        actor,
        target: userId,
        payload: {
          reason: "entry_recovery_blocked",
          from: decision.from,
          desired: decision.desired,
          anomalies: decision.anomalies,
        },
      });
      return {
        kind: "ambiguous",
        detail: "entry_recovery_blocked",
        from: decision.from,
        to: decision.desired ?? undefined,
        anomalies: decision.anomalies,
      };
    }

    // 階級ロールが無い・自動で越えてはいけない遷移。DBは触らず記録だけ残す
    services.events.log("rank_sync_ambiguous", {
      actor,
      target: userId,
      payload: { reason: decision.reason, from: decision.from, desired: decision.desired, anomalies: decision.anomalies },
    });
    return {
      kind: "ambiguous",
      detail: decision.reason,
      from: decision.from,
      to: decision.desired ?? undefined,
      anomalies: decision.anomalies,
    };
  }

  const applied = services.evaluation.syncStatusFromRoles(userId, decision.from, decision.to, actor, {
    anomalies: decision.anomalies,
  });
  return applied
    ? { kind: "update", detail: "applied", from: decision.from, to: decision.to, anomalies: decision.anomalies }
    : { kind: "noop", detail: "stale_precondition", from: decision.from, to: decision.to, anomalies: decision.anomalies };
}

/**
 * ロール変更を受けて再判定を予約する。
 * 同じ人の連続したロール変更は最後の1回にまとめる。
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
