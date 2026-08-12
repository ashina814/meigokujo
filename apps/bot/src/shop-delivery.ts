import type { Guild, GuildMember } from "discord.js";
import {
  AUTO_DELIVERABLE_KINDS,
  describeRejection,
  parseDeliverySnapshot,
  type PurchaseRow,
} from "@meigokujo/core";
import { refreshEvalStatsForUser } from "./eval-daily.js";
import { withUserLock } from "./user-lock.js";
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
  member: Pick<GuildMember, "id"> & { roles: { highest: { position: number } } },
): { reason: string; message: string } | null {
  if (guild.ownerId === member.id) {
    return {
      reason: "target_is_owner",
      message: "サーバー所有者のニックネームはBotから変更できません。お手数ですがご自身で変更してください。",
    };
  }
  const me = guild.members.me;
  if (!me) return { reason: "bot_member_unavailable", message: "Bot自身の情報が取れないため変更できません。" };
  if (me.roles.highest.position <= member.roles.highest.position) {
    return {
      reason: "role_hierarchy",
      message: "あなたのロールがBotより上位のため、Botからは変更できません。運営にご相談ください。",
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

  const fail = (reason: string, userMessage: string): DeliveryOutcome => {
    services.shop.markDeliveryFailed(purchase.id, reason, actor);
    return { state: "failed", message: userMessage, error: reason };
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
  const data = snapshot.delivery_data as { role_id?: string; days?: number };
  const userId = purchase.user_id;

  try {
    if (kind === "add_role") {
      const roleId = data.role_id;
      if (!roleId) return fail("role_id_missing", "配送設定が不完全です（ロールID未設定）。運営にお問い合わせください。");
      if (!guild) return fail("guild_unavailable", "サーバー情報が取れず配送できませんでした。運営にお問い合わせください。");
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return fail("member_fetch_failed", "メンバー情報の取得に失敗し配送できませんでした。運営にお問い合わせください。");
      if (!member.roles.cache.has(roleId)) {
        // 付与済みなら何もしない（冪等）
        const added = await member.roles.add(roleId).then(() => true).catch((e: Error) => e.message);
        if (added !== true) return fail(`role_add_failed:${added}`, "ロールの付与に失敗しました。運営にお問い合わせください。");
      }
      services.shop.markDeliverySucceeded(purchase.id, actor);
      return { state: "delivered", message: `ロールを付与しました: <@&${roleId}>` };
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
        .catch((e: Error) => e.message || "unknown");
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
