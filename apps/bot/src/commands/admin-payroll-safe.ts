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
import {
  isManualPayrollPeriod,
  jstPeriod,
  manualPayrollPeriods,
  planHash,
  reportOf,
  safeText,
  shorten,
} from "../payroll-ui-utils.js";
import { handleAdminButton as handleAdminButtonBase } from "./admin-hub.js";

export { handleAdminCommand, handleAdminModal, handleAdminSelect } from "./admin-hub.js";

const PAYROLL_PREFIX = "mgmt:payroll:";
const EMBED_DESCRIPTION_LIMIT = 3_900;

function boundedDescription(
  prefix: string[],
  details: string[],
  suffix: string[],
  omittedLabel: (count: number) => string,
  limit = EMBED_DESCRIPTION_LIMIT,
): string {
  const selected: string[] = [];
  for (let index = 0; index < details.length; index += 1) {
    const remaining = details.length - index - 1;
    const candidate = [
      ...prefix,
      ...selected,
      details[index]!,
      ...(remaining > 0 ? [omittedLabel(remaining)] : []),
      ...suffix,
    ]
      .filter(Boolean)
      .join("\n");
    if (candidate.length > limit) break;
    selected.push(details[index]!);
  }
  const omitted = details.length - selected.length;
  return shorten(
    [...prefix, ...selected, ...(omitted > 0 ? [omittedLabel(omitted)] : []), ...suffix]
      .filter(Boolean)
      .join("\n"),
    limit,
  );
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
  const { current: period, previous: previousPeriod } = manualPayrollPeriods();
  const run = services.payroll.getRunByPeriod(period);
  const previousRun = services.payroll.getRunByPeriod(previousPeriod);
  const currentReport = run ? reportOf(run) : undefined;
  const currentReportUnknown = run?.status === "executed" && !currentReport;
  const salaryLines = rows.map((row) => `・<@&${row.role_id}> **${row.label}**: ${fmtLd(row.amount)}`);
  const suffix = [
    "",
    "支給ボタンでは送金せず、現在のロールから対象者・内訳・総額を計算します。",
    "確認後にだけ支給し、部分失敗時は同じRunから未払い分だけ再実行できます。",
  ];
  if (currentReport?.failed.length) suffix.push("", `⚠️ 前回実行で **${currentReport.failed.length}件** が未払いです。`);
  if (currentReportUnknown) suffix.push("", "⚠️ 実行結果を安全に読み取れません。冪等再実行で確認してください。");
  const description = boundedDescription(
    [
      `**現在月（JST）:** \`${period}\` / ${statusLabel(run)}`,
      `**前月:** \`${previousPeriod}\` / ${statusLabel(previousRun)}`,
      "",
      "**給与表**（ロールごとに月額を設定）",
    ],
    salaryLines.length > 0 ? salaryLines : ["（給与表は空）"],
    suffix,
    (count) => `…他 ${count}行`,
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:payroll:add-start").setLabel("行追加").setEmoji("➕").setStyle(ButtonStyle.Primary),
  );
  if (!run || run.status === "draft") {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:pay-period:${period}`)
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
  } else if (run.status === "executed" && (currentReportUnknown || (currentReport?.failed.length ?? 0) > 0)) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:retry:${run.id}`)
        .setLabel(currentReportUnknown ? "結果不明Runを安全再実行" : "未払い分を再実行")
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
  if (!previousRun) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:pay-period:${previousPeriod}`)
        .setLabel(`${previousPeriod} 前月分を確認`)
        .setEmoji("🗓️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(rows.length === 0),
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
    embeds: [new EmbedBuilder().setTitle("💰 給与").setColor(0x6b21a8).setDescription(description)],
    components,
  };
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
  const allLines = [...plan.items]
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .map((item) => {
      const labels = shorten(item.breakdown.map((part) => part.label).join(" + "), 320);
      return `<@${item.userId}> — **${fmtLd(item.total)}**（${labels}）`;
    });
  const visible = allLines.slice(0, 15);
  const extra = Math.max(0, allLines.length - visible.length);
  const description = boundedDescription(
    [
      `対象: **${plan.items.length}名** / 総額: **${fmtLd(plan.totalPayout)}**`,
      "この画面ではまだ送金していません。添付テキストに全対象者・金額・ロール内訳があります。",
      "",
    ],
    visible,
    extra > 0 ? [`…他 ${extra}名（添付を確認）`] : [],
    (count) => `…上位表示の他 ${count}名（添付を確認）`,
  );
  return new EmbedBuilder()
    .setTitle(`🔎 ${plan.period} 給与支給案 (#${runId})`)
    .setColor(0xd97706)
    .setDescription(description);
}

function failureLine(failure: ExecutionReport["failed"][number]): string {
  const details = Object.entries(failure.details)
    .map(([key, value]) => `${safeText(key)}=${safeText(String(value))}`)
    .join(", ");
  return `・<@${failure.userId}> — \`${failure.code}\`${details ? `（${shorten(details, 500)}）` : ""}`;
}

function failureText(run: PayoutRunRow, report: ExecutionReport): string {
  const lines = [
    `${run.period} 給与支給エラー (#${run.id})`,
    `失敗件数: ${report.failed.length}`,
    "",
    "user_id\tcode\tdetails",
  ];
  for (const failure of report.failed) {
    const details = Object.entries(failure.details)
      .map(([key, value]) => `${safeText(key)}=${safeText(String(value))}`)
      .join(", ");
    lines.push([failure.userId, safeText(failure.code), details].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function executionResult(run: PayoutRunRow, report: ExecutionReport, moneySupply: number) {
  const failureLines = report.failed.map(failureLine);
  const description = boundedDescription(
    [
      `**対象月:** \`${run.period}\` / **Run:** #${run.id}`,
      `成功 **${report.succeeded}件** / 支給済みスキップ **${report.skippedAsPaid}件** / 失敗 **${report.failed.length}件**`,
      `今回の支給額: **${fmtLd(report.totalPaid)}** / 通貨発行残高: ${fmtLd(moneySupply)}`,
      ...(failureLines.length > 0 ? ["", "**未払い・失敗理由**"] : []),
    ],
    failureLines,
    failureLines.length > 0 ? ["全件のエラー詳細は添付ファイルにも保存しています。"] : [],
    (count) => `…他 ${count}件（添付を確認）`,
  );
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
        .setDescription(description),
    ],
    components,
    files: report.failed.length
      ? [
          {
            attachment: Buffer.from(failureText(run, report), "utf8"),
            name: `salary-failures-${run.period}-run-${run.id}.txt`,
          },
        ]
      : [],
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

function existingRunMessage(run: PayoutRunRow, services: Services) {
  const plan = services.payroll.planOf(run);
  const report = reportOf(run);
  const reportUnknown = run.status === "executed" && !report;
  const lines = [
    `**対象月:** \`${run.period}\` / **Run:** #${run.id}`,
    `状態: **${statusLabel(run)}**`,
    `計画: **${plan.items.length}名** / **${fmtLd(plan.totalPayout)}**`,
  ];
  if (report) {
    lines.push(`直近実行: 成功 ${report.succeeded}件 / 支給済みスキップ ${report.skippedAsPaid}件 / 失敗 ${report.failed.length}件`);
  } else if (reportUnknown) {
    lines.push("直近実行: 結果を安全に読み取れないため、冪等再実行が必要です。");
  }
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (run.status === "approved" || (run.status === "executed" && (reportUnknown || (report?.failed.length ?? 0) > 0))) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:payroll:retry:${run.id}`)
          .setLabel(run.status === "approved" ? "支給を再開" : reportUnknown ? "結果不明Runを安全再実行" : "未払い分だけ再実行")
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

async function previewPayroll(interaction: ButtonInteraction, services: Services, period: string): Promise<void> {
  await interaction.deferUpdate();
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
        .setCustomId(`mgmt:payroll:pay-period:${period}`)
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
    if ((run.status === "draft" || run.status === "approved") && planHash(run) !== expectedHash) {
      await interaction.editReply({
        content: "⚠️ 支給案が別操作で更新されています。給与画面へ戻り、最新内容をもう一度確認してください。",
        embeds: [],
        components: [payrollBackRow()],
        attachments: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (run.status === "executed" || run.status === "cancelled") {
      await interaction.editReply(existingRunMessage(run, services));
      return;
    }
    if (run.status === "draft") run = services.payroll.approve(runId, `user:${interaction.user.id}`);
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
    await previewPayroll(interaction, services, jstPeriod());
  } else if (action === "pay-period") {
    const period = rawRunId;
    if (!period || !isManualPayrollPeriod(period)) {
      await interaction.reply({ content: "対象月が不正です。現在月または前月だけを指定できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    await previewPayroll(interaction, services, period);
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
