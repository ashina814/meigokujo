import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import { C_JACKPOT, C_MAMMON, E, HR_THIN } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * /賭場番付 — マモンの賭場の番付（casino-bot /番付 相当）。
 * ephemeral（本人にだけ見える）。
 */
export const banzukeCommand = new SlashCommandBuilder()
  .setName("賭場番付")
  .setDescription("🏅 マモンの賭場の番付を見る")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("種別")
      .setDescription("見る番付")
      .setRequired(true)
      .addChoices(
        { name: "賭場利用可能額", value: "balance" },
        { name: "勝率（10戦以上）", value: "win_rate" },
        { name: "最大単勝", value: "biggest_win" },
        { name: "総獲得", value: "total_earned" },
        { name: "総ベット", value: "total_wagered" },
        { name: "最長連勝", value: "best_win_streak" },
      ),
  );

export type BanzukeKind = "balance" | "win_rate" | "biggest_win" | "total_earned" | "total_wagered" | "best_win_streak";

const LABELS: Record<BanzukeKind, { title: string; icon: string; color: number }> = {
  balance: { title: "賭場利用可能額", icon: "💰", color: C_JACKPOT },
  win_rate: { title: "勝率", icon: "📊", color: 0x22c55e },
  biggest_win: { title: "最大単勝", icon: "🎯", color: 0xf59e0b },
  total_earned: { title: "総獲得", icon: "📈", color: 0x0ea5e9 },
  total_wagered: { title: "総ベット", icon: "💸", color: 0x8b5cf6 },
  best_win_streak: { title: "最長連勝", icon: "🔥", color: 0xdc2626 },
};

export const BANZUKE_SELECT_ID = "casino:home:banzuke-pick";

/**
 * 番付の描画。`/賭場番付` と `/賭場` ハブの両方から使う。
 * 種別セレクトを添えるので、ハブから来た人はコマンド引数を知らなくても切り替えられる。
 */
export function renderBanzuke(services: Services, kind: string, viewerId: string) {
  const safeKind: BanzukeKind = kind in LABELS ? (kind as BanzukeKind) : "balance";
  const meta = LABELS[safeKind];
  const rows = services.casino.top(safeKind, 10);

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 番付" })
    .setTitle(`${meta.icon}  ${meta.title} 番付  Top 10`)
    .setColor(meta.color);

  if (rows.length === 0) {
    embed.setDescription("まだ番付に載る者がいない。");
  } else {
    const lines = rows.map((r, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `\`${String(i + 1).padStart(2, " ")}.\``;
      const value =
        safeKind === "win_rate"
          ? `**${(r.value as number).toFixed(1)}%**${r.sub ? ` · ${r.sub}戦` : ""}`
          : safeKind === "best_win_streak"
            ? `**${r.value.toLocaleString()}連勝**`
            : `**${fmtEther(r.value)}**`;
      const self = r.user_id === viewerId ? " ← お前" : "";
      return `${medal}  <@${r.user_id}>${self}\n　　${value}`;
    });
    embed.setDescription(lines.join("\n"));
    if (!rows.some((r) => r.user_id === viewerId)) {
      embed.setDescription(`${embed.data.description ?? ""}\n${HR_THIN}\n${E.chart} お前はまだ Top10 に入っていない。`);
    }
  }
  embed.setFooter({ text: `${E.paytable} 通行証で自分の戦績カードを見られる` });

  const picker = new StringSelectMenuBuilder()
    .setCustomId(BANZUKE_SELECT_ID)
    .setPlaceholder("ほかの番付を見る")
    .addOptions(
      Object.entries(LABELS).map(([value, m]) => ({
        label: m.title,
        value,
        emoji: m.icon,
        default: value === safeKind,
      })),
    );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker)],
    allowedMentions: { parse: [] as never[] },
  };
}

export async function handleBanzukeCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const kind = interaction.options.getString("種別", true);
  await interaction.reply({ ...renderBanzuke(services, kind, interaction.user.id), flags: MessageFlags.Ephemeral });
}
