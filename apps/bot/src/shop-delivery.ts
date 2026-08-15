import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import {
  AUTO_DELIVERABLE_KINDS,
  roleToRestoreForStatus,
  describeRejection,
  parseDeliverySnapshot,
  type OriginalRoleRow,
  type PurchaseRow,
} from "@meigokujo/core";
import { refreshEvalStatsForUser } from "./eval-daily.js";
import { withUserLock } from "./user-lock.js";
import {
  currentLadderRoles,
  missingLadderRoleKeys,
  reconcileAltRank,
  restoreAltRank,
} from "./sub-account-rank.js";
import type { Services } from "./services.js";

/**
 * 自動配送の実行。**購入（課金）とは独立した工程**として扱う。
 *
 * ## なぜ分けるか
 *
 * 以前は `purchaseOnce()` が課金と operation の completed を確定した後に配送していた。
 * つまり**配送が失敗しても課金だけ成立**し、同じ operation の再実行は `replayed=true` で
 * 配送そのものを飛ばすので、二度と配れなかった。実際に「再評価チャレンジ」で
 * 500,000Ld を払ったのに迷霊ロールが外れないまま、という事故が起きている。
 *
 * ここでは配送状態（pending / delivered / failed）を購入行に持たせ、
 * **成功するまで何度でも同じ購入を配送できる**ようにする。二重配送は
 * `beginDelivery()` の `delivered` 判定と、各配送種別の冪等性で防ぐ。
 *
 * ## interaction を受け取らない
 *
 * 購入直後の配送も、運営の回収導線からの再配送も同じ経路を通す必要がある。
 * そのため Discord の interaction ではなく `Guild` だけを受け取る。
 */

export interface DeliveryOutcome {
  /**
   * `not_active` は返金・取消・失効した購入への配送要求。**`failed` と混ぜない。**
   * `failed` は「配れなかったので返金へ倒す」合図なので、返金済みの購入がここへ入ると
   * 二重返金を試みることになる。
   */
  state: "delivered" | "failed" | "already_delivered" | "not_active";
  /** 利用者へ見せる文言。**失敗時に「配送しました」と読める文言を返さない** */
  message: string;
  /** 失敗理由（記録用） */
  error?: string;
  /**
   * `false` のときは**失敗しても返金しない**。
   *
   * Discord 側の副作用を戻せたか確認できなかったときに使う。返金してしまうと
   * 「払っていないのにロールを持っている」が残る。ここは人が見て決める。
   */
  refundable?: boolean;
}

/**
 * 購入に記録された配送内容。**商品の現在定義へフォールバックしない。**
 *
 * 再配送は「その購入で何を売ったか」だけを再実行する約束なので、スナップショットが
 * 無い・壊れている・知らない種別なら何もしない（legacy unknown）。ここでフォールバックすると、
 * 商品定義を後から変えただけで過去の購入の配送内容が変わってしまう。
 */
/** 購入時に本人が入力した内容 */
export function parseRequest(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Botがニックネームを変えられない理由。**課金前にも同じ判定を使う**ので、
 * 「払ったのに変えられない」を作らない。
 */
export function nicknameBlockReason(
  guild: Pick<Guild, "ownerId"> & { members: { me: GuildMember | null } },
  member: Pick<GuildMember, "id" | "manageable">,
): { reason: string; message: string } | null {
  if (guild.ownerId === member.id) {
    return {
      reason: "target_is_owner",
      message: "サーバー所有者のニックネームはBotから変更できません。お手数ですがご自身で変更してください。",
    };
  }
  const me = guild.members.me;
  if (!me) return { reason: "bot_member_unavailable", message: "Bot自身の情報が取れないため変更できません。" };
  if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    return {
      reason: "missing_manage_nicknames",
      message: "Botに「ニックネームの管理」権限がないため、現在は名前を変更できません。運営にご相談ください。",
    };
  }
  // Discord.js が owner / bot自身 / ロール順序まで含めて算出する manageability を正本にする。
  // 独自の position 数値比較を重ねると、ライブラリ側の判定と二重管理になる。
  if (!member.manageable) {
    return {
      reason: "role_hierarchy",
      message: "Discord上のロール階層によりBotから管理できないため、名前を変更できません。運営にご相談ください。",
    };
  }
  return null;
}

