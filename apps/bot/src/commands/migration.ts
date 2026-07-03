import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import {
  MigrationError,
  parseBalanceDump,
  type MemberNameInfo,
  type StagingStatus,
} from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

export const migrationCommand = new SlashCommandBuilder()
  .setName("移行")
  .setDescription("旧ボット残高の一括移行（運営専用）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("取込")
      .setDescription("残高ダンプ（テキストファイル）を取り込んでメンバー照合する")
      .addAttachmentOption((o) => o.setName("ファイル").setDescription("ランキング形式の .txt").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("状況").setDescription("移行の進捗サマリー"))
  .addSubcommand((sub) =>
    sub
      .setName("一覧")
      .setDescription("要対応の行を表示")
      .addStringOption((o) =>
        o
          .setName("種別")
          .setDescription("表示する種別")
          .setRequired(true)
          .addChoices(
            { name: "未照合（該当メンバーなし）", value: "unmatched" },
            { name: "同名衝突", value: "ambiguous" },
            { name: "キャップ超過", value: "over_cap" },
            { name: "実行待ち（割当・承認済み）", value: "ready" },
            { name: "除外済み", value: "excluded" },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("割当")
      .setDescription("未照合・同名衝突の行にメンバーを割り当てる")
      .addIntegerOption((o) => o.setName("番号").setDescription("ダンプの順位番号").setRequired(true))
      .addUserOption((o) => o.setName("相手").setDescription("割り当てるメンバー").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("承認")
      .setDescription("キャップ超過の行を運営判断で通す")
      .addIntegerOption((o) => o.setName("番号").setDescription("ダンプの順位番号").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("除外")
      .setDescription("行を移行対象から外す（退去者・管理者残高など）")
      .addIntegerOption((o) => o.setName("番号").setDescription("ダンプの順位番号").setRequired(true))
      .addStringOption((o) => o.setName("理由").setDescription("記録用").setMaxLength(100)),
  )
  .addSubcommand((sub) => sub.setName("実行").setDescription("照合済みの行を一括 opening 発行する"));

function statusLabel(s: StagingStatus): string {
  return (
    {
      auto: "自動実行可",
      ambiguous: "同名衝突",
      over_cap: "キャップ超過",
      unmatched: "未照合",
      ready: "実行待ち",
      done: "発行済み",
      excluded: "除外",
    } as const
  )[s];
}

export async function handleMigration(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand();
  const actor = `user:${interaction.user.id}`;

  if (sub === "取込") {
    const file = interaction.options.getAttachment("ファイル", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const text = await fetch(file.url).then((r) => r.text());
    const dump = parseBalanceDump(text);

    const guild = interaction.guild;
    if (!guild) return;
    const membersCol = await guild.members.fetch();
    const members: MemberNameInfo[] = membersCol
      .filter((m) => !m.user.bot)
      .map((m) => ({
        userId: m.id,
        names: [m.displayName, m.user.username, m.user.globalName].filter(
          (n): n is string => typeof n === "string" && n.length > 0,
        ),
      }));

    const cap = services.settings.getNumber("migration_cap");
    const summary = services.migration.import(dump, members, cap);

    const issueLines = dump.issues.slice(0, 8).map((i) => `・${i.reason}: ${i.line.slice(0, 60)}`);
    const embed = new EmbedBuilder()
      .setTitle("📦 移行ダンプ取込 完了")
      .setDescription(
        [
          `取込 **${summary.staged}行** / パース不能・要手動 **${summary.issues}行**`,
          "",
          `✅ 自動実行可: **${summary.auto}**`,
          `⚠️ 同名衝突: **${summary.ambiguous}** → \`/移行 割当\``,
          `💰 キャップ超過（>${fmtLd(cap)}）: **${summary.overCap}** → \`/移行 承認\` か \`/移行 除外\``,
          `❓ 未照合: **${summary.unmatched}** → \`/移行 割当\` か \`/移行 除外\``,
          "",
          issueLines.length > 0 ? "パース不能行:\n" + issueLines.join("\n") : "",
          "準備ができたら `/移行 実行`（何度実行しても二重発行はされません）",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setColor(0x6b21a8);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "状況") {
    const c = services.migration.counts();
    await interaction.reply({
      content: [
        "📦 移行の進捗:",
        `発行済み **${c.done}** / 自動実行可 **${c.auto}** / 実行待ち **${c.ready}**`,
        `要対応 → 同名衝突 **${c.ambiguous}** / キャップ超過 **${c.over_cap}** / 未照合 **${c.unmatched}**`,
        `除外 **${c.excluded}**`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "一覧") {
    const status = interaction.options.getString("種別", true) as StagingStatus;
    const rows = services.migration.list(status).slice(0, 20);
    const lines =
      rows.length > 0
        ? rows.map(
            (r) =>
              `\`${String(r.rank).padStart(3)}\` ${r.display_name}: **${fmtLd(r.amount)}**` +
              (r.user_id ? ` → <@${r.user_id}>` : "") +
              (r.note ? `（${r.note}）` : ""),
          )
        : ["該当なし"];
    await interaction.reply({
      content: `📋 ${statusLabel(status)}（最大20件）:\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    if (sub === "割当") {
      const rank = interaction.options.getInteger("番号", true);
      const target = interaction.options.getUser("相手", true);
      const row = services.migration.assign(rank, target.id, actor);
      await interaction.reply({
        content: `✅ ${rank}位「${row.display_name}」（${fmtLd(row.amount)}）を <@${target.id}> に割り当てました。実行待ちです。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (sub === "承認") {
      const rank = interaction.options.getInteger("番号", true);
      const row = services.migration.approve(rank, actor);
      await interaction.reply({
        content: `✅ ${rank}位「${row.display_name}」（${fmtLd(row.amount)}）のキャップ超過を承認しました。実行待ちです。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (sub === "除外") {
      const rank = interaction.options.getInteger("番号", true);
      const reason = interaction.options.getString("理由") ?? undefined;
      const row = services.migration.exclude(rank, actor, reason);
      await interaction.reply({
        content: `✅ ${rank}位「${row.display_name}」を移行対象から外しました。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (e) {
    if (e instanceof MigrationError) {
      const msg =
        e.code === "ERR_ROW_NOT_FOUND"
          ? "その番号の行がありません。`/移行 一覧` で確認してください。"
          : e.code === "ERR_BAD_STATUS"
            ? `その行は現在の状態では操作できません（${JSON.stringify(e.details)}）。`
            : "対象ユーザーが未割当です。先に `/移行 割当` してください。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
      return;
    }
    throw e;
  }

  if (sub === "実行") {
    const c = services.migration.counts();
    const targets = c.auto + c.ready;
    if (targets === 0) {
      await interaction.reply({
        content: "実行対象がありません。`/移行 取込` から始めてください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mig:run").setLabel(`${targets}件を発行する`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("mig:cancel").setLabel("やめる").setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: `⚠️ **${targets}件** の opening 発行を実行します。よろしいですか？（冪等なので誤って2回押しても二重発行はされません）`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleMigrationButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) return;
  if (interaction.customId === "mig:cancel") {
    await interaction.update({ content: "実行をやめました。", components: [] });
    return;
  }
  if (interaction.customId !== "mig:run") return;

  await interaction.update({ content: "⏳ 発行中…", components: [] });
  const report = services.migration.execute(`user:${interaction.user.id}`);
  const lines = [
    `✅ 移行実行: 発行 **${report.succeeded}件** / 発行済みスキップ ${report.skippedAsPaid}件 / 失敗 ${report.failed.length}件`,
    `発行総額: **${fmtLd(report.totalIssued)}** / 通貨発行残高: ${fmtLd(services.ledger.moneySupply())}`,
    report.remaining > 0 ? `⚠️ 要対応の残り: **${report.remaining}件**（\`/移行 状況\` で確認）` : "🎉 要対応はすべて処理済みです。",
  ];
  if (report.failed.length > 0) {
    lines.push("失敗: " + report.failed.map((f) => `${f.rank}位（${f.code}）`).join(", "));
  }
  await interaction.editReply({ content: lines.join("\n") });
}
