import type { Client, TextChannel } from "discord.js";
import type { Services } from "./services.js";

/**
 * ユーザーへ通知する。まず DM を試み、DM が不達（DM拒否・ブロック等）なら
 * 指定のフォールバックチャンネルへメンション付きで投稿する。
 * どちらも届かなければ delivered=false。
 */
export async function notifyUser(
  client: Client,
  services: Services,
  userId: string,
  content: string,
  opts: { fallbackChannelKey?: string } = {},
): Promise<{ delivered: boolean; via: "dm" | "channel" | "none" }> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
    return { delivered: true, via: "dm" };
  } catch {
    // DM が開いていない → フォールバックへ
  }
  const chId = opts.fallbackChannelKey ? services.settings.getString(opts.fallbackChannelKey) : null;
  if (chId) {
    const ch = (await client.channels.fetch(chId).catch(() => null)) as TextChannel | null;
    if (ch?.isTextBased()) {
      const sent = await ch
        .send({ content: `<@${userId}> ${content}`, allowedMentions: { users: [userId] } })
        .catch(() => null);
      if (sent) return { delivered: true, via: "channel" };
    }
  }
  return { delivered: false, via: "none" };
}
