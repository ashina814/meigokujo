import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type VoiceChannel } from "discord.js";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/**
 * 部屋のライフサイクル管理（刻時盤から毎分）:
 * 在室スキャン → 全員退出＋猶予で削除 / ゲーム部屋の期限警告・失効 / 蜜月募集の失効返金。
 */
export async function scanRooms(client: Client, services: Services): Promise<void> {
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;

  // ① 在室状況の更新
  for (const room of services.rooms.listOpen()) {
    const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
    if (!channel) {
      services.rooms.close(room.id, "チャンネル消失");
      continue;
    }
    const humans = channel.members.filter((m) => !m.user.bot).size;
    services.rooms.markOccupancy(room.id, humans > 0);
  }

  // ② ゲーム部屋: 期限10分前の延長案内
  for (const room of services.rooms.gamesNeedingWarning()) {
    const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
    services.rooms.markWarned(room.id);
    if (channel?.isTextBased()) {
      const tiers = services.rooms.gameTiers();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...tiers.slice(0, 4).map(([h, price]) =>
          new ButtonBuilder().setCustomId(`room:extend:${room.id}:${h}`).setLabel(`+${h}h (${price.toLocaleString()})`).setStyle(ButtonStyle.Secondary),
        ),
      );
      await channel.send({ content: "⏰ 利用期限まであと10分です。延長しますか？", components: [row] }).catch(() => undefined);
    }
  }

  // ③ ゲーム部屋: 期限切れ → 閉じる
  for (const room of services.rooms.expiredGames()) {
    const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
    services.rooms.close(room.id, "利用期限切れ");
    await channel?.delete("利用期限切れ").catch(() => undefined);
  }

  // ④ 全員退出＋猶予で削除
  const grace = services.settings.getNumber("room_empty_grace_min");
  for (const room of services.rooms.dueForDeletion(grace)) {
    const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
    services.rooms.close(room.id, "全員退出");
    await channel?.delete("全員退出のため自動削除").catch(() => undefined);
  }

  // ⑤ 蜜月募集の失効 → 半額返金 + 部屋とパネルの片付け
  for (const { recruit, room, refunded } of services.rooms.expireRecruits()) {
    const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
    // 誰も入っていなければ部屋も閉じる
    if (!channel || channel.members.filter((m) => !m.user.bot).size === 0) {
      services.rooms.close(room.id, "募集失効");
      await channel?.delete("募集失効").catch(() => undefined);
    }
    if (recruit.panel_channel_id && recruit.panel_message_id) {
      const pc = await client.channels.fetch(recruit.panel_channel_id).catch(() => null);
      if (pc?.isTextBased() && "messages" in pc) {
        const msg = await pc.messages.fetch(recruit.panel_message_id).catch(() => null);
        await msg?.delete().catch(() => undefined);
      }
    }
    const owner = await client.users.fetch(recruit.owner_id).catch(() => null);
    await owner?.send(`🌸 蜜月の募集が無応募のまま失効しました。半額 **${fmtLd(refunded)}** を返金しました。`).catch(() => undefined);
  }
}