const purchaseLocks = new Map<number, Promise<unknown>>();

/**
 * 同じ購入への操作を**同時に2本走らせない。**
 *
 * 状態の判定（`beginDelivery`）と実行（Discord API）の間には必ず待ちがあり、
 * その隙に2本目が入ると、両方が「まだ配送していない」を見てから両方が動く。
 * 片方が名前を変え、もう片方が失敗して返金する——**変えたうえで返した**が成立する。
 * DBの条件付き更新は書き込みの二重化までしか止められないので、Discord側の副作用を
 * 含めて直列化する。Botは単一プロセスなので、プロセス内の直列化で足りる。
 *
 * **区間は「配送して、駄目なら返す」まで。** 配送だけを直列化すると、失敗した1本目が
 * 返金を書き終える前に2本目が「まだ有効な購入」を見てしまい、同じ穴が残る
 * （`deliverOrRefund` がこのロックを取る）。
 */
export function withPurchaseLock<T>(purchaseId: number, run: () => Promise<T>): Promise<T> {
  const previous = purchaseLocks.get(purchaseId);
  const next = (previous ? previous.then(noop, noop) : Promise.resolve()).then(run);
  purchaseLocks.set(purchaseId, next);
  return next.finally(() => {
    // 後続が並んでいれば、その最後の1本だけが自分を消す
    if (purchaseLocks.get(purchaseId) === next) purchaseLocks.delete(purchaseId);
  });
}

function noop(): void {
  /* 直前の操作の成否は、次の操作の判定に影響しない（DBの状態だけを見る） */
}

export function deliverPurchase(
  services: Services,
  guild: Guild | null,
  purchase: PurchaseRow,
  actor: string,
): Promise<DeliveryOutcome> {
  return withNicknameSerialization(purchase, () =>
    withPurchaseLock(purchase.id, () => deliverPurchaseUnlocked(services, guild, purchase, actor)),
  );
}

/**
 * 名前変更は**利用者単位でも直列化する**。
 *
 * 購入ごとのロックだけだと、同じ人の別の改名purchase（A→B と A→C）が同時に走る。
 * 予約の取り合いと巻き戻しが噛み合って、正本が壊れる。入城パネルと同じ鍵を使うので、
 * 商館とパネルの同時操作も噛み合わない。
 */
export function withNicknameSerialization<T>(purchase: PurchaseRow, run: () => Promise<T>): Promise<T> {
  const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
  if (snapshot?.delivery_kind !== "set_nickname") return run();
  return withUserLock(`nickname:${purchase.user_id}`, run);
}

/**
 * 配送の本体。**`withPurchaseLock` の中からだけ呼ぶこと。**
 * 返金までを1区間にしたい呼び出し側（`deliverOrRefund`）のために開けてある。
 */
