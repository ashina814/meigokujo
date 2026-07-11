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
import type { ShopItemRow } from "@meigokujo/core";
import { ShopError } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

/**
 * 公式ショップ（買う側の永続パネル）。
 * /パネル設置 種別:公式ショップ で設置される。
 */

const CATALOG_LIMIT = 25;

function formatPrice(item: ShopItemRow): string {
  const parts: string[] = [];
  if (item.price_land !== null) parts.push(`${fmtLd(item.price_land)}`);
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
      items.slice(0, 25).map((it) => ({
        name: `${it.name} — ${formatPrice(it)}`,
        value: [
          `${formatKind(it)}${it.require_role_id ? ` / <@&${it.require_role_id}> 限定` : ""}${it.stock !== null ? ` / 在庫 ${it.stock}` : ""}`,
          it.description ? `_${it.description}_` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      })),
    );
  }

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("shop:pick")
      .setPlaceholder("商品を選ぶ")
      .addOptions(
        items.slice(0, CATALOG_LIMIT).map((it) => ({
          label: `${it.name}`.slice(0, 100),
          value: String(it.id),
          description: `${formatPrice(it)} / ${formatKind(it)}`.slice(0, 100),
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

function itemDetail(item: ShopItemRow, userHasRole: boolean, balance: number): {
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
      { name: "階級要件", value: item.require_role_id ? `<@&${item.require_role_id}>` : "なし", inline: true },
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
        .setDisabled(!userHasRole || balance < item.price_land || (item.stock !== null && item.stock <= 0)),
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
    embed.setFooter({ text: `階級要件を満たしていません（要 ${item.require_role_id}）` });
  }
  return { embeds: [embed], components };
}

export async function handleShopButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // shop:buy:<itemId>:<land|alt>  shop:contracts
  const action = parts[1];

  if (action === "contracts") {
    const rows = services.shop.listUserPurchases(interaction.user.id, { activeOnly: true });
    const lines =
      rows.length > 0
        ? rows.map((p) => {
            const item = services.shop.getItem(p.item_id);
            const label = item?.name ?? `#${p.item_id}`;
            const exp = p.expires_at ? `<t:${p.expires_at}:D>` : "—";
            const renew = p.auto_renew ? "🔁 自動更新" : "❌ 更新停止";
            return `・**${label}**（有効期限 ${exp}・${renew}）`;
          })
        : ["契約中の商品はありません。"];
    const embed = new EmbedBuilder()
      .setTitle("📜 契約中の商品")
      .setColor(0xdb2777)
      .setDescription(lines.join("\n"));
    // 解約ボタン
    const monthlyRows = rows.filter((p) => p.auto_renew);
    const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
    if (monthlyRows.length > 0) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("shop:cancel")
        .setPlaceholder("解約する契約を選ぶ")
        .addOptions(
          monthlyRows.slice(0, 25).map((p) => {
            const item = services.shop.getItem(p.item_id);
            return { label: (item?.name ?? `#${p.item_id}`).slice(0, 100), value: String(p.id) };
          }),
        );
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
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
    const memberRoleIds =
      member && "roles" in member && "cache" in member.roles ? [...member.roles.cache.keys()] : [];
    try {
      const res = services.shop.purchase({
        itemId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds,
        payAlt: mode === "alt",
      });
      // 自動配送
      let deliveryNote = "";
      if (item.delivery === "auto") {
        deliveryNote = await tryAutoDeliver(interaction, services, item, interaction.user.id).catch(
          () => "自動配送に失敗しました。運営にお問い合わせください。",
        );
      } else {
        deliveryNote = "スタッフが配送の対応をします。";
        await notifyStaffForDelivery(interaction, services, res.purchase.id, item).catch(() => undefined);
      }
      const expires = res.purchase.expires_at ? `\n有効期限: <t:${res.purchase.expires_at}:D>` : "";
      await interaction.reply({
        content: `✅ **${item.name}** を購入しました${deliveryNote ? `\n${deliveryNote}` : ""}${expires}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      const msg =
        e instanceof ShopError
          ? e.code === "ERR_ITEM_DISABLED"
            ? "この商品は現在販売されていません。"
            : e.code === "ERR_NO_STOCK"
              ? "在庫切れです。"
              : e.code === "ERR_ROLE_REQUIRED"
                ? "階級要件を満たしていません。"
                : e.code === "ERR_ALREADY_ACTIVE"
                  ? "既にこの月額商品を契約中です。"
                  : e.code === "ERR_NO_PRICE"
                    ? "この商品の価格が設定されていません。"
                    : "処理に失敗しました。"
          : e instanceof Error && "code" in e && (e as { code: unknown }).code === "ERR_INSUFFICIENT"
            ? "残高が足りません。"
            : "処理に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
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
    const memberRoleIds =
      member && "roles" in member && "cache" in member.roles ? [...member.roles.cache.keys()] : [];
    const hasRole = !item.require_role_id || memberRoleIds.includes(item.require_role_id);
    const balance = services.ledger.balanceOf(`user:${interaction.user.id}`);
    const view = itemDetail(item, hasRole, balance);
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
    return;
  }
}

// ---- 自動配送 ----

async function tryAutoDeliver(
  interaction: ButtonInteraction,
  services: Services,
  item: import("@meigokujo/core").ShopItemRow,
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
    // 直接更新
    services.db
      .prepare(
        "UPDATE souls SET eval_deadline_at = eval_deadline_at + ?, updated_at = ? WHERE user_id = ?",
      )
      .run(days * 86_400, Math.floor(Date.now() / 1000), userId);
    return `評価期限を **+${days}日** 延長しました。`;
  }
  if (item.delivery_kind === "revoke_meirei") {
    const soul = services.entry.getSoul(userId);
    if (!soul) return "魂記録がありません。";
    if (soul.status !== "meirei") return "現在の状態が迷霊ではありません。";
    // 案内待ちに戻す（resetToWaiting は現状 waiting 用途だが再評価チャレンジは同等）
    services.entry.resetToWaiting(userId, `shop:${item.id}`);
    // Discordロールも解除→案内待ちに
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
  item: import("@meigokujo/core").ShopItemRow,
): Promise<void> {
  const shokanChId = services.settings.getString("channel:shokan");
  const chId = shokanChId ?? services.settings.getString("channel:kessai");
  if (!chId) return;
  const ch = await interaction.client.channels.fetch(chId).catch(() => null);
  if (!ch?.isTextBased() || !("send" in ch)) return;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`shokan:deliver:${purchaseId}`).setLabel("配送完了").setEmoji("📦").setStyle(ButtonStyle.Success),
  );
  await ch
    .send({
      content: `📦 **公式ショップ**: <@${interaction.user.id}> が **${item.name}** を購入。手動配送をお願いします（購入ID #${purchaseId}）。`,
      components: [row],
      allowedMentions: { users: [interaction.user.id] },
    })
    .catch(() => undefined);
}
