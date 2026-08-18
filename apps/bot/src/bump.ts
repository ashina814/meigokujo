import type { Message } from "discord.js";
import { TREASURY } from "@meigokujo/core";
import { handleBoostRewardMessage } from "./boost-reward.js";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

const DISBOARD_ID = "302050872383242240";
/** ディス速（Dissoku）。設定 bump_dissoku_bot_id で上書き可 */
const DISSOKU_DEFAULT_ID = "761562078095867916";
/** 冥獄城の bump/up 受付チャンネル。設定 channel:bump で上書き可 */
const BUMP_CHANNEL_DEFAULT_ID = "1466310307994665000";
/** 実運用では DISBOARD /bump・ディス速 /up ともに2時間 */
const COOLDOWN_SEC = { disboard: 2 * 3600, dissoku: 2 * 3600 } as const;
/** 掲示板Botは応答投稿後にembedを完成させることがあるため、有限回だけ再取得する。 */
const BUMP_RETRY_DELAYS_MS = [1_000, 3_000, 7_000] as const;

type BumpKind = keyof typeof COOLDOWN_SEC;
type LegacyInteraction = {
  user?: { id: string; bot?: boolean };
  name?: string;
  commandName?: string;
};
type BumpHandleOptions = {
  retryAttempt?: number;
};

function compact(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Discord上の見た目と同じ範囲を成功判定へ含める。 */
export function bumpMessageText(message: Pick<Message, "content" | "embeds">): string {
  return compact(
    [
      message.content,
      ...message.embeds.flatMap((embed) => [
        embed.title ?? "",
        embed.description ?? "",
        ...embed.fields.flatMap((field) => [field.name, field.value]),
      ]),
    ].join(" "),
  );
}

function invocation(message: Message): {
  name: string | undefined;
  user: { id: string; bot?: boolean } | undefined;
} {
  const legacy = (message as Message & { interaction?: LegacyInteraction | null }).interaction;
  const metadata = message.interactionMetadata as
    | (NonNullable<Message["interactionMetadata"]> & { name?: string })
    | null;
  return {
    // discord.jsの版によってcommand名の公開位置が異なるため、取得できる場所を順に見る。
    name: legacy?.commandName ?? legacy?.name ?? metadata?.name,
    user: metadata?.user ?? legacy?.user,
  };
}

function reject(message: Message, reason: string): void {
  console.warn(
    `[bump] 除外 reason=${reason} message=${message.id} author=${message.author.id} guild=${message.guildId ?? "dm"} channel=${message.channelId}`,
  );
}

function scheduleBumpRetry(
  message: Message,
  services: Services,
  kind: BumpKind,
  retryAttempt: number,
): void {
  const delayMs = BUMP_RETRY_DELAYS_MS[retryAttempt];
  if (delayMs === undefined) return;

  console.info(
    `[bump] 応答の完成待ち kind=${kind} message=${message.id} attempt=${retryAttempt + 1} delayMs=${delayMs}`,
  );

  const timer = setTimeout(() => {
    void message
      .fetch(true)
      .then((fresh) => handleBumpMessage(fresh, services, { retryAttempt: retryAttempt + 1 }))
      .catch((error) =>
        console.warn(
          `[bump] 応答の再取得失敗 kind=${kind} message=${message.id} attempt=${retryAttempt + 1}:`,
          error,
        ),
      );
  }, delayMs);
  timer.unref?.();
}

/**
 * MessageCreateの経済報酬入口。
 * 先にサーバーブーストを処理し、それ以外だけbump/up判定へ流す。
 */
export async function handleBumpMessage(
  message: Message,
  services: Services,
  options: BumpHandleOptions = {},
): Promise<void> {
  if (await handleBoostRewardMessage(message, services)) return;
  if (!message.author.bot) return;

  const dissokuId = services.settings.getString("bump_dissoku_bot_id") ?? DISSOKU_DEFAULT_ID;
  const isDisboard = message.author.id === DISBOARD_ID;
  const isDissoku = message.author.id === dissokuId;
  if (!isDisboard && !isDissoku) return;

  const kind: BumpKind = isDisboard ? "disboard" : "dissoku";
  const mainGuildId = services.settings.getString("guild:main");
  if (!mainGuildId || message.guildId !== mainGuildId) {
    reject(message, "guild_mismatch");
    return;
  }

  const bumpChannelId = services.settings.getString("channel:bump") ?? BUMP_CHANNEL_DEFAULT_ID;
  if (message.channelId !== bumpChannelId) {
    reject(message, "channel_mismatch");
    return;
  }

  const interaction = invocation(message);
  const expectedCommand = isDisboard ? "bump" : "up";
  // discord.jsがcommand名を公開しない版では、Bot ID・Guild・Channel・成功文面で判定する。
  if (interaction.name !== undefined && interaction.name !== expectedCommand) {
    reject(message, `command_mismatch:${interaction.name}`);
    return;
  }

  const runner = interaction.user;
  if (!runner || runner.bot) {
    reject(message, "runner_missing");
    return;
  }

  const text = bumpMessageText(message);
  const success = isDisboard
    ? /表示順をアップしたよ|Bump done/i.test(text)
    : /をアップしたよ|UPしたよ/i.test(text);
  if (!success) {
    // クールタイム等の明示的な失敗は完成済み応答なので再取得しない。
    const explicitFailure = /失敗|間隔をあけて|あと\s*\d+\s*分|しばらく待/i.test(text);
    reject(message, explicitFailure ? "failure_response" : "success_text_missing");

    const retryAttempt = options.retryAttempt ?? 0;
    if (!explicitFailure) {
      scheduleBumpRetry(message, services, kind, retryAttempt);
    }
    return;
  }

  const reward = services.settings.getNumber("bump_reward");
  let duplicateReward = false;

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
    duplicateReward = result.duplicate;

    if (!duplicateReward && message.channel.isSendable()) {
      await message.channel
        .send(`💰 <@${runner.id}> に${isDisboard ? "bump" : "up"}報酬 **${fmtLd(reward)}** を支給しました。`)
        .catch((error) => console.warn(`[bump] 支給通知失敗 message=${message.id}:`, error));
    }
  }

  // 報酬0でも実績は記録する。同一メッセージIDは addOnce が二重加算を防ぐ。
  // 送金済み・回数未加算で止まった場合も、再処理時に回数だけ追いつける。
  const counted = services.bumps.addOnce(message.id, runner.id);
  if (!counted) return;

  services.settings.set(
    `bump:cooldown:${kind}`,
    { until: Math.floor(Date.now() / 1000) + COOLDOWN_SEC[kind], channelId: message.channelId },
    "system:bump",
  );

  console.info(
    `[bump] 成功 kind=${kind} message=${message.id} user=${runner.id} reward=${reward} duplicateReward=${duplicateReward}`,
  );
}