export async function deliverPurchaseUnlocked(
  services: Services,
  guild: Guild | null,
  purchase: PurchaseRow,
  actor: string,
): Promise<DeliveryOutcome> {
  const begin = services.shop.beginDelivery(purchase.id);
  if (begin.reason === "not_active") {
    // 返金・取消・失効した購入への配送要求（古い確認画面の再送・巡回の取りこぼし）。
    // **返金済みなら名前は変えない。** ここを failed にすると呼び出し側が二重返金を試みる
    return {
      state: "not_active",
      message:
        begin.status === "refunded"
          ? "この購入は返金済みのため、何もしていません。"
          : `この購入は ${begin.status} のため、何もしていません。`,
      error: `purchase_not_active:${begin.status}`,
    };
  }
  if (!begin.proceed) {
    // 二度押し・再起動・再配送要求。副作用を一切走らせない
    return { state: "already_delivered", message: "この購入は配送済みです。" };
  }

  const fail = (reason: string, userMessage: string, opts: { refundable?: boolean } = {}): DeliveryOutcome => {
    services.shop.markDeliveryFailed(purchase.id, reason, actor);
    return { state: "failed", message: userMessage, error: reason, refundable: opts.refundable };
  };

  const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
  if (!snapshot) {
    // 購入時の配送内容が読めない。商品の現在設定で代用せず、何もせず failed にする
    return fail(
      purchase.delivery_snapshot_json ? "snapshot_unreadable" : "snapshot_missing",
      "この購入には配送内容の記録がないため自動配送できません。運営にお問い合わせください。",
    );
  }
  if (!AUTO_DELIVERABLE_KINDS.has(snapshot.delivery_kind)) {
    // 撤回された配送種別（再評価チャレンジの revoke_meirei）。
    // 面談を経ずに status とロールを動かさない。過去の購入も自動では実行しない
    return fail(
      `auto_delivery_withdrawn:${snapshot.delivery_kind}`,
      "この商品は自動での適用を行いません。**再評価面談チケット**を開いてください。",
    );
  }
  const kind = snapshot.delivery_kind;
  const data = snapshot.delivery_data as { role_id?: string; channel_id?: string; days?: number };
  const userId = purchase.user_id;

  try {
    if (kind === "add_role") {
      const roleId = data.role_id;
      if (!roleId) return fail("role_id_missing", "配送設定が不完全です（ロールID未設定）。運営にお問い合わせください。");
      if (!guild) return fail("guild_unavailable", "サーバー情報が取れず配送できませんでした。運営にお問い合わせください。");
      let member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
      if (!member) return fail("member_fetch_failed", "メンバー情報の取得に失敗し配送できませんでした。運営にお問い合わせください。");
      if (!member.roles.cache.has(roleId)) {
        // APIの返り値だけでは成功としない。エラー応答でも実際には付いている場合があるため、
        // mutation後にforce fetchしたDiscord実状態を正本にする。
        const addError = await member.roles.add(roleId).then(() => null).catch((e: Error) => e.message);
        member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
        if (!member) return fail("member_final_fetch_failed", "ロール付与後の状態を確認できませんでした。自動で再試行します。");
        if (!member.roles.cache.has(roleId)) {
          return fail(`role_add_failed:${addError ?? "role_missing"}`, "ロールの付与に失敗しました。自動で再試行します。");
        }
      }
      services.shop.markDeliverySucceeded(purchase.id, actor);
      const destination = typeof data.channel_id === "string" && data.channel_id.trim()
        ? `\n利用先: <#${data.channel_id.trim()}>`
        : "";
      return { state: "delivered", message: `利用可能になりました（<@&${roleId}>）。${destination}` };
    }

    if (kind === "set_nickname") {
      const request = parseRequest(purchase.request_json);
      const raw = typeof request?.nickname === "string" ? request.nickname : null;
      if (!raw) return fail("nickname_missing", "希望の名前が記録されていないため変更できませんでした。");
      if (!guild) return fail("guild_unavailable", "サーバー情報が取れず変更できませんでした。");
      // **最新の状態を取り直す。** 課金後にBotが落ちた場合、変更だけ先に済んでいることがある
      const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
      if (!member) return fail("member_fetch_failed", "メンバー情報の取得に失敗し変更できませんでした。");

      // **名前の正本は入城制度と同じ。** ただし有料の改名は二段階で進める。
      // 新名を仮押さえし、**旧名は Discord の変更が通るまで手放さない**。
      // 先に手放すと、変更に失敗して戻すときに旧名を他の人へ取られている
      const staged = services.nicknames.stageRename({
        userId,
        nickname: raw,
        purchaseId: purchase.id,
        actor,
        allowLocked: true, // 入城後の固定を越えられるのは商館の正式な改名だけ
      });
      if (!staged.ok) {
        const r = staged.rejection;
        if (r.code === "taken") {
          return fail(
            `nickname_taken:${r.by}`,
            "その名前は購入後に他の方が使い始めたため、お使いいただけませんでした。",
          );
        }
        if (r.code === "locked") return fail("nickname_locked", "名前が固定されているため変更できませんでした。");
        return fail(`nickname_rejected:${r.code}`, describeRejection(r));
      }
      const { nickname: wanted, key } = staged;

      // **見るのは `nickname`（サーバーニックネーム）。** `displayName` はグローバル
      // 表示名も混ざるので、まだ変えていないのに「変わっている」と誤認する
      if (member.nickname === wanted) {
        // Discord だけ変わって落ちた場合もここに来る。確定させて終わらせる
        services.nicknames.commitRename(userId, key, actor);
        services.shop.markDeliverySucceeded(purchase.id, actor);
        return { state: "delivered", message: `サーバーニックネームは既に **${wanted}** です。` };
      }
      const blocked = nicknameBlockReason(guild, member);
      if (blocked) {
        services.nicknames.abortRename(userId, key, actor);
        return fail(blocked.reason, blocked.message);
      }
      const setError = await member
        .setNickname(wanted, "公式ショップ: 名前変更")
        .then(() => null)
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message || "unknown" : String(e);
          const code =
            typeof e === "object" && e !== null && "code" in e
              ? String((e as { code?: unknown }).code ?? "") || null
              : null;
          const me = guild.members.me;
          try {
            services.events.log("shop_nickname_set_failed", {
              actor,
              target: userId,
              payload: {
                purchaseId: purchase.id,
                error: message,
                code,
                memberManageable: member.manageable,
                botHasManageNicknames: me?.permissions.has(PermissionFlagsBits.ManageNicknames) ?? false,
                botHighestRoleId: me?.roles.highest.id ?? null,
                botHighestRolePosition: me?.roles.highest.position ?? null,
                memberHighestRoleId: member.roles.highest.id,
                memberHighestRolePosition: member.roles.highest.position,
              },
            });
          } catch {
            // 診断ログの失敗で既存の返金・収束経路を壊さない。
          }
          return message;
        });
      if (setError !== null) {
        // **エラーが返っても、変わっていることがある。** 応答が落ちただけ・内部再試行で
        // 通っていた、など。ここで確かめずに取り消すと「名前は変わったのに返金もした」に
        // なる。最新のメンバーを取り直し、希望どおりなら成功として扱う
        const latest = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
        if (latest?.nickname !== wanted) {
          // **仮押さえだけ解放する。旧名はそのまま。** 名乗っている名前は変わらない
          services.nicknames.abortRename(userId, key, actor);
          return fail(`nickname_set_failed:${setError}`, "名前の変更に失敗しました。");
        }
      }
      // ここで初めて旧名を手放す
      services.nicknames.commitRename(userId, key, actor);
      services.shop.markDeliverySucceeded(purchase.id, actor);
      return { state: "delivered", message: `サーバーニックネームを **${wanted}** に変更しました。` };
    }

    if (kind === "create_original_role") {
      const request = parseRequest(purchase.request_json);
      const applicationId = typeof request?.applicationId === "number" ? request.applicationId : null;
      if (!applicationId) return fail("application_missing", "申請の記録が無いため作成できませんでした。");
      if (!guild) return fail("guild_unavailable", "サーバー情報が取れず作成できませんでした。");
      const application = services.originalRoles.get(applicationId);
      if (!application) return fail("application_not_found", "申請が見つかりません。運営にお問い合わせください。");
      if (application.user_id !== userId) return fail("application_owner_mismatch", "申請の持ち主が違います。");
      // 落ちて再実行された場合、ロールは作れているのに契約が始まっていないことがある。
      // **作り直さない**（同じ名前のロールが増える）。作った記録があればそれを使う
      if (application.status === "active" && application.role_id) {
        services.shop.markDeliverySucceeded(purchase.id, actor);
        return { state: "delivered", message: `オリジナルロール <@&${application.role_id}> は作成済みです。` };
      }
      if (application.status !== "approved") {
        return fail(`application_bad_status:${application.status}`, "この申請は承認待ちの状態ではありません。");
      }
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return fail("member_fetch_failed", "メンバー情報の取得に失敗しました。");

      const resolved = await resolveOriginalRole(services, guild, application, actor);
      if ("error" in resolved) {
        return fail(resolved.error, ORIGINAL_ROLE_MESSAGES[resolved.error] ?? "ロールの作成に失敗しました。");
      }
      const { role, createdNow } = resolved;

      // 仮の名前のままなら、付与の直前に本来の名前へ変える
      if (role.name !== application.name) {
        const renamed = await role
          .edit({ name: application.name, reason: `公式ショップ: オリジナルロール命名（申請 #${application.id}）` })
          .then(() => true)
          .catch((e: Error) => e.message || "unknown");
        if (renamed !== true) {
          if (createdNow) await role.delete("公式ショップ: 命名に失敗したため取り消し").catch(() => undefined);
          return fail(`role_rename_failed:${renamed}`, "ロール名の設定に失敗しました。");
        }
      }

      let added = await member.roles
        .add(role.id, "公式ショップ: オリジナルロール付与")
        .then(() => true)
        .catch((e: Error) => e.message || "unknown");
      if (added !== true) {
        // **エラーだけで決めない。** Discord側では通っていることがある。
        // 取り直して実際に持っていれば、付与は成功として先へ進む
        if (await memberHasRole(guild, userId, role.id)) added = true;
      }
      if (added !== true) {
        // 付けられないロールを残さない（誰のものでもないロールが増える）。
        // 前回の続きで拾ったロールは消さずに残す——記録と結び付いているので、
        // 次の巡回が同じロールで付与だけをやり直せる
        if (createdNow) await role.delete("公式ショップ: 付与に失敗したため取り消し").catch(() => undefined);
        return fail(`role_add_failed:${added}`, "ロールの付与に失敗しました。");
      }
      if (!services.originalRoles.activate({ id: application.id, roleId: role.id, purchaseId: purchase.id, actor })) {
        const settled = services.originalRoles.get(application.id);
        // 相手が同じロールで契約を始めていたなら、これは成功の収束。何も戻さない
        if (settled?.status === "active" && settled.role_id === role.id) {
          services.shop.markDeliverySucceeded(purchase.id, actor);
          return { state: "delivered", message: `オリジナルロール <@&${role.id}> を作成しました。**30日間**ご利用いただけます。` };
        }
        // **返金する前に、今つけた副作用を戻す。** 返金だけして付与が残ると
        // 「払っていないのに持っている」になる。引き継いだ既存ロールは消さず、
        // 本人からの付与だけ外す（他の契約の持ち物かもしれない）
        const removed = await member.roles
          .remove(role.id, "公式ショップ: 契約を開始できなかったため取り消し")
          .then(() => true)
          .catch(() => false);
        // **外せたかどうかを実物で確かめる。** 外れていないまま返金すると
        // 「払っていないのに持っている」が残る。確認できなければ返金しない
        const stillHeld = removed ? await memberHasRole(guild, userId, role.id) : await memberHasRoleStrict(guild, userId, role.id);
        if (stillHeld !== false) {
          return fail(
            "activate_conflict_rollback_failed",
            "契約の開始に失敗しました。運営が確認しますので、そのままお待ちください。",
            { refundable: false },
          );
        }
        if (createdNow) await role.delete("公式ショップ: 二重実行のため取り消し").catch(() => undefined);
        return fail("activate_conflict", "契約の開始に失敗しました。運営にお問い合わせください。");
      }
      services.shop.markDeliverySucceeded(purchase.id, actor);
      return {
        state: "delivered",
        message: `オリジナルロール <@&${role.id}> を作成しました。**30日間**ご利用いただけます。`,
      };
    }

    if (kind === "activate_sub_account") {
      const request = parseRequest(purchase.request_json);
      const applicationId = typeof request?.applicationId === "number" ? request.applicationId : null;
      if (!applicationId) return fail("application_missing", "申請の記録が無いため有効化できませんでした。");
      if (!guild) return fail("guild_unavailable", "サーバー情報が取れず有効化できませんでした。");
      const application = services.subAccounts.get(applicationId);
      if (!application) return fail("application_not_found", "申請が見つかりません。運営にお問い合わせください。");
      if (application.main_user_id !== userId) return fail("application_owner_mismatch", "申請の持ち主が違います。");
      // 落ちて再実行された場合、ロールは付いているのに記録が終わっていないことがある
      if (application.status === "active") {
        services.shop.markDeliverySucceeded(purchase.id, actor);
        return { state: "delivered", message: `サブ垢 <@${application.alt_user_id}> は有効化済みです。` };
      }
      if (application.status !== "approved") {
        return fail(`application_bad_status:${application.status}`, "この申請は承認待ちの状態ではありません。");
      }
      const alt = await guild.members.fetch(application.alt_user_id).catch(() => null);
      if (!alt) return fail("alt_not_in_guild", "サブ垢がサーバーに参加していないため有効化できませんでした。");

      // **入城処理（ghostify）は流用しない。** あれは初期発行・評価期間の開始・
      // 招待実績の確定までやるので、サブ垢に流すと同じ人が二重に初期発行を受け、
      // 評価期間まで生える。サブ垢に渡すのは本体と同じ階級ロールだけ
      const soul = services.entry.getSoul(userId);
      if (!soul || !roleToRestoreForStatus(soul.status)) {
        return fail("main_rank_unavailable", "本体の階級が確認できないため有効化できませんでした。運営にお問い合わせください。");
      }
      // **1個 add するだけにしない。** 別の階級ロールが残っていれば正規化し、
      // 本体と完全に同じ状態になったことを実状態で確かめてから契約を始める。
      // 毎分の巡回と同じ処理を使う（片方だけ緩い、を作らない）
      // **Discord を変更する前に、巻き戻しの基準を DB へ残す。**
      // ここに残さないと、剥がした直後に落ちたとき「元は何を持っていたか」が
      // プロセスと一緒に消え、再起動後の再試行が剥がしたあとの状態を
      // 「開始前」と誤認して、返金したうえで元の階級を消したままにする
      const missingKeys = missingLadderRoleKeys(services);
      if (missingKeys.length > 0) {
        return fail(
          `alt_rank_config_missing:${missingKeys.join(",")}`,
          "階級ロールの設定が足りないため有効化できませんでした。運営にお問い合わせください。",
        );
      }
      let baseline = services.subAccounts.activationBaseline(application.id);
      if (baseline === null) {
        const current = await currentLadderRoles(services, guild, application.alt_user_id);
        if (current === null) {
          return fail("alt_rank_unverifiable", "サブ垢の状態を確認できなかったため有効化できませんでした。");
        }
        baseline = services.subAccounts.saveActivationBaseline(application.id, current);
      }
      const synced = await reconcileAltRank(services, guild, alt, userId, { baseline });
      if (!synced.ok) {
        // **変更を始めたあとの失敗は、開始前へ戻せた確認が取れるまで返金しない。**
        // 返金だけ通ると「払っていないのに階級ロールが残っている」が起きる
        const safeToRefund = synced.restored === true;
        return fail(
          `alt_rank_sync_failed:${synced.reason}${synced.restored === true ? "" : ":rollback_unconfirmed"}`,
          safeToRefund
            ? "サブ垢の階級を本体に合わせられなかったため有効化できませんでした。"
            : "サブ垢の階級を戻せたか確認できませんでした。運営が確認しますので、そのままお待ちください。",
          { refundable: safeToRefund },
        );
      }


      if (!services.subAccounts.activate({ id: application.id, purchaseId: purchase.id, actor })) {
        const settled = services.subAccounts.get(application.id);
        // 相手が先に有効化していたなら、これは成功の収束
        if (settled?.status === "active") {
          services.shop.markDeliverySucceeded(purchase.id, actor);
          return { state: "delivered", message: `サブ垢 <@${application.alt_user_id}> を有効化しました。` };
        }
        // **返金の前に、階級ロールを処理開始前の状態へ戻す。**
        // 正規化で剥がしたものは戻し、足したものは外す。今回付けていない
        // 元からのロールを巻き添えで剥がさない
        const restored = await restoreAltRank(services, guild, alt, baseline);
        if (restored !== true) {
          return fail(
            "sub_account_conflict_rollback_failed",
            "サブ垢の有効化に失敗しました。運営が確認しますので、そのままお待ちください。",
            { refundable: false },
          );
        }
        return fail("sub_account_activate_conflict", "サブ垢の有効化に失敗しました。運営にお問い合わせください。");
      }
      services.shop.markDeliverySucceeded(purchase.id, actor);
      return {
        state: "delivered",
        message: `サブ垢 <@${application.alt_user_id}> を有効化しました。階級は本体に合わせて自動で追従します。`,
      };
    }

    if (kind === "extend_deadline") {
      const days = data.days ?? 1;
      const soul = services.entry.getSoul(userId);
      if (!soul || !soul.eval_deadline_at) {
        return fail("no_eval_deadline", "評価期限を持っていないため延長できませんでした。運営にお問い合わせください。");
      }
      // 冪等でない配送なので、効果と完了マークを同じトランザクションで確定する。
      // 途中で落ちても「延ばしたのに未配送のまま」にはならない＝再試行で二重延長しない
      services.shop.completeDeliveryWith(purchase.id, actor, () => {
        services.db
          .prepare("UPDATE souls SET eval_deadline_at = eval_deadline_at + ?, updated_at = ? WHERE user_id = ?")
          .run(days * 86_400, Math.floor(Date.now() / 1_000), userId);
      });
      if (guild) await refreshEvalStatsForUser(guild, services, userId).catch(() => undefined);
      return { state: "delivered", message: `評価期限を **+${days}日** 延長しました。` };
    }

    return fail(`unsupported_delivery_kind:${kind ?? "null"}`, "自動配送は未対応の種類です。運営にお問い合わせください。");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return fail(`unexpected:${reason}`, "配送処理でエラーが発生しました。運営にお問い合わせください。");
  }
}

