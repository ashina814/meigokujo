import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Guild,
  type UserSelectMenuInteraction,
} from "discord.js";
import { SubAccountError } from "@meigokujo/core";
import { PAIR_ERROR_MESSAGE, eligible, mainRank } from "./sub-account.js";
import type { Services } from "../services.js";

/**
 * 旧サブ垢の引き継ぎ（運営用）。
 *
 * 旧商品#4の購入履歴には「買った」しか残っておらず、**どのアカウントがサブ垢かの記録が
 * どこにも無い**。推測すると他人のアカウントを本体に紐付ける事故になるので、
 * 運営が本体とサブ垢を1件ずつ突き合わせて登録する。
 *
 * 本体を選ぶ → サブ垢を選ぶ → 内容を確認 → 登録
 */

/** 旧「サブ垢追加」の商品ID。設定されていれば残件を一覧に出す */
export const LEGACY_ITEM_SETTING_KEY = "shop:sub_account_legacy_item_id";

const backRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:recover").setLabel("← 回収へ").setStyle(ButtonStyle.Secondary),
  );

export interface LegacyBuyer {
  userId: string;
  purchaseId: number;
}

/** 旧商品を買った人。**サブ垢は引かない**（記録が無いので推測しない） */
export function legacyBuyers(services: Services): LegacyBuyer[] {
  const itemId = Number(services.settings.getString(LEGACY_ITEM_SETTING_KEY));
  if (!Number.isInteger(itemId) || itemId <= 0) return [];
  return (
    services.db
      .prepare("SELECT id, user_id FROM shop_purchases WHERE item_id = ? AND status = 'active' ORDER BY id")
      .all(itemId) as Array<{ id: number; user_id: string }>
  ).map((row) => ({ userId: row.user_id, purchaseId: row.id }));
}

export function importHome(services: Services) {
  const buyers = legacyBuyers(services);
  const registered = new Set(services.subAccounts.listActive().map((r) => r.main_user_id));
  const remaining = buyers.filter((b) => !registered.has(b.userId));
  const embed = new EmbedBuilder()
    .setTitle("👥 既存サブ垢の引き継ぎ")
    .setColor(0x0f766e)
    .setDescription(
      [
        "旧商品で処理済みのサブ垢を、新しい制度へ移します。",
        "",
        "**購入履歴からサブ垢は推測しません。** どのアカウントがサブ垢かは記録が無いため、",
        "運営が1件ずつ本体とサブ垢を突き合わせて登録します。",
        "",
        buyers.length === 0
          ? "-# 旧商品のIDが未設定です（設定キー shop:sub_account_legacy_item_id）。設定すると残件をここに一覧できます。対象が分かっていれば、未設定のままでも下から登録できます。"
          : [
              `旧商品の購入 **${buyers.length}件** ／ 未登録 **${remaining.length}件**`,
              ...remaining.map((b) => `・<@${b.userId}>（購入 #${b.purchaseId}）`),
            ].join("\n"),
        "",
        "-# 登録すると、そのサブ垢の階級は本体に合わせて自動で追従します。",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  return {
    embeds: [embed],
    content: "",
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("mgmt:recover:sub-import-main").setPlaceholder("本体を選ぶ").setMaxValues(1),
      ),
      backRow(),
    ],
  };
}

/** 2段目。本体を先に固定してからサブ垢を選ばせる（取り違えを減らす） */
export function importAltPicker(services: Services, mainUserId: string) {
  const rank = mainRank(services, mainUserId);
  const embed = new EmbedBuilder()
    .setTitle("👥 サブ垢を選ぶ")
    .setColor(eligible(services, mainUserId) ? 0x0f766e : 0xdc2626)
    .setDescription(
      [
        `本体 <@${mainUserId}>（階級 ${rank ?? "不明"}）`,
        eligible(services, mainUserId) ? "" : "⚠️ **この方は魔人未満です。** 登録すると階級の追従で何も付かなくなります。",
        "",
        "**その方が実際に使っているサブ垢**を選んでください。",
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
          .setCustomId(`mgmt:recover:sub-import-alt:${mainUserId}`)
          .setPlaceholder("サブ垢を選ぶ")
          .setMaxValues(1),
      ),
      backRow(),
    ],
  };
}

export type ImportBlock = "pair" | "alt_not_in_guild" | "unavailable";

