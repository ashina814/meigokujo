import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { SUB_ACCOUNT_PAYMENT_GRACE_DAYS, SubAccountError, isEligibleMainRank, type ShopItemRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

/**
 * サブ垢の利用者導線。
 *
 * ```
 * サブ垢のIDを入力 → 運営が本人確認して承認 → 80,000Ld 支払い → 有効化
 * ```
 *
 * **旧仕様の「先に払ってから人が処理」には戻さない。** 申請でも承認でも Land を
 * 動かさず、支払いは承認のあとの本人の操作だけにする。
 */

/** その商品が「サブ垢追加」か。設定で決める（旧購入を巻き込まない） */
export function isSubAccountItem(services: Services, item: ShopItemRow): boolean {
  const configured = Number(services.settings.getString("shop:sub_account_item_id"));
  return Number.isInteger(configured) && configured === item.id;
}

/** 支払い画面ごとの一意な鍵。返金されたあとに開き直すと別の値になる */
export function payAttemptToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 入力されたDiscord ID。`<@123>` 形式も受ける */
export function parseUserId(raw: string): string | null {
  const text = raw.trim();
  const m = /^(?:<@!?)?(\d{17,20})>?$/.exec(text);
  return m ? m[1]! : null;
}

/** 本体の現在の階級。**Discordロールではなく台帳を正本にする** */
export function mainRank(services: Services, userId: string) {
  return services.entry.getSoul(userId)?.status ?? null;
}

export function eligible(services: Services, userId: string): boolean {
  return isEligibleMainRank(mainRank(services, userId));
}

export const LEGACY_SUB_ACCOUNT_BLOCK_MESSAGE =
  "旧サブ垢契約が残っています。二重に支払わず、運営へ引き継ぎを依頼してください。";

/** 旧契約が未引き継ぎなら、新制度の申請を作らせない。購入履歴から alt は推測しない。 */
export function hasUnresolvedLegacySubAccount(services: Services, userId: string): boolean {
  const legacyItemId = Number(services.settings.getString("shop:sub_account_legacy_item_id"));
  if (!Number.isInteger(legacyItemId) || legacyItemId <= 0) return false;
  if (services.subAccounts.listByMain(userId).some((row) => row.status === "active")) return false;
  // 人が一度でも旧契約を明示登録していれば、正式解除後も「未引き継ぎ」へ戻さない。
  if (services.subAccounts.hasLegacyImport(userId)) return false;
  return Boolean(
    services.db
      .prepare("SELECT 1 FROM shop_purchases WHERE item_id = ? AND user_id = ? AND status = 'active' LIMIT 1")
      .get(legacyItemId, userId),
  );
}

export const RANK_REQUIRED_MESSAGE =
  "サブ垢の追加は**魔人以上**の方が対象です。現在の階級では申請・支払いができません。";

export const PAIR_ERROR_MESSAGE: Record<string, string> = {
  ERR_RANK_TOO_LOW: RANK_REQUIRED_MESSAGE,
  ERR_SELF: "自分自身をサブ垢にはできません。",
  ERR_ALT_TAKEN: "そのアカウントは既に別の方のサブ垢として登録されています。",
  ERR_ALT_IS_MAIN: "そのアカウントは本体として登録されています。サブ垢にはできません。",
  ERR_MAIN_IS_ALT: "サブ垢からサブ垢を追加することはできません。",
};

/** 商品の詳細に出す操作。**いま何をすればいいか**だけを見せる */
export function subAccountActions(services: Services, item: ShopItemRow, userId: string) {
  const rows = services.subAccounts.listByMain(userId);
  if (hasUnresolvedLegacySubAccount(services, userId)) {
    return { notes: [`⚠️ ${LEGACY_SUB_ACCOUNT_BLOCK_MESSAGE}`], components: [] };
  }
  // **押せるボタンで資格を表さない。** 出す前に今の階級を見る
  if (!eligible(services, userId) && rows.every((r) => r.status !== "active")) {
    return { notes: [`⚠️ ${RANK_REQUIRED_MESSAGE}`], components: [] };
  }
  const pending = rows.find((r) => r.status === "pending");
  const approved = rows.find((r) => r.status === "approved");
  const active = rows.filter((r) => r.status === "active");
  const buttons: ButtonBuilder[] = [];
  const notes: string[] = [];

  if (approved) {
    notes.push(
      `✅ サブ垢 <@${approved.alt_user_id}> の申請が承認されています。下のボタンから ${fmtLd(item.price_land ?? 0)} をお支払いください。`,
      `-# 承認から **${SUB_ACCOUNT_PAYMENT_GRACE_DAYS}日** を過ぎると申請は取り消されます。`,
    );
    buttons.push(
      new ButtonBuilder()
        // **表示した額を確定まで持たせる**（押した時の最新価格で引かない）
        // 料金だけでなく**商品内容そのもの**を確定する。承認後に名称・提供方法・条件が
        // 変わった商品を、承認時に見せた説明のまま売らない。
        .setCustomId(`shop:sub-pay:${item.id}:${approved.id}:${item.price_land ?? 0}:${services.shop.quoteGenericPurchase(item.id).termsToken}:${payAttemptToken()}`)
        .setLabel(`支払って有効化する (${fmtLd(item.price_land ?? 0)})`)
        .setEmoji("💰")
        .setStyle(ButtonStyle.Success),
    );
  } else if (pending) {
    notes.push(`⏳ サブ垢 <@${pending.alt_user_id}> の申請は運営の確認待ちです。結果はDMでお知らせします。`);
  } else {
    buttons.push(
      new ButtonBuilder().setCustomId(`shop:sub-apply:${item.id}`).setLabel("申請する").setEmoji("👥").setStyle(ButtonStyle.Primary),
    );
    notes.push(
      "-# 申請の時点では課金しません。運営が本人確認をしたあとに支払いへ進みます。",
      "-# サブ垢には本体と同じ階級が付き、以後も本体に合わせて自動で追従します。",
    );
  }

  if (active.length > 0) {
    notes.push("", `**有効なサブ垢 ${active.length}件**`, ...active.map((r) => `・<@${r.alt_user_id}>`));
  }
  return { notes, components: buttons.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [] };
}

export function applyModal(itemId: number) {
  return new ModalBuilder()
    .setCustomId(`shop:sub-input:${itemId}`)
    .setTitle("サブ垢の追加申請")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("alt")
          .setLabel("サブ垢のDiscord ID")
          .setPlaceholder("例: 123456789012345678")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
    );
}

