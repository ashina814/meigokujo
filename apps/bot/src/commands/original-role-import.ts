import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type RoleSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { ORIGINAL_ROLE_TERM_DAYS, OriginalRoleError } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * 旧オリジナルロールの引き継ぎ（運営用）。
 *
 * 旧商品の購入履歴には「買った」という事実しか残っておらず、**どのロールを作ったかの
 * 記録がどこにも無い**。名前が似ているロールを機械的に結び付けると、別人のロールを
 * 期限切れで剥奪する事故になる。だから**人が buyer と role を1件ずつ突き合わせる**。
 *
 * 画面は3段。「実行前に必ず全部見せる」ことを守る:
 *
 * 対象者を選ぶ → ロールを選ぶ → buyer / role / 期限 を確認 → 登録
 */

const DAY = 86_400;
/** 旧「オリジナルロール継続or付与 月額」の商品ID。設定されていれば残件を一覧に出す */
export const LEGACY_ITEM_SETTING_KEY = "shop:original_role_legacy_item_id";

const backRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:recover").setLabel("← 回収へ").setStyle(ButtonStyle.Secondary),
  );

export interface LegacyHolder {
  userId: string;
  purchaseId: number;
  expiresAt: number | null;
}

/**
 * 旧商品を契約中の人。**ロールは引かない**（推測しないため）。
 * 期限だけは購入行に残っているので、確認画面の初期値として見せる。
 */
export function legacyHolders(services: Services): LegacyHolder[] {
  const itemId = Number(services.settings.getString(LEGACY_ITEM_SETTING_KEY));
  if (!Number.isInteger(itemId) || itemId <= 0) return [];
  return (
    services.db
      .prepare("SELECT id, user_id, expires_at FROM shop_purchases WHERE item_id = ? AND status = 'active' ORDER BY id")
      .all(itemId) as Array<{ id: number; user_id: string; expires_at: number | null }>
  ).map((row) => ({ userId: row.user_id, purchaseId: row.id, expiresAt: row.expires_at }));
}

/** その人の旧契約（無ければ null）。**ロールの推測には使わない** */
function legacyOf(services: Services, userId: string): LegacyHolder | null {
  return legacyHolders(services).find((h) => h.userId === userId) ?? null;
}

export function importHome(services: Services) {
  const holders = legacyHolders(services);
  const registered = new Set(services.originalRoles.listByStatus("active", 100).map((r) => r.user_id));
  const remaining = holders.filter((h) => !registered.has(h.userId));
  const embed = new EmbedBuilder()
    .setTitle("🎨 既存オリジナルロールの引き継ぎ")
    .setColor(0x0f766e)
    .setDescription(
      [
        "旧商品で契約中の方を、新しいオリジナルロール制度へ移します。",
        "",
        "**購入履歴からロールは推測しません。** どのロールがその人のものかは記録が無いため、",
        "運営が1件ずつ本人とロールを突き合わせて登録します。",
        "",
        holders.length === 0
          ? "-# 旧商品のIDが未設定です（設定キー shop:original_role_legacy_item_id）。設定すると残件をここに一覧できます。対象者が分かっていれば、未設定のままでも下から登録できます。"
          : [
              `旧商品の契約中 **${holders.length}件** ／ 未登録 **${remaining.length}件**`,
              ...remaining.map(
                (h) => `・<@${h.userId}>（購入 #${h.purchaseId}${h.expiresAt ? ` ／ 期限 <t:${h.expiresAt}:D>` : ""}）`,
              ),
            ].join("\n"),
        "",
        "-# 同じロールを二重に登録することはできません。登録すると本人が更新できるようになります。",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  return {
    embeds: [embed],
    content: "",
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId("mgmt:recover:orole-import-user")
          .setPlaceholder("引き継ぐ対象者を選ぶ")
          .setMaxValues(1),
      ),
      backRow(),
    ],
  };
}

