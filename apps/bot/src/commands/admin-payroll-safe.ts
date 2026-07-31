import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} from "discord.js";
import type { ExecutionReport, PayoutPlan, PayoutRunRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";
import { handleAdminButton as handleAdminButtonBase } from "./admin-hub.js";

export { handleAdminCommand, handleAdminModal, handleAdminSelect } from "./admin-hub.js";

const PAYROLL_PREFIX = "mgmt:payroll:";

function jstPeriod(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("JSTの対象月を計算できませんでした");
  return `${year}-${month}`;
}

function planHash(run: PayoutRunRow): string {
  return createHash("sha256").update(run.plan_json).digest("hex").slice(0, 12);
}

function reportOf(run: PayoutRunRow): ExecutionReport | undefined {
  if (!run.report_json) return undefined;
  try {
    return JSON.parse(run.report_json) as ExecutionReport;
  } catch {
    return undefined;
  }
}

function payrollBackRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("← 給与へ").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:hub").setLabel("管理ハブ").setStyle(ButtonStyle.Secondary),
  );
}

function statusLabel(run: PayoutRunRow | undefined): string {
  if (!run) return "未作成";
  const labels: Record<PayoutRunRow["status"], string> = {
    draft: "支給案作成済み・未承認",
    approved: "承認済み・実行待ち",
    executed: "実行済み",
    cancelled: "見送り済み",
  };
  return `#${run.id} ${labels[run.status]}`;
}

function payrollHome(services: Services) {
  const rows = services.payroll.listSalaries();
  const period = jstPeriod();
  const run = services.payroll.getRunByPeriod(period);
  const previousReport = run ? reportOf(run) : undefined;
  const salaryLines = rows.length
    ? rows.map((row) => `・<@&${row.role_id}> **${row.label}**: ${fmtLd(row.amount)}`).join("\n")
    : "（給与表は空）";
  const description = [
    `**対象月（JST）:** \`${period}\``,
    `**支給状態:** ${statusLabel(run)}`,
    "",
    "**給与表**（ロールごとに月額を設定）",
    salaryLines,
    "",
    "支給ボタンでは送金せず、現在のロールから対象者・内訳・総額を計算します。",
    "確認後にだけ支給し、部分失敗時は同じRunから未払い分だけ再実行できます。",
  ];
  if (previousReport?.failed.length) {
    description.push("", `⚠️ 前回実行で **${previousReport.failed.length}件** が未払いです。`);
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:payroll:add-start").setLabel("行追加").setEmoji("➕").setStyle(ButtonStyle.Primary),
  );
  if (!run || run.status === "draft") {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId("mgmt:payroll:pay")
        .setLabel(`${period} 支給案を確認`)
        .setEmoji("🔎")
        .setStyle(ButtonStyle.Success)
        .setDisabled(rows.length === 0),
    );
  } else if (run.status === "approved") {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:retry:${run.id}`)
        .setLabel("承認済み支給を再開")
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Success),
    );
  } else if (run.status === "executed" && previousReport?.failed.length) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:retry:${run.id}`)
        .setLabel("未払い分を再実行")
        .setEmoji("🔁")
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId("mgmt:payroll:done")
        .setLabel(run.status === "cancelled" ? "今月は見送り済み" : "今月は支給済み")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [buttons];
  if (rows.length) {
    const remove = new StringSelectMenuBuilder()
      .setCustomId("mgmt:payroll:remove-pick")
      .setPlaceholder("削除する行を選ぶ")
      .addOptions(
        rows.slice(0, 25).map((row) => ({
          label: `${row.label}: ${row.amount.toLocaleString("ja-JP")}`.slice(0, 100),
          value: row.role_id,
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(remove));
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mgmt:hub").setLabel("← ハブへ").setStyle(ButtonStyle.Secondary),
    ),
  );
  return {
    embeds: [new EmbedBuilder().setTitle("💰 給与").setColor(0x6b21a8).setDescription(description.join("\n"))],
    components,
  };
}

function safeText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}

