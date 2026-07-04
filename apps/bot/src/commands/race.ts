import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type TextChannel,
} from "discord.js";
import { LedgerError, RaceError, type RaceRow, type SettleResult } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { notifyUser } from "../notify.js";
import type { Services } from "../services.js";

export const raceCommand = new SlashCommandBuilder()
  .setName("レース")
  .setDescription("冥馬レース（レース賭博）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("作成")
      .setDescription("レースを開催する（運営）")
      .addStringOption((o) => o.setName("出走馬").setDescription("カンマ区切りで2〜8頭（例: 黒炎,白骨,影武者）").setRequired(true).setMaxLength(300))
      .addIntegerOption((o) => o.setName("時間").setDescription("発走までの時間（h）").setRequired(true).setMinValue(1).setMaxValue(168))
      .addStringOption((o) => o.setName("名前").setDescription("レース名（任意）").setMaxLength(100))
      .addIntegerOption((o) => o.setName("控除率").setDescription("ハウスエッジ％（既定10）").setMinValue(0).setMaxValue(90)),
  )
  .addSubcommand((sub) => sub.setName("一覧").setDescription("開催中のレースを表示"))
  .addSubcommand((sub) =>
    sub.setName("発走").setDescription("レースを発走・清算する（運営）").addIntegerOption((o) => o.setName("レース").setDescription("対象").setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) =>
    sub.setName("取消").setDescription("レースを取り消して全額返金（運営）").addIntegerOption((o) => o.setName("レース").setDescription("対象").setRequired(true).setAutocomplete(true)),
  );

// ---- パネル ----

