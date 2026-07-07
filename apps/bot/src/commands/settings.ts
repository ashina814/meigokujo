import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  PermissionFlagsBits,
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
  ["session_vc2", "説明会場VC（2つ目）"],
  ["eval_forum", "評価フォーラム"],
  ["shurei", "集令"],
  ["announce", "昇格のお知らせ"],
  ["recruit", "蜜月の募集掲示"],
  ["casino", "カジノ（設定するとゲームはそこ限定）"],
] as const;

/** ロール割当の種別（role:<kind> に保存） */
export const ROLE_KINDS = [
  ["queue_wait", "入城案内待ち"],
  ["ghost", "亡霊"],
  ["meirei", "迷霊"],
  ["majin", "魔人"],
  ["mazoku", "魔族"],
  ["bump_notify", "紹介協力者"],
  ["judge", "門番"],
  ["judge_lead", "門番統括"],
  ["judge_extra", "門番（予備）"],
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
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
  )
  .addSubcommand((sub) =>
    sub
      .setName("巣穴")
      .setDescription("冥獣の巣（評価VC）のカテゴリとトリガーVCを設定")
      .addChannelOption((o) => o.setName("カテゴリ").setDescription("複製先の巣穴カテゴリ").addChannelTypes(ChannelType.GuildCategory))
      .addChannelOption((o) => o.setName("巣穴大").setDescription("入ると増えるトリガーVC（全員可）").addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName("巣穴中").setDescription("トリガーVC（魔剣士・審のみ）").addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName("巣穴小").setDescription("トリガーVC（魔剣士・審のみ）").addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName("応接室").setDescription("トリガーVC（魔剣士・審のみ・2人・報酬対象外）").addChannelTypes(ChannelType.GuildVoice)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("位階")
      .setDescription("累計VC時間で上がる位階ロールのラダーを編集")
      .addStringOption((o) =>
        o.setName("操作").setDescription("何をするか").setRequired(true).addChoices({ name: "追加/更新", value: "add" }, { name: "削除", value: "remove" }, { name: "表示", value: "show" }),
      )
      .addRoleOption((o) => o.setName("ロール").setDescription("位階ロール（追加/削除時）"))
      .addNumberOption((o) => o.setName("時間").setDescription("この累計VC時間(h)以上で付与（追加時）").setMinValue(0)),
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
    const denLines = (
      [
        ["category:eval_den", "カテゴリ"],
        ["vc:den_large", "巣穴大"],
        ["vc:den_medium", "巣穴中"],
        ["vc:den_small", "巣穴小"],
        ["vc:den_reception", "応接室"],
      ] as const
    ).map(([key, label]) => {
      const id = services.settings.getString(key);
      return `${label}: ${id ? `<#${id}>` : "未設定"}`;
    });
    const ladder = services.settings.getJson<Array<{ hours: number; roleId: string }>>("vc_rank_ladder", []);
    const ladderLine =
      ladder.length > 0
        ? [...ladder].sort((a, b) => a.hours - b.hours).map((t) => `${t.hours}h→<@&${t.roleId}>`).join(" / ")
        : "未設定";
    const embed = new EmbedBuilder()
      .setTitle("⚙️ 冥獄城ボット 設定")
      .addFields(
        { name: "チャンネル割当", value: channelLines.join("\n") },
        { name: "管理ロール", value: adminRoleId ? `<@&${adminRoleId}>` : "未設定（OWNERのみ）" },
        { name: "巣穴（評価VC）", value: denLines.join("\n") },
        { name: "位階ラダー", value: ladderLine },
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

  if (sub === "位階") {
    const op = interaction.options.getString("操作", true);
    const ladder = services.settings.getJson<Array<{ hours: number; roleId: string }>>("vc_rank_ladder", []);
    if (op === "show") {
      const sorted = [...ladder].sort((a, b) => a.hours - b.hours);
      await interaction.reply({
        content: sorted.length > 0 ? `📶 位階ラダー（累計VC時間→ロール）:\n${sorted.map((t) => `・${t.hours}h → <@&${t.roleId}>`).join("\n")}` : "位階ラダーは未設定です。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const role = interaction.options.getRole("ロール");
    if (!role) {
      await interaction.reply({ content: "ロールを指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    let next = ladder.filter((t) => t.roleId !== role.id);
    if (op === "add") {
      const hours = interaction.options.getNumber("時間");
      if (hours === null) {
        await interaction.reply({ content: "追加時は「時間」も指定してください。", flags: MessageFlags.Ephemeral });
        return;
      }
      next = [...next, { hours, roleId: role.id }];
    }
    services.settings.set("vc_rank_ladder", next, actor);
    await interaction.reply({
      content: `✅ 位階ラダーを更新しました（${next.length}段）。反映は次回の判定（毎朝6時）から。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "巣穴") {
    const map: Array<[string, string]> = [
      ["カテゴリ", "category:eval_den"],
      ["巣穴大", "vc:den_large"],
      ["巣穴中", "vc:den_medium"],
      ["巣穴小", "vc:den_small"],
      ["応接室", "vc:den_reception"],
    ];
    const done: string[] = [];
    for (const [opt, keyName] of map) {
      const ch = interaction.options.getChannel(opt);
      if (ch) {
        services.settings.set(keyName, ch.id, actor);
        done.push(`${opt}→<#${ch.id}>`);
      }
    }
    await interaction.reply({
      content: done.length > 0 ? `✅ 巣穴設定を更新: ${done.join(" / ")}` : "更新する項目を1つ以上指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}
