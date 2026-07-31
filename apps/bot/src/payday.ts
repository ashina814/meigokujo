import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import { PayrollError, type MemberRoles, type PayoutPlan, type PayoutRunRow } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import { isAdmin } from "./permissions.js";
import type { Services } from "./services.js";

const EMBED_DESCRIPTION_LIMIT = 3_900;
const RESULT_CONTENT_LIMIT = 1_800;

function planHash(run: PayoutRunRow): string {
  return createHash("sha256").update(run.plan_json).digest("hex").slice(0, 12);
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function boundedLines(
  fixed: string[],
  details: string[],
  omittedLabel: (count: number) => string,
  limit: number,
): string {
  const output = [...fixed];
  for (let index = 0; index < details.length; index += 1) {
    const remaining = details.length - index - 1;
    const suffix = remaining > 0 ? omittedLabel(remaining) : "";
    const candidate = [...output, details[index]!, suffix].filter(Boolean).join("\n");
    if (candidate.length > limit) {
      output.push(omittedLabel(details.length - index));
      break;
    }
    output.push(details[index]!);
  }
  return shorten(output.filter(Boolean).join("\n"), limit);
}

/** ギルドの全メンバーからロール一覧を作る（Bot除外）。GuildMembers インテント必須 */
async function collectMembers(guild: Guild): Promise<MemberRoles[]> {
  const members = await guild.members.fetch();
  return members
    .filter((member) => !member.user.bot)
    .map((member) => ({ userId: member.id, roleIds: [...member.roles.cache.keys()] }));
}

function planEmbed(plan: PayoutPlan, runId: number): EmbedBuilder {
  const detailLines = [...plan.items]
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .map((item) => {
      const labels = shorten(item.breakdown.map((part) => part.label).join(" + "), 320);
      return `<@${item.userId}> — **${fmtLd(item.total)}**（${labels}）`;
    });
  const description = boundedLines(
    [`対象: **${plan.items.length}名** / 総額: **${fmtLd(plan.totalPayout)}**（国庫から発行）`, ""],
    detailLines,
    (count) => `…他 ${count}名（全件は /管理 → 給与 の明細で確認）`,
    EMBED_DESCRIPTION_LIMIT,
  );
  return new EmbedBuilder()
    .setTitle(`💰 ${plan.period} 給与支給案 (#${runId})`)
    .setDescription(description)
    .setColor(0xd97706);
}

function staleSnapshotMessage(): string {
  return "⚠️ この給与パネルの支給案は、作成後に再集計または更新されています。ここからは支給せず、`/管理 → 給与` で最新の対象者・金額を確認してください。";
}

/**
 * 支給案を作って #決裁 に承認パネルを投稿する。
 * 刻時盤（毎月1日 09:00）と /給与支給 コマンドの両方から呼ばれる。
 */
export async function createAndPostDraft(
  client: Client,
  services: Services,
  period: string,
  actor: string,
): Promise<{ ok: true; runId: number } | { ok: false; message: string }> {
  const guildId = services.settings.getString("guild:main");
  const kessaiId = services.settings.getString("channel:kessai");
  if (!guildId) return { ok: false, message: "対象サーバーが未記録です。/給与表 か /設定 を一度実行してください。" };
  if (!kessaiId) return { ok: false, message: "#決裁 チャンネルが未設定です。/設定 チャンネル から設定してください。" };

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const kessai = (await client.channels.fetch(kessaiId).catch(() => null)) as TextChannel | null;
  if (!guild || !kessai?.isTextBased()) {
    return { ok: false, message: "サーバーまたは #決裁 チャンネルにアクセスできません。" };
  }

  let members: MemberRoles[];
  try {
    members = await collectMembers(guild);
  } catch {
    return {
      ok: false,
      message:
        "メンバー一覧の取得に失敗しました。Developer Portal → Bot → **Server Members Intent** が有効か確認してください。",
    };
  }

  try {
    const run = services.payroll.generateDraft(period, members, actor);
    const plan = services.payroll.planOf(run);
    const hash = planHash(run);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pay:ok:${run.id}:${hash}`).setLabel("承認して支給").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pay:no:${run.id}:${hash}`).setLabel("今月は見送り").setStyle(ButtonStyle.Danger),
    );
    await kessai.send({ embeds: [planEmbed(plan, run.id)], components: [row] });
    return { ok: true, runId: run.id };
  } catch (error) {
    if (error instanceof PayrollError && error.code === "ERR_EMPTY_PLAN") {
      return { ok: false, message: "支給対象がいません。/給与表 にロールを登録してください。" };
    }
    if (error instanceof PayrollError && error.code === "ERR_INVALID_STATUS") {
      return { ok: false, message: `${period} の支給案は既に承認/実行済みです。` };
    }
    throw error;
  }
}

export async function handlePaydayButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "承認は運営のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const runId = Number(parts[2]);
  const expectedHash = parts[3];
  if ((action !== "ok" && action !== "no") || !Number.isSafeInteger(runId)) return;
  if (!expectedHash) {
    await interaction.reply({ content: staleSnapshotMessage(), flags: MessageFlags.Ephemeral });
    return;
  }

  const actor = `user:${interaction.user.id}`;
  await interaction.deferUpdate();

  try {
    let run = services.payroll.getRun(runId);
    if (planHash(run) !== expectedHash) {
      await interaction.editReply({
        embeds: interaction.message.embeds,
        components: [],
        content: staleSnapshotMessage(),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (action === "no") {
      services.payroll.cancel(runId, actor);
      await interaction.editReply({
        embeds: interaction.message.embeds,
        components: [],
        content: `❌ <@${interaction.user.id}> が今月の支給を見送りました。`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (run.status === "draft") run = services.payroll.approve(runId, actor);
    if (run.status !== "approved") {
      throw new PayrollError("ERR_INVALID_STATUS", { id: runId, status: run.status, expected: "approved" });
    }

    const report = services.payroll.execute(runId, actor);
    const fixed = [
      `✅ 支給完了: 成功 **${report.succeeded}件** / 支給済みスキップ ${report.skippedAsPaid}件 / 失敗 ${report.failed.length}件`,
      `支給総額: **${fmtLd(report.totalPaid)}** / 通貨発行残高: ${fmtLd(services.ledger.moneySupply())}`,
    ];
    const failureLines = report.failed.map((failure) => `<@${failure.userId}>（${failure.code}）`);
    const content = boundedLines(
      fixed,
      failureLines,
      (count) => `…他 ${count}件（詳細は /管理 → 給与）`,
      RESULT_CONTENT_LIMIT,
    );
    await interaction.editReply({
      embeds: interaction.message.embeds,
      components: [],
      content:
        report.failed.length > 0
          ? `${content}\n原因解消後は \`/管理 → 給与\` から未払い分だけ再実行できます。`
          : content,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (error instanceof PayrollError) {
      await interaction.editReply({
        embeds: interaction.message.embeds,
        components: [],
        content: `❌ 実行に失敗しました: ${error.code}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    throw error;
  }
}
