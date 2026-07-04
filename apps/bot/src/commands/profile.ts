import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from "discord.js";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

const RANK_LABEL: Record<string, string> = {
  waiting: "入城案内待ち",
  ghost: "亡霊",
  majin: "魔人",
  mazoku: "魔族",
  meirei: "迷霊",
  departed: "去りし魂",
};

export const profileCommand = new SlashCommandBuilder()
  .setName("プロフィール")
  .setDescription("魂の記録カードを表示する")
  .setDMPermission(false)
  .addUserOption((o) => o.setName("対象").setDescription("他の人の記録を見る（省略で自分）"));

export async function handleProfile(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const target = interaction.options.getUser("対象") ?? interaction.user;
  const isSelf = target.id === interaction.user.id;

  // 開いたときに称号を評価（新規獲得があれば付与）。他人のプロフィールでも遅れて拾える
  const newlyGranted = services.titles.evaluate(target.id);

  const soul = services.entry.getSoul(target.id);
  const balance = services.ledger.balanceOf(`user:${target.id}`);
  const daysInCastle = soul?.ghost_at ? Math.floor((Date.now() / 1000 - soul.ghost_at) / 86_400) : 0;
  const presence = services.vc.presence(target.id, 36_500);
  const vcHours = Math.floor(presence.totalSeconds / 3600);
  const titles = services.titles.list(target.id);

  const member = interaction.guild?.members.cache.get(target.id) as GuildMember | undefined;
  const rank = soul ? (RANK_LABEL[soul.status] ?? soul.status) : "記録なし";

  const embed = new EmbedBuilder()
    .setTitle(`📜 ${member?.displayName ?? target.username} の魂の記録`)
    .setThumbnail(target.displayAvatarURL())
    .setColor(0x6b21a8)
    .addFields(
      { name: "階級", value: rank, inline: true },
      { name: "所持", value: fmtLd(balance), inline: true },
      { name: "在城", value: daysInCastle > 0 ? `${daysInCastle}日` : "—", inline: true },
      { name: "累計浮上", value: vcHours > 0 ? `${vcHours}時間` : "—", inline: true },
      { name: "出現日数", value: presence.daysSeen > 0 ? `${presence.daysSeen}日` : "—", inline: true },
      { name: "称号数", value: `${titles.length}`, inline: true },
      {
        name: "獲得称号",
        value:
          titles.length > 0
            ? titles.map((t) => `${t.emoji} **${t.name}** — ${t.desc}`).join("\n")
            : "まだ称号を持っていない。城で生きた証がここに刻まれる。",
      },
    );
  if (soul?.status === "ghost" && soul.eval_deadline_at) {
    embed.setFooter({ text: `審判期限まで…` }).addFields({ name: "審判", value: `<t:${soul.eval_deadline_at}:R>`, inline: true });
  }

  const lines: string[] = [];
  if (newlyGranted.length > 0 && isSelf) {
    lines.push(`🎉 新たな称号を獲得: ${newlyGranted.map((t) => `${t.emoji}${t.name}`).join(" / ")}`);
  }

  await interaction.reply({
    content: lines.length > 0 ? lines.join("\n") : undefined,
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}
