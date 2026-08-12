import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  ORIGINAL_ROLE_PAYMENT_GRACE_DAYS,
  ORIGINAL_ROLE_TERM_DAYS,
  OriginalRoleError,
  type OriginalRoleRow,
  type ShopItemRow,
} from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

/**
 * オリジナルロールの利用者導線。
 *
 * ```
 * 新規: 申請 → 運営が承認 → 750,000Ld 支払い → Botが作成・付与 → 30日
 * 更新: 自分のロールを選ぶ → 250,000Ld 確認 → 支払い → +30日（スタッフ不要）
 * ```
 *
 * **申請では Land を動かさない。** 通るか分からないものに先に払わせると、
 * 却下のたびに返金の仕事が生まれる。
 */

export const ORIGINAL_ROLE_NAME_MAX = 32;

/** その商品が「オリジナルロール新規作成」か。設定で決める（旧商品を巻き込まない） */
export function isOriginalRoleItem(services: Services, item: ShopItemRow): boolean {
  const configured = Number(services.settings.getString("shop:original_role_item_id"));
  return Number.isInteger(configured) && configured === item.id;
}

export function renewPrice(services: Services): number {
  return services.settings.getNumber("original_role_renew_price");
}

/** 色の入力。`#A855F7` / `A855F7` を受ける */
export function parseColor(raw: string): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(text);
  return m ? Number.parseInt(m[1]!, 16) : "invalid";
}

/** ロール名の形。名前の規則とは別物（オリジナルロールは記号も許す） */
export function validateRoleName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "ロール名を入れてください。";
  if (name.length > ORIGINAL_ROLE_NAME_MAX) {
    return `ロール名は ${ORIGINAL_ROLE_NAME_MAX} 文字までです（いまは ${name.length} 文字）。`;
  }
  if (name.includes("@")) return "ロール名に `@` は使えません。";
  return null;
}

// ---- 商品画面（新規申請・支払い・更新の入口）----

/**
 * 商品#7 の詳細に出す操作。**状態によって出すものを変える**ので、
 * 利用者は「いま自分が何をすればいいか」だけを見る。
 */
