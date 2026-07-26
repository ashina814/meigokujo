import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type VoiceChannel } from "discord.js";
import type { RoomRow } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

function isUnknownChannel(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === 10003 || code === "10003";
}

async function fetchRoomChannel(client: Client, room: RoomRow): Promise<VoiceChannel | null> {
  const channel = await client.channels.fetch(room.channel_id).catch((error) => {
    if (isUnknownChannel(error)) return null;
    console.error("[room] チャンネル取得失敗", { roomId: room.id, channelId: room.channel_id, error });
    throw error;
  });
  return channel as VoiceChannel | null;
}

async function deleteRoomChannel(client: Client, services: Services, room: RoomRow, reason: string): Promise<boolean> {
  let channel: VoiceChannel | null;
  try {
    channel = await fetchRoomChannel(client, room);
  } catch (error) {
    services.rooms.markDeleteFailed(room.id, error);
    return false;
  }
  if (!channel) {
    services.rooms.markDeletedAndClosed(room.id, room.close_reason ?? reason);
    return true;
  }
  try {
    await channel.delete(reason);
    services.rooms.markDeletedAndClosed(room.id, room.close_reason ?? reason);
    return true;
  } catch (error) {
    console.error("[room] チャンネル削除失敗", { roomId: room.id, channelId: room.channel_id, reason, error });
    services.rooms.markDeleteFailed(room.id, error);
    return false;
  }
}

async function notifyOwner(client: Client, userId: string, content: string): Promise<void> {
  const user = await client.users.fetch(userId).catch(() => null);
  await user?.send(content).catch((error) => {
    console.error("[room] オーナーDM送信失敗", { userId, error });
  });
}

async function closeWithDelete(
  client: Client,
  services: Services,
  room: RoomRow,
  closeReason: string,
  deleteReason: string,
  opts: { refundUnused?: boolean; dm?: string } = {},
): Promise<void> {
  services.rooms.requestDelete(room.id, closeReason);
  const deleted = await deleteRoomChannel(client, services, services.rooms.get(room.id), deleteReason);
  if (!deleted) return;
  if (opts.refundUnused) {
    const { refunded } = services.rooms.refundUnusedPaidRoom(room.id);
    if (refunded > 0) {
      await notifyOwner(
        client,
        room.owner_id,
        [
          "作成後、一度も人間が入室していなかった有料部屋をBotの未利用整理で削除しました。",
          `返金額: ${fmtLd(refunded)}`,
          "もう一度使う場合は、部屋パネルから再作成してください。",
        ].join("\n"),
      );
    }
  }
  if (opts.dm) await notifyOwner(client, room.owner_id, opts.dm);
}

export async function scanRooms(client: Client, services: Services): Promise<void> {
  const guildId = services.settings.getString("guild:main");
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;

  for (const room of services.rooms.listPendingDelete()) {
    await deleteRoomChannel(client, services, room, room.close_reason ?? "部屋の削除再試行").catch((error) => {
      console.error("[room] pending_delete再試行失敗", { roomId: room.id, error });
    });
  }

  for (const room of services.rooms.listOpen()) {
    if (room.pending_delete) continue;
    try {
      const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
      if (!channel) {
        services.rooms.markDeletedAndClosed(room.id, "channel_missing");
        continue;
      }
      const humans = channel.members.filter((m) => !m.user.bot).size;
      services.rooms.markOccupancy(room.id, humans > 0);
    } catch (error) {
      console.error("[room] 在室状態更新失敗", { roomId: room.id, error });
    }
  }

  for (const room of services.rooms.gamesNeedingWarning()) {
    try {
      const channel = (await guild.channels.fetch(room.channel_id).catch(() => null)) as VoiceChannel | null;
      if (channel?.isTextBased()) {
        const tiers = services.rooms.gameTiers();
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...tiers.slice(0, 4).map(([h, price]) =>
            new ButtonBuilder().setCustomId(`room:extend:${room.id}:${h}`).setLabel(`+${h}h (${price.toLocaleString()})`).setStyle(ButtonStyle.Secondary),
          ),
        );
        await channel.send({ content: "⚠️ 利用期限まであと10分です。延長する場合は確認画面へ進んでください。", components: [row] });
      }
      services.rooms.markWarned(room.id);
    } catch (error) {
      console.error("[room] ゲーム部屋期限警告失敗", { roomId: room.id, error });
    }
  }

  for (const room of services.rooms.expiredRooms()) {
    await closeWithDelete(client, services, room, "expired", "利用期限切れ", {
      dm: `${room.kind === "game" ? "ゲーム部屋" : "部屋"}は利用期限切れのため削除しました。`,
    }).catch((error) => {
      console.error("[room] 期限切れ処理失敗", { roomId: room.id, error });
    });
  }

  const emptyGrace = services.settings.getNumber("room_empty_grace_min");
  const unusedGrace = services.settings.getNumber("room_unused_grace_min");
  for (const room of services.rooms.dueForDeletion(emptyGrace, unusedGrace)) {
    const unused = room.activated_at === null;
    await closeWithDelete(client, services, room, unused ? "unused" : "empty", unused ? "未入室のまま削除猶予を超過" : "全員退出のため自動削除", {
      refundUnused: unused && room.kind !== "normal",
      dm: unused
        ? undefined
        : "部屋は全員退出後の削除猶予を過ぎたため削除しました。通常の全員退出クローズでは返金はありません。",
    }).catch((error) => {
      console.error("[room] 自動削除処理失敗", { roomId: room.id, error });
    });
  }

  for (const { recruit, room, refunded } of services.rooms.expireRecruits()) {
    try {
      if (recruit.panel_channel_id && recruit.panel_message_id) {
        const pc = await client.channels.fetch(recruit.panel_channel_id).catch(() => null);
        if (pc?.isTextBased() && "messages" in pc) {
          const msg = await pc.messages.fetch(recruit.panel_message_id).catch(() => null);
          await msg?.edit({ content: "（この蜜月募集は期限切れになりました）", components: [] }).catch(() => undefined);
        }
      }
      await closeWithDelete(client, services, room, "recruit_expired", "蜜月募集失効", {
        dm: `🌸 蜜月の募集が無応募のまま失効しました。設定額 **${fmtLd(refunded)}** を返金しました。`,
      });
    } catch (error) {
      console.error("[room] 蜜月募集失効処理失敗", { recruitId: recruit.id, roomId: room.id, error });
    }
  }
}
