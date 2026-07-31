import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import type { ExecutionReport, PayoutPlan, PayoutRunRow } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";
import { handleAdminButton as handleSafePayrollButton } from "./admin-payroll-safe.js";

export { handleAdminCommand, handleAdminModal, handleAdminSelect } from "./admin-payroll-safe.js";

const RECOVER_PREFIX = "mgmt:payroll:recover:";
const CANCEL_PREFIX = "mgmt:payroll:cancel:";
const EMBED_DESCRIPTION_LIMIT = 3_900;

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

function statusLabel(run: PayoutRunRow): string {
  if (run.status === "draft") return "支給案作成済み・未承認";
  if (run.status === "approved") return "承認済み・実行待ち";
  if (run.status === "executed") return "一部未完了・再実行待ち";
  return "見送り済み";
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}

function pastRecoverableRuns(services: Services): PayoutRunRow[] {
  const currentPeriod = jstPeriod();
  return services.payroll.listRecoverableRuns().filter((run) => run.period < currentPeriod);
}

function olderRecoverableRun(services: Services, target: PayoutRunRow): PayoutRunRow | undefined {
  return services.payroll
    .listRecoverableRuns()
    .find((run) => run.id !== target.id && (run.period < target.period || (run.period === target.period && run.id < target.id)));
}

function recoveryHome(run: PayoutRunRow, services: Services, pendingCount: number) {
  const currentPeriod = jstPeriod();
  const plan = services.payroll.planOf(run);
  const report = reportOf(run);
  const lines = [
    `現在は \`${currentPeriod}\` ですが、先に処理すべき過去月の給与Runがあります。`,
    "新しい月の給与より、この保存済みスナップショットを優先表示しています。",
    "",
    `**対象月:** \`${run.period}\` / **Run:** #${run.id}`,
    `**状態:** ${statusLabel(run)}`,
    `**計画:** ${plan.items.length}名 / ${fmtLd(plan.totalPayout)}`,
  ];
  if (run.status === "executed") {
    lines.push(
      report
        ? `**直近実行:** 成功 ${report.succeeded}件 / 支給済みスキップ ${report.skippedAsPaid}件 / 失敗 ${report.failed.length}件`
        : "**直近実行:** 結果を読み取れないため、安全な冪等再実行が必要です。",
    );
  }
  if (pendingCount > 1) lines.push("", `ほかに未完了Runが ${pendingCount - 1}件あります。古いものから処理します。`);

  const primary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RECOVER_PREFIX}${run.id}`)
      .setLabel("保存済み案を確認")
      .setEmoji("🔎")
      .setStyle(ButtonStyle.Primary),
  );
  if (run.status === "approved" || run.status === "executed") {
    primary.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:retry:${run.id}`)
        .setLabel(run.status === "approved" ? "支給を再開" : "未払い分を再実行")
        .setEmoji(run.status === "approved" ? "▶️" : "🔁")
        .setStyle(run.status === "approved" ? ButtonStyle.Success : ButtonStyle.Danger),
    );
  }

  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:hub").setLabel("← 管理ハブへ").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle("⚠️ 未完了の給与Run")
        .setColor(0xdc2626)
        .setDescription(lines.join("\n")),
    ],
    components: [primary, back],
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

function blockedByOlderRun(run: PayoutRunRow, services: Services, pendingCount: number) {
  const payload = recoveryHome(run, services, pendingCount);
  payload.content = `⛔ \`${run.period}\` の未完了Run #${run.id} を先に処理してください。新しい月の支給案作成・承認・再実行は行っていません。`;
  return payload;
}

function planDescription(run: PayoutRunRow, plan: PayoutPlan): string {
  const allLines = [...plan.items]
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .map((item) => {
      const labels = shorten(item.breakdown.map((part) => part.label).join(" + "), 320);
      return `<@${item.userId}> — **${fmtLd(item.total)}**（${labels}）`;
    });
  const visible = allLines.slice(0, 15);
  const extra = allLines.length - visible.length;
  const fixed = [
    `**状態:** ${statusLabel(run)}`,
    `**対象:** ${plan.items.length}名 / **総額:** ${fmtLd(plan.totalPayout)}`,
    "この内容は作成時の保存済みスナップショットです。現在のロールでは再集計していません。",
    "全対象者・金額・給与ロール内訳は添付明細を確認してください。",
    "",
  ];
  const suffix = extra > 0 ? [`…他 ${extra}名（添付を確認）`] : [];
  const selected: string[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const omittedVisible = visible.length - index - 1;
    const candidate = [
      ...fixed,
      ...selected,
      visible[index]!,
      ...(omittedVisible > 0 ? [`…上位表示の他 ${omittedVisible}名（添付を確認）`] : []),
      ...suffix,
    ].join("\n");
    if (candidate.length > EMBED_DESCRIPTION_LIMIT) break;
    selected.push(visible[index]!);
  }
  const omittedVisible = visible.length - selected.length;
  return shorten(
    [
      ...fixed,
      ...selected,
      ...(omittedVisible > 0 ? [`…上位表示の他 ${omittedVisible}名（添付を確認）`] : []),
      ...suffix,
    ].join("\n"),
    EMBED_DESCRIPTION_LIMIT,
  );
}

