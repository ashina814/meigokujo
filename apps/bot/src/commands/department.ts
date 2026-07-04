import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from "discord.js";
import { DepartmentError, LedgerError } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * 部署口座（経済設計.md §5）。業務資金を個人残高から分離する `sys:dept:*` を運用する。
 * 作成・削除は運営、入金・出金・歩合はその部署の担当ロール保持者（＋運営）。
 */
export const departmentCommand = new SlashCommandBuilder()
  .setName("部署")
  .setDescription("部署口座の管理（業務資金）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("作成")
      .setDescription("部署を作成／担当ロールを更新（運営）")
      .addStringOption((o) => o.setName("名前").setDescription("部署名（例: 賭博場）").setRequired(true).setMaxLength(40))
      .addRoleOption((o) => o.setName("担当ロール").setDescription("入出金できる部署員ロール").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("削除")
      .setDescription("部署を削除（残高0のときのみ・運営）")
      .addStringOption((o) => o.setName("部署").setDescription("削除する部署").setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) => sub.setName("一覧").setDescription("部署と残高の一覧"))
  .addSubcommand((sub) =>
    sub
      .setName("入金")
      .setDescription("自分の所持から部署口座へ入れる（売上・原資積み立て）")
      .addStringOption((o) => o.setName("部署").setDescription("入金先の部署").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("理由").setDescription("任意メモ").setMaxLength(200)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("出金")
      .setDescription("部署口座から住人へ払い戻す（釣り銭・賞金など）")
      .addStringOption((o) => o.setName("部署").setDescription("出金元の部署").setRequired(true).setAutocomplete(true))
      .addUserOption((o) => o.setName("対象").setDescription("受取る住人").setRequired(true))
      .addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("理由").setDescription("必須。監査ログに残ります").setRequired(true).setMaxLength(200)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("歩合")
      .setDescription("部署口座から従業員へ歩合を支給")
      .addStringOption((o) => o.setName("部署").setDescription("原資の部署").setRequired(true).setAutocomplete(true))
      .addUserOption((o) => o.setName("対象").setDescription("支給する従業員").setRequired(true))
      .addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("理由").setDescription("任意メモ（例: 7月分歩合）").setMaxLength(200)),
  );

function memberRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const member = interaction.member as GuildMember | null;
  return member ? [...member.roles.cache.keys()] : [];
}

/** その部署を操作できるか（運営 or 担当ロール保持者） */
function canOperate(interaction: ChatInputCommandInteraction, services: Services, key: string): boolean {
  if (isAdmin(interaction, services)) return true;
  return services.departments.canOperate(key, memberRoleIds(interaction));
}

