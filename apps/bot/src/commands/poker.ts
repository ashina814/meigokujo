import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { ChipError, PokerError, cardLabel, type PokerTable } from "@meigokujo/core";
import type { Services } from "../services.js";

const chip = (n: number) => `${n.toLocaleString()} チップ`;

export const pokerCommand = new SlashCommandBuilder()
  .setName("ポーカー")
  .setDescription("対人ポーカー（5カードドロー）。プレイヤー同士でポットを奪い合う")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("卓")
      .setDescription("ポーカー卓を開く（あなたがホスト＝親）")
      .addIntegerOption((o) => o.setName("アンティ").setDescription("参加費（チップ）。全員がこれを出してポットにする").setRequired(true).setMinValue(1)),
  );

// ---- パネル描画 ----
function renderPanel(t: PokerTable, services: Services) {
  const pot = services.chips.balanceOf(t.potHolder);
  const embed = new EmbedBuilder().setTitle("🃏 対人ポーカー（5カードドロー）").setColor(0x8b5cf6);

  if (t.phase === "open") {
    const seats = t.seats.map((s) => `・<@${s.userId}>${s.userId === t.hostId ? " 👑" : ""}`).join("\n") || "（まだ誰もいません）";
    embed.setDescription(
      [
        `アンティ **${chip(t.ante)}** ／ ポット **${chip(pot)}**`,
        "",
        `**着席（${t.seats.length}/6）**`,
        seats,
        "",
        "「参加」でアンティを払って着席。ホストが「配る」で開始（2人〜6人）。",
      ].join("\n"),
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pok:join:${t.id}`).setLabel("参加").setStyle(ButtonStyle.Primary).setDisabled(t.seats.length >= 6),
      new ButtonBuilder().setCustomId(`pok:deal:${t.id}`).setLabel("配る（ホスト）").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pok:cancel:${t.id}`).setLabel("解散").setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
  }

  // draw フェーズ
  const seats = t.seats.map((s) => `・<@${s.userId}>${s.userId === t.hostId ? " 👑" : ""}　${s.ready ? "✅ 交換済み" : "⏳ 交換待ち"}`).join("\n");
  embed.setDescription(
    [
      `ポット **${chip(pot)}**（アンティ ${chip(t.ante)} ×${t.seats.length}人）`,
      "",
      "**交換フェーズ** — 各自「手札を見る／交換」から、捨てる札を選んでください（そのままでも可）。",
      seats,
      "",
      "全員が交換し終えたら、ホストが「ショーダウン」。最強手がポット総取り（同点は分割・テラ銭5%）。",
    ].join("\n"),
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pok:hand:${t.id}`).setLabel("手札を見る／交換").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pok:show:${t.id}`).setLabel("ショーダウン（ホスト）").setStyle(ButtonStyle.Success).setDisabled(!services.poker.get(t.id) || !allReady(t)),
  );
  return { embeds: [embed], components: [row] };
}

function allReady(t: PokerTable): boolean {
  return t.seats.length >= 2 && t.seats.every((s) => s.ready);
}

/** 公開パネルを保存済みの channel/message から編集して更新（エフェメラル操作後に使う） */
async function refreshPanel(interaction: ButtonInteraction | StringSelectMenuInteraction, services: Services, t: PokerTable): Promise<void> {
  if (!t.channelId || !t.messageId) return;
  try {
    const ch = await interaction.client.channels.fetch(t.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(t.messageId);
      await msg.edit(renderPanel(t, services));
    }
  } catch {
    // パネルが消えている等は無視
  }
}

function chipErr(e: unknown): string {
  if (e instanceof ChipError && e.code === "ERR_INSUFFICIENT_CHIPS") return `チップが足りません（保有 ${chip(Number(e.meta.held ?? 0))}）。/為替 両替 で増やせます。`;
  if (e instanceof PokerError) {
    switch (e.code) {
      case "ERR_NO_TABLE":
        return "この卓はもう終了しています。";
      case "ERR_NOT_HOST":
        return "これはホスト（親）だけの操作です。";
      case "ERR_ALREADY_JOINED":
        return "すでに着席しています。";
      case "ERR_FULL":
        return "満席です（6人）。";
      case "ERR_BAD_PHASE":
        return "今はその操作ができません。";
      case "ERR_TOO_FEW":
        return "2人以上そろってから配ってください。";
      case "ERR_BAD_ANTE":
        return "アンティは1以上で指定してください。";
    }
  }
  return "処理に失敗しました。";
}