/** 2段目。**対象者を先に固定してからロールを選ばせる**（取り違えを減らす） */
export function importRolePicker(services: Services, userId: string) {
  const legacy = legacyOf(services, userId);
  const embed = new EmbedBuilder()
    .setTitle("🎨 引き継ぐロールを選ぶ")
    .setColor(0x0f766e)
    .setDescription(
      [
        `対象者 <@${userId}>`,
        legacy
          ? `旧契約 購入 #${legacy.purchaseId}${legacy.expiresAt ? ` ／ 期限 <t:${legacy.expiresAt}:D>` : ""}`
          : `旧契約の購入行は見つかりませんでした（期限は今日から${ORIGINAL_ROLE_TERM_DAYS}日で登録します）。`,
        "",
        "**その人が実際に使っているオリジナルロール**を選んでください。",
        "-# 階級ロールや共通ロールを選ばないでください。選んだロールは期限切れで剥奪されます。",
      ].join("\n"),
    );
  return {
    embeds: [embed],
    content: "",
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`mgmt:recover:orole-import-role:${userId}`)
          .setPlaceholder("引き継ぐロールを選ぶ")
          .setMaxValues(1),
      ),
      backRow(),
    ],
  };
}

/** 3段目。**buyer / role / 期限をすべて出してから**でないと登録させない */
export function importConfirm(services: Services, userId: string, roleId: string, roleName: string) {
  const legacy = legacyOf(services, userId);
  const expiresAt = legacy?.expiresAt ?? Math.floor(Date.now() / 1000) + ORIGINAL_ROLE_TERM_DAYS * DAY;
  const taken = services.originalRoles.roleTaken(roleId);
  const embed = new EmbedBuilder()
    .setTitle("🎨 この内容で引き継ぎます")
    .setColor(taken ? 0xdc2626 : 0x0f766e)
    .addFields(
      { name: "対象者", value: `<@${userId}>`, inline: true },
      { name: "ロール", value: `<@&${roleId}>（${roleName}）`, inline: true },
      {
        name: "期限",
        value: legacy?.expiresAt
          ? `<t:${expiresAt}:D>（旧契約 購入 #${legacy.purchaseId} の期限をそのまま引き継ぎます）`
          : `<t:${expiresAt}:D>（旧契約の期限が取れなかったため、今日から${ORIGINAL_ROLE_TERM_DAYS}日で登録します）`,
      },
    )
    .setDescription(
      taken
        ? "⚠️ **このロールは既に別の契約で登録されています。** 二重登録はできません。"
        : "登録すると、本人が公式ショップから更新できるようになります。期限切れでこのロールは剥奪されます。",
    );
  return {
    embeds: [embed],
    content: "",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:recover:orole-import-run:${userId}:${roleId}:${expiresAt}`)
          .setLabel("この内容で登録する")
          .setStyle(ButtonStyle.Success)
          .setDisabled(taken),
        new ButtonBuilder().setCustomId("mgmt:recover:orole-import").setLabel("やり直す").setStyle(ButtonStyle.Secondary),
      ),
      backRow(),
    ],
  };
}

export async function handleImportUser(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  await interaction.update(importRolePicker(services, interaction.values[0]!));
}

export async function handleImportRole(interaction: RoleSelectMenuInteraction, services: Services): Promise<void> {
  const userId = interaction.customId.split(":")[3]!;
  const roleId = interaction.values[0]!;
  const role = interaction.roles.first() ?? interaction.guild?.roles.cache.get(roleId) ?? null;
  await interaction.update(importConfirm(services, userId, roleId, role?.name ?? roleId));
}

export async function handleImportRun(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const userId = parts[3]!;
  const roleId = parts[4]!;
  const expiresAt = Number(parts[5]);
  const role = interaction.guild?.roles.cache.get(roleId) ?? null;
  try {
    const row = services.originalRoles.importExisting({
      userId,
      roleId,
      name: role?.name ?? `旧オリジナルロール(${roleId})`,
      expiresAt,
      actor: `user:${interaction.user.id}`,
    });
    await interaction.update({
      embeds: [],
      content: [
        `✅ <@${userId}> のオリジナルロール <@&${roleId}> を引き継ぎました（契約 #${row.id}）。`,
        `期限 <t:${row.expires_at ?? 0}:D> ／ 本人が公式ショップから更新できます。`,
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("mgmt:recover:orole-import")
            .setLabel("続けて登録する")
            .setStyle(ButtonStyle.Primary),
        ),
        backRow(),
      ],
    });
  } catch (error) {
    const message =
      error instanceof OriginalRoleError && error.code === "ERR_ROLE_TAKEN"
        ? "このロールは既に別の契約で登録されています。**何も登録していません。**"
        : "登録できませんでした。**何も登録していません。**";
    await interaction.update({ embeds: [], content: `❌ ${message}`, components: [backRow()] });
  }
}
