import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder, type GuildMember } from "discord.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

/** 昇格面談の合格後に実行する昇格処理（入城導線⑦の最終段） */
export const promoteCommand = new SlashCommandBuilder()
  .setName("昇格")
  .setDescription("面談合格者を魔人に昇格させる（審・運営専用）")
  .setDMPermission(false)
  .addUserOption((o) => o.setName("対象").setDescription("昇格させる亡霊").setRequired(true));

function isShin(interaction: ChatInputCommandInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const shinRoleId = services.settings.getString("role:shin");
  if (!shinRoleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(shinRoleId) ?? false;
}

export async function handlePromote(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isShin(interaction, services)) {
    await interaction.reply({ content: "昇格の実行は審・運営のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const target = interaction.options.getUser("対象", true);
  const soul = services.entry.getSoul(target.id);
  if (soul?.status !== "ghost") {
    await interaction.reply({
      content: `対象は亡霊ではありません（現在: ${soul?.status ?? "記録なし"}）。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  services.evaluation.promoteToMajin(target.id, `user:${interaction.user.id}`);

  const member = await interaction.guild!.members.fetch(target.id).catch(() => null);
  if (member) {
    // 魔人を先に付けてから亡霊・面談ロールを剥がす。逆順にすると Discord の2イベント間で
    // handleMemberRoleUpdate ③（亡霊剥奪検知）が「他の階級ロールなし」と誤判定して
    // 案内待ちにリセットしてしまう副作用を起こす。
    const majinRoleId = services.settings.getString("role:majin");
    if (majinRoleId) await member.roles.add(majinRoleId).catch(() => undefined);
    const remove = ["role:ghost", "role:mendan"]
      .map((k) => services.settings.getString(k))
      .filter((id): id is string => !!id);
    for (const roleId of remove) await member.roles.remove(roleId).catch(() => undefined);
  }

  // 昇格のお知らせ自動投稿（給与テーブルはロール参照なので切替は自動）
  const announceId = services.settings.getString("channel:announce");
  if (announceId) {
    const channel = await interaction.client.channels.fetch(announceId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send(
        `⚔️ **昇格のお知らせ** — 審判を乗り越え、<@${target.id}> が **魔人** へと昇格しました。祝福を。`,
      );
    }
  }

  await interaction.editReply({
    content: `✅ <@${target.id}> を魔人に昇格させました（ロール切替・お知らせ投稿・給与テーブルは次回支給から自動反映）。`,
  });
}
