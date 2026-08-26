import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { CONSUMABLES, getConsumableDef, HOUSE_HOLDER } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { C_MAMMON } from "../casino/ui.js";
import { readAvailableWallet } from "../casino/wallet.js";
import type { Services } from "../services.js";

/**
 * @deprecated slash registrationから退役済み。商店は`/賭場` のhome/panelから利用する。
 * /賭場商店 — マモンの賭場のお守り商店。
 * casino-bot /商店 準拠。Land表示の価格で消耗品を買う → 「装備」→ 発動条件で自動消費。
 * 冥獄城の /商館（Land建てショップ）とは経済圏が分離されている（賭場内で完結）。
 */
/**
 * 商店の描画。legacy `/賭場商店` interactionと `/賭場` ハブの両方から使う。
 * 入口が増えても中身が食い違わないよう、描画は必ずここを通す。
 */
export function renderShop(userId: string, services: Services) {
  return { embeds: [buildEmbed(userId, services)], components: buildComponents() };
}

export async function handleBakutenCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({ ...renderShop(interaction.user.id, services), flags: MessageFlags.Ephemeral });
}

function buildEmbed(userId: string, services: Services): EmbedBuilder {
  const inv = services.items.inventory(userId);
  const armed = new Set(services.items.armedList(userId));
  // 購入時に不足分を手元のLandから自動で寄せるので、ここは賭場の他の画面と
  // 同じ「所持」を出す。利用者から見て Land は単一の通貨で、置き場所の違いは見せない
  const wallet = readAvailableWallet(services, userId);
  const held = wallet.status === "formal" ? wallet.available : services.chips.balanceOf(userId);

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
      name: `${c.name}${armedMark}  ·  ${fmtEther(c.price).replace(" Ld", "Ld")}`,
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

function buildComponents(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const buySelect = new StringSelectMenuBuilder()
    .setCustomId("bakuten:buy")
    .setPlaceholder("買う商品を選ぶ")
    .addOptions(
      CONSUMABLES.map((c) => ({
        label: `${c.name} — ${c.price.toLocaleString()} Ld`,
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

/** 商店の購入結果。`ok:false` は残高不足だけ（技術例外はグループごと巻き戻って投げ直す） */
export interface BuyResult {
  ok: boolean;
  /** 判定時の所持額（不足メッセージに出す） */
  held: number;
  /** この購入の業務グループ鍵。同じ操作の再試行では同じ値になる */
  groupKey: string;
}

/**
 * 賭場商店の購入（PR3 で UI から切り出した購入サービス）。
 *
 * 徴収・付与・残高判定を**ひとつの業務グループ**で行う。分けると
 * 「代金だけ引かれてお守りが増えない」状態が残る。残高判定もグループの中でやるのは、
 * 購入成功後の再試行が「保存済みの結果を返す」前に残高不足で弾かれないようにするため。
 *
 * `operationId` には interaction.id のように**同じ操作の再試行で同じ値になるもの**を渡す。
 * ランダム値を渡すと二重課金・二重付与を防げない。
 */
export function buyConsumable(
  services: Services,
  userId: string,
  key: string,
  operationId: string,
): BuyResult {
  const def = getConsumableDef(key);
  if (!def) throw new Error(`buyConsumable: 不明な商品 ${key}`);
  const groupKey = `shop:buy:${userId}:${def.key}:${operationId}`;
  const r = services.chips.runGroup(
    { groupKey, kind: "shop", actorId: userId },
    (): { ok: boolean; held: number } => {
      // 利用者から見た所持は「手元のLand + 賭場に置いている分」。
      // 賭場に置いている分だけで判定すると、ホームでは買えるように見えて商店で弾かれる。
      // 判定にはホームと同じスナップショットを使い、表示と挙動を一致させる。
      const wallet = readAvailableWallet(services, userId);
      // 版が異常・帳簿破損・overflow のときは available が通常Landだけに落ちる。
      // その状態では自動移動もさせない（fail-closed のまま）
      const trustworthy = wallet.status === "formal";
      const held = trustworthy ? wallet.available : services.chips.balanceOf(userId);
      if (held < def.price) return { ok: false, held };

      // 不足分だけ手元のLandから寄せる。**この runGroup の中で呼ぶ**ので、
      // ChipTx は内側の auto-deposit を同じグループへ合流させ、預入・代金・付与が
      // 1つの業務操作として確定する（預入だけ先に確定して残ることがない）。
      // operationId は呼び出し元の interaction.id なので、再送しても
      // 外側 shop:buy の replay に吸収されて二重入金・二重課金・二重付与にならない。
      if (trustworthy) services.chipFlow.ensureFreeChips(userId, def.price, operationId);

      services.chips.transfer(userId, HOUSE_HOLDER, def.price, { reason: `賭場商店での購入: ${def.key}` });
      services.items.grant(userId, def.key, 1);
      return { ok: true, held };
    },
  );
  return { ...r, groupKey };
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
    const bought = buyConsumable(services, uid, def.key, interaction.id);
    if (!bought.ok) {
      await interaction.reply({
        content: `利用可能額が足りない（所持 ${fmtEther(bought.held)} / 必要 ${fmtEther(def.price)}）。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.update({ embeds: [buildEmbed(uid, services)], components: buildComponents() });
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
    await interaction.update({ embeds: [buildEmbed(uid, services)], components: buildComponents() });
    return;
  }
}

export async function handleBakutenButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const uid = interaction.user.id;
  if (interaction.customId === "bakuten:refresh") {
    await interaction.update({ embeds: [buildEmbed(uid, services)], components: buildComponents() });
  }
}
