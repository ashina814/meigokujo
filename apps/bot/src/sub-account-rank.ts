import type { Guild, GuildMember } from "discord.js";
import { RANK_ROLE_SETTING_KEYS, roleToRestoreForStatus, type LadderRank } from "@meigokujo/core";
import type { Services } from "./services.js";

/**
 * サブ垢の階級を本体に合わせる。**初回の有効化と毎分の巡回で同じ処理を使う。**
 *
 * ## 判断はすべて Discord の実状態で行う
 *
 * `roles.add` / `roles.remove` は失敗しても例外を返さないことがあり、逆に例外を
 * 返しても向こうでは通っていることがある。ローカルの `roles.cache` も古い。
 * だから**操作の前も後も取り直して**、実物を見てから決める。
 *
 * ## 途中で失敗したら、始める前の状態へ戻す
 *
 * 「返金したのに権利は残っている」を作らないため、変更を始めたあとに失敗したら
 * 開始前の階級集合へ戻す。**戻ったことを実状態で確かめられたときだけ**返金してよい。
 * 戻せない・確かめられない場合は人へ渡す。
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

/**
 * 階級ロール設定のうち、値が入っていないもの。
 *
 * **1つでも欠けていたら階級を触らない。** 欠けたぶんは「そのロールを持っていない」
 * ようにしか見えないので、設定漏れが「階級なしが正解」に化けて、既存の階級を
 * 剥がしたうえで成功扱いになってしまう。
 */
export function missingLadderRoleKeys(services: Services): string[] {
  return Object.values(RANK_ROLE_SETTING_KEYS).filter((key) => !services.settings.getString(key));
}

export type RankSyncResult =
  /** 望む状態になっている（何もしなかった場合を含む）。`previous` は触る前の実状態 */
  | { ok: true; changed: boolean; wanted: string | null; previous: string[] }
  /** 階級ロールの設定が欠けている。**Discord は一切変更していない** */
  | { ok: false; reason: "config_missing"; wanted: null; mutated: false; restored: true; missingKeys: string[] }
  /** 望む状態にできなかった／確かめられなかった */
  | {
      ok: false;
      reason: "mismatch" | "unverifiable";
      wanted: string | null;
      /** Discord を変更したか */
      mutated: boolean;
      /**
       * 開始前の状態へ戻せたか。**`true` のときだけ返金してよい。**
       * `null` は実状態を確認できなかった合図。
       */
      restored: boolean | null;
      extra?: string[];
      missing?: string | null;
    };

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
  opts: {
    /**
     * 巻き戻しの基準。**課金がからむ初回の有効化では、Discord を変更する前に
     * DB へ残したものを渡す。** 再起動後の再試行が取り直すと、剥がしたあとの
     * 状態を「開始前」と誤認してしまう
     */
    baseline?: readonly string[];
  } = {},
): Promise<RankSyncResult> {
  // **設定が揃っていなければ何も触らない。** 判定の前に確かめる
  const missingKeys = missingLadderRoleKeys(services);
  if (missingKeys.length > 0) {
    return { ok: false, reason: "config_missing", wanted: null, mutated: false, restored: true, missingKeys };
  }
  const wanted = wantedRankRoleId(services, mainUserId);
  const ladder = ladderRoleIds(services);

  // **開始前の状態も実物から取る。** `roles.cache` は古いことがあり、古い集合を
  // 「開始前」として巻き戻すと、持っていなかったロールを新しく付けてしまう
  const previous = opts.baseline ? [...opts.baseline] : await freshLadderRoles(guild, member.id, ladder);
  if (previous === null) {
    // まだ何も触っていないので、戻すものは無い
    return { ok: false, reason: "unverifiable", wanted, mutated: false, restored: true };
  }
  // 剥がす対象は**いまの実状態**から決める（基準は巻き戻し用で、現在の状態とは別物）
  const presentState = opts.baseline ? await freshLadderRoles(guild, member.id, ladder) : previous;
  if (presentState === null) return { ok: false, reason: "unverifiable", wanted, mutated: false, restored: true };
  const toRemove = presentState.filter((id) => id !== wanted);

  /** 変更を始めたあとの失敗。**開始前へ戻してから**でないと返金させない */
  const rollback = async (
    reason: "mismatch" | "unverifiable",
    extra?: string[],
    missing?: string | null,
  ): Promise<RankSyncResult> => {
    const restored = await restoreAltRank(services, guild, member, previous);
    return { ok: false, reason, wanted, mutated: true, restored, extra, missing };
  };

  for (const id of toRemove) {
    await member.roles.remove(id, "サブ垢: 本体の階級に合わせる").catch(() => undefined);
  }
  // **剥がせたか確かめてから足す。** 確認できないうちは何も足さない
  const afterRemoval = toRemove.length > 0 ? await freshLadderRoles(guild, member.id, ladder) : presentState;
  if (afterRemoval === null) return rollback("unverifiable");
  const stillExtra = afterRemoval.filter((id) => id !== wanted);
  if (stillExtra.length > 0) return rollback("mismatch", stillExtra, wanted);

  const needsAdd = wanted !== null && !afterRemoval.includes(wanted);
  if (needsAdd) {
    await member.roles.add(wanted, "サブ垢: 本体の階級に合わせる").catch(() => undefined);
  }
  // 最後にもう一度、実状態で見る
  const final = needsAdd ? await freshLadderRoles(guild, member.id, ladder) : afterRemoval;
  if (final === null) {
    // **ここが要注意。** add が向こうで通っている可能性があるので、戻せた確認が取れるまで返金しない
    return rollback("unverifiable");
  }
  const extra = final.filter((id) => id !== wanted);
  const missing = wanted !== null && !final.includes(wanted) ? wanted : null;
  if (extra.length > 0 || missing !== null) return rollback("mismatch", extra, missing);

  return { ok: true, changed: toRemove.length > 0 || needsAdd, wanted, previous };
}

