import type { Guild, GuildMember } from "discord.js";
import { RANK_ROLE_SETTING_KEYS, roleToRestoreForStatus, type LadderRank } from "@meigokujo/core";
import type { Services } from "./services.js";

/**
 * サブ垢の階級を本体に合わせる。**初回の有効化と毎分の巡回で同じ処理を使う。**
 *
 * ## 予定した操作ではなく、Discord の実状態で成功を決める
 *
 * `roles.add` / `roles.remove` は失敗しても例外を返さないことがあり、逆に例外を
 * 返しても向こうでは通っていることがある。「呼んだから合っているはず」で成功に
 * するとこうなる:
 *
 * ```
 * alt=魔族 / main=魔人 → 魔族のremoveが失敗 → 魔人をadd成功 → 魔族+魔人のまま「同期済み」
 * ```
 *
 * だから最後に**取り直して**、望む状態と一致したときだけ成功にする。
 * 一致しない・確認できない場合は失敗として残し、次の巡回で再試行する。
 *
 * ## 下位ロールを足して成功にしない
 *
 * 不要なロールを剥がせないなら、そこで止める。剥がせないまま別の階級を足すと、
 * サブ垢だけが2つの階級を持つ状態が固定される。
 */

/** 本体の階級に対応するロールID。迷霊・離脱・入城前は `null`（階級ロールを持たせない） */
export function wantedRankRoleId(services: Services, mainUserId: string): string | null {
  const rank = roleToRestoreForStatus(services.entry.getSoul(mainUserId)?.status ?? null);
  if (!rank) return null;
  const key = RANK_ROLE_SETTING_KEYS[rank as LadderRank];
  return key ? (services.settings.getString(key) ?? null) : null;
}

/** 設定されている階級ロールすべて */
export function ladderRoleIds(services: Services): string[] {
  return Object.values(RANK_ROLE_SETTING_KEYS)
    .map((key) => services.settings.getString(key))
    .filter((id): id is string => !!id);
}

export type RankSyncResult =
  /** 望む状態になっている（何もしなかった場合を含む） */
  | { ok: true; changed: boolean; wanted: string | null }
  /** 望む状態にできなかった。`extra` が残っているロール */
  | { ok: false; reason: "mismatch"; wanted: string | null; extra: string[]; missing: string | null }
  /** Discord から実状態を確認できなかった */
  | { ok: false; reason: "unverifiable"; wanted: string | null };

/**
 * サブ垢の階級ロールを本体に合わせ、**実状態で確かめてから**結果を返す。
 *
 * 剥がすのが先。剥がせなかったら足さない（2つの階級を持つ状態を作らない）。
 */
export async function reconcileAltRank(
  services: Services,
  guild: Guild,
  member: GuildMember,
  mainUserId: string,
): Promise<RankSyncResult> {
  const wanted = wantedRankRoleId(services, mainUserId);
  const ladder = ladderRoleIds(services);
  const before = ladder.filter((id) => member.roles.cache.has(id));
  const toRemove = before.filter((id) => id !== wanted);

  for (const id of toRemove) {
    await member.roles.remove(id, "サブ垢: 本体の階級に合わせる").catch(() => undefined);
  }
  // **剥がせたか確かめてから足す。** 確認できないうちは何も足さない
  const afterRemoval = await freshLadderRoles(guild, member.id, ladder);
  if (afterRemoval === null) return { ok: false, reason: "unverifiable", wanted };
  const stillExtra = afterRemoval.filter((id) => id !== wanted);
  if (stillExtra.length > 0) {
    return { ok: false, reason: "mismatch", wanted, extra: stillExtra, missing: wanted };
  }

  const needsAdd = wanted !== null && !afterRemoval.includes(wanted);
  if (needsAdd) {
    await member.roles.add(wanted, "サブ垢: 本体の階級に合わせる").catch(() => undefined);
  }
  // 最後にもう一度、実状態で見る
  const final = needsAdd ? await freshLadderRoles(guild, member.id, ladder) : afterRemoval;
  if (final === null) return { ok: false, reason: "unverifiable", wanted };
  const extra = final.filter((id) => id !== wanted);
  const missing = wanted !== null && !final.includes(wanted) ? wanted : null;
  if (extra.length > 0 || missing !== null) {
    return { ok: false, reason: "mismatch", wanted, extra, missing };
  }
  return { ok: true, changed: toRemove.length > 0 || needsAdd, wanted };
}

/**
 * いま実際に付いている階級ロール。**取り直して**から見る。
 * 確認できなければ `null`（「付いていない」と混同しない）。
 */
async function freshLadderRoles(guild: Guild, userId: string, ladder: readonly string[]): Promise<string[] | null> {
  const fresh = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!fresh) return null;
  return ladder.filter((id) => fresh.roles.cache.has(id));
}

/** 記録に残す用の説明。運営が読んで次の手が分かる粒度にする */
export function describeRankSyncFailure(result: Extract<RankSyncResult, { ok: false }>): string {
  if (result.reason === "unverifiable") return "Discordから実状態を確認できませんでした";
  const parts: string[] = [];
  if (result.extra.length > 0) parts.push(`余分な階級ロールが残っています: ${result.extra.join(", ")}`);
  if (result.missing) parts.push(`付けられませんでした: ${result.missing}`);
  return parts.join(" / ");
}
