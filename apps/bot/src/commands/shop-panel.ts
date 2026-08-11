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
import { deliverPurchase } from "../shop-delivery.js";
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
        "期限付きの商品が切れても**自動で再課金しません**。続ける場合はご自身で買い直してください。",
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

/**
 * その商品が「再評価を受ける権利」か。
 *
 * 再評価チャレンジは**配送する物が無い**。購入で権利が立ち、消費するのは
 * 既存の再評価面談フローだけ。ここを配送商品として扱うと、汎用の「配送完了」で
 * `delivered_at` が入り、**面談前に権利が消える**（購入 #44 で実際に起きた形）。
 */
function isReevalItem(services: Services, item: ShopItemRow): boolean {
  const configured = Number(services.settings.getString("shop:reeval_item_id"));
  return Number.isInteger(configured) && configured === item.id;
}

/** 再評価面談の受付パネルへのジャンプリンク（未設置なら null） */
function reevalPanelLink(services: Services, guildId: string | null): string | null {
  if (!guildId) return null;
  const panel = services.tickets.getPanel("reeval");
  if (!panel || !panel.enabled || panel.archivedAt) return null;
  if (!panel.channelId || !panel.messageId) return null;
  return `https://discord.com/channels/${guildId}/${panel.channelId}/${panel.messageId}`;
}

type PurchaseOutcome = ReturnType<Services["shop"]["purchase"]> & { replayed?: boolean };

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
): PurchaseOutcome {
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
      // 課金だけが冪等。**配送は再実行してよい**（未配送なら届けるのが正しい）。
      // 二度配らないのは購入行の配送状態が保証するので、ここでは印を返すだけにする
      return { purchase, item, needsManualDelivery: item.delivery === "manual", replayed: true };
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
    return { ...result, replayed: false };
  });
  return execute.immediate();
}

/** 手動配送の案内。商品説明があれば併記する */
function manualDeliveryNote(item: ShopItemRow, head: string): string {
  return item.description ? `${head}
${item.description}` : head;
}

async function finishPurchase(
  interaction: ButtonInteraction,
  services: Services,
  result: PurchaseOutcome,
): Promise<void> {
  const { item, purchase } = result;
  let deliveryNote = "";
  let delivered = true;
  if (item.delivery === "auto") {
    // **replayed でも配送を試す。** 課金は冪等（operation IDで一度きり）だが、
    // 配送は成功するまで再試行してよい。二度配らないのは配送状態が保証する。
    const outcome = await deliverPurchase(services, interaction.guild, purchase, `user:${interaction.user.id}`);
    deliveryNote = outcome.message;
    delivered = outcome.state !== "failed";
  } else if (isReevalItem(services, item)) {
    // **配送しない。** 買ったのは面談を受ける権利で、消費するのは既存の再評価面談フロー。
    // スタッフへ配送依頼を投げると「配送完了」で権利を消せてしまうので、通知も出さない
    const link = reevalPanelLink(services, interaction.guildId);
    deliveryNote = [
      "🎟 **再評価を受ける権利**を取得しました（この時点では階級は変わりません）。",
      link ? `▶ **[再評価面談の受付はこちら](${link})**` : "受付の場所は運営にご確認ください。",
    ].join("\n");
  } else if (result.replayed) {
    deliveryNote = manualDeliveryNote(item, "この購入は受付済みです（スタッフ対応待ち）。");
  } else {
    // 手動配送は商品ごとに次の一手が違う。商品説明をそのまま出して、
    // 案内を商品側のデータで持てるようにする
    deliveryNote = manualDeliveryNote(item, "スタッフが配送の対応をします。");
    await notifyStaffForDelivery(interaction, services, purchase.id, item).catch(() => undefined);
  }
  const expires = purchase.expires_at ? `\n有効期限: <t:${purchase.expires_at}:D>` : "";
  // 配送が失敗したのに「購入しました」だけ出すと、届いたように読める。
  // 課金は成立し配送は未完了、という事実をそのまま書く
  const head = delivered
    ? `✅ **${item.name}** を購入しました`
    : `⚠️ **${item.name}** の支払いは完了しましたが、**配送が完了していません**（購入 #${purchase.id}）`;
  await interaction.editReply({
    content: `${head}${deliveryNote ? `\n${deliveryNote}` : ""}${expires}`,
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

/**
 * 返還済み・購入未完了で止まった確認票の再試行ボタン（監査項目13）。
 * 「やめる」は出さない——返還が済んだあとに取り消せる操作ではない。
 */
function retryConfirmComponents(
  confirmationId: string,
  itemId: number,
  mode: "land" | "alt",
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop:chips:${confirmationId}:${itemId}:${mode}`)
        .setLabel("購入を再試行")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
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
          return `・**${label}**（有効期限 ${exp}）`;
        })
      : ["契約中の商品はありません。"];
    // 自動更新を廃止したので「自動更新中／停止中」も「解約する」も出さない。
    // 放っておけば期限で終わるだけで、利用者が止める操作は存在しない
    const embed = new EmbedBuilder()
      .setTitle("📜 契約中の商品")
      .setColor(0xdb2777)
      .setDescription(
        [...lines, "", "-# 期限が切れても自動では再課金しません。続ける場合は商館から買い直してください。"].join("\n"),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
    let redeemed = false;
    let purchased = false;
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
      redeemed = true;
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
      purchased = true;
      if (!services.chipFlow.completeExternalConfirmation(confirmationId, interaction.user.id)) {
        throw new Error("購入確認の完了記録に失敗しました");
      }
      await finishPurchase(interaction, services, result);
    } catch (error) {
      // 返還だけが済んで購入が失敗した状態を、ボタンを消して黙って終わらせない（監査項目13）。
      // 資金が Land 側にあること・購入が未完了であることを明示し、**同じ確認票の
      // ボタンを残して**再試行できるようにする。返還も購入も安定キーなので、
      // 押し直しても資金は二重に動かず、購入が成立していれば完了記録だけが収束する。
      const stranded = redeemed && !purchased;
      await interaction.editReply({
        content: stranded
          ? [
              `❌ ${purchaseErrorMessage(error, services)}`,
              `自由チップは既にLandへ返還済みです（購入は未完了）。`,
              "同じボタンをもう一度押すと、二重に資金を動かさずこの購入だけを再試行します。",
            ].join("\n")
          : `❌ ${purchaseErrorMessage(error, services)}`,
        embeds: [],
        components: stranded ? retryConfirmComponents(confirmationId, itemId, mode) : [],
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
