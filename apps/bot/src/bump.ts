import type { Message } from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

const DISBOARD_ID = "302050872383242240";
/** ディス速（Dissoku）。設定 bump_dissoku_bot_id で上書き可 */
const DISSOKU_DEFAULT_ID = "761562078095867916";
/** クールタイム: DISBOARD /bump = 2時間、ディス速 /up = 1時間 */
const COOLDOWN_SEC = { disboard: 2 * 3600, dissoku: 1 * 3600 } as const;

/**
 * bump/up 報酬（ボット設計.md）: 掲示板ボットの成功メッセージを検知して実行者に自動記帳。
 * 成功判定: DISBOARD「表示順をアップしたよ」/ ディス速「UPしたよ」/ 英語版「Bump done」。
 * 失敗メッセージ（「あとN分」「UPに失敗」等）はどれにもマッチしない。
 */
export async function handleBumpMessage(message: Message, services: Services): Promise<void> {
  if (!message.author.bot) return;
  const dissokuId = services.settings.getString("bump_dissoku_bot_id") ?? DISSOKU_DEFAULT_ID;
  const isDisboard = message.author.id === DISBOARD_ID;
  const isDissoku = message.author.id === dissokuId;
  if (!isDisboard && !isDissoku) return;

  const runner = message.interactionMetadata?.user;
  if (!runner || runner.bot) return;

  const embedText = message.embeds
    .map((e) => `${e.description ?? ""} ${e.fields.map((f) => f.value).join(" ")}`)
    .join(" ");
  if (!/(アップ|UP)したよ|Bump done/i.test(embedText)) return;

  const reward = services.settings.getNumber("bump_reward");
  if (reward > 0) {
    const accountId = `user:${runner.id}`;
    services.ledger.ensureAccount(accountId, "user");
    const result = services.ledger.transfer({
      from: TREASURY,
      to: accountId,
      amount: reward,
      type: "reward_bump",
      actor: "system:bump",
      reason: isDisboard ? "bump報酬" : "up報酬",
      idempotencyKey: `bump:${message.id}`,
    });
    if (!result.duplicate && message.channel.isSendable()) {
      await message.channel
        .send(`💰 <@${runner.id}> に${isDisboard ? "bump" : "up"}報酬 **${fmtLd(reward)}** を支給しました。`)
        .catch(() => undefined);
    }
    // ランキング用のbumpカウント（初回・冪等ではないが tx が冪等なので重複防止は台帳側で担保）
    if (!result.duplicate) services.bumps.add(runner.id);
  }

  // クールタイム終了通知の予約（DISBOARD 2h / ディス速 1h・刻時盤が拾う）
  const kind = isDisboard ? "disboard" : "dissoku";
  services.settings.set(
    `bump:cooldown:${kind}`,
    { until: Math.floor(Date.now() / 1000) + COOLDOWN_SEC[kind], channelId: message.channelId },
    "system:bump",
  );
}

/** 刻時盤から毎分呼ばれる: クールタイムが明けていたら紹介協力者に通知 */
export async function checkBumpCooldowns(
  client: import("discord.js").Client,
  services: Services,
): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  for (const kind of ["disboard", "dissoku"] as const) {
    const raw = services.settings.getJson<{ until: number; channelId: string } | null>(
      `bump:cooldown:${kind}`,
      null,
    );
    if (!raw || raw.until > nowTs) continue;
    services.settings.set(`bump:cooldown:${kind}`, { until: 0, channelId: "" }, "system:bump");
    if (!raw.channelId) continue;
    const channel = await client.channels.fetch(raw.channelId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      const notifyRoleId = services.settings.getString("role:bump_notify");
      await channel.send(
        `⏰ ${notifyRoleId ? `<@&${notifyRoleId}> ` : ""}${kind === "disboard" ? "/bump" : "/up"} のクールタイムが明けました！`,
      );
    }
  }
}
