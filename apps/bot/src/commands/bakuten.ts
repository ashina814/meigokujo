import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { CONSUMABLES, getConsumableDef, HOUSE_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { C_MAMMON } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * /賭場商店 — マモンの賭場のお守り商店。
 * casino-bot /商店 準拠。エテル建てで消耗品を買う → 「装備」→ 発動条件で自動消費。
 * 冥獄城の /商館（Land建てショップ）とは経済圏が分離されている（賭場内で完結）。
 */
export const bakutenCommand = new SlashCommandBuilder()
  .setName("賭場商店")
  .setDescription("🛍 マモンの賭場のお守り商店（エテル建て）")
  .setDMPermission(false);

export async function handleBakutenCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({ embeds: [buildEmbed(interaction.user.id, services)], components: buildComponents(services), flags: MessageFlags.Ephemeral });
}

function buildEmbed(userId: string, services: Services): EmbedBuilder {
  const inv = services.items.inventory(userId);
  const armed = new Set(services.items.armedList(userId));
  const held = services.ether.balanceOf(userId);

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 商店" })
    .setColor(C_MAMMON)
    .setTitle("🛍  お守り棚")
    .setDescription(
      [
        `所持 **${fmtEther(held)}**`,
        "",
        "*買う → 装備する → 発動条件を満たしたら自動で消える。*",
      ].join("\n"),
    );

  // 各お守りを Field で並べる（inline: true で2列レイアウト）
  for (const c of CONSUMABLES) {
    const own = inv.find((i) => i.key === c.key)?.quantity ?? 0;
    const armedMark = armed.has(c.key) ? " 🟢" : "";
    embed.addFields({
      name: `${c.name}${armedMark}  ·  ${fmtEther(c.price).replace(" ◈", "◈")}`,
      value: [
        `${c.desc}`,
        `所持 **${own}**${armed.has(c.key) ? "  ／  装備中" : ""}`,
      ].join("\n"),
      inline: true,
    });
  }
  // 2列 x 2行 = 4個で足りない場合の詰めを inline 数で調整（現状4個なので綺麗に並ぶ）

  embed.setFooter({ text: `${armed.size > 0 ? `装備 ${armed.size}種類` : "装備なし"} · 装備は各ゲームの発動条件で消費` });
  return embed;
}

function buildComponents(services: Services): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const buySelect = new StringSelectMenuBuilder()
    .setCustomId("bakuten:buy")
    .setPlaceholder("買う商品を選ぶ")
    .addOptions(
      CONSUMABLES.map((c) => ({
        label: `${c.name} — ${c.price.toLocaleString()} ◈`,
        value: c.key,
        description: c.desc.slice(0, 100),
      })),
    );
  const armSelect = new StringSelectMenuBuilder()
    .setCustomId("bakuten:arm")
    .setPlaceholder("装備する（在庫から1つ消費）")
    .addOptions(
      CONSUMABLES.map((c) => ({
        label: c.name,
        value: c.key,
        description: `${c.desc.slice(0, 80)}`,
      })),
    );
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buySelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(armSelect),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("bakuten:refresh").setLabel("🔁 更新").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export async function handleBakutenSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const uid = interaction.user.id;
  const action = interaction.customId.split(":")[1];
  const key = interaction.values[0]!;
  const def = getConsumableDef(key);
  if (!def) {
    await interaction.reply({ content: "不明な商品。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "buy") {
    const held = services.ether.balanceOf(uid);
    if (held < def.price) {
      await interaction.reply({ content: `エテルが足りない（所持 ${fmtEther(held)} / 必要 ${fmtEther(def.price)}）。`, flags: MessageFlags.Ephemeral });
      return;
    }
    services.ether.transfer(uid, HOUSE_HOLDER, def.price);
    services.items.grant(uid, def.key, 1);
    await interaction.update({ embeds: [buildEmbed(uid, services)], components: buildComponents(services) });
    return;
  }

  if (action === "arm") {
    const r = services.items.arm(uid, def.key);
    if (!r.ok) {
      const msg =
        r.reason === "NO_STOCK"
          ? `${def.name} の在庫がない。`
          : r.reason === "ALREADY_ARMED"
            ? `${def.name} は既に装備している。`
            : "不明なアイテム。";
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({ embeds: [buildEmbed(uid, services)], components: buildComponents(services) });
    return;
  }
}

export async function handleBakutenButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const uid = interaction.user.id;
  if (interaction.customId === "bakuten:refresh") {
    await interaction.update({ embeds: [buildEmbed(uid, services)], components: buildComponents(services) });
  }
}
