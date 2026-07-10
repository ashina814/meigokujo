import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  RoleSelectMenuInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
} from "discord.js";
import type { ShopItemRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * /商館: 冥界商館スタッフ用のショップ管理ハブ。
 * 権限: 運営 or 「冥界商館」部署の担当ロール保持者。
 * 商品CRUDと購入配送マークを行う。
 */
export const shokanCommand = new SlashCommandBuilder()
  .setName("商館")
  .setDescription("冥界商館の管理（商品追加・編集・配送）")
  .setDMPermission(false);

const SHOKAN_DEPT_KEY = "冥界商館";

function canOperate(interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const dept = services.departments.get(SHOKAN_DEPT_KEY);
  if (!dept?.role_id) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(dept.role_id) ?? false;
}

function backButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:hub").setLabel("← 商館ハブ").setStyle(ButtonStyle.Secondary),
  );
}

function renderHub(services: Services) {
  const items = services.shop.listItems();
  const enabled = items.filter((i) => i.enabled).length;
  const embed = new EmbedBuilder()
    .setTitle("🛒 冥界商館 管理コンソール")
    .setColor(0xdb2777)
    .setDescription(
      [
        `**商品**: ${items.length}件（有効 ${enabled} / 無効 ${items.length - enabled}）`,
        "",
        "商品を追加・編集・無効化できます。購入者への手動配送は `#決裁` or `channel:shokan` に投稿される通知から。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("shokan:list").setLabel("一覧").setEmoji("📃").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("shokan:new").setLabel("新規商品").setEmoji("➕").setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

function renderList(services: Services) {
  const items = services.shop.listItems();
  const embed = new EmbedBuilder().setTitle("📃 商品一覧").setColor(0xdb2777);
  if (items.length === 0) {
    embed.setDescription("まだ商品がありません。「新規商品」から追加してください。");
    return { embeds: [embed], components: [backButton()] };
  }
  embed.setDescription(
    items
      .slice(0, 25)
      .map((it) => {
        const status = it.enabled ? "🟢" : "⚫";
        const kind = it.kind === "monthly" ? "月額" : "単発";
        const price = it.price_land !== null ? fmtLd(it.price_land) : "—";
        return `${status} \`#${it.id}\` **${it.name}** — ${price} / ${kind}`;
      })
      .join("\n"),
  );
  const menu = new StringSelectMenuBuilder()
    .setCustomId("shokan:pick")
    .setPlaceholder("編集する商品を選ぶ")
    .addOptions(
      items.slice(0, 25).map((it) => ({
        label: `${it.enabled ? "" : "[無効] "}${it.name}`.slice(0, 100),
        value: String(it.id),
        description: `${it.price_land !== null ? fmtLd(it.price_land) : "—"} / ${it.kind === "monthly" ? "月額" : "単発"}`.slice(0, 100),
      })),
    );
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()] };
}

function renderItem(item: ShopItemRow) {
  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${item.name}`)
    .setColor(item.enabled ? 0xdb2777 : 0x6b7280)
    .addFields(
      { name: "説明", value: item.description ?? "（説明なし）" },
      { name: "価格 (Land)", value: item.price_land !== null ? fmtLd(item.price_land) : "—", inline: true },
      { name: "代替価格", value: item.price_alt_kind ? `${item.price_alt_kind} ${item.price_alt_amount}` : "—", inline: true },
      { name: "種類", value: item.kind === "monthly" ? "月額" : "単発", inline: true },
      { name: "期限（日）", value: String(item.duration_days ?? "—"), inline: true },
      { name: "階級要件", value: item.require_role_id ? `<@&${item.require_role_id}>` : "なし", inline: true },
      { name: "配送", value: `${item.delivery === "auto" ? "自動" : "手動"}${item.delivery_kind ? ` (${item.delivery_kind})` : ""}`, inline: true },
      { name: "在庫", value: item.stock === null ? "無限" : String(item.stock), inline: true },
      { name: "状態", value: item.enabled ? "🟢 有効" : "⚫ 無効", inline: true },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`shokan:edit-basic:${item.id}`).setLabel("基本情報を編集").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`shokan:edit-role:${item.id}`).setLabel("階級要件").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`shokan:edit-delivery:${item.id}`).setLabel("配送設定").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`shokan:toggle:${item.id}`)
      .setLabel(item.enabled ? "無効化" : "有効化")
      .setStyle(item.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row, backButton()] };
}

export async function handleShokanCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!canOperate(interaction, services)) {
    await interaction.reply({
      content: "この操作には運営または「冥界商館」部署の担当ロールが必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ ...renderHub(services), flags: MessageFlags.Ephemeral });
}

export async function handleShokanButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!canOperate(interaction, services)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const arg = parts[2];

  if (action === "hub") return void (await interaction.update(renderHub(services)));
  if (action === "list") return void (await interaction.update(renderList(services)));
  if (action === "new") return void (await interaction.showModal(newItemModal()));
  if (action === "edit-basic" && arg) return void (await interaction.showModal(editBasicModal(Number(arg), services)));
  if (action === "edit-role" && arg) return void (await interaction.update(roleEditor(Number(arg))));
  if (action === "edit-delivery" && arg) return void (await interaction.showModal(editDeliveryModal(Number(arg), services)));
  if (action === "toggle" && arg) {
    const id = Number(arg);
    const item = services.shop.getItem(id);
    if (!item) return;
    services.shop.setEnabled(id, !item.enabled, `user:${interaction.user.id}`);
    return void (await interaction.update(renderItem(services.shop.getItem(id)!)));
  }
  if (action === "deliver" && arg) {
    const id = Number(arg);
    services.shop.markDelivered(id, `user:${interaction.user.id}`);
    await interaction.reply({ content: `📦 購入 #${id} を配送済みにしました。`, flags: MessageFlags.Ephemeral });
    // 元メッセージのボタンを無効化
    if (interaction.message.editable) {
      await interaction.message
        .edit({
          content: `${interaction.message.content}\n✅ 配送完了（${interaction.user.username}）`,
          components: [],
        })
        .catch(() => undefined);
    }
    return;
  }
}