/**
 * 階級ロールを**指定の状態へ戻す**。
 *
 * 契約が成立しないなら、こちらが正規化した副作用も残さない。返金だけして
 * 「勝手に階級を剥がされた」も「払っていないのに権利がある」も残さないため、
 * 実状態を取り直して差分だけを当て、最後にもう一度実状態で一致を確かめる。
 *
 * @returns 戻せたら `true`、戻せなければ `false`、実状態を確認できなければ `null`
 */
export async function restoreAltRank(
  services: Services,
  guild: Guild,
  member: GuildMember,
  previous: readonly string[],
): Promise<boolean | null> {
  const ladder = ladderRoleIds(services);
  const want = new Set(previous);
  const current = await freshLadderRoles(guild, member.id, ladder);
  if (current === null) return null;
  for (const id of ladder) {
    const has = current.includes(id);
    if (want.has(id) && !has) {
      await member.roles.add(id, "サブ垢: 契約が成立しなかったため元に戻す").catch(() => undefined);
    } else if (!want.has(id) && has) {
      await member.roles.remove(id, "サブ垢: 契約が成立しなかったため元に戻す").catch(() => undefined);
    }
  }
  const fresh = await freshLadderRoles(guild, member.id, ladder);
  if (fresh === null) return null;
  return fresh.length === want.size && fresh.every((id) => want.has(id));
}

/**
 * いま実際に付いている階級ロール。**取り直して**から見る。
 * 確認できなければ `null`（「付いていない」と混同しない）。
 */
export async function currentLadderRoles(
  services: Services,
  guild: Guild,
  userId: string,
): Promise<string[] | null> {
  return freshLadderRoles(guild, userId, ladderRoleIds(services));
}

async function freshLadderRoles(guild: Guild, userId: string, ladder: readonly string[]): Promise<string[] | null> {
  const fresh = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!fresh) return null;
  return ladder.filter((id) => fresh.roles.cache.has(id));
}

/** 記録に残す用の説明。運営が読んで次の手が分かる粒度にする */
export function describeRankSyncFailure(result: Extract<RankSyncResult, { ok: false }>): string {
  if (result.reason === "config_missing") {
    return `階級ロールの設定が足りません（${result.missingKeys.join(", ")}）。Discordは変更していません`;
  }
  const parts: string[] = [];
  if (result.reason === "unverifiable") parts.push("Discordから実状態を確認できませんでした");
  if (result.extra && result.extra.length > 0) parts.push(`余分な階級ロールが残っています: ${result.extra.join(", ")}`);
  if (result.missing) parts.push(`付けられませんでした: ${result.missing}`);
  if (result.mutated) {
    parts.push(
      result.restored === true
        ? "変更は開始前の状態へ戻しました"
        : result.restored === false
          ? "**開始前の状態へ戻せませんでした**（要対応）"
          : "**戻せたか確認できませんでした**（要対応）",
    );
  }
  return parts.join(" / ");
}
