import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";
import type { RankedTableSnapshot } from "@meigokujo/core";
import type { RankedDisputePublicStatus } from "@meigokujo/core";
import type { Services } from "../services.js";

export const RANKED_TABLE_CUSTOM_PREFIX = "rtbl:";
const RESULT_MODAL_PREFIX = "rtbl:result-modal:";

export function isRankedTableButton(customId: string): boolean {
  return customId.startsWith(RANKED_TABLE_CUSTOM_PREFIX);
}

export function isRankedTableModal(customId: string): boolean {
  return customId.startsWith(RESULT_MODAL_PREFIX);
}

export function renderRankedTable(snapshot: RankedTableSnapshot, dispute?: RankedDisputePublicStatus | null): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const { table, config, participants, result } = snapshot;
  const active = participants.filter((p) => p.participantState !== "declined");
  const title = `順位卓 / ${labelForGame(table.gameKey)}`;
  const lines = [
    `状態: ${stateLabel(table.state)}`,
    `基準額: ${config.baseAmount.toLocaleString("ja-JP")} Ld`,
    `場代: ${config.feePerUser.toLocaleString("ja-JP")} Ld / 人`,
    `参加: ${active.length}/${config.participantCount}`,
  ];
  if (result) lines.push(`結果hash: ${result.hash.slice(0, 12)}`);
  if (dispute?.resolvedAt) {
    lines.push(`arbitration: ${resolutionLabel(dispute.resolutionKind)} / fee ${dispute.feeOutcome ?? "keep"}`);
    lines.push(`resolved by: ${dispute.resolvedBy ?? "unknown"} / <t:${dispute.resolvedAt}:f>`);
    if (dispute.publicSummary) lines.push(`summary: ${dispute.publicSummary}`);
    lines.push("public summary does not include raw evidence, URLs, attachments, testimony details, or external account information.");
  } else if (table.state === "disputed") {
    if (dispute?.resolvedAt) {
      lines.push(`裁定: ${resolutionLabel(dispute.resolutionKind)} / fee ${dispute.feeOutcome ?? "keep"}`);
      if (dispute.publicSummary) lines.push(`要約: ${dispute.publicSummary}`);
    } else {
      lines.push(`証拠期限: ${dispute ? `<t:${dispute.evidenceDeadlineAt}:R>` : "確認中"}`);
      lines.push(dispute?.evidenceClosedAt ? "証拠提出は締切済み。裁定待ちです。" : "`/賭場証拠 提出` で証拠を提出できます。");
    }
  }
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .addFields({
      name: "参加者",
      value: active.length === 0 ? "なし" : active.map((p) => `${p.seat}. <@${p.userId}> ${participantMark(p.readyState, p.approvalState)}`).join("\n"),
    })
    .setFooter({ text: `table ${table.tableId} / rev ${table.revision}` })
    .setColor(colorForState(table.state));
  const row = controlsFor(snapshot);
  return { embeds: [embed], components: row ? [row] : [] };
}

export async function handleRankedTableButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  try {
    if (parsed.action === "join") {
      services.rankedTables.join({ tableId: parsed.tableId, userId: interaction.user.id, seat: parsed.seat ?? 1, operationId: interaction.id });
      await refresh(interaction, services, parsed.tableId, "参加しました。");
      return;
    }
    if (parsed.action === "ready") {
      services.rankedTables.ready({ tableId: parsed.tableId, userId: interaction.user.id, operationId: interaction.id });
      await refresh(interaction, services, parsed.tableId, "準備完了にしました。");
      return;
    }
    if (parsed.action === "decline") {
      services.rankedTables.decline({ tableId: parsed.tableId, userId: interaction.user.id, operationId: interaction.id });
      await refresh(interaction, services, parsed.tableId, "辞退しました。");
      return;
    }
    if (parsed.action === "result") {
      await interaction.showModal(resultModal(parsed.tableId));
      return;
    }
    if (parsed.action === "approve" || parsed.action === "dispute") {
      const hash = services.rankedTables.snapshot(parsed.tableId).result?.hash;
      if (!hash) {
        await interaction.reply({ content: "承認対象の結果がありません。", ephemeral: true });
        return;
      }
      if (parsed.action === "approve") {
        services.rankedTables.approve({ tableId: parsed.tableId, userId: interaction.user.id, resultHash: hash, operationId: interaction.id });
        await refresh(interaction, services, parsed.tableId, "承認しました。");
      } else {
        services.rankedTables.dispute({ tableId: parsed.tableId, userId: interaction.user.id, resultHash: hash, operationId: interaction.id });
        await refresh(interaction, services, parsed.tableId, "異議ありとして記録しました。");
      }
    }
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : String(error), ephemeral: true });
  }
}

