import type { Client, Guild } from "discord.js";
import { Shop } from "@meigokujo/core";
import { awaitExternalEffectReady } from "./external-effect-barrier.js";
import type { TimedAccessGrant } from "@meigokujo/core";
import type { Services } from "./services.js";

export interface TimedAccessReconcileResult {
  checked: number;
  restored: number;
  absent: number;
  failed: Array<{ userId: string; roleId: string; error: string }>;
}

const emptyResult = (): TimedAccessReconcileResult => ({ checked: 0, restored: 0, absent: 0, failed: [] });

function errorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Number((error as { code?: unknown }).code);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * Discordへの操作は (利用者, ロール) 単位で1回でよいので、契約をそこへ畳む。
 *
 * **畳んだ結果の `purchase` は「代表」でしかない。** 同じロールを与える有効な契約が
 * 複数あると、`Map.set` の後勝ちで **id が最大の購入**だけが残る。ロールの付与は1回
 * なので、それが「どの購入の効果か」はここでは決まらない。
 *
 * したがって代表の `purchase.id` は、
 *   - Discordへ何をするか決めるため（同じロールを二度付けない）
 * には使ってよいが、
 *   - **どの購入が提供済みかの証拠**
 * には使ってはいけない。証拠を残すときは別途、帰属が一意であることを確かめる
 * （`timedAccessAttributionUnique()`）。
 */
function uniqueGrants(grants: TimedAccessGrant[]): TimedAccessGrant[] {
  const unique = new Map<string, TimedAccessGrant>();
  for (const grant of grants) unique.set(`${grant.purchase.user_id}:${grant.roleId}`, grant);
  return [...unique.values()];
}

/**
 * 有効な期限付きアクセス契約をDiscordへ収束させる。
 *
 * role addの直前と直後に契約を再確認する。期限切れ処理と競合して古い一覧からaddした場合は、
 * activeな別契約が無いことを確かめて自分で剥がし、expiredなのにロールだけ残す順序を作らない。
 */