/** 内容が変わっていたときの再確認。**1 Ld も動かさないまま新しい内容で確かめ直す** */
export function payRequote(
  item: ShopItemRow,
  applicationId: number,
  altUserId: string,
  termsToken: string,
  opts: { priceChanged?: boolean } = {},
) {
  const price = item.price_land ?? 0;
  return {
    content: [
      opts.priceChanged
        ? "⚠️ 確認したあとに料金が変わりました。**まだ引き落としていません。**"
        : "⚠️ 確認したあとに商品の内容が変わりました。**まだ引き落としていません。**",
      `サブ垢 <@${altUserId}> の追加料金は現在 **${fmtLd(price)}** です。`,
    ].join("\n"),
    embeds: [],
    allowedMentions: { parse: [] as never[] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop:sub-pay:${item.id}:${applicationId}:${price}:${termsToken}:${payAttemptToken()}`)
          .setLabel(`この料金で支払う (${fmtLd(price)})`)
          .setEmoji("💰")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

/** 申請を受け付ける。**Land は動かさない** */
export async function handleApplyModal(
  interaction: ModalSubmitInteraction,
  services: Services,
  itemId: number,
): Promise<void> {
  // **modalを開いたあとに商品が止まることがある。** 確定時にも確かめる
  const item = services.shop.getItem(itemId);
  if (!item || !item.enabled || !isSubAccountItem(services, item)) {
    await interaction.reply({
      content: "⚠️ この商品はいま申請できません（販売が停止されました）。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (hasUnresolvedLegacySubAccount(services, interaction.user.id)) {
    await interaction.reply({
      content: `⚠️ ${LEGACY_SUB_ACCOUNT_BLOCK_MESSAGE}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const altUserId = parseUserId(interaction.fields.getTextInputValue("alt"));
  if (!altUserId) {
    await interaction.reply({
      content: "⚠️ Discord IDの形式が違います。17〜20桁の数字（ユーザーID）を入れてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const existing = services.subAccounts.listByMain(interaction.user.id).find((r) => r.status !== "active");
  if (existing) {
    await interaction.reply({
      content: `⚠️ サブ垢 <@${existing.alt_user_id}> の申請がまだ進行中です。先にそちらを終わらせてください。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  let row;
  try {
    row = services.subAccounts.apply({
      mainUserId: interaction.user.id,
      altUserId,
      mainStatus: mainRank(services, interaction.user.id),
      actor: `user:${interaction.user.id}`,
    });
  } catch (error) {
    const message =
      error instanceof SubAccountError ? (PAIR_ERROR_MESSAGE[error.code] ?? "この組み合わせでは登録できません。") : "申請を受け付けられませんでした。";
    await interaction.reply({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content: [
      `📨 申請を受け付けました（申請 #${row.id}）。**この時点では課金していません。**`,
      `サブ垢 <@${row.alt_user_id}>`,
      "運営が本人確認をしたあと、結果をDMでお知らせします。承認されたら公式ショップからお支払いください。",
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  await notifyStaff(interaction, services, `👥 **サブ垢の追加申請**（申請 #${row.id}・<@${row.main_user_id}>）が届きました。`);
}

async function notifyStaff(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  services: Services,
  content: string,
): Promise<void> {
  const channelId = services.settings.getString("channel:shokan") ?? services.settings.getString("channel:kessai");
  if (!channelId) return;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  // 通知は業務の正本にしない。操作は商館の管理パネルに集約する
  await channel
    .send({ content: `${content}\n-# 商館の管理パネルの「サブ垢」から確認してください。`, allowedMentions: { parse: [] } })
    .catch(() => undefined);
}