export function originalRoleActions(services: Services, item: ShopItemRow, userId: string) {
  const rows = services.originalRoles.listByUser(userId);
  const pending = rows.find((r) => r.status === "pending");
  const approved = rows.find((r) => r.status === "approved");
  const active = rows.filter((r) => r.status === "active");
  const buttons: ButtonBuilder[] = [];
  const notes: string[] = [];

  if (approved) {
    notes.push(
      `✅ 申請 **${approved.name}** が承認されています。下のボタンから ${fmtLd(item.price_land ?? 0)} をお支払いください。`,
      `-# 承認から **${ORIGINAL_ROLE_PAYMENT_GRACE_DAYS}日** を過ぎると申請は取り消されます。`,
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:orole-pay:${item.id}:${approved.id}`)
        .setLabel(`支払って作成する (${fmtLd(item.price_land ?? 0)})`)
        .setEmoji("💰")
        .setStyle(ButtonStyle.Success),
    );
  } else if (pending) {
    notes.push(`⏳ 申請 **${pending.name}** は運営の確認待ちです。結果はDMでお知らせします。`);
  } else {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:orole-apply:${item.id}`)
        .setLabel("申請する")
        .setEmoji("🎨")
        .setStyle(ButtonStyle.Primary),
    );
    notes.push("-# 申請の時点では課金しません。運営が承認したあとに支払いへ進みます。");
  }

  if (active.length > 0) {
    notes.push(
      "",
      `**契約中のオリジナルロール ${active.length}件**`,
      ...active.map((r) => `・<@&${r.role_id ?? ""}> 期限 <t:${r.expires_at ?? 0}:D>`),
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:orole-renew:${item.id}`)
        .setLabel(`更新する (${fmtLd(renewPrice(services))})`)
        .setEmoji("♻️")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return { notes, components: buttons.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [] };
}

export function applyModal(itemId: number) {
  return new ModalBuilder()
    .setCustomId(`shop:orole-input:${itemId}`)
    .setTitle("オリジナルロールの申請")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("ロール名")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(ORIGINAL_ROLE_NAME_MAX),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("color")
          .setLabel("色（省略可・例 #A855F7）")
          .setPlaceholder("空欄なら既定の色で作成します")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(7),
      ),
    );
}

/** 申請を受け付ける。**Land は動かさない** */
export async function handleApplyModal(
  interaction: ModalSubmitInteraction,
  services: Services,
  itemId: number,
): Promise<void> {
  const nameError = validateRoleName(interaction.fields.getTextInputValue("name"));
  if (nameError) {
    await interaction.reply({ content: `⚠️ ${nameError}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const color = parseColor(interaction.fields.getTextInputValue("color") ?? "");
  if (color === "invalid") {
    await interaction.reply({
      content: "⚠️ 色は `#A855F7` のような6桁の16進数で入れてください（省略も可）。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const existing = services.originalRoles
    .listByUser(interaction.user.id)
    .find((r) => r.status === "pending" || r.status === "approved");
  if (existing) {
    await interaction.reply({
      content: `⚠️ 申請 **${existing.name}** がまだ進行中です。先にそちらを終わらせてください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const row = services.originalRoles.apply({
    userId: interaction.user.id,
    name: interaction.fields.getTextInputValue("name").trim(),
    color: color === null ? null : color,
    actor: `user:${interaction.user.id}`,
  });
  await interaction.reply({
    content: [
      `📨 申請を受け付けました（申請 #${row.id}）。**この時点では課金していません。**`,
      `ロール名 **${row.name}**${row.color === null ? "" : ` ／ 色 #${row.color.toString(16).padStart(6, "0").toUpperCase()}`}`,
      "運営が確認したあと、結果をDMでお知らせします。承認されたら公式ショップからお支払いください。",
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
  await notifyStaff(interaction, services, `🎨 **オリジナルロールの申請**（申請 #${row.id}・<@${row.user_id}>）が届きました。`);
}

/** 更新するロールを選ぶ */
export function renewPicker(services: Services, itemId: number, userId: string) {
  const active = services.originalRoles.listByUser(userId).filter((r) => r.status === "active");
  const price = renewPrice(services);
  const embed = new EmbedBuilder()
    .setTitle("♻️ オリジナルロールの更新")
    .setColor(0xdb2777)
    .setDescription(
      [
        `更新すると期限が **+${ORIGINAL_ROLE_TERM_DAYS}日** 伸びます（残り期間は切り捨てません）。`,
        `料金 **${fmtLd(price)}** ／ 残高 ${fmtLd(services.ledger.balanceOf(`user:${userId}`))}`,
      ].join("\n"),
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`shop:orole-renew-pick:${itemId}`)
    .setPlaceholder("更新するロールを選ぶ")
    .addOptions(
      active.slice(0, 25).map((r) => ({
        label: r.name.slice(0, 100),
        value: String(r.id),
        description: `期限 ${new Date((r.expires_at ?? 0) * 1000).toISOString().slice(0, 10)}`,
      })),
    );
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

/** 更新の確認。**確認した料金を確定まで持たせる** */
export function renewConfirm(services: Services, itemId: number, row: OriginalRoleRow) {
  const price = renewPrice(services);
  return {
    content: [
      `♻️ **${row.name}** を更新します。`,
      `期限 <t:${row.expires_at ?? 0}:D> → **+${ORIGINAL_ROLE_TERM_DAYS}日**`,
      `料金 **${fmtLd(price)}** ／ 残高 ${fmtLd(services.ledger.balanceOf(`user:${row.user_id}`))}`,
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop:orole-renew-do:${itemId}:${row.id}:${price}`)
          .setLabel("更新する")
          .setStyle(ButtonStyle.Success),
      ),
    ],
    embeds: [],
  };
}

/**
 * 更新を確定する。**課金と期限延長は core が同じ取引で確定する**ので、
 * ここで途中状態を持たない。
 */
export async function handleRenewConfirm(
  interaction: ButtonInteraction,
  services: Services,
  roleRowId: number,
  quotedPrice: number,
): Promise<void> {
  const price = renewPrice(services);
  if (quotedPrice !== price) {
    const row = services.originalRoles.get(roleRowId);
    if (!row) {
      await interaction.update({ content: "その契約が見つかりません。", embeds: [], components: [] });
      return;
    }
    // 確認した額でしか引き落とさない
    await interaction.update({
      ...renewConfirm(services, Number(interaction.customId.split(":")[2]), row),
      content: `⚠️ 確認したあとに料金が変わりました。**まだ引き落としていません。**\n${renewConfirm(services, 0, row).content}`,
    });
    return;
  }
  try {
    const renewed = services.originalRoles.renew({
      id: roleRowId,
      userId: interaction.user.id,
      price,
      actor: `user:${interaction.user.id}`,
    });
    await interaction.update({
      content: `✅ **${renewed.name}** を更新しました。期限は <t:${renewed.expires_at ?? 0}:D> までです。`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    const message =
      error instanceof OriginalRoleError
        ? "この契約は更新できません（他の方のもの、または状態が変わっています）。"
        : "残高が足りないか、更新に失敗しました。";
    await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
  }
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
    .send({ content: `${content}\n-# 商館の管理パネルの「オリジナルロール」から確認してください。`, allowedMentions: { parse: [] } })
    .catch(() => undefined);
}