/**
 * 運営の回収導線: purchase ID を指定して再配送する。
 *
 * **任意の商品効果を撃てる汎用口にはしない。** 対象は
 * 「実在する購入」「status=active」「購入時に自動配送として売られた記録がある」に限り、
 * 実行する内容もその購入に記録された配送スナップショットだけ。
 */
export async function redeliverPurchase(
  services: Services,
  guild: Guild | null,
  purchaseId: number,
  actor: string,
): Promise<DeliveryOutcome> {
  const purchase = services.shop.getPurchase(purchaseId);
  if (!purchase) return { state: "failed", message: "その購入が見つかりません。", error: "purchase_not_found" };
  if (purchase.status !== "active") {
    return { state: "failed", message: `この購入は ${purchase.status} のため再配送できません。`, error: "purchase_not_active" };
  }
  // 可否は**購入時スナップショット**で決める。商品の現在設定を根拠にすると、
  // 買った後に商品を自動配送へ変えただけで過去の購入が再配送できてしまう
  const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
  if (!snapshot) {
    return {
      state: "failed",
      message: "この購入には自動配送の記録がありません（手動配送・または記録以前の購入）。再配送の対象外です。",
      error: purchase.delivery_snapshot_json ? "snapshot_unreadable" : "snapshot_missing",
    };
  }
  if (!AUTO_DELIVERABLE_KINDS.has(snapshot.delivery_kind)) {
    return {
      state: "failed",
      message: "この配送種別は自動実行を取りやめています（再評価チャレンジは面談を経て復帰します）。再配送できません。",
      error: `auto_delivery_withdrawn:${snapshot.delivery_kind}`,
    };
  }
  services.events.log("shop_redelivery_requested", {
    actor,
    target: purchase.user_id,
    payload: {
      purchaseId,
      itemId: purchase.item_id,
      deliveryKind: snapshot.delivery_kind,
      previousState: purchase.delivery_state,
      attempts: purchase.delivery_attempts,
    },
  });
  return deliverPurchase(services, guild, purchase, actor);
}

