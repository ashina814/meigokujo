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
  ["entry_guide", "入城案内"],
  ["session_vc", "説明会場VC"],
  ["eval_forum", "評価フォーラム"],
  ["shurei", "集令"],
  ["announce", "昇格のお知らせ"],
] as const;

/** ロール割当の種別（role:<kind> に保存） */
export const ROLE_KINDS = [
  ["queue_wait", "入城案内待ち"],
  ["ghost", "亡霊"],
  ["meirei", "迷霊"],
  ["majin", "魔人"],
  ["bump_notify", "紹介協力者"],
  ["judge", "面接担当"],
  ["swordsman", "魔剣士"],
  ["mendan", "面談待ち"],
  ["shin", "審（昇格面談の審査）"],
  ["ticket_staff", "チケット対応"],
  ["male", "男性属性"],
  ["female", "女性属性"],
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
  )
  .addSubcommand((sub) =>
    sub
      .setName("ロール")
      .setDescription("機能が参照するロールを割り当てる")
      .addStringOption((o) =>
        o
          .setName("種別")
          .setDescription("どの用途のロールか")
          .setRequired(true)
          .addChoices(...ROLE_KINDS.map(([value, name]) => ({ name, value }))),
      )
      .addRoleOption((o) => o.setName("ロール").setDescription("割り当てるロール").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("浮上リスト")
      .setDescription("VC浮上報酬の対象VCリストを編集")
      .addStringOption((o) =>
        o
          .setName("操作")
          .setDescription("何をするか")
          .setRequired(true)
          .addChoices({ name: "追加", value: "add" }, { name: "削除", value: "remove" }, { name: "表示", value: "show" }),
      )
      .addStringOption((o) =>
        o
          .setName("種別")
          .setDescription("どちらのリストか")
          .setRequired(true)
          .addChoices({ name: "報酬対象（評価対象VC）", value: "vc_whitelist" }, { name: "寝落ちVC（減額）", value: "vc_sleep_list" }),
      )
      .addChannelOption((o) => o.setName("チャンネル").setDescription("対象VC（追加・削除時に必須）")),
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

  if (sub === "ロール") {
    const kind = interaction.options.getString("種別", true);
    const role = interaction.options.getRole("ロール", true);
    services.settings.set(`role:${kind}`, role.id, actor);
    const label = ROLE_KINDS.find(([v]) => v === kind)?.[1] ?? kind;
    await interaction.reply({
      content: `✅ ${label} ロールを <@&${role.id}> に設定しました。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "浮上リスト") {
    const op = interaction.options.getString("操作", true);
    const key = interaction.options.getString("種別", true);
    const list = services.settings.getJson<string[]>(key, []);
    if (op === "show") {
      await interaction.reply({
        content: `📋 ${key === "vc_whitelist" ? "報酬対象VC" : "寝落ちVC"}: ${list.length > 0 ? list.map((id) => `<#${id}>`).join(" ") : "未設定"}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channel = interaction.options.getChannel("チャンネル");
    if (!channel) {
      await interaction.reply({ content: "チャンネルを指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const next = op === "add" ? [...new Set([...list, channel.id])] : list.filter((id) => id !== channel.id);
    services.settings.set(key, next, actor);
    await interaction.reply({
      content: `✅ ${op === "add" ? "追加" : "削除"}しました。現在: ${next.length > 0 ? next.map((id) => `<#${id}>`).join(" ") : "なし"}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}
