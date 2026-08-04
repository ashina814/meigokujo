import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type MessageCreateOptions,
} from "discord.js";
import { LedgerError, ShopError, type ShopItemRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { refreshEvalStatsForUser } from "../eval-daily.js";
import { meetsRoleRequirement, requirementLabel } from "../rank-requirement.js";
import type { Services } from "../services.js";

/**
 * 公式ショップ（買う側の永続パネル）。
 * /パネル設置 種別:公式ショップ で設置される。
 */

const CATALOG_LIMIT = 25;
const EXTERNAL_CONFIRM_TTL_SEC = 2 * 60;

function formatPrice(item: ShopItemRow): string {
  const parts: string[] = [];
  if (item.price_land !== null) parts.push(fmtLd(item.price_land));
  if (item.price_alt_kind && item.price_alt_amount !== null) {
    const kindJa = item.price_alt_kind === "invite" ? "招待" : item.price_alt_kind;
    parts.push(`${kindJa} ${item.price_alt_amount}`);
  }
  return parts.join(" / ") || "—";
}

function formatKind(item: ShopItemRow): string {
  if (item.kind === "monthly") return "月額";
  if (item.duration_days) return `期限付き（${item.duration_days}日）`;
  return "単発";
}

export function shopPanelMessage(services: Services): MessageCreateOptions {
  const items = services.shop.listItems({ enabledOnly: true });
  const embed = new EmbedBuilder()
    .setTitle("🛒 冥獄城 公式ショップ")
    .setColor(0xdb2777)
    .setDescription(
      [
        "冥界商館が扱う公式商品です。**支払いは Land を焼却**します（通貨は循環から消えます）。",
        "月額購入は **毎月1日に自動再課金**、当月末までは有効。",
        "",
        `**${items.length}件** の商品`,
      ].join("\n"),
    );
  if (items.length > 0) {
    embed.addFields(
      items.slice(0, 25).map((item) => ({
        name: `${item.name} — ${formatPrice(item)}`,
        value: [
          `${formatKind(item)}${item.require_role_id ? ` / <@&${item.require_role_id}> 限定` : ""}${item.stock !== null ? ` / 在庫 ${item.stock}` : ""}`,
          item.description ? `_${item.description}_` : "",
        ].filter(Boolean).join("\n"),
      })),
    );
  }

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("shop:pick")
      .setPlaceholder("商品を選ぶ")
      .addOptions(
        items.slice(0, CATALOG_LIMIT).map((item) => ({
          label: item.name.slice(0, 100),
          value: String(item.id),
          description: `${formatPrice(item)} / ${formatKind(item)}`.slice(0, 100),
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("shop:contracts").setLabel("契約中").setEmoji("📜").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components };
}

function itemDetail(item: ShopItemRow, userHasRole: boolean, balance: number, requireLabel: string): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${item.name}`)
    .setColor(0xdb2777)
    .setDescription(item.description ?? "（説明なし）")
    .addFields(
      { name: "価格", value: formatPrice(item), inline: true },
      { name: "種類", value: formatKind(item), inline: true },
      { name: "配送", value: item.delivery === "auto" ? "自動" : "手動（スタッフ対応）", inline: true },
      { name: "階級要件", value: requireLabel, inline: true },
      { name: "在庫", value: item.stock === null ? "無限" : String(item.stock), inline: true },
      { name: "あなたの残高", value: fmtLd(balance), inline: true },
    );
  const buttons: ButtonBuilder[] = [];
  if (item.price_land !== null) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:buy:${item.id}:land`)
        .setLabel(`Land で買う (${fmtLd(item.price_land)})`)
        .setEmoji("💰")
        .setStyle(ButtonStyle.Primary)
        // Land不足でも押せるようにし、押下後に賭場チップ返還の確認を出す。
        .setDisabled(!userHasRole || (item.stock !== null && item.stock <= 0)),
    );
  }
  if (item.price_alt_kind && item.price_alt_amount !== null) {
    const kindJa = item.price_alt_kind === "invite" ? "招待" : item.price_alt_kind;
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shop:buy:${item.id}:alt`)
        .setLabel(`${kindJa} ${item.price_alt_amount} で買う`)
        .setEmoji("🎟")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!userHasRole || (item.stock !== null && item.stock <= 0)),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (buttons.length > 0) row.addComponents(...buttons);
  const components = row.components.length > 0 ? [row] : [];
  if (!userHasRole && item.require_role_id) {
    embed.setFooter({ text: "階級要件を満たしていません（上の「階級要件」を参照）" });
  }
  return { embeds: [embed], components };
}

function purchaseOnce(
  services: Services,
  input: {
    operationId: string;
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    mode: "land" | "alt";
  },
): ReturnType<Services["shop"]["purchase"]> {
  const execute = services.db.transaction(() => {
    const existing = services.db.prepare(
      "SELECT * FROM shop_purchase_operations WHERE operation_id=?",
    ).get(input.operationId) as
      | { user_id: string; item_id: number; mode: string; purchase_id: number | null; status: string }
      | undefined;
    if (existing) {
      if (existing.user_id !== input.userId || existing.item_id !== input.itemId || existing.mode !== input.mode) {
        throw new Error("shop operation conflict");
      }
      if (existing.status !== "completed" || existing.purchase_id === null) {
        throw new Error("shop operation is incomplete");
      }
      const purchase = services.shop.getPurchase(existing.purchase_id);
      const item = services.shop.getItem(existing.item_id);
      if (!purchase || !item) throw new Error("shop operation result is missing");
      return { purchase, item, needsManualDelivery: item.delivery === "manual" };
    }

    services.db.prepare(
      `INSERT INTO shop_purchase_operations
       (operation_id,user_id,item_id,mode,status,created_at)
       VALUES (?,?,?,?, 'executing', ?)`,
    ).run(input.operationId, input.userId, input.itemId, input.mode, Math.floor(Date.now() / 1_000));

    const result = services.shop.purchase({
      itemId: input.itemId,
      userId: input.userId,
      actor: input.actor,
      memberRoleIds: input.memberRoleIds,
      payAlt: input.mode === "alt",
    });
    services.db.prepare(
      `UPDATE shop_purchase_operations
       SET status='completed',purchase_id=?,completed_at=?
       WHERE operation_id=? AND status='executing'`,
    ).run(result.purchase.id, Math.floor(Date.now() / 1_000), input.operationId);
    return result;
  });
  return execute.immediate();
}

async function finishPurchase(
  interaction: ButtonInteraction,
  services: Services,
  result: ReturnType<Services["shop"]["purchase"]>,
): Promise<void> {
  const { item, purchase } = result;
  let deliveryNote = "";
  if (item.delivery === "auto") {
    deliveryNote = await tryAutoDeliver(interaction, services, item, interaction.user.id).catch(
      () => "自動配送に失敗しました。運営にお問い合わせください。",
    );
  } else {
    deliveryNote = "スタッフが配送の対応をします。";
    await notifyStaffForDelivery(interaction, services, purchase.id, item).catch(() => undefined);
  }
  const expires = purchase.expires_at ? `\n有効期限: <t:${purchase.expires_at}:D>` : "";
  await interaction.editReply({
    content: `✅ **${item.name}** を購入しました${deliveryNote ? `\n${deliveryNote}` : ""}${expires}`,
    embeds: [],
    components: [],
  });
}

function purchaseErrorMessage(error: unknown, services: Services): string {
  if (error instanceof ShopError) {
    if (error.code === "ERR_ITEM_DISABLED") return "この商品は現在販売されていません。";
    if (error.code === "ERR_NO_STOCK") return "在庫切れです。";
    if (error.code === "ERR_ROLE_REQUIRED") {
      return `階級要件を満たしていません（要 ${requirementLabel(services.settings, (error.details.roleId as string | undefined) ?? null)}）。`;
    }
    if (error.code === "ERR_ALREADY_ACTIVE") return "既にこの月額商品を契約中です。";
    if (error.code === "ERR_NO_PRICE") return "この商品の価格が設定されていません。";
  }
  if (error instanceof LedgerError && error.code === "ERR_INSUFFICIENT") return "残高が足りません。";
  return error instanceof Error ? error.message : "処理に失敗しました。";
}

function chipReturnView(confirmationId: string, item: ShopItemRow, land: number, chips: number) {
  return {
    content: [
      `Landが足りません。商品 **${item.name}** は ${fmtLd(item.price_land ?? 0)}、現在のLandは ${fmtLd(land)} です。`,
      `賭場に **${fmtLd(chips)}** あります。`,
      "押した場合だけ自由チップをLandへ戻し、この購入を同じoperation IDで一度だけ再試行します。",
    ].join("\n"),
    embeds: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop:chips:${confirmationId}:${item.id}:land`)
          .setLabel("Landへ戻して続ける")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`shop:chips-no:${confirmationId}`)
          .setLabel("やめる")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export async function handleShopButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "contracts") {
    const rows = services.shop.listUserPurchases(interaction.user.id, { activeOnly: true });
    const lines = rows.length > 0
      ? rows.map((purchase) => {
          const item = services.shop.getItem(purchase.item_id);
          const label = item?.name ?? `#${purchase.item_id}`;
          const exp = purchase.expires_at ? `<t:${purchase.expires_at}:D>` : "—";
          const renew = purchase.auto_renew ? "🔁 自動更新" : "❌ 更新停止";
          return `・**${label}**（有効期限 ${exp}・${renew}）`;
        })
      : ["契約中の商品はありません。"];
    const embed = new EmbedBuilder().setTitle("📜 契約中の商品").setColor(0xdb2777).setDescription(lines.join("\n"));
    const monthlyRows = rows.filter((purchase) => purchase.auto_renew);
    const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
    if (monthlyRows.length > 0) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("shop:cancel")
        .setPlaceholder("解約する契約を選ぶ")
        .addOptions(monthlyRows.slice(0, 25).map((purchase) => {
          const item = services.shop.getItem(purchase.item_id);
          return { label: (item?.name ?? `#${purchase.item_id}`).slice(0, 100), value: String(purchase.id) };
        }));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "chips-no") {
    const confirmationId = parts[2];
    if (!confirmationId) return;
    const cancelled = services.chipFlow.cancelExternalConfirmation(confirmationId, interaction.user.id);
    await interaction.update({
      content: cancelled ? "購入をやめました。賭場の自由チップは変更していません。" : "この確認は取り消せません。",
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "chips") {
    const confirmationId = parts[2];
    const itemId = Number(parts[3]);
    const mode = parts[4] as "land" | "alt";
    if (!confirmationId || !Number.isSafeInteger(itemId) || mode !== "land") return;
    const confirmation = services.chipFlow.externalConfirmation(confirmationId);
    if (!confirmation || confirmation.userId !== interaction.user.id || confirmation.operationKind !== `shop:${itemId}:${mode}`) {
      await interaction.reply({ content: "この確認は利用できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      let row = confirmation;
      if (row.status === "pending") row = services.chipFlow.beginExternalConfirmation(confirmationId, interaction.user.id);
      if (row.status !== "executing") throw new Error("この確認は既に処理されています");
      services.chipFlow.redeemExactFreeChips(
        interaction.user.id,
        row.chipAmount,
        `external:${confirmationId}`,
        "公式ショップ購入を続けるための返還",
        true,
      );
      const member = interaction.member;
      const memberRoleIds = member && "roles" in member && "cache" in member.roles
        ? [...member.roles.cache.keys()]
        : [];
      const result = purchaseOnce(services, {
        operationId: row.operationId,
        itemId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds,
        mode,
      });
      if (!services.chipFlow.completeExternalConfirmation(confirmationId, interaction.user.id)) {
        throw new Error("購入確認の完了記録に失敗しました");
      }
      await finishPurchase(interaction, services, result);
    } catch (error) {
      await interaction.editReply({
        content: `❌ ${purchaseErrorMessage(error, services)}`,
        embeds: [],
        components: [],
      });
    }
    return;
  }

  if (action === "buy") {
    const itemId = Number(parts[2]);
    const mode = parts[3] as "land" | "alt";
    const item = services.shop.getItem(itemId);
    if (!item) {
      await interaction.reply({ content: "商品が見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = interaction.member;
    const memberRoleIds = member && "roles" in member && "cache" in member.roles
      ? [...member.roles.cache.keys()]
      : [];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = purchaseOnce(services, {
        operationId: interaction.id,
        itemId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds,
        mode,
      });
      await finishPurchase(interaction, services, result);
    } catch (error) {
      if (
        mode === "land"
        && item.price_land !== null
        && error instanceof LedgerError
        && error.code === "ERR_INSUFFICIENT"
      ) {
        const freeChips = services.chipAssets.freeChips(interaction.user.id);
        const land = services.ledger.balanceOf(`user:${interaction.user.id}`);
        if (freeChips > 0) {
          try {
            const confirmation = services.chipFlow.createExternalConfirmation({
              id: interaction.id,
              userId: interaction.user.id,
              operationKind: `shop:${itemId}:${mode}`,
              operationId: interaction.id,
              requiredLand: Math.max(1, item.price_land - land),
              chipAmount: freeChips,
              expiresAt: Math.floor(Date.now() / 1_000) + EXTERNAL_CONFIRM_TTL_SEC,
            });
            await interaction.editReply(chipReturnView(confirmation.id, item, land, freeChips));
            return;
          } catch (confirmationError) {
            await interaction.editReply({
              content: `❌ ${confirmationError instanceof Error ? confirmationError.message : "返還確認を作成できません"}`,
              embeds: [],
              components: [],
            });
            return;
          }
        }
      }
      await interaction.editReply({ content: `❌ ${purchaseErrorMessage(error, services)}`, embeds: [], components: [] });
    }
    return;
  }
}

export async function handleShopSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  if (action === "pick") {
    const itemId = Number(interaction.values[0]);
    const item = services.shop.getItem(itemId);
    if (!item) {
      await interaction.reply({ content: "商品が見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = interaction.member;
    const memberRoleIds = member && "roles" in member && "cache" in member.roles
      ? [...member.roles.cache.keys()]
      : [];
    const hasRole = !item.require_role_id || meetsRoleRequirement(services.settings, memberRoleIds, item.require_role_id);
    const balance = services.ledger.balanceOf(`user:${interaction.user.id}`);
    const view = itemDetail(item, hasRole, balance, requirementLabel(services.settings, item.require_role_id));
    await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "cancel") {
    const purchaseId = Number(interaction.values[0]);
    services.shop.cancelSubscription(purchaseId, `user:${interaction.user.id}`);
    await interaction.update({
      content: "🛑 解約しました（次月から自動更新しません。当月末までは有効）。",
      embeds: [],
      components: [],
    });
  }
}

async function tryAutoDeliver(
  interaction: ButtonInteraction,
  services: Services,
  item: ShopItemRow,
  userId: string,
): Promise<string> {
  const data: { role_id?: string; days?: number } = item.delivery_data ? JSON.parse(item.delivery_data) : {};
  if (item.delivery_kind === "add_role") {
    const roleId = data.role_id;
    if (!roleId) return "配送設定が不完全です（ロールID未設定）。";
    const guild = interaction.guild;
    if (!guild) return "ギルド情報が取れませんでした。";
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return "メンバー情報の取得に失敗しました。";
    await member.roles.add(roleId).catch(() => undefined);
    return `ロールを付与しました: <@&${roleId}>`;
  }
  if (item.delivery_kind === "extend_deadline") {
    const days = data.days ?? 1;
    const soul = services.entry.getSoul(userId);
    if (!soul || !soul.eval_deadline_at) return "評価期限を持っていないため延長できません。";
    services.db
      .prepare("UPDATE souls SET eval_deadline_at = eval_deadline_at + ?, updated_at = ? WHERE user_id = ?")
      .run(days * 86_400, Math.floor(Date.now() / 1_000), userId);
    if (interaction.guild) {
      await refreshEvalStatsForUser(interaction.guild, services, userId).catch(() => undefined);
    }
    return `評価期限を **+${days}日** 延長しました。評価スレッドにも反映済みです。`;
  }
  if (item.delivery_kind === "revoke_meirei") {
    const soul = services.entry.getSoul(userId);
    if (!soul) return "魂記録がありません。";
    if (soul.status !== "meirei") return "現在の状態が迷霊ではありません。";
    services.entry.resetToWaiting(userId, `shop:${item.id}`);
    const guild = interaction.guild;
    if (guild) {
      const meireiRoleId = services.settings.getString("role:meirei");
      const waitRoleId = services.settings.getString("role:queue_wait");
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        if (meireiRoleId) await member.roles.remove(meireiRoleId).catch(() => undefined);
        if (waitRoleId) await member.roles.add(waitRoleId).catch(() => undefined);
      }
    }
    return "迷霊から案内待ちに戻しました（再評価チャレンジ発動）。";
  }
  return "自動配送は未対応の種類です。";
}

async function notifyStaffForDelivery(
  interaction: ButtonInteraction,
  services: Services,
  purchaseId: number,
  item: ShopItemRow,
): Promise<void> {
  const shokanChId = services.settings.getString("channel:shokan");
  const channelId = shokanChId ?? services.settings.getString("channel:kessai");
  if (!channelId) return;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`shokan:deliver:${purchaseId}`)
      .setLabel("配送完了")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Success),
  );
  await channel.send({
    content: `📦 **公式ショップ**: <@${interaction.user.id}> が **${item.name}** を購入。手動配送をお願いします（購入ID #${purchaseId}）。`,
    components: [row],
    allowedMentions: { users: [interaction.user.id] },
  }).catch(() => undefined);
}