export function racePanelMessage(services: Services, r: RaceRow) {
  const open = r.status === "open";
  const horses = services.races.horses(r);
  const byHorse = services.races.poolByHorse(r.id);
  const payoutPool = r.pool * (1 - r.house_edge_bps / 10_000);
  const lines = horses.map((h, i) => {
    const staked = byHorse[i] ?? 0;
    const odds = staked > 0 ? (payoutPool / staked).toFixed(2) : "—";
    const mark = r.status === "settled" && r.winner_index === i ? "🏆 " : "";
    return `${mark}**${i + 1}. ${h}** — 賭け ${fmtLd(staked)}（配当 ×${odds}）`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`🏇 冥馬レース #${r.id}${r.title ? `「${r.title}」` : ""}`)
    .setColor(open ? 0x16a34a : 0x52525b)
    .setDescription(
      [
        ...lines,
        "",
        `総賭け金: **${fmtLd(r.pool)}** ／ 控除 ${(r.house_edge_bps / 100).toFixed(0)}%`,
        open ? `発走: <t:${r.starts_at}:R>（<t:${r.starts_at}:f>）` : r.status === "settled" ? `🏁 1着: 【${horses[r.winner_index ?? 0] ?? "?"}】` : "🚫 取り消されました",
      ].join("\n"),
    );
  const components = open
    ? [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`race:pick:${r.id}`)
            .setPlaceholder("🏇 賭ける馬を選ぶ")
            .addOptions(horses.map((h, i) => ({ label: `${i + 1}. ${h}`.slice(0, 100), value: String(i) }))),
        ),
      ]
    : [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`race:done:${r.id}`).setLabel("終了").setStyle(ButtonStyle.Secondary).setDisabled(true))];
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export async function refreshRacePanel(client: Client, services: Services, r: RaceRow): Promise<void> {
  if (!r.channel_id || !r.message_id) return;
  const ch = (await client.channels.fetch(r.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(r.message_id).catch(() => null);
  await msg?.edit(racePanelMessage(services, r)).catch(() => undefined);
}

// ---- コマンド ----

export async function handleRaceCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "一覧") {
    const rows = services.races.listOpen();
    const embed = new EmbedBuilder()
      .setTitle("🏇 開催中のレース")
      .setColor(0x16a34a)
      .setDescription(
        rows.length > 0
          ? rows.map((r) => `**#${r.id}${r.title ? ` ${r.title}` : ""}** — 総賭け ${fmtLd(r.pool)}　発走 <t:${r.starts_at}:R>`).join("\n")
          : "開催中のレースはありません。",
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "作成") {
    const horses = interaction.options.getString("出走馬", true).split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
    const hours = interaction.options.getInteger("時間", true);
    const title = interaction.options.getString("名前") ?? undefined;
    const edgePct = interaction.options.getInteger("控除率") ?? 10;
    const startsAt = Math.floor(Date.now() / 1000) + hours * 3600;
    try {
      const r = services.races.create({ title, horses, houseEdgeBps: edgePct * 100, startsAt, createdBy: `user:${interaction.user.id}` });
      const channel = interaction.channel as TextChannel | null;
      if (channel?.isTextBased()) {
        const sent = await channel.send(racePanelMessage(services, r)).catch(() => null);
        if (sent) {
          services.races.setPanel(r.id, sent.channelId, sent.id);
          await sent.pin().catch(() => undefined);
        }
      }
      await interaction.reply({ content: `✅ 冥馬レース #${r.id}（${horses.length}頭）を開催しました（発走 <t:${startsAt}:R>）。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      const msg = e instanceof RaceError && e.code === "ERR_BAD_HORSES" ? "出走馬は2〜8頭で指定してください。" : "作成に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const id = interaction.options.getInteger("レース", true);
  try {
    if (sub === "発走") {
      const res = services.races.settle(id, `user:${interaction.user.id}`);
      await refreshRacePanel(interaction.client, services, res.race);
      await announceRace(interaction.client, services, res);
      await interaction.reply({ content: `🏁 #${id} 発走完了。1着: 【${res.winnerName}】`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (sub === "取消") {
      services.races.cancel(id, `user:${interaction.user.id}`);
      await refreshRacePanel(interaction.client, services, services.races.get(id)!);
      await interaction.reply({ content: `🚫 #${id} を取り消し、賭け金を返金しました。`, flags: MessageFlags.Ephemeral });
      return;
    }
  } catch (e) {
    const msg = e instanceof RaceError && e.code === "ERR_RACE_NOT_FOUND" ? "そのレースは見つかりません。" : e instanceof RaceError && e.code === "ERR_RACE_CLOSED" ? "そのレースはすでに終了しています。" : "処理に失敗しました。";
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

// ---- 賭け（セレクト → モーダル）----

export async function handleRaceSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const id = Number(interaction.customId.split(":")[2]);
  const horseIndex = Number(interaction.values[0]);
  const r = services.races.get(id);
  if (!r || r.status !== "open") {
    await interaction.reply({ content: "このレースは締め切られています。", flags: MessageFlags.Ephemeral });
    return;
  }
  const horse = services.races.horses(r)[horseIndex] ?? `${horseIndex + 1}番`;
  const modal = new ModalBuilder()
    .setCustomId(`race:betmodal:${id}:${horseIndex}`)
    .setTitle(`「${horse}」に賭ける`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("賭け金（Land）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleRaceBetModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // race:betmodal:id:horse
  const id = Number(parts[2]);
  const horseIndex = Number(parts[3]);
  const amount = Number(interaction.fields.getTextInputValue("amount").replace(/[,，\s]/g, ""));
  if (!Number.isInteger(amount) || amount <= 0) {
    await interaction.reply({ content: "賭け金は正の整数で入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    const r = services.races.bet({ raceId: id, bettorId: interaction.user.id, horseIndex, amount, idempotencyKey: `race-bet:${interaction.id}` });
    const horse = services.races.horses(r)[horseIndex] ?? `${horseIndex + 1}番`;
    await refreshRacePanel(interaction.client, services, r);
    await interaction.reply({ content: `✅ 「${horse}」に **${fmtLd(amount)}** 賭けました。`, flags: MessageFlags.Ephemeral });
  } catch (e) {
    let msg = "賭けに失敗しました。";
    if (e instanceof RaceError && (e.code === "ERR_RACE_STARTED" || e.code === "ERR_RACE_CLOSED")) msg = "このレースは締め切られています。";
    else if (e instanceof RaceError && e.code === "ERR_BAD_HORSE") msg = "その馬は存在しません。";
    else if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))}）。`;
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

// ---- 実況・結果告知（手動・自動共通）----

export async function announceRace(client: Client, services: Services, res: SettleResult): Promise<void> {
  const r = res.race;
  if (!r.channel_id) return;
  const ch = (await client.channels.fetch(r.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  const lines = [`🏇 **冥馬レース #${r.id} 発走！**`, `……ゴール！ 1着は 【**${res.winnerName}**】！`];
  if (res.refunded) {
    lines.push("的中者がいなかったため、賭け金は全額返金されました。");
  } else if (res.payouts.length > 0) {
    lines.push("", "**配当:**", ...res.payouts.slice(0, 20).map((p) => `・<@${p.userId}> ＋${fmtLd(p.amount)}`));
  } else {
    lines.push("賭けはありませんでした。");
  }
  await ch.send({ content: lines.join("\n"), allowedMentions: { users: res.payouts.map((p) => p.userId).slice(0, 20) } }).catch(() => undefined);

  for (const p of res.payouts.slice(0, 30)) {
    await notifyUser(client, services, p.userId, `🏇 冥馬レース #${r.id} で【${res.winnerName}】的中！ **${fmtLd(p.amount)}** の配当。`, { fallbackChannelKey: "channel:shurei" }).catch(() => undefined);
  }
}

// ---- オートコンプリート ----

export async function handleRaceAutocomplete(interaction: AutocompleteInteraction, services: Services): Promise<void> {
  const focused = interaction.options.getFocused().toString().toLowerCase();
  const choices = services.races
    .listOpen()
    .filter((r) => !focused || `${r.id}`.includes(focused) || (r.title ?? "").toLowerCase().includes(focused))
    .slice(0, 25)
    .map((r) => ({ name: `#${r.id}${r.title ? ` ${r.title}` : ""}（総 ${r.pool.toLocaleString()}Ld）`.slice(0, 100), value: r.id }));
  await interaction.respond(choices).catch(() => undefined);
}
