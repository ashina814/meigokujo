import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { handleDepartment, handleDepartmentAutocomplete } from "./department.js";
import type { Services } from "../services.js";

/**
 * 運営操作の集約コマンド（ManageGuild で一般メンバーには非表示）。
 * 部署の作成・削除だけを畳んでいる。将来 /管理 ハブに移す想定。
 */
export const operationsCommand = new SlashCommandBuilder()
  .setName("運営")
  .setDescription("運営操作（部署の管理）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((g) =>
    g
      .setName("部署")
      .setDescription("部署口座の作成・削除")
      .addSubcommand((s) =>
        s
          .setName("作成")
          .setDescription("部署を作成／担当ロールを更新")
          .addStringOption((o) => o.setName("名前").setDescription("部署名（例: 冥界商館）").setRequired(true).setMaxLength(40))
          .addRoleOption((o) => o.setName("担当ロール").setDescription("入出金できる部署員ロール").setRequired(true)),
      )
      .addSubcommand((s) => s.setName("削除").setDescription("部署を削除（残高0のときのみ）").addStringOption((o) => o.setName("部署").setDescription("削除する部署").setRequired(true).setAutocomplete(true))),
  );

export async function handleOperations(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  switch (interaction.options.getSubcommandGroup()) {
    case "部署":
      return handleDepartment(interaction, services);
  }
}

export async function handleOperationsAutocomplete(interaction: AutocompleteInteraction, services: Services): Promise<void> {
  return handleDepartmentAutocomplete(interaction, services);
}
