import type { Client, MessageCreateOptions, TextChannel } from "discord.js";
import type { Services } from "./services.js";

export type DeliveryVia = "dm" | "channel" | "none";

/**
 * ユーザーへ届ける。まず DM を試み、DM が不達（DM拒否・ブロック等）なら
 * 指定のフォールバックチャンネルへメンション付きで投稿する。
 *
 * DM本文とフォールバック本文は**別物**として渡す。入城案内のように
 * 「DMには案内そのもの、公開chには『DMを送れなかった』の1行だけ」と
 * 出し分けたい場面があるため（設計案 確定事項2）。
 */
export async function deliverToUser(
  client: Client,
  services: Services,
  userId: string,
  opts: {
    dm: MessageCreateOptions;
    fallback?: { channelKey: string; content: string };
  },
): Promise<{ delivered: boolean; via: DeliveryVia }> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(opts.dm);
    return { delivered: true, via: "dm" };
  } catch {
    // DM が開いていない → フォールバックへ
  }
  if (!opts.fallback) return { delivered: false, via: "none" };

  const chId = services.settings.getString(opts.fallback.channelKey);
  if (chId) {
    const ch = (await client.channels.fetch(chId).catch(() => null)) as TextChannel | null;
    if (ch?.isTextBased()) {
      const sent = await ch
        .send({
          content: `<@${userId}> ${opts.fallback!.content}`,
          allowedMentions: { users: [userId] },
        })
        .catch(() => null);
      if (sent) return { delivered: true, via: "channel" };
    }
  }
  return { delivered: false, via: "none" };
}

/** 文面が同じでよい場合の薄いラッパ */
export async function notifyUser(
  client: Client,
  services: Services,
  userId: string,
  content: string,
  opts: { fallbackChannelKey?: string } = {},
): Promise<{ delivered: boolean; via: DeliveryVia }> {
  return deliverToUser(client, services, userId, {
    dm: { content },
    fallback: opts.fallbackChannelKey ? { channelKey: opts.fallbackChannelKey, content } : undefined,
  });
}
