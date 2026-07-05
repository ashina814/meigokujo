import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { LedgerError, TREASURY } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * 運営調整（経済設計.md: adjust=最終手段、fine=罰金）。理由必須・監査ログ行き。
 */
export const adjustCommand = new SlashCommandBuilder()
  .setName("調整")
  .setDescription("Land の発行・回収・罰金（運営専用）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o
      .setName("種別")
      .setDescription("操作の種類")
      .setRequired(true)
      .addChoices(
        { name: "発行（国庫 → 対象者）", value: "issue" },
        { name: "回収（対象者 → 国庫）", value: "collect" },
        { name: "罰金（対象者 → 国庫・公示なし）", value: "fine" },
      ),
  )
  .addUserOption((o) => o.setName("対象").setDescription("対象者").setRequired(true))
  .addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1))
  .addStringOption((o) => o.setName("理由").setDescription("必須。監査ログに残ります").setRequired(true).setMaxLength(200));

export async function handleAdjust(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const kind = interaction.options.getString("種別", true);
  const target = interaction.options.getUser("対象", true);
  const amount = interaction.options.getInteger("金額", true);
  const reason = interaction.options.getString("理由", true);

  if (target.bot) {
    await interaction.reply({ content: "Bot の口座は操作できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const account = `user:${target.id}`;
  services.ledger.ensureAccount(account, "user");
  const actor = `user:${interaction.user.id}`;

  const [from, to, type] =
    kind === "issue"
      ? [TREASURY, account, "adjust"]
      : kind === "fine"
        ? [account, TREASURY, "fine"]
        : [account, TREASURY, "adjust"];

  try {
    const result = services.ledger.transfer({
      from,
      to,
      amount,
      type,
      actor,
      reason,
      idempotencyKey: `adjust:${interaction.id}`,
      approvedBy: actor, // 運営操作なので高額承認は実行者=承認者として通す（監査ログで追える）
    });
    const label = kind === "issue" ? "発行" : kind === "fine" ? "罰金" : "回収";
    await interaction.reply({
      content: [
        `✅ ${label}: <@${target.id}> ${kind === "issue" ? "＋" : "−"}**${fmtLd(amount)}**（tx#${result.tx.id}）`,
        `対象者の残高: ${fmtLd(services.ledger.balanceOf(account))} / 通貨発行残高: ${fmtLd(services.ledger.moneySupply())}`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    const err = e as LedgerError;
    const message =
      err instanceof LedgerError && err.code === "ERR_INSUFFICIENT"
        ? `対象者の残高が足りません（所持: ${fmtLd(Number(err.details.balance))} / 必要: ${fmtLd(Number(err.details.required))}）。`
        : `台帳エラー: ${err instanceof LedgerError ? err.code : "不明"}`;
    await interaction.reply({ content: `❌ ${message}`, flags: MessageFlags.Ephemeral });
  }
}