/** 登録してよい組み合わせか。**押されたときにも同じ判定を通す** */
export async function checkImportPair(
  services: Services,
  guild: Guild | null,
  mainUserId: string,
  altUserId: string,
): Promise<{ ok: true } | { ok: false; reason: ImportBlock; detail?: string }> {
  try {
    services.subAccounts.assertPairAllowed(mainUserId, altUserId);
  } catch (error) {
    const code = error instanceof SubAccountError ? error.code : "";
    return { ok: false, reason: "pair", detail: PAIR_ERROR_MESSAGE[code] ?? "この組み合わせでは登録できません。" };
  }
  if (!guild) return { ok: false, reason: "unavailable" };
  const alt = await guild.members.fetch(altUserId).catch(() => null);
  if (!alt) return { ok: false, reason: "alt_not_in_guild" };
  return { ok: true };
}

/** 3段目。**本体 / サブ垢 / 階級をすべて出してから**でないと登録させない */
export async function importConfirm(services: Services, guild: Guild | null, mainUserId: string, altUserId: string) {
  const check = await checkImportPair(services, guild, mainUserId, altUserId);
  const rank = mainRank(services, mainUserId);
  const blocked = check.ok
    ? null
    : check.reason === "pair"
      ? `⚠️ ${check.detail}`
      : check.reason === "alt_not_in_guild"
        ? "⚠️ そのサブ垢はサーバーにいません。**いないアカウントは登録しません。**"
        : "⚠️ Discordから対象を確認できませんでした。**確認できないまま登録はしません。**";
  const embed = new EmbedBuilder()
    .setTitle("👥 この内容で引き継ぎます")
    .setColor(blocked ? 0xdc2626 : 0x0f766e)
    .addFields(
      { name: "本体", value: `<@${mainUserId}>`, inline: true },
      { name: "サブ垢", value: `<@${altUserId}>`, inline: true },
      {
        name: "階級",
        value: `${rank ?? "不明"}${eligible(services, mainUserId) ? "" : "（**魔人未満**。追従で階級ロールは付きません）"}`,
      },
    )
    .setDescription(blocked ?? "登録すると、このサブ垢の階級は本体に合わせて自動で追従します。");
  return {
    embeds: [embed],
    content: "",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:recover:sub-import-run:${mainUserId}:${altUserId}`)
          .setLabel("この内容で登録する")
          .setStyle(ButtonStyle.Success)
          .setDisabled(blocked !== null),
        new ButtonBuilder().setCustomId("mgmt:recover:sub-import").setLabel("やり直す").setStyle(ButtonStyle.Secondary),
      ),
      backRow(),
    ],
  };
}

export async function handleImportMain(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  await interaction.update(importAltPicker(services, interaction.values[0]!));
}

export async function handleImportAlt(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  const mainUserId = interaction.customId.split(":")[3]!;
  await interaction.update(await importConfirm(services, interaction.guild, mainUserId, interaction.values[0]!));
}

export async function handleImportRun(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  const mainUserId = parts[3]!;
  const altUserId = parts[4]!;
  // **画面の表示を信用しない。** 押されたときにもう一度確かめる
  const check = await checkImportPair(services, interaction.guild, mainUserId, altUserId);
  if (!check.ok) {
    const reason =
      check.reason === "pair"
        ? check.detail
        : check.reason === "alt_not_in_guild"
          ? "そのサブ垢はサーバーにいません。"
          : "Discordから対象を確認できませんでした。";
    await interaction.update({
      embeds: [],
      content: `❌ ${reason}\n**何も登録していません。**`,
      components: [backRow()],
    });
    return;
  }
  try {
    const row = services.subAccounts.importExisting({ mainUserId, altUserId, actor: `user:${interaction.user.id}` });
    await interaction.update({
      embeds: [],
      content: `✅ <@${mainUserId}> のサブ垢として <@${altUserId}> を登録しました（#${row.id}）。階級は本体に追従します。`,
      allowedMentions: { parse: [] },
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("mgmt:recover:sub-import").setLabel("続けて登録する").setStyle(ButtonStyle.Primary),
        ),
        backRow(),
      ],
    });
  } catch (error) {
    const code = error instanceof SubAccountError ? error.code : "";
    await interaction.update({
      embeds: [],
      content: `❌ ${PAIR_ERROR_MESSAGE[code] ?? "登録できませんでした。"}\n**何も登録していません。**`,
      components: [backRow()],
    });
  }
}