function previewText(plan: PayoutPlan, runId: number, displayNames: ReadonlyMap<string, string>): string {
  const lines = [
    `${plan.period} 給与支給案 (#${runId})`,
    `対象者数: ${plan.items.length}`,
    `支給総額: ${plan.totalPayout}`,
    "",
    "user_id\tdisplay_name\ttotal\tbreakdown",
  ];
  for (const item of [...plan.items].sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))) {
    const breakdown = item.breakdown
      .map((part) => `${safeText(part.label)}[${part.roleId}]=${part.amount}`)
      .join(" + ");
    lines.push(
      [item.userId, safeText(displayNames.get(item.userId) ?? "取得不能"), String(item.total), breakdown].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function previewEmbed(plan: PayoutPlan, runId: number): EmbedBuilder {
  const top = [...plan.items]
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .slice(0, 15)
    .map((item) => `<@${item.userId}> — **${fmtLd(item.total)}**（${item.breakdown.map((part) => part.label).join(" + ")}）`);
  const rest = plan.items.length - top.length;
  return new EmbedBuilder()
    .setTitle(`🔎 ${plan.period} 給与支給案 (#${runId})`)
    .setColor(0xd97706)
    .setDescription(
      [
        `対象: **${plan.items.length}名** / 総額: **${fmtLd(plan.totalPayout)}**`,
        "この画面ではまだ送金していません。添付テキストに全対象者・金額・ロール内訳があります。",
        "",
        ...top,
        rest > 0 ? `…他 ${rest}名（添付を確認）` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
}

function failureLines(report: ExecutionReport): string[] {
  return report.failed.map((failure) => {
    const details = Object.entries(failure.details)
      .slice(0, 4)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    return `・<@${failure.userId}> — \`${failure.code}\`${details ? `（${details}）` : ""}`;
  });
}

function executionResult(run: PayoutRunRow, report: ExecutionReport, moneySupply: number) {
  const lines = [
    `**対象月:** \`${run.period}\` / **Run:** #${run.id}`,
    `成功 **${report.succeeded}件** / 支給済みスキップ **${report.skippedAsPaid}件** / 失敗 **${report.failed.length}件**`,
    `今回の支給額: **${fmtLd(report.totalPaid)}** / 通貨発行残高: ${fmtLd(moneySupply)}`,
  ];
  if (report.failed.length) lines.push("", "**未払い・失敗理由**", ...failureLines(report));
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (report.failed.length) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:payroll:retry:${run.id}`)
          .setLabel("未払い分だけ再実行")
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }
  components.push(payrollBackRow());
  return {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle(report.failed.length ? "⚠️ 給与支給は一部未完了" : "✅ 給与支給完了")
        .setColor(report.failed.length ? 0xdc2626 : 0x16a34a)
        .setDescription(lines.join("\n")),
    ],
    components,
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

function existingRunMessage(run: PayoutRunRow, services: Services) {
  const plan = services.payroll.planOf(run);
  const report = reportOf(run);
  const lines = [
    `**対象月:** \`${run.period}\` / **Run:** #${run.id}`,
    `状態: **${statusLabel(run)}**`,
    `計画: **${plan.items.length}名** / **${fmtLd(plan.totalPayout)}**`,
  ];
  if (report) {
    lines.push(`直近実行: 成功 ${report.succeeded}件 / 支給済みスキップ ${report.skippedAsPaid}件 / 失敗 ${report.failed.length}件`);
  }
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (run.status === "approved" || (run.status === "executed" && report?.failed.length)) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:payroll:retry:${run.id}`)
          .setLabel(run.status === "approved" ? "支給を再開" : "未払い分だけ再実行")
          .setStyle(run.status === "approved" ? ButtonStyle.Success : ButtonStyle.Danger),
      ),
    );
  }
  components.push(payrollBackRow());
  return {
    content: "",
    embeds: [new EmbedBuilder().setTitle("💰 既存の給与Run").setColor(0x6b21a8).setDescription(lines.join("\n"))],
    components,
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

async function showPayrollError(interaction: ButtonInteraction, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "不明なエラー";
  await interaction.editReply({
    content: `❌ 給与処理に失敗しました: ${message}`,
    embeds: [],
    components: [payrollBackRow()],
    attachments: [],
    allowedMentions: { parse: [] },
  });
}

async function previewPayroll(interaction: ButtonInteraction, services: Services): Promise<void> {
  await interaction.deferUpdate();
  const period = jstPeriod();
  try {
    const existing = services.payroll.getRunByPeriod(period);
    if (existing && existing.status !== "draft") {
      await interaction.editReply(existingRunMessage(existing, services));
      return;
    }
    const guild = interaction.guild;
    if (!guild) throw new Error("ギルド情報を取得できませんでした");
    const fetched = await guild.members.fetch();
    const humans = fetched.filter((member) => !member.user.bot);
    const members = humans.map((member) => ({ userId: member.id, roleIds: [...member.roles.cache.keys()] }));
    const displayNames = new Map(humans.map((member) => [member.id, member.displayName]));
    const run = services.payroll.generateDraft(period, members, `user:${interaction.user.id}`);
    const plan = services.payroll.planOf(run);
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:confirm:${run.id}:${planHash(run)}`)
        .setLabel("この内容で支給")
        .setEmoji("💸")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("mgmt:payroll:pay")
        .setLabel("現在のロールで再集計")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
      content: "",
      embeds: [previewEmbed(plan, run.id)],
      components: [controls, payrollBackRow()],
      files: [
        {
          attachment: Buffer.from(previewText(plan, run.id, displayNames), "utf8"),
          name: `salary-preview-${plan.period}-run-${run.id}.txt`,
        },
      ],
      attachments: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await showPayrollError(interaction, error);
  }
}

async function confirmPayroll(
  interaction: ButtonInteraction,
  services: Services,
  runId: number,
  expectedHash: string,
): Promise<void> {
  await interaction.deferUpdate();
  try {
    let run = services.payroll.getRun(runId);
    if (run.status === "executed" || run.status === "cancelled") {
      await interaction.editReply(existingRunMessage(run, services));
      return;
    }
    if (run.status === "draft") {
      if (planHash(run) !== expectedHash) {
        await interaction.editReply({
          content: "⚠️ 支給案が別操作で更新されています。給与画面へ戻り、最新内容をもう一度確認してください。",
          embeds: [],
          components: [payrollBackRow()],
          attachments: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      run = services.payroll.approve(runId, `user:${interaction.user.id}`);
    }
    if (run.status !== "approved") throw new Error(`このRunは実行できません（状態: ${run.status}）`);
    const report = services.payroll.execute(runId, `user:${interaction.user.id}`);
    run = services.payroll.getRun(runId);
    await interaction.editReply(executionResult(run, report, services.ledger.moneySupply()));
  } catch (error) {
    await showPayrollError(interaction, error);
  }
}

async function retryPayroll(interaction: ButtonInteraction, services: Services, runId: number): Promise<void> {
  await interaction.deferUpdate();
  try {
    const before = services.payroll.getRun(runId);
    if (before.status !== "approved" && before.status !== "executed") {
      throw new Error(`このRunは再実行できません（状態: ${before.status}）`);
    }
    const report = services.payroll.execute(runId, `user:${interaction.user.id}`);
    const after = services.payroll.getRun(runId);
    await interaction.editReply(executionResult(after, report, services.ledger.moneySupply()));
  } catch (error) {
    await showPayrollError(interaction, error);
  }
}

/** /管理 の給与部分だけを安全な二段階操作へ差し替え、それ以外は既存実装へ委譲する。 */
export async function handleAdminButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!interaction.customId.startsWith(PAYROLL_PREFIX) && interaction.customId !== "mgmt:payroll") {
    await handleAdminButtonBase(interaction, services);
    return;
  }
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const [, section, action, rawRunId, expectedHash] = interaction.customId.split(":");
  if (section !== "payroll") {
    await handleAdminButtonBase(interaction, services);
  } else if (!action) {
    await interaction.update(payrollHome(services));
  } else if (action === "pay") {
    await previewPayroll(interaction, services);
  } else if (action === "confirm") {
    const runId = Number(rawRunId);
    if (!Number.isSafeInteger(runId) || !expectedHash) {
      await interaction.reply({ content: "支給案の識別子が不正です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await confirmPayroll(interaction, services, runId, expectedHash);
  } else if (action === "retry") {
    const runId = Number(rawRunId);
    if (!Number.isSafeInteger(runId)) {
      await interaction.reply({ content: "給与Runの識別子が不正です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await retryPayroll(interaction, services, runId);
  } else {
    await handleAdminButtonBase(interaction, services);
  }
}