export async function handleDepartment(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const actor = `user:${interaction.user.id}`;

  if (sub === "一覧") {
    const rows = services.departments.listWithBalance();
    const embed = new EmbedBuilder()
      .setTitle("🏦 部署口座")
      .setColor(0x6b21a8)
      .setDescription(
        rows.length > 0
          ? rows
              .map((d) => `**${d.name}** — ${fmtLd(d.balance)}${d.role_id ? `　担当 <@&${d.role_id}>` : "　担当未設定"}`)
              .join("\n")
          : "まだ部署がありません。`/部署 作成` で登録してください。",
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  // ここから先は 作成/削除 は運営、入金/出金/歩合 は担当ロール（＋運営）
  if (sub === "作成") {
    if (!isAdmin(interaction, services)) {
      await interaction.reply({ content: "部署の作成には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.options.getString("名前", true);
    const role = interaction.options.getRole("担当ロール", true);
    try {
      const dept = services.departments.upsert(name, name, role.id);
      await interaction.reply({
        content: `✅ 部署「**${dept.name}**」を用意しました（担当 <@&${role.id}>）。口座残高: ${fmtLd(services.departments.balanceOf(dept.key))}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      const msg = e instanceof DepartmentError && e.code === "ERR_DEPT_BAD_KEY" ? "部署名に「:」は使えません。" : "作成に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (sub === "削除") {
    if (!isAdmin(interaction, services)) {
      await interaction.reply({ content: "部署の削除には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const key = interaction.options.getString("部署", true);
    try {
      services.departments.remove(key);
      await interaction.reply({ content: `✅ 部署「${key}」を削除しました。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      const msg =
        e instanceof DepartmentError && e.code === "ERR_DEPT_HAS_BALANCE"
          ? `残高が残っています（${fmtLd(services.departments.balanceOf(key))}）。先に出金してから削除してください。`
          : e instanceof DepartmentError && e.code === "ERR_DEPT_NOT_FOUND"
            ? "その部署は見つかりません。"
            : "削除に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // 入金 / 出金 / 歩合
  const key = interaction.options.getString("部署", true);
  const dept = services.departments.get(key);
  if (!dept) {
    await interaction.reply({ content: "その部署は見つかりません。`/部署 一覧` で確認してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canOperate(interaction, services, key)) {
    await interaction.reply({
      content: `この操作には「${dept.name}」の担当ロール${dept.role_id ? ` <@&${dept.role_id}>` : ""} か管理権限が必要です。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const amount = interaction.options.getInteger("金額", true);
  const reason = interaction.options.getString("理由") ?? undefined;

  try {
    if (sub === "入金") {
      services.ledger.ensureAccount(actor, "user");
      const result = services.departments.deposit(interaction.user.id, {
        key,
        amount,
        actor,
        reason,
        idempotencyKey: `deptin:${interaction.id}`,
        approvedBy: actor, // 部署員の業務操作として通す（監査で追える）
      });
      await interaction.reply({
        content: `✅ 「${dept.name}」へ入金しました: <@${interaction.user.id}> −**${fmtLd(amount)}**（tx#${result.tx.id}）\n部署残高: ${fmtLd(services.departments.balanceOf(key))}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const target = interaction.options.getUser("対象", true);
    if (target.bot) {
      await interaction.reply({ content: "Bot は対象にできません。", flags: MessageFlags.Ephemeral });
      return;
    }
    services.ledger.ensureAccount(`user:${target.id}`, "user");
    const common = { key, amount, actor, reason, approvedBy: actor };

    if (sub === "出金") {
      const result = services.departments.withdraw(target.id, { ...common, idempotencyKey: `deptout:${interaction.id}` });
      await interaction.reply({
        content: `✅ 「${dept.name}」から払い戻し: <@${target.id}> ＋**${fmtLd(amount)}**（tx#${result.tx.id}）\n部署残高: ${fmtLd(services.departments.balanceOf(key))}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === "歩合") {
      const result = services.departments.payCommission(target.id, { ...common, idempotencyKey: `comm:${interaction.id}` });
      await interaction.reply({
        content: `✅ 「${dept.name}」から歩合を支給: <@${target.id}> ＋**${fmtLd(amount)}**（tx#${result.tx.id}）\n部署残高: ${fmtLd(services.departments.balanceOf(key))}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  } catch (e) {
    let msg = "処理に失敗しました。";
    if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") {
      const who = sub === "入金" ? "所持" : "部署の残高";
      msg = `${who}が足りません（残高: ${fmtLd(Number(e.details.balance))} / 必要: ${fmtLd(Number(e.details.required))}）。`;
    } else if (e instanceof LedgerError) {
      msg = `台帳エラー: ${e.code}`;
    }
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

/** 「部署」オプションのオートコンプリート（部署名で絞り込み、value=key） */
export async function handleDepartmentAutocomplete(
  interaction: AutocompleteInteraction,
  services: Services,
): Promise<void> {
  const focused = interaction.options.getFocused().toString().toLowerCase();
  const choices = services.departments
    .list()
    .filter((d) => !focused || d.name.toLowerCase().includes(focused) || d.key.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((d) => ({ name: d.name, value: d.key }));
  await interaction.respond(choices).catch(() => undefined);
}