export async function handleRankedTableModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const tableId = interaction.customId.slice(RESULT_MODAL_PREFIX.length);
  const raw = interaction.fields.getTextInputValue("ranking");
  const orderedUserIds = raw.split(/[\s,]+/).map((value) => value.replace(/[<@!>]/g, "").trim()).filter(Boolean);
  try {
    services.rankedTables.submitResult({ tableId, userId: interaction.user.id, orderedUserIds, operationId: interaction.id });
    await editBoundRankedTableMessage(interaction.client, services, tableId);
    await refresh(interaction, services, tableId, "結果を入力しました。全員の承認待ちです。");
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : String(error), ephemeral: true });
  }
}

async function refresh(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  services: Services,
  tableId: string,
  content: string,
): Promise<void> {
  const snapshot = services.rankedTables.snapshot(tableId);
  const payload = renderRankedTable(snapshot, services.rankedDisputes.publicStatus(tableId));
  if (interaction.isModalSubmit()) {
    await interaction.reply({ content, ephemeral: true });
    return;
  }
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, ...payload });
    return;
  }
  await interaction.update({ content, ...payload }).catch(async () => {
    await interaction.reply({ content, ephemeral: true });
  });
}

function controlsFor(snapshot: RankedTableSnapshot): ActionRowBuilder<ButtonBuilder> | null {
  const { table, config, participants } = snapshot;
  const active = participants.filter((p) => p.participantState !== "declined");
  if (table.state === "recruiting") {
    const taken = new Set(active.map((p) => p.seat));
    const nextSeat = Array.from({ length: config.participantCount }, (_, index) => index + 1).find((seat) => !taken.has(seat)) ?? config.participantCount;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rtbl:join:${table.tableId}:${nextSeat}`).setLabel("参加").setStyle(ButtonStyle.Success),
    );
  }
  if (table.state === "ready_check") {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rtbl:ready:${table.tableId}`).setLabel("準備完了").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rtbl:decline:${table.tableId}`).setLabel("辞退する").setStyle(ButtonStyle.Secondary),
    );
  }
  if (table.state === "playing") {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rtbl:result:${table.tableId}`).setLabel("結果を入力").setStyle(ButtonStyle.Primary),
    );
  }
  if (table.state === "pending_approval") {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rtbl:approve:${table.tableId}`).setLabel("承認").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rtbl:dispute:${table.tableId}`).setLabel("異議あり").setStyle(ButtonStyle.Danger),
    );
  }
  return null;
}

export async function editBoundRankedTableMessage(client: Client, services: Services, tableId: string): Promise<void> {
  const snapshot = services.rankedTables.snapshot(tableId);
  const { table } = snapshot;
  if (!table.channelId || !table.messageId) return;
  try {
    const channel = client.channels.cache.get(table.channelId) ?? await client.channels.fetch(table.channelId);
    const textChannel = channel as { messages?: { fetch(id: string): Promise<{ edit(payload: unknown): Promise<unknown> }> } } | null;
    const message = await textChannel?.messages?.fetch(table.messageId);
    await message?.edit(renderRankedTable(snapshot, services.rankedDisputes.publicStatus(tableId)));
  } catch (e) {
    services.events.log("casino_ranked_message_edit_failed", {
      actor: "system:ranked-ui",
      target: tableId,
      payload: { channelId: table.channelId, messageId: table.messageId, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

function resultModal(tableId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${RESULT_MODAL_PREFIX}${tableId}`)
    .setTitle("順位入力")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("ranking")
          .setLabel("1位から順に userId または mention を入力")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true),
      ),
    );
}

function parseCustomId(customId: string): { action: string; tableId: string; seat?: number } | null {
  const parts = customId.split(":");
  if (parts[0] !== "rtbl" || !parts[1] || !parts[2]) return null;
  const parsedSeat = parts[3] ? Number(parts[3]) : undefined;
  return { action: parts[1], tableId: parts[2], ...(parsedSeat !== undefined && Number.isSafeInteger(parsedSeat) && parsedSeat > 0 ? { seat: parsedSeat } : {}) };
}

function labelForGame(gameKey: string): string {
  if (gameKey === "gf") return "GF";
  if (gameKey === "sanma") return "三麻";
  if (gameKey === "yonma") return "四麻";
  return gameKey;
}

function stateLabel(state: string): string {
  switch (state) {
    case "recruiting": return "募集中";
    case "ready_check": return "準備確認";
    case "playing": return "対局中";
    case "pending_approval": return "結果承認待ち";
    case "disputed": return "異議対応中";
    case "settled": return "精算済み";
    default: return state;
  }
}

function participantMark(ready: string | null, approval: string | null): string {
  if (approval === "approved") return "承認済";
  if (approval === "disputed") return "異議";
  if (ready === "ready") return "準備完了";
  return "";
}

function colorForState(state: string): number {
  if (state === "disputed") return 0xb91c1c;
  if (state === "settled") return 0x15803d;
  if (state === "pending_approval") return 0xca8a04;
  return 0x2563eb;
}

function resolutionLabel(kind: string | null): string {
  if (kind === "ranked_result") return "順位確定";
  if (kind === "refund_collateral") return "預託返金";
  if (kind === "insufficient_evidence") return "証拠不足";
  return "未確定";
}