/**
 * オリジナルロールの実体を決める。**「作ったかどうか分からない」を作り直しで解決しない。**
 *
 * Discord へロールを作る操作と、それをDBに書く操作の間には必ず窓がある。ここで落ちると
 * 「ロールはあるのに記録が無い」状態が残り、素直に再試行すると同じ名前のロールが2個できる。
 * そこで作りにいく前に印（`role_creation_started_at`）を置き、再試行はこの順で拾う:
 *
 * 1. 記録済みの `role_id` がまだ生きていれば、それを使う
 * 2. 印があるなら、**申請と同じ名前で・印より後に生まれ・他の契約が使っていない**ロールを探す
 *    - 候補が2つ以上なら**選ばない**。どれが本人のものか決められないので運営へ回す
 * 3. どれも無ければ、新しく作る
 */
const ORIGINAL_ROLE_MESSAGES: Record<string, string> = {
  role_lookup_failed: "Discordのロール一覧を確認できなかったため、作成を見送りました。少し待って再度お試しください。",
  role_create_ambiguous: "作りかけのロールが複数見つかったため、自動では進められませんでした。運営にお問い合わせください。",
};

/**
 * 作りかけのロールに付ける**一意な仮の名前**。
 *
 * 「本来の名前 + だいたいの時刻」で探すと、たまたま同じ名前の別人のロールを拾いうる。
 * 申請IDを埋めた名前で作れば、**作った直後に落ちても自分のものだけを一意に回収できる**。
 * 付与の直前に本来の名前へ変える。
 */