export async function handleShokanSelect(
  interaction: StringSelectMenuInteraction | RoleSelectMenuInteraction,
  services: Services,
): Promise<void> {
  if (!canOperate(interaction, services)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "pick" && interaction.isStringSelectMenu()) {
    const item = services.shop.getItem(Number(interaction.values[0]));
    if (!item) return;
    return void (await interaction.update(renderItem(item)));
  }
  if (action === "role-set" && interaction.isRoleSelectMenu()) {
    const id = Number(parts[2]);
    services.shop.updateItem(id, { require_role_id: interaction.values[0] }, `user:${interaction.user.id}`);
    return void (await interaction.update(renderItem(services.shop.getItem(id)!)));
  }
  if (action === "role-clear" && interaction.isStringSelectMenu()) {
    const id = Number(parts[2]);
    services.shop.updateItem(id, { require_role_id: null }, `user:${interaction.user.id}`);
    return void (await interaction.update(renderItem(services.shop.getItem(id)!)));
  }
}

export async function handleShokanModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  if (!canOperate(interaction, services)) return;
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "new") {
    const name = interaction.fields.getTextInputValue("name").trim();
    const price = Number(interaction.fields.getTextInputValue("price").replaceAll(",", "").trim());
    const kindRaw = interaction.fields.getTextInputValue("kind").trim().toLowerCase();
    const durationRaw = interaction.fields.getTextInputValue("duration").trim();
    const desc = interaction.fields.getTextInputValue("desc").trim() || null;
    if (!name || !Number.isFinite(price) || price < 0) {
      await interaction.reply({ content: "名前と 0以上の価格 を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const kind = kindRaw === "m" || kindRaw === "monthly" || kindRaw === "月額" ? "monthly" : "one_shot";
    const duration = durationRaw ? Number(durationRaw) : null;
    const created = services.shop.createItem(
      {
        name,
        description: desc,
        price_land: price,
        kind,
        duration_days: duration && Number.isFinite(duration) ? duration : null,
        delivery: "manual",
        enabled: true,
      },
      `user:${interaction.user.id}`,
    );
    await interaction.reply({
      content: `✅ 商品 #${created.id} 「${created.name}」を追加しました。編集は「一覧」から。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (action === "edit-basic") {
    const id = Number(parts[2]);
    const name = interaction.fields.getTextInputValue("name").trim();
    const price = Number(interaction.fields.getTextInputValue("price").replaceAll(",", "").trim());
    const kindRaw = interaction.fields.getTextInputValue("kind").trim().toLowerCase();
    const durationRaw = interaction.fields.getTextInputValue("duration").trim();
    const desc = interaction.fields.getTextInputValue("desc").trim() || null;
    const kind = kindRaw === "m" || kindRaw === "monthly" || kindRaw === "月額" ? "monthly" : "one_shot";
    const duration = durationRaw ? Number(durationRaw) : null;
    services.shop.updateItem(
      id,
      {
        name,
        description: desc,
        price_land: Number.isFinite(price) && price >= 0 ? price : null,
        kind,
        duration_days: duration && Number.isFinite(duration) ? duration : null,
      },
      `user:${interaction.user.id}`,
    );
    await interaction.reply({ content: `✅ 商品 #${id} を更新しました。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "edit-delivery") {
    const id = Number(parts[2]);
    const modeRaw = interaction.fields.getTextInputValue("mode").trim().toLowerCase();
    const kindRaw = interaction.fields.getTextInputValue("kind").trim().toLowerCase();
    const dataRaw = interaction.fields.getTextInputValue("data").trim();
    const mode = modeRaw === "auto" || modeRaw === "自動" ? "auto" : "manual";
    const kind =
      kindRaw === "add_role"
        ? "add_role"
        : kindRaw === "extend_deadline"
          ? "extend_deadline"
          : kindRaw === "revoke_meirei"
            ? "revoke_meirei"
            : null;
    services.shop.updateItem(
      id,
      { delivery: mode, delivery_kind: kind, delivery_data: dataRaw || null },
      `user:${interaction.user.id}`,
    );
    await interaction.reply({ content: `✅ 配送設定を更新しました。`, flags: MessageFlags.Ephemeral });
    return;
  }
}

// ---- Modals & Selects ----

function newItemModal() {
  return new ModalBuilder()
    .setCustomId("shokan:new")
    .setTitle("新規商品")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("商品名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("price").setLabel("価格（Land）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("kind").setLabel("種類: monthly / one_shot").setStyle(TextInputStyle.Short).setRequired(true).setValue("one_shot"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("duration").setLabel("期限日数（単発の期限付きのみ・空欄可）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(6),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("desc").setLabel("説明").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
      ),
    );
}

function editBasicModal(id: number, services: Services) {
  const item = services.shop.getItem(id);
  const modal = new ModalBuilder().setCustomId(`shokan:edit-basic:${id}`).setTitle(`#${id} 基本情報の編集`);
  const inputs = [
    new TextInputBuilder().setCustomId("name").setLabel("商品名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(item?.name ?? ""),
    new TextInputBuilder().setCustomId("price").setLabel("価格（Land）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15).setValue(item?.price_land !== undefined && item?.price_land !== null ? String(item.price_land) : "0"),
    new TextInputBuilder().setCustomId("kind").setLabel("種類: monthly / one_shot").setStyle(TextInputStyle.Short).setRequired(true).setValue(item?.kind ?? "one_shot"),
    new TextInputBuilder().setCustomId("duration").setLabel("期限日数（空欄可）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(6).setValue(item?.duration_days ? String(item.duration_days) : ""),
    new TextInputBuilder().setCustomId("desc").setLabel("説明").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setValue(item?.description ?? ""),
  ];
  modal.addComponents(
    ...inputs.map((i) => new ActionRowBuilder<TextInputBuilder>().addComponents(i)),
  );
  return modal;
}

function editDeliveryModal(id: number, services: Services) {
  const item = services.shop.getItem(id);
  const modal = new ModalBuilder().setCustomId(`shokan:edit-delivery:${id}`).setTitle(`#${id} 配送設定`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("mode").setLabel("配送: auto / manual").setStyle(TextInputStyle.Short).setRequired(true).setValue(item?.delivery ?? "manual"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("kind")
        .setLabel("自動配送種別: add_role / extend_deadline / revoke_meirei / 空欄")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(item?.delivery_kind ?? ""),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("data")
        .setLabel("配送データ JSON（例: {\"role_id\":\"…\"} / {\"days\":1}）")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
        .setValue(item?.delivery_data ?? ""),
    ),
  );
  return modal;
}

function roleEditor(id: number) {
  const embed = new EmbedBuilder()
    .setTitle(`#${id} 階級要件の設定`)
    .setColor(0xdb2777)
    .setDescription("要件ロールを選ぶか、「解除」で無条件にします。");
  const picker = new RoleSelectMenuBuilder().setCustomId(`shokan:role-set:${id}`).setPlaceholder("要件ロールを選ぶ");
  const clear = new StringSelectMenuBuilder()
    .setCustomId(`shokan:role-clear:${id}`)
    .setPlaceholder("階級要件を解除する")
    .addOptions({ label: "階級要件なしにする", value: "clear" });
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(clear),
      backButton(),
    ],
  };
}