/** 刻時盤から毎分呼ばれる: クールタイムが明けていたら紹介協力者に通知 */
export async function checkBumpCooldowns(
  client: import("discord.js").Client,
  services: Services,
): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);

  for (const kind of ["disboard", "dissoku"] as const) {
    const key = `bump:cooldown:${kind}`;
    const raw = services.settings.getJson<{ until: number; channelId: string } | null>(key, null);
    if (!raw) continue;

    // 旧実装が残した完了値を一度だけ削除し、毎分の監査ログ増殖を止める。
    if (raw.until <= 0) {
      services.settings.delete(key, "system:bump");
      continue;
    }
    if (raw.until > nowTs) continue;

    if (!raw.channelId) {
      console.warn(`[bump] クールダウン通知先なし kind=${kind}`);
      services.settings.delete(key, "system:bump");
      continue;
    }

    try {
      const channel = await client.channels.fetch(raw.channelId);
      if (!channel?.isTextBased() || !("send" in channel)) {
        console.warn(`[bump] クールダウン通知先が送信不可 kind=${kind} channel=${raw.channelId}`);
        continue;
      }

      const notifyRoleId = services.settings.getString("role:bump_notify");
      await channel.send(
        `⏰ ${notifyRoleId ? `<@&${notifyRoleId}> ` : ""}${kind === "disboard" ? "/bump" : "/up"} のクールタイムが明けました！`,
      );

      // 送信成功後にだけ完了扱いにする。失敗時は設定を残して次tickで再試行する。
      services.settings.delete(key, "system:bump");
      console.info(`[bump] クールダウン通知成功 kind=${kind} channel=${raw.channelId}`);
    } catch (error) {
      console.warn(`[bump] クールダウン通知失敗・再試行予定 kind=${kind} channel=${raw.channelId}:`, error);
    }
  }
}