export async function handlePokerCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  // カジノ専用チャンネルが設定されていれば、そこでだけ開帳
  const casinoCh = services.settings.getString("channel:casino");
  if (casinoCh && interaction.channelId !== casinoCh) {
    await interaction.reply({ content: `🃏 ポーカーは <#${casinoCh}> で開帳しています。そちらでどうぞ。`, flags: MessageFlags.Ephemeral });
    return;
  }

  const ante = interaction.options.getInteger("アンティ", true);
  try {
    const t = services.poker.create(interaction.user.id, ante);
    const reply = await interaction.reply({ ...renderPanel(t, services), fetchReply: true });
    services.poker.setPanel(t.id, reply.channelId, reply.id);
  } catch (e) {
    await interaction.reply({ content: `❌ ${chipErr(e)}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

export async function handlePokerButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, action, id] = interaction.customId.split(":");
  const uid = interaction.user.id;
  const t = services.poker.get(id!);
  if (!t) {
    await interaction.reply({ content: "❌ この卓はもう終了しています。", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    if (action === "join") {
      services.poker.join(id!, uid);
      await interaction.update(renderPanel(t, services));
      return;
    }
    if (action === "deal") {
      if (t.hostId !== uid) {
        await interaction.reply({ content: "❌ 配れるのはホスト（親）だけです。", flags: MessageFlags.Ephemeral });
        return;
      }
      services.poker.deal(id!, uid);
      await interaction.update(renderPanel(t, services));
      return;
    }
    if (action === "cancel") {
      if (t.hostId !== uid) {
        await interaction.reply({ content: "❌ 解散できるのはホスト（親）だけです。", flags: MessageFlags.Ephemeral });
        return;
      }
      services.poker.cancel(id!, uid);
      const embed = new EmbedBuilder().setTitle("🃏 対人ポーカー").setColor(0x52525b).setDescription("卓は解散されました。アンティは全員に返金済みです。");
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }
    if (action === "hand") {
      const seat = services.poker.seatOf(t, uid);
      if (!seat) {
        await interaction.reply({ content: "❌ あなたはこの卓に着席していません。", flags: MessageFlags.Ephemeral });
        return;
      }
      const handLine = seat.cards.map(cardLabel).join("  ");
      if (seat.ready) {
        await interaction.reply({ content: `あなたの手札（交換済み・確定）:\n**${handLine}**`, flags: MessageFlags.Ephemeral });
        return;
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId(`pok:swap:${id}`)
        .setPlaceholder("捨てる札を選ぶ")
        .setMinValues(1)
        .setMaxValues(5)
        .addOptions(seat.cards.map((c, i) => ({ label: cardLabel(c), value: String(i) })));
      const selRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`pok:stand:${id}`).setLabel("このまま確定（交換なし）").setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: `あなたの手札:\n**${handLine}**\n\n捨てる札を選んで交換（1回だけ）。総取りなら「このまま確定」。`, components: [selRow, btnRow], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "stand") {
      const seat = services.poker.swap(id!, uid, []);
      const handLine = seat.cards.map(cardLabel).join("  ");
      await interaction.update({ content: `交換なしで確定しました。あなたの手札:\n**${handLine}**`, components: [] });
      await refreshPanel(interaction, services, t);
      return;
    }
    if (action === "show") {
      if (t.hostId !== uid) {
        await interaction.reply({ content: "❌ ショーダウンを宣言できるのはホスト（親）だけです。", flags: MessageFlags.Ephemeral });
        return;
      }
      const res = services.poker.showdown(id!, uid);
      const rows = res.hands
        .slice()
        .sort((a, b) => (res.winners.includes(b.userId) ? 1 : 0) - (res.winners.includes(a.userId) ? 1 : 0))
        .map((h) => `${res.winners.includes(h.userId) ? "👑" : "・"} <@${h.userId}>　${h.cards.join(" ")}　**${h.hand}**`);
      const winLine =
        res.winners.length === 1
          ? `勝者 <@${res.winners[0]}> が **${chip(res.perWinner)}** を獲得！`
          : `${res.winners.map((w) => `<@${w}>`).join("・")} が **${chip(res.perWinner)}** ずつ山分け！`;
      const embed = new EmbedBuilder()
        .setTitle("🃏 ショーダウン！")
        .setColor(0xf0b429)
        .setDescription([...rows, "", winLine].join("\n"))
        .setFooter({ text: `ポット ${chip(res.pot)} ／ テラ銭 ${chip(res.rake)}` });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }
  } catch (e) {
    await interaction.reply({ content: `❌ ${chipErr(e)}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

export async function handlePokerSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const [, , id] = interaction.customId.split(":");
  const uid = interaction.user.id;
  const t = services.poker.get(id!);
  if (!t) {
    await interaction.update({ content: "この卓はもう終了しています。", components: [] });
    return;
  }
  try {
    const discards = interaction.values.map((v) => Number(v)).filter((n) => Number.isInteger(n));
    const seat = services.poker.swap(id!, uid, discards);
    const handLine = seat.cards.map(cardLabel).join("  ");
    await interaction.update({ content: `交換しました。あなたの最終手札:\n**${handLine}**`, components: [] });
    await refreshPanel(interaction, services, t);
  } catch (e) {
    await interaction.update({ content: `❌ ${chipErr(e)}`, components: [] }).catch(() => undefined);
  }
}