async function reconcileTimedAccessRoles(
  guild: Guild,
  services: Pick<Services, "shop" | "events">,
  userId?: string,
): Promise<TimedAccessReconcileResult> {
  // **起動時収束を追い越さない。** 前のプロセスの held を調べ終わる前に
  // 同じ資源を取りにいくと、収束の前提（新しい worker はまだ動いていない）が崩れる
  await awaitExternalEffectReady();

  const result: TimedAccessReconcileResult = { checked: 0, restored: 0, absent: 0, failed: [] };
  for (const grant of uniqueGrants(services.shop.listActiveTimedAccess(userId))) {
    const target = grant.purchase.user_id;
    result.checked += 1;

    // **Discord を読む前に、外部効果の実行権を取る。**
    //
    // 「ロールが無いことを確認してから付ける」だけでは足りない。確認した後・付ける
    // 前に通常配送が同じ (guild, user, role) へ投げられるので、`roles.add` が二重に
    // 走りうる。読む前に durable な鍵を取り、取れた場合だけ**取ったあとに読み直す**。
    //
    // 鍵は購入ではなく効果の単位。同じロールを与える別契約が並んでいても、
    // 実行してよいのは常に1人だけになる。
    const effectKey = Shop.discordRoleEffectKey(guild.id, target, grant.roleId);
    const lock = services.shop.acquireExternalEffectLock({
      scope: "discord_role",
      key: effectKey,
      operation: "add",
      owner: "system:shop-timed-access",
      purchaseId: grant.purchase.id,
    });
    if (!lock.ok) {
      // 別の処理が同じ効果を握っている。**何も投げず、何も推測しない。**
      // 失敗でも未提供でもない——今は言えることが無い、というだけ
      continue;
    }
    let lockOpen = true;
    /** 副作用が無いと確認できたときだけ解放する。分からなければ握ったまま残す */
    const closeLock = (next: "settled" | "released" | "uncertain", reason: string): void => {
      if (!lockOpen) return;
      lockOpen = false;
      const args = { key: effectKey, token: lock.token, reason, actor: "system:shop-timed-access" };
      if (next === "settled") services.shop.settleExternalEffectLock(args);
      else if (next === "released") services.shop.releaseExternalEffectLock(args);
      else services.shop.markExternalEffectUncertain(args);
    };

    let member;
    try {
      // **鍵を取ったあとの観測が正本。** 取る前に見た状態は使わない
      member = await guild.members.fetch({ user: target, force: true });
    } catch (error) {
      closeLock("released", "member_fetch_failed_no_effect");
      if (errorCode(error) === 10007) {
        result.absent += 1;
        continue;
      }
      const message = `member_fetch_failed:${error instanceof Error ? error.message : String(error)}`;
      result.failed.push({ userId: target, roleId: grant.roleId, error: message });
      services.events.log("shop_timed_access_reconcile_failed", {
        actor: "system:shop-timed-access",
        target,
        payload: { purchaseId: grant.purchase.id, roleId: grant.roleId, error: message },
      });
      continue;
    }

    let added = false;
    /** 一度でも Discord へ投げたか。投げたあとは「無かった」と断定しない */
    let attempted = false;
    try {
      if (!member.roles.cache.has(grant.roleId)) {
        // **鍵を持ったまま、投げる直前にもう一度権利を確かめる。**
        // 一覧を取ってから鍵を取るまでに失効していることがある
        if (!services.shop.activeTimedAccessGrantsRole(target, grant.roleId)) {
          closeLock("released", "entitlement_expired_before_effect");
          continue;
        }
        attempted = true;
        // **APIの返り値だけで決めない。** エラー応答でも実際には付いていることがある。
        // 投げたあとに取り直した実物を正本にする（通常配送と同じ規則）
        const addError = await member.roles
          .add(grant.roleId, "有効な期限付きアクセス契約の復元")
          .then(() => null)
          .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        // ここで throw したら結果は分からないまま＝catch が uncertain で鍵を残す
        member = await guild.members.fetch({ user: target, force: true });
        added = member.roles.cache.has(grant.roleId);
        if (!added) {
          // 取り直した実物にロールが無い＝**副作用が無いことを確認できた**。
          // 鍵を解放して、次の巡回が普通にやり直せるようにする
          closeLock("released", "verified_no_effect_after_add");
          throw new Error(`role_add_failed:${addError ?? "role_missing"}`);
        }
      }

      // addと失効が競合した場合、古い処理が付けたロールを残さない。
      if (!services.shop.activeTimedAccessGrantsRole(target, grant.roleId)) {
        if (member.roles.cache.has(grant.roleId)) {
          await member.roles.remove(grant.roleId, "期限付きアクセス契約の失効を確認");
          const settled = await guild.members.fetch({ user: target, force: true });
          if (settled.roles.cache.has(grant.roleId)) throw new Error("stale_role_remained");
        }
        // 付けたものを自分で取り消した＝正味の副作用は残っていない
        closeLock("released", "expired_during_effect_rolled_back");
        continue;
      }
      if (!member.roles.cache.has(grant.roleId)) {
        // 付けたはずのロールが、その後の確認で消えている（外部が剥がした等）。
        // 実物で不在を確認できているので副作用は残っていない
        closeLock("released", "role_missing_after_add");
        throw new Error("role_missing_after_add");
      }

      services.shop.markDeliverySucceeded(grant.purchase.id, "system:shop-timed-access");
      // 成功印の直前に失効が割り込んだ場合も、古い巡回が権利を残さない。
      if (!services.shop.activeTimedAccessGrantsRole(target, grant.roleId)) {
        if (member.roles.cache.has(grant.roleId)) {
          await member.roles.remove(grant.roleId, "期限付きアクセス契約の失効を確認");
          const settled = await guild.members.fetch({ user: target, force: true });
          if (settled.roles.cache.has(grant.roleId)) throw new Error("stale_role_remained_after_settle");
        }
        closeLock("released", "expired_after_settle_rolled_back");
        continue;
      }
      if (added) {
        result.restored += 1;
        // **ここまで来たものだけが「外部効果の成立を確認できた」と言える。**
        //   1. 最初のforce fetchでロールが**無かった**
        //   2. 付ける直前にも契約がactiveだった
        //   3. 自分で `roles.add()` を成功させた
        //   4. force refetchで在席を**再確認**した
        //   5. 失効競合のチェックを通過した
        //
        // `added=false`（元からロールがあった）はここへ来ない。**ロールの起源を
        // 証明していない**ので、提供済みの証拠にも未提供の証拠にもしない。
        //
        // **所有権つきで、証拠と鍵の決着を1つの transaction にまとめる。**
        //
        // 「証拠を書く」と「鍵を閉じる」を割ると、間で落ちたときに
        // 「鍵は閉じたが購入側は未決着」になり、別 worker が再実行できてしまう。
        // また鍵を持たない呼び出し側が証拠だけ作れる形も残してはいけない。
        //
        // 帰属が証明できなければ証拠は書かず、鍵だけ正常に閉じる
        // （曖昧さは失敗ではない。言えることが無いだけ）。
        services.shop.completeTimedAccessRoleAdd({
          effectKey,
          effectToken: lock.token,
          purchaseId: grant.purchase.id,
          userId: target,
          roleId: grant.roleId,
          writer: "system:shop-timed-access",
          detail: { itemId: grant.item.id, verification: "force_refetch_role_present" },
        });
        lockOpen = false; // 上の operation が settled まで済ませている
        services.events.log("shop_timed_access_restored", {
          actor: "system:shop-timed-access",
          target,
          payload: { purchaseId: grant.purchase.id, itemId: grant.item.id, roleId: grant.roleId },
        });
      }
      // added=false（元から在った）の場合はここで閉じる。
      // added=true は上の完了 operation が所有権つきで閉じている
      closeLock("settled", "role_already_present");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // **投げたあとに分からなくなったなら、鍵は握ったまま残す。**
      // 解放すると「効果は無かった」と断定したことになり、次の worker が重ねて投げる
      closeLock(attempted ? "uncertain" : "released", `reconcile_failed:${message}`);
      services.shop.markDeliveryFailed(grant.purchase.id, `timed_access_reconcile:${message}`, "system:shop-timed-access");
      result.failed.push({ userId: target, roleId: grant.roleId, error: message });
      services.events.log("shop_timed_access_reconcile_failed", {
        actor: "system:shop-timed-access",
        target,
        payload: { purchaseId: grant.purchase.id, roleId: grant.roleId, error: message },
      });
    }
  }
  return result;
}

export async function reconcileTimedAccessForClient(
  client: Client,
  services: Pick<Services, "shop" | "settings" | "events">,
  userId?: string,
): Promise<TimedAccessReconcileResult> {
  const guildId = services.settings.getString("guild:main");
  if (!guildId) throw new Error("shop_timed_access:guild_id_missing");
  const guild = await client.guilds.fetch(guildId);
  return reconcileTimedAccessForGuild(guild, services, userId);
}

/** 起動時・再参加時とも、設定上のmain guild以外ではDiscordを一切読まない。 */
export async function reconcileTimedAccessForGuild(
  guild: Guild,
  services: Pick<Services, "shop" | "settings" | "events">,
  userId?: string,
): Promise<TimedAccessReconcileResult> {
  const guildId = services.settings.getString("guild:main");
  if (!guildId || guild.id !== guildId) return emptyResult();
  return reconcileTimedAccessRoles(guild, services, userId);
}