export function stagingRoleName(applicationId: number): string {
  return `作成中-オリジナルロール-申請${applicationId}`;
}

async function resolveOriginalRole(
  services: Services,
  guild: Guild,
  application: OriginalRoleRow,
  actor: string,
): Promise<{ role: Role; createdNow: boolean } | { error: string }> {
  // **「無い」と「確認できない」を分ける。** APIが読めなかっただけで作りに進むと、
  // 既にあるロールの隣に2個目ができる。読めなければ何も作らずに終わる
  let all: Awaited<ReturnType<Guild["roles"]["fetch"]>> | null;
  try {
    all = await guild.roles.fetch();
  } catch {
    return { error: "role_lookup_failed" };
  }
  if (!all) return { error: "role_lookup_failed" };

  if (application.role_id) {
    const known = all.get(application.role_id);
    // 記録があるロールが消えている（人が消した）ときだけ、作り直しへ進む
    if (known) return { role: known, createdNow: false };
  }
  if (application.role_creation_started_at !== null) {
    // 仮の名前は申請IDで一意。**名前と時刻での推測ではない**
    const staged = [...all.values()].filter((r) => r.name === stagingRoleName(application.id));
    if (staged.length > 1) return { error: "role_create_ambiguous" };
    if (staged.length === 1) {
      services.originalRoles.attachRole(application.id, staged[0]!.id, actor);
      return { role: staged[0]!, createdNow: false };
    }
  }
  // **作りにいく前に印を置く。** これが無いと、次の再試行は探すことすらできない
  services.originalRoles.markRoleCreationStarted(application.id);
  // **危険な権限は付けない。** 見た目のためのロールなので権限は空で作る
  const created = await guild.roles
    .create({
      name: stagingRoleName(application.id),
      color: application.color ?? undefined,
      permissions: [],
      mentionable: false,
      hoist: false,
      reason: `公式ショップ: オリジナルロール作成（申請 #${application.id}）`,
    })
    .then((role) => role)
    .catch((e: Error) => e.message || "unknown");
  if (typeof created === "string") return { error: `role_create_failed:${created}` };
  // **付与より先に記録する。** ここで落ちても role_id から拾い直せる
  services.originalRoles.attachRole(application.id, created.id, actor);
  return { role: created, createdNow: true };
}

/** 本当に持っているか、取り直して確かめる。確認できなければ「持っていない」とは言わない */
async function memberHasRole(guild: Guild, userId: string, roleId: string): Promise<boolean> {
  const fresh = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  return fresh?.roles.cache.has(roleId) ?? false;
}

/**
 * 外れたかどうかを確かめる。**「確認できなかった」を「外れた」に倒さない。**
 * `null` は確認できなかった合図で、呼び出し側は返金を止める。
 */
async function memberHasRoleStrict(guild: Guild, userId: string, roleId: string): Promise<boolean | null> {
  const fresh = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!fresh) return null;
  return fresh.roles.cache.has(roleId);
}