function planText(run: PayoutRunRow, plan: PayoutPlan): string {
  const lines = [
    `${run.period} 保存済み給与支給案 (#${run.id})`,
    `状態: ${run.status}`,
    `対象者数: ${plan.items.length}`,
    `支給総額: ${plan.totalPayout}`,
    "",
    "user_id\ttotal\tbreakdown",
  ];
  for (const item of [...plan.items].sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))) {
    const breakdown = item.breakdown
      .map((part) => `${safeText(part.label)}[${part.roleId}]=${part.amount}`)
      .join(" + ");
    lines.push([item.userId, String(item.total), breakdown].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function recoveryPreview(run: PayoutRunRow, services: Services) {
  const plan = services.payroll.planOf(run);
  const action = new ActionRowBuilder<ButtonBuilder>();
  if (run.status === "draft") {
    const hash = planHash(run);
    action.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:confirm:${run.id}:${hash}`)
        .setLabel("保存済み内容で支給")
        .setEmoji("💸")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${CANCEL_PREFIX}${run.id}:${hash}`)
        .setLabel("この月は見送り")
        .setEmoji("⏭️")
        .setStyle(ButtonStyle.Secondary),
    );
  } else {
    action.addComponents(
      new ButtonBuilder()
        .setCustomId(`mgmt:payroll:retry:${run.id}`)
        .setLabel(run.status === "approved" ? "支給を再開" : "未払い分を再実行")
        .setEmoji(run.status === "approved" ? "▶️" : "🔁")
        .setStyle(run.status === "approved" ? ButtonStyle.Success : ButtonStyle.Danger),
    );
  }
  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("← 未完了Runへ").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:hub").setLabel("管理ハブ").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle(`🔎 ${run.period} 保存済み給与案 (#${run.id})`)
        .setColor(0xd97706)
        .setDescription(planDescription(run, plan)),
    ],
    components: [action, back],
    files: [
      {
        attachment: Buffer.from(planText(run, plan), "utf8"),
        name: `salary-saved-${run.period}-run-${run.id}.txt`,
      },
    ],
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

async function denyNonAdmin(interaction: ButtonInteraction, services: Services): Promise<boolean> {
  if (isAdmin(interaction, services)) return false;
  await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
  return true;
}

async function cancelRecoveredDraft(
  interaction: ButtonInteraction,
  services: Services,
  runId: number,
  expectedHash: string,
): Promise<void> {
  await interaction.deferUpdate();
  try {
    const run = services.payroll.getRun(runId);
    if (run.status !== "draft" || planHash(run) !== expectedHash) {
      await interaction.editReply({
        content: "⚠️ この見送りボタンは古くなっています。給与画面を開き直してください。",
        embeds: [],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("給与画面へ").setStyle(ButtonStyle.Primary),
          ),
        ],
        attachments: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    services.payroll.cancel(run.id, `user:${interaction.user.id}`);
    const remaining = pastRecoverableRuns(services);
    if (remaining.length > 0) {
      await interaction.editReply(recoveryHome(remaining[0]!, services, remaining.length));
      return;
    }
    await interaction.editReply({
      content: `✅ \`${run.period}\` の給与Run #${run.id} を見送りました。`,
      embeds: [],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("現在月の給与画面へ").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("mgmt:hub").setLabel("管理ハブ").setStyle(ButtonStyle.Secondary),
        ),
      ],
      attachments: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ 給与Runの見送りに失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`,
      embeds: [],
      components: [],
      attachments: [],
      allowedMentions: { parse: [] },
    });
  }
}

export async function handleAdminButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "mgmt:payroll") {
    if (await denyNonAdmin(interaction, services)) return;
    const pastRuns = pastRecoverableRuns(services);
    if (pastRuns.length === 0) {
      await handleSafePayrollButton(interaction, services);
      return;
    }
    await interaction.update(recoveryHome(pastRuns[0]!, services, pastRuns.length));
    return;
  }

  if (interaction.customId.startsWith(RECOVER_PREFIX)) {
    if (await denyNonAdmin(interaction, services)) return;
    const runId = Number(interaction.customId.slice(RECOVER_PREFIX.length));
    if (!Number.isSafeInteger(runId)) {
      await interaction.reply({ content: "給与Runの識別子が不正です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      const recoverable = services.payroll.listRecoverableRuns().find((run) => run.id === runId);
      if (!recoverable) {
        await interaction.editReply({
          content: "✅ この給与Runは既に解決済みです。給与画面を開き直してください。",
          embeds: [],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("給与画面へ").setStyle(ButtonStyle.Primary),
            ),
          ],
          attachments: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply(recoveryPreview(recoverable, services));
    } catch (error) {
      await interaction.editReply({
        content: `❌ 保存済み給与案の取得に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`,
        embeds: [],
        components: [],
        attachments: [],
        allowedMentions: { parse: [] },
      });
    }
    return;
  }

  if (interaction.customId.startsWith(CANCEL_PREFIX)) {
    if (await denyNonAdmin(interaction, services)) return;
    const [, , , runIdRaw, expectedHash] = interaction.customId.split(":");
    const runId = Number(runIdRaw);
    if (!Number.isSafeInteger(runId) || !expectedHash) {
      await interaction.reply({ content: "給与Runの識別子が不正です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await cancelRecoveredDraft(interaction, services, runId, expectedHash);
    return;
  }

  const [, section, action, runIdRaw] = interaction.customId.split(":");
  if (section === "payroll" && (action === "pay" || action === "confirm" || action === "retry")) {
    if (await denyNonAdmin(interaction, services)) return;
    let blocker: PayoutRunRow | undefined;
    if (action === "pay") {
      blocker = pastRecoverableRuns(services)[0];
    } else {
      const runId = Number(runIdRaw);
      if (Number.isSafeInteger(runId)) {
        try {
          blocker = olderRecoverableRun(services, services.payroll.getRun(runId));
        } catch {
          blocker = undefined;
        }
      }
    }
    if (blocker) {
      const pendingCount = services.payroll.listRecoverableRuns().filter((run) => run.period <= blocker.period).length;
      await interaction.update(blockedByOlderRun(blocker, services, Math.max(1, pendingCount)));
      return;
    }
  }

  await handleSafePayrollButton(interaction, services);
}
