import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import { PayrollError, type MemberRoles, type PayoutPlan } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import { isAdmin } from "./permissions.js";
import type { Services } from "./services.js";

/** ギルドの全メンバーからロール一覧を作る（Bot除外）。GuildMembers インテント必須 */
async function collectMembers(guild: Guild): Promise<MemberRoles[]> {
  const members = await guild.members.fetch();
  return members
    .filter((m) => !m.user.bot)
    .map((m) => ({ userId: m.id, roleIds: [...m.roles.cache.keys()] }));
}

function planEmbed(plan: PayoutPlan, runId: number): EmbedBuilder {
  const top = [...plan.items]
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)
    .map((i) => `<@${i.userId}> — **${fmtLd(i.total)}**（${i.breakdown.map((b) => b.label).join("+")}）`);
  const rest = plan.items.length - top.length;
  return new EmbedBuilder()
    .setTitle(`💰 ${plan.period} 給与支給案 (#${runId})`)
    .setDescription(
      [
        `対象: **${plan.items.length}名** / 総額: **${fmtLd(plan.totalPayout)}**（国庫から発行）`,
        "",
        ...top,
        rest > 0 ? `…他 ${rest} 名` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setColor(0xd97706);
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
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pay:ok:${run.id}`).setLabel("承認して支給").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pay:no:${run.id}`).setLabel("今月は見送り").setStyle(ButtonStyle.Danger),
    );
    await kessai.send({ embeds: [planEmbed(plan, run.id)], components: [row] });
    return { ok: true, runId: run.id };
  } catch (e) {
    if (e instanceof PayrollError && e.code === "ERR_EMPTY_PLAN") {
      return { ok: false, message: "支給対象がいません。/給与表 にロールを登録してください。" };
    }
    if (e instanceof PayrollError && e.code === "ERR_INVALID_STATUS") {
      return { ok: false, message: `${period} の支給案は既に承認/実行済みです。` };
    }
    throw e;
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
  if (!action || !Number.isSafeInteger(runId)) return;

  const actor = `user:${interaction.user.id}`;

  if (action === "no") {
    try {
      services.payroll.cancel(runId, actor);
    } catch (e) {
      if (e instanceof PayrollError) {
        await interaction.reply({ content: `処理できません: ${e.code}`, flags: MessageFlags.Ephemeral });
        return;
      }
      throw e;
    }
    await interaction.update({
      embeds: interaction.message.embeds,
      components: [],
      content: `❌ <@${interaction.user.id}> が今月の支給を見送りました。`,
    });
    return;
  }

  // 承認 → 実行。実行には時間がかかりうるので先に応答を確定させる
  await interaction.update({
    embeds: interaction.message.embeds,
    components: [],
    content: `⏳ <@${interaction.user.id}> が承認しました。支給を実行中…`,
  });

  try {
    const run = services.payroll.getRun(runId);
    if (run.status === "draft") services.payroll.approve(runId, actor);
    const report = services.payroll.execute(runId, actor);
    const lines = [
      `✅ 支給完了: 成功 **${report.succeeded}件** / 支給済みスキップ ${report.skippedAsPaid}件 / 失敗 ${report.failed.length}件`,
      `支給総額: **${fmtLd(report.totalPaid)}** / 通貨発行残高: ${fmtLd(services.ledger.moneySupply())}`,
    ];
    if (report.failed.length > 0) {
      lines.push(
        "失敗: " + report.failed.map((f) => `<@${f.userId}>（${f.code}）`).join(", "),
        "（原因解消後にもう一度実行すれば、失敗分だけ支給されます）",
      );
    }
    await interaction.editReply({ content: lines.join("\n") });
  } catch (e) {
    if (e instanceof PayrollError) {
      await interaction.editReply({ content: `❌ 実行に失敗しました: ${e.code}` });
      return;
    }
    throw e;
  }
}
