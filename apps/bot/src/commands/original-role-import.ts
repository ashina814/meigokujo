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
import type { Guild, Role } from "discord.js";
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

/**
 * 登録してよいロールか。**期限切れに剥奪できないロールを契約にしない。**
 *
 * ここを通さないと、期限が来ても外せないロールを「契約中」として抱え込み、
 * 運営が手で外すまで残る。@everyone や連携ロール（Bot・ブースト等）は
 * そもそも人に付け外しできない。
 */
export type ImportBlock = "not_held" | "managed" | "everyone" | "not_removable";

export const IMPORT_BLOCK_REASON: Record<ImportBlock, string> = {
  not_held: "この方はこのロールを持っていません。**本人が実際に使っているロール**を選んでください。",
  managed: "このロールは連携（Bot・ブースト等）が管理しているため、契約にできません。",
  everyone: "@everyone は契約にできません。",
  not_removable: "Botがこのロールを外せません（Botより上の位置にあるか、権限が足りません）。期限切れに剥奪できないため登録できません。",
};

export async function checkImportTarget(
  guild: Guild | null,
  userId: string,
  roleId: string,
): Promise<{ ok: true; role: Role } | { ok: false; reason: ImportBlock | "unavailable" }> {
  if (!guild) return { ok: false, reason: "unavailable" };
  if (roleId === guild.id) return { ok: false, reason: "everyone" };
  let role: Role | null;
  try {
    role = (await guild.roles.fetch()).get(roleId) ?? null;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!role) return { ok: false, reason: "unavailable" };
  if (role.managed) return { ok: false, reason: "managed" };
  // `editable` は「Botの最上位ロールより下」かつ「ロール管理権限がある」を見る。
  // 付け外しできる条件と同じなので、剥奪できるかの判定にそのまま使える
  if (!role.editable) return { ok: false, reason: "not_removable" };
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, reason: "unavailable" };
  if (!member.roles.cache.has(roleId)) return { ok: false, reason: "not_held" };
  return { ok: true, role };
}

/** 3段目。**buyer / role / 期限をすべて出し、登録してよいか確かめてから**でないと押させない */
export async function importConfirm(services: Services, guild: Guild | null, userId: string, roleId: string) {
  const legacy = legacyOf(services, userId);
  const expiresAt = legacy?.expiresAt ?? Math.floor(Date.now() / 1000) + ORIGINAL_ROLE_TERM_DAYS * DAY;
  const check = await checkImportTarget(guild, userId, roleId);
  const taken = services.originalRoles.roleTaken(roleId);
  const blocked = taken
    ? "⚠️ **このロールは既に別の契約で登録されています。** 二重登録はできません。"
    : check.ok
      ? null
      : check.reason === "unavailable"
        ? "⚠️ Discordから対象を確認できませんでした。**確認できないまま登録はしません。** 少し待って開き直してください。"
        : `⚠️ ${IMPORT_BLOCK_REASON[check.reason]}`;
  const roleName = check.ok ? check.role.name : roleId;
  const embed = new EmbedBuilder()
    .setTitle("🎨 この内容で引き継ぎます")
    .setColor(blocked ? 0xdc2626 : 0x0f766e)
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
      blocked ?? "登録すると、本人が公式ショップから更新できるようになります。期限切れでこのロールは剥奪されます。",
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
          .setDisabled(blocked !== null),
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
  await interaction.update(await importConfirm(services, interaction.guild, userId, interaction.values[0]!));
}

export async function handleImportRun(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const userId = parts[3]!;
  const roleId = parts[4]!;
  const expiresAt = Number(parts[5]);
  // **画面の表示を信用しない。** 押されたときにもう一度確かめる
  const check = await checkImportTarget(interaction.guild, userId, roleId);
  if (!check.ok) {
    const reason =
      check.reason === "unavailable"
        ? "Discordから対象を確認できませんでした。**何も登録していません。**"
        : `${IMPORT_BLOCK_REASON[check.reason]}
**何も登録していません。**`;
    await interaction.update({ embeds: [], content: `❌ ${reason}`, components: [backRow()] });
    return;
  }
  try {
    const row = services.originalRoles.importExisting({
      userId,
      roleId,
      name: check.role.name,
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
