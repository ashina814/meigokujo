import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type TextChannel,
  PermissionFlagsBits,
} from "discord.js";
import { FiscalError, type FiscalPlan, type FiscalRunRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { jstNow } from "../scheduler.js";
import type { Services } from "../services.js";

export const taxCommand = new SlashCommandBuilder()
  .setName("冥府税")
  .setDescription("高額残高への課税案を作り #決裁 に出す（運営）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((o) => o.setName("控除下限").setDescription("この残高までは非課税（既定100万）").setMinValue(0))
  .addIntegerOption((o) => o.setName("税率").setDescription("超過分への税率％（既定5）").setMinValue(1).setMaxValue(90));

export const pensionCommand = new SlashCommandBuilder()
  .setName("年金")
  .setDescription("在城の長い魂へ年金を給付する案を #決裁 に出す（運営）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((o) => o.setName("在城日数").setDescription("この日数を超えた魂が対象（既定365）").setMinValue(1))
  .addIntegerOption((o) => o.setName("金額").setDescription("1人あたりの給付額（既定50,000）").setMinValue(1));

function planEmbed(plan: FiscalPlan, run: FiscalRunRow): EmbedBuilder {
  const isTax = plan.kind === "tax";
  const top = plan.items
    .slice(0, 15)
    .map((i) => `<@${i.userId}> — **${isTax ? "−" : "＋"}${fmtLd(i.amount)}**（${i.detail}）`);
  const rest = plan.items.length - top.length;
  const paramLine = isTax
    ? `控除下限 ${fmtLd(plan.params.threshold ?? 0)} / 税率 ${(plan.params.rateBps ?? 0) / 100}%`
    : `在城 ${plan.params.minDays ?? 0}日超 / 1人 ${fmtLd(plan.params.amount ?? 0)}`;
  return new EmbedBuilder()
    .setTitle(`${isTax ? "🪙 冥府税" : "🕊 魂の年金"} ${plan.period}（案 #${run.id}）`)
    .setColor(isTax ? 0x9333ea : 0x0ea5e9)
    .setDescription(
      [
        `対象 **${plan.items.length}名** / 総額 **${fmtLd(plan.total)}**（${isTax ? "国庫へ回収" : "国庫から発行"}）`,
        paramLine,
        "",
        ...top,
        rest > 0 ? `…他 ${rest} 名` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
}

async function postDraft(interaction: ChatInputCommandInteraction, services: Services, run: FiscalRunRow): Promise<void> {
  const plan = services.fiscal.planOf(run);
  const kessaiId = services.settings.getString("channel:kessai");
  const kessai = kessaiId ? ((await interaction.client.channels.fetch(kessaiId).catch(() => null)) as TextChannel | null) : null;
  if (!kessai?.isTextBased()) {
    await interaction.reply({ content: "#決裁 チャンネルが未設定です。/設定 チャンネル から設定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const label = plan.kind === "tax" ? "承認して課税" : "承認して給付";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`fis:ok:${run.id}`).setLabel(label).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`fis:no:${run.id}`).setLabel("見送り").setStyle(ButtonStyle.Danger),
  );
  await kessai.send({ embeds: [planEmbed(plan, run)], components: [row], allowedMentions: { parse: [] } });
  await interaction.reply({ content: `✅ ${plan.kind === "tax" ? "冥府税" : "年金"}の案（対象 ${plan.items.length}名 / 総額 ${fmtLd(plan.total)}）を #決裁 に出しました。`, flags: MessageFlags.Ephemeral });
}

export async function handleTaxCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const threshold = interaction.options.getInteger("控除下限") ?? 1_000_000;
  const ratePct = interaction.options.getInteger("税率") ?? 5;
  const period = jstNow().period;
  try {
    const run = services.fiscal.generateTaxDraft(period, { threshold, rateBps: ratePct * 100 }, `user:${interaction.user.id}`);
    await postDraft(interaction, services, run);
  } catch (e) {
    await interaction.reply({ content: fiscalErrMsg(e, "tax", period), flags: MessageFlags.Ephemeral });
  }
}

export async function handlePensionCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const minDays = interaction.options.getInteger("在城日数") ?? 365;
  const amount = interaction.options.getInteger("金額") ?? 50_000;
  const period = jstNow().period;
  try {
    const run = services.fiscal.generatePensionDraft(period, { minDays, amount }, `user:${interaction.user.id}`);
    await postDraft(interaction, services, run);
  } catch (e) {
    await interaction.reply({ content: fiscalErrMsg(e, "pension", period), flags: MessageFlags.Ephemeral });
  }
}

function fiscalErrMsg(e: unknown, kind: "tax" | "pension", period: string): string {
  if (e instanceof FiscalError && e.code === "ERR_EMPTY_PLAN") return kind === "tax" ? "課税対象（控除下限を超える住人）がいません。" : "年金対象（在城日数を満たす魂）がいません。";
  if (e instanceof FiscalError && e.code === "ERR_INVALID_STATUS") return `${period} の${kind === "tax" ? "冥府税" : "年金"}は既に承認/実行済みです。`;
  return "案の作成に失敗しました。";
}

// ---- #決裁 の承認ボタン ----

export async function handleFiscalButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "承認は運営のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const runId = Number(parts[2]);
  if (!Number.isSafeInteger(runId)) return;
  const actor = `user:${interaction.user.id}`;

  if (action === "no") {
    try {
      services.fiscal.cancel(runId, actor);
    } catch (e) {
      await interaction.reply({ content: `処理できません: ${e instanceof FiscalError ? e.code : "不明"}`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({ embeds: interaction.message.embeds, components: [], content: `❌ <@${interaction.user.id}> が見送りました。` });
    return;
  }

  await interaction.update({ embeds: interaction.message.embeds, components: [], content: `⏳ <@${interaction.user.id}> が承認しました。実行中…` });
  try {
    const run = services.fiscal.get(runId);
    if (run.status === "draft") services.fiscal.approve(runId, actor);
    const report = services.fiscal.execute(runId, actor);
    const kind = services.fiscal.get(runId).kind;
    const verb = kind === "tax" ? "回収" : "給付";
    const lines = [
      `✅ ${kind === "tax" ? "冥府税" : "年金"}を実行しました（${verb} ${report.succeeded}名 / 計 ${fmtLd(report.total)}）。`,
      report.skippedAsDone > 0 ? `（実行済みスキップ: ${report.skippedAsDone}名）` : "",
      report.failed.length > 0 ? `⚠️ 失敗 ${report.failed.length}名（残高不足など）: ${report.failed.slice(0, 10).map((f) => `<@${f.userId}>`).join(", ")}` : "",
    ].filter(Boolean);
    await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
  } catch (e) {
    await interaction.editReply({ content: `❌ 実行に失敗しました: ${e instanceof FiscalError ? e.code : "不明"}` });
  }
}
