import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { TABLE_TYPES } from "@meigokujo/core";
import { C_MAMMON } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * 卓建てパネル（/管理 → パネル → 卓建て で設置）。
 * ボタンから種類別の一時VCを生成する。
 * - 最後の1人が退出したら自動削除（voice-state ハンドラ）
 * - 起動時に空VCを sweep
 */

export function takutatePanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 卓建て" })
    .setColor(C_MAMMON)
    .setTitle("🪑  卓を立てる")
    .setDescription("用途別の一時VCを開く。**最後の1人が退出したら自動で片付けられる**。")
    .addFields({
      name: "▸ 卓の種類",
      value: TABLE_TYPES.map((t) => `${t.emoji}  **${t.name}**  ·  定員 ${t.userLimit}`).join("\n"),
      inline: false,
    })
    .setFooter({ text: "パネルのボタンから即席で開ける" });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();
  for (const t of TABLE_TYPES) {
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`taku:make:${t.key}`)
        .setLabel(t.name)
        .setEmoji(t.emoji)
        .setStyle(ButtonStyle.Primary),
    );
    if (current.components.length >= 5) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
    }
  }
  if (current.components.length > 0) rows.push(current);
  return { embeds: [embed], components: rows };
}

export async function handleTakuButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts[1] !== "make") return;
  const key = parts[2]!;
  const def = TABLE_TYPES.find((t) => t.key === key);
  if (!def) {
    await interaction.reply({ content: "不明な卓の種類。", flags: MessageFlags.Ephemeral });
    return;
  }
  const guild = interaction.guild;
  if (!guild) return;
  const panelChannel = interaction.channel;
  if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "テキストチャンネルで実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  // パネル設置チャンネルの親カテゴリ配下に VC を作る（権限は継承）
  const parent = panelChannel.parent;
  try {
    const uid = interaction.user.id;
    const name = `${def.emoji} ${def.name}・${interaction.user.username.slice(0, 12)}`;
    const vc = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parent ?? undefined,
      userLimit: def.userLimit,
      reason: `卓建て by ${uid}`,
    });
    services.takutate.track(vc.id, guild.id, uid, def.key);
    await interaction.reply({
      content: `✅ ${def.emoji} **${def.name}** を立てた: <#${vc.id}>（最後の1人が退出で自動削除）`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    await interaction.reply({ content: `❌ VC 作成に失敗した（Botの権限不足?）`, flags: MessageFlags.Ephemeral });
    void e;
  }
}

/** VoiceStateUpdate ハンドラ: 追跡中の卓VCが空になったら削除 */
export async function handleTakuVoiceUpdate(
  oldState: import("discord.js").VoiceState,
  newState: import("discord.js").VoiceState,
  services: Services,
): Promise<void> {
  // 退出のみ関心（新チャンネルには何もしない）
  const oldCh = oldState.channel;
  if (!oldCh || oldCh.type !== ChannelType.GuildVoice) return;
  if (!services.takutate.isTracked(oldCh.id)) return;
  // 誰もいない?
  const humans = oldCh.members.filter((m) => !m.user.bot);
  if (humans.size > 0) return;
  // 削除
  try {
    await oldCh.delete("卓建て: 最後の1人退出で自動削除");
    services.takutate.untrack(oldCh.id);
  } catch {
    /* ignore */
  }
  void newState;
}

/** 起動時に空になっている追跡中卓VCを sweep */
export async function sweepStaleTables(client: import("discord.js").Client, services: Services): Promise<number> {
  let removed = 0;
  for (const t of services.takutate.list()) {
    try {
      const guild = await client.guilds.fetch(t.guild_id).catch(() => null);
      const ch = guild ? await guild.channels.fetch(t.channel_id).catch(() => null) : null;
      if (!ch) {
        services.takutate.untrack(t.channel_id);
        removed++;
        continue;
      }
      if (ch.type === ChannelType.GuildVoice) {
        const humans = ch.members.filter((m) => !m.user.bot);
        if (humans.size === 0) {
          await ch.delete("卓建て: 起動時 sweep").catch(() => undefined);
          services.takutate.untrack(t.channel_id);
          removed++;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
