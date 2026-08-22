import { describe, expect, it } from "vitest";
import { Collection, ChannelType } from "discord.js";
import type { Client, Message } from "discord.js";
import { openDb, RankEngine, Settings, TitleV2Store, textLevel, voiceLevel } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { handleMessageXp, tickVoiceXp } from "../src/rank-tracker.js";

/**
 * PR #159レビュー §1-2: `rank-title-wiring.test.ts`は主に`recordLiveRankTitleUnlock()`を
 * 直接呼んでいたため、`rank-tracker.ts`の実callsite（`handleMessageXp()`/`tickVoiceXp()`
 * 内の`recordLiveRankTitleUnlock(...)`呼び出し）を削除してもhelper単体testはgreenのまま
 * になり得た。このファイルは production entry point（`handleMessageXp`/`tickVoiceXp`
 * そのもの）を実際に呼び、成功XP award → rank-title sidecar → `rank_title_unlocks`まで
 * 到達することを直接固定する——rank-tracker.ts側のcallsiteが削除されればこのtestが
 * fallthroughして失敗する。
 *
 * 通知等のDiscord外部I/Oを避けるため、tierUp=falseだがcurrent-tier unlock欠損
 * （pre-v2 user相当）のfixtureを使う——`notifyRankUp()`（Discord送信を伴う）へ
 * 分岐しない経路で、sidecar到達だけを検証する。
 */

/** levelFn(xp)がlevel以上になる最小のxpを二分探索する（`textXpPerLevel`等はpackage exports
 * のsubpath公開対象外のため、公開済みの`textLevel`/`voiceLevel`だけで逆算する）。 */
function minXpForLevel(level: number, levelFn: (xp: number) => number): number {
  if (level === 0) return 0;
  let lo = 0;
  let hi = 1;
  while (levelFn(hi) < level) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (levelFn(mid) >= level) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function setup() {
  const db = openDb(":memory:");
  const ranks = new RankEngine(db);
  const titleV2 = new TitleV2Store(db);
  const settings = new Settings(db);
  const services = { ranks, titleV2, settings } as unknown as Services;
  return { db, ranks, titleV2, settings, services };
}

function fakeMessage(userId: string): Message {
  return {
    author: { bot: false, id: userId },
    inGuild: () => true,
    content: "hello",
    attachments: { size: 0 },
    channel: { parentId: null },
    channelId: "chan-1",
  } as unknown as Message;
}

function fakeVoiceChannel(id: string, humanIds: readonly string[]) {
  const members = new Collection(humanIds.map((uid) => [uid, { id: uid, user: { bot: false } }] as const));
  return { id, type: ChannelType.GuildVoice, parentId: null, members };
}

function fakeClientWithVoiceChannel(channel: ReturnType<typeof fakeVoiceChannel>): Client {
  const channelsCache = new Collection([[channel.id, channel] as const]);
  const guild = { channels: { cache: channelsCache } };
  return { guilds: { fetch: async () => guild } } as unknown as Client;
}

describe("handleMessageXp() — production callsiteの実配線固定", () => {
  it("成功したtext XP award → recordLiveRankTitleUnlock() → rank_title_unlocksまで実際に到達する", async () => {
    const { db, ranks, titleV2, services } = setup();
    const userId = "prod-text-user";
    ranks.awardText(userId, minXpForLevel(75, textLevel), 0); // pre-v2相当: current tier unlock無し
    db.prepare(`UPDATE rank_text SET last_award_at = 0 WHERE user_id = ?`).run(userId); // cooldown回避
    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv075")).toBe(false);

    await handleMessageXp(fakeMessage(userId), services);

    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv075")).toBe(true);
    expect(titleV2.rankTitleUnlock(userId, "rank.text.lv075")?.unlockedAt).toBeNull();
  });
});

describe("tickVoiceXp() — production callsiteの実配線固定", () => {
  it("2人以上のVCでのvoice XP award → recordLiveRankTitleUnlock() → rank_title_unlocksまで実際に到達する", async () => {
    const { ranks, titleV2, settings, services } = setup();
    settings.set("guild:main", "guild-1", "test");
    const userId = "prod-voice-user";
    ranks.awardVoice(userId, minXpForLevel(75, voiceLevel), 5); // pre-v2相当: current tier unlock無し
    expect(titleV2.hasRankTitleUnlock(userId, "rank.voice.lv075")).toBe(false);

    const channel = fakeVoiceChannel("vc-1", [userId, "bystander"]); // 2人以上必須
    const client = fakeClientWithVoiceChannel(channel);

    await tickVoiceXp(client, services);

    expect(titleV2.hasRankTitleUnlock(userId, "rank.voice.lv075")).toBe(true);
    expect(titleV2.rankTitleUnlock(userId, "rank.voice.lv075")?.unlockedAt).toBeNull();
    // textとkeyが衝突しないことも間接確認
    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv075")).toBe(false);
  });
});
