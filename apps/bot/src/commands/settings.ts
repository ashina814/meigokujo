import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { SETTING_DEFAULTS, type SettingKey } from "@meigokujo/core";
import { config } from "../config.js";
import type { Services } from "../services.js";

/** チャンネル割当の種別（ボット設計.md 設定パネル） */
export const CHANNEL_KINDS = [
  ["public_log", "公開取引ログ"],
  ["kessai", "#決裁"],
  ["keikiban", "#城の計器盤"],
  ["audit_log", "監査ログ"],
] as const;

const NUMERIC_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export const settingsCommand = new SlashCommandBuilder()
  .setName("設定")
  .setDescription("冥獄城ボットの設定（運営専用）")
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName("表示").setDescription("現在の設定を一覧表示"))
  .addSubcommand((sub) =>
    sub
      .setName("チャンネル")
      .setDescription("チャンネル割当を設定")
      .addStringOption((o) =>
        o
          .setName("種別")
          .setDescription("どの用途のチャンネルか")
          .setRequired(true)
          .addChoices(...CHANNEL_KINDS.map(([value, name]) => ({ name, value }))),
      )
      .addChannelOption((o) => o.setName("チャンネル").setDescription("割り当てるチャンネル").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("数値")
      .setDescription("数値パラメータを設定")
      .addStringOption((o) =>
        o
          .setName("キー")
          .setDescription("設定キー")
          .setRequired(true)
          .addChoices(...NUMERIC_KEYS.slice(0, 25).map((k) => ({ name: k, value: k }))),
      )
      .addNumberOption((o) => o.setName("値").setDescription("設定値").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("管理ロール")
      .setDescription("/設定 を使える運営ロールを指定")
      .addRoleOption((o) => o.setName("ロール").setDescription("高度な管理者ロール").setRequired(true)),
  );

function isAdmin(interaction: ChatInputCommandInteraction, services: Services): boolean {
  if (interaction.user.id === config.ownerId) return true;
  const adminRoleId = services.settings.getString("role:admin");
  if (!adminRoleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(adminRoleId) ?? false;
}

export async function handleSettings(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({
      content: "この操作には城の管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const actor = `user:${interaction.user.id}`;

  if (sub === "表示") {
    const channelLines = CHANNEL_KINDS.map(([kind, label]) => {
      const id = services.settings.getString(`channel:${kind}`);
      return `${label}: ${id ? `<#${id}>` : "未設定"}`;
    });
    const adminRoleId = services.settings.getString("role:admin");
    const numericLines = NUMERIC_KEYS.map(
      (k) => `${k}: **${services.settings.getNumber(k).toLocaleString()}**`,
    );
    const embed = new EmbedBuilder()
      .setTitle("⚙️ 冥獄城ボット 設定")
      .addFields(
        { name: "チャンネル割当", value: channelLines.join("\n") },
        { name: "管理ロール", value: adminRoleId ? `<@&${adminRoleId}>` : "未設定（OWNERのみ）" },
        { name: "数値パラメータ", value: numericLines.join("\n") },
      )
      .setColor(0x6b21a8);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "チャンネル") {
    const kind = interaction.options.getString("種別", true);
    const channel = interaction.options.getChannel("チャンネル", true);
    services.settings.set(`channel:${kind}`, channel.id, actor);
    const label = CHANNEL_KINDS.find(([v]) => v === kind)?.[1] ?? kind;
    await interaction.reply({
      content: `✅ ${label} を <#${channel.id}> に設定しました。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "数値") {
    const key = interaction.options.getString("キー", true);
    const value = interaction.options.getNumber("値", true);
    services.settings.set(key, value, actor);
    await interaction.reply({
      content: `✅ \`${key}\` を **${value.toLocaleString()}** に設定しました（即時反映）。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "管理ロール") {
    const role = interaction.options.getRole("ロール", true);
    services.settings.set("role:admin", role.id, actor);
    await interaction.reply({
      content: `✅ 管理ロールを <@&${role.id}> に設定しました。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}
