import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { handleRecruitModal, handleRoomButton } from "../src/commands/rooms.js";
import { trackVoiceState } from "../src/vc-tracking.js";

/**
 * 宿VCの生成先。
 *
 * 生成先は「操作されたパネルがたまたま置かれている場所」ではなく、種別ごとの設定で決める。
 * とくに秘密の宿(朧月)は **DMの承諾ボタン**から作られるので参照できる親カテゴリが無く、
 * これまで常にカテゴリ外（サーバー直下）へ作られていた。カテゴリが付かないと
 * XP・浮上報酬の除外判定（チャンネルID または 親カテゴリID）が親側で成立せず、
 * 除外設定へ載せる方法が無くなる＝秘密の宿の滞在にXPが入る。
 */

const CATEGORY_ID = "cat-rooms";
const PANEL_CATEGORY_ID = "cat-panel-somewhere-else";

/** guild.channels.create に渡された parent を取り出す */
function createdParent(guild: { channels: { create: ReturnType<typeof vi.fn> } }): unknown {
  const arg = guild.channels.create.mock.calls.at(-1)?.[0] as { parent?: unknown } | undefined;
  return arg?.parent;
}

function makeGuild(categoryId: string | null) {
  const channel = {
    id: "made-vc",
    toString: () => "<#made-vc>",
    send: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    lockPermissions: vi.fn(async () => undefined),
  };
  return {
    guild: {
      roles: { everyone: { id: "everyone" } },
      members: {
        fetch: vi.fn(async (id: string) => ({ id, displayName: id, user: { bot: false }, send: vi.fn(), voice: {} })),
      },
      channels: {
        // 設定されたカテゴリだけがカテゴリとして解決できる
        fetch: vi.fn(async (id: string) =>
          categoryId && id === categoryId ? { id, type: ChannelType.GuildCategory } : null,
        ),
        create: vi.fn(async () => channel),
      },
    },
    channel,
  };
}

function makeServices(settings: Record<string, string>) {
  return {
    settings: {
      getString: vi.fn((key: string) => settings[key]),
      getNumber: vi.fn(() => 5),
    },
    rooms: {
      getOborozukiInviteByToken: vi.fn(() => ({
        id: 1,
        requester_id: "owner",
        target_id: "target",
        status: "pending",
        token: "token",
        price: 30000,
        expires_at: 999,
      })),
      acceptOborozukiInvite: vi.fn(() => ({
        room: { id: 30, kind: "oborozuki", channel_id: "made-vc", owner_id: "owner", status: "open", pending_delete: 0, expires_at: 123, capacity: 2 },
        invite: { id: 1 },
      })),
      panelValues: vi.fn(() => ({
        slotPrice: 7000, mitsugetsuPrice: 5000, oborozukiPrice: 30000, gameTiers: [],
        recruitExpireHours: 6, recruitRefund: 2500, emptyGraceMinutes: 5,
        unusedGraceMinutes: 5, loveRoomTtlHours: 12, normalMaxCapacity: 99,
      })),
      refundUnusedPaidRoom: vi.fn(() => ({ refunded: 0 })),
      requestDelete: vi.fn(),
      markDeletedAndClosed: vi.fn(),
      markDeleteFailed: vi.fn(),
    },
  };
}

/** 朧月はDMの承諾ボタンから作られる（parent を渡せる文脈が無い経路） */
function oborozukiAcceptInteraction(guild: unknown) {
  return {
    customId: "room:oboroaccept:token",
    isButton: () => true,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    user: { id: "target" },
    guild,
    // DM から押されるので channel から親カテゴリは取れない
    channel: null,
    client: { guilds: { fetch: vi.fn() } },
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

describe("宿VCは設定された正規カテゴリへ作られる", () => {
  it("秘密の宿（朧月）は設定カテゴリの中に作られる", async () => {
    const { guild } = makeGuild(CATEGORY_ID);
    const services = makeServices({ "category:room_oborozuki": CATEGORY_ID });

    await handleRoomButton(oborozukiAcceptInteraction(guild) as never, services as never);

    expect(guild.channels.create).toHaveBeenCalled();
    expect(createdParent(guild)).toEqual(expect.objectContaining({ id: CATEGORY_ID }));
  });

  it("種別ごとの指定が無ければ、宿共通カテゴリを使う", async () => {
    const { guild } = makeGuild(CATEGORY_ID);
    const services = makeServices({ "category:rooms": CATEGORY_ID });

    await handleRoomButton(oborozukiAcceptInteraction(guild) as never, services as never);

    expect(createdParent(guild)).toEqual(expect.objectContaining({ id: CATEGORY_ID }));
  });

  it("種別ごとの指定は共通カテゴリより優先される", async () => {
    const { guild } = makeGuild(CATEGORY_ID);
    const services = makeServices({ "category:rooms": "cat-other", "category:room_oborozuki": CATEGORY_ID });

    await handleRoomButton(oborozukiAcceptInteraction(guild) as never, services as never);

    expect(createdParent(guild)).toEqual(expect.objectContaining({ id: CATEGORY_ID }));
  });

  it("秘密の宿はDMから作られるので、パネルの位置に引きずられない", async () => {
    const { guild } = makeGuild(CATEGORY_ID);
    const services = makeServices({ "category:room_oborozuki": CATEGORY_ID });
    const interaction = oborozukiAcceptInteraction(guild) as Record<string, unknown>;
    // パネルが別カテゴリにある状況を作っても、生成先は設定のまま動かない
    interaction.channel = { isDMBased: () => false, parentId: PANEL_CATEGORY_ID };

    await handleRoomButton(interaction as never, services as never);

    expect(createdParent(guild)).toEqual(expect.objectContaining({ id: CATEGORY_ID }));
    expect(createdParent(guild)).not.toEqual(expect.objectContaining({ id: PANEL_CATEGORY_ID }));
  });

  it("カテゴリ未設定なら従来どおり（朧月はカテゴリ無し）", async () => {
    const { guild } = makeGuild(null);
    const services = makeServices({});

    await handleRoomButton(oborozukiAcceptInteraction(guild) as never, services as never);

    // 設定を入れるまで既存サーバーの挙動を変えない。この状態ではXP除外も効かない
    expect(guild.channels.create).toHaveBeenCalled();
    expect(createdParent(guild)).toBeUndefined();
  });
});

describe("蜜月はパネルの位置に引きずられない", () => {
  function mitsugetsuWorld(settings: Record<string, string>, categoryId: string | null) {
    const created = { id: "mitsu-vc", send: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), lockPermissions: vi.fn(async () => undefined) };
    const owner = { id: "owner", displayName: "owner", user: { bot: false }, voice: {}, roles: { cache: new Map() } };
    const guild = {
      client: { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send: vi.fn(async () => ({ id: "panel-msg" })) })) } },
      roles: { everyone: { id: "everyone" } },
      members: { fetch: vi.fn(async () => owner) },
      channels: {
        fetch: vi.fn(async (id: string) => (categoryId && id === categoryId ? { id, type: ChannelType.GuildCategory } : null)),
        create: vi.fn(async () => created),
      },
    };
    const services = {
      ledger: { balanceOf: vi.fn(() => 100000) },
      settings: {
        getString: vi.fn((key: string) =>
          key === "role:male" ? "male-role" : key === "channel:recruit" ? "recruit-channel" : settings[key],
        ),
      },
      rooms: {
        priceFor: vi.fn(() => 5000),
        ownershipConflict: vi.fn(() => undefined),
        registerWithRecruit: vi.fn(() => ({
          room: { id: 40, kind: "mitsugetsu", channel_id: "mitsu-vc", owner_id: "owner", status: "open", pending_delete: 0 },
          recruit: { id: 50, expires_at: 999 },
        })),
        setRecruitPanel: vi.fn(),
        refundUnusedPaidRoom: vi.fn(),
        requestDelete: vi.fn(),
        cancelRecruit: vi.fn(),
        markDeleteFailed: vi.fn(),
        markDeletedAndClosed: vi.fn(),
      },
    };
    const interaction = {
      customId: "room:recruit:male",
      user: { id: "owner" },
      guild,
      // パネルは別カテゴリに置かれている
      channel: { isDMBased: () => false, parentId: PANEL_CATEGORY_ID },
      fields: { getTextInputValue: vi.fn(() => "雑談") },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    return { guild, services, interaction };
  }

  it("設定があれば、パネルを別カテゴリへ動かしても生成先は変わらない", async () => {
    const { guild, services, interaction } = mitsugetsuWorld({ "category:room_mitsugetsu": CATEGORY_ID }, CATEGORY_ID);

    await handleRecruitModal(interaction as never, services as never);

    expect(createdParent(guild)).toEqual(expect.objectContaining({ id: CATEGORY_ID }));
  });

  it("未設定なら従来どおりパネルの親カテゴリへ作られる（既存サーバーを壊さない）", async () => {
    const { guild, services, interaction } = mitsugetsuWorld({}, PANEL_CATEGORY_ID);

    await handleRecruitModal(interaction as never, services as never);

    expect(createdParent(guild)).toEqual(expect.objectContaining({ id: PANEL_CATEGORY_ID }));
  });
});

describe("生成先カテゴリがXP除外へ繋がる", () => {
  /**
   * XP・浮上報酬の除外は「チャンネルID または 親カテゴリID」で判定する
   * （rank-tracker.ts / vc/rewards.ts）。カテゴリ配下で除外を効かせるには、
   * 計測に親カテゴリIDが乗っていることが前提になる。
   * 朧月がカテゴリ外に作られていた間は parentId が常に null で、
   * この前提が崩れていた＝除外設定に載せる手段が無かった。
   */
  it("宿カテゴリ配下のVCは、親カテゴリIDつきで計測される", () => {
    const open = vi.fn();
    const services = { vc: { open, close: vi.fn() } };
    const member = { id: "u1", user: { bot: false } };

    trackVoiceState(
      { channelId: null, member, selfMute: false, selfDeaf: false } as never,
      {
        channelId: "made-vc",
        member,
        selfMute: false,
        selfDeaf: false,
        channel: { id: "made-vc", parentId: CATEGORY_ID },
      } as never,
      services as never,
    );

    // この親カテゴリを xp_excluded_channels に入れれば、既存ロジックがそのまま外す
    expect(open).toHaveBeenCalledWith("u1", "made-vc", CATEGORY_ID, false, false);
  });

  it("カテゴリ外に作られたVCは親が無く、カテゴリ指定では除外できない", () => {
    const open = vi.fn();
    const services = { vc: { open, close: vi.fn() } };
    const member = { id: "u1", user: { bot: false } };

    trackVoiceState(
      { channelId: null, member, selfMute: false, selfDeaf: false } as never,
      { channelId: "root-vc", member, selfMute: false, selfDeaf: false, channel: { id: "root-vc", parentId: null } } as never,
      services as never,
    );

    // これが修正前の朧月の状態。除外はチャンネルID直指定しか手が無く、
    // 毎回IDが変わる宿では事実上不可能だった
    expect(open).toHaveBeenCalledWith("u1", "root-vc", null, false, false);
  });
});

describe("生成先カテゴリを解決できないときは作らない（fail-closed）", () => {
  /**
   * 指定されたカテゴリが消えている・別種別のIDが入っている、というだけで
   * サーバー直下へ宿VCが生まれると、親カテゴリでのXP除外がまた効かなくなる。
   * 黙って parent なしへ落ちるのではなく、作らずに失敗させる。
   */
  it("朧月: 存在しないカテゴリIDならVCを作らない", async () => {
    const { guild } = makeGuild(null); // どのIDも解決できない
    const services = makeServices({ "category:room_oborozuki": "cat-deleted" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interaction = oborozukiAcceptInteraction(guild);

    await handleRoomButton(interaction as never, services as never);

    expect(guild.channels.create).not.toHaveBeenCalled();
    // 課金もしない
    expect(services.rooms.acceptOborozukiInvite).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.editReply.mock.calls.at(-1)?.[0])).toContain("生成先カテゴリ設定");
    errorSpy.mockRestore();
  });

  it("朧月: 設定値がカテゴリ以外（テキストch等）を指していたらVCを作らない", async () => {
    const { guild } = makeGuild(null);
    // ID は取れるがカテゴリではない
    guild.channels.fetch = vi.fn(async (id: string) => ({ id, type: ChannelType.GuildText }));
    const services = makeServices({ "category:room_oborozuki": "not-a-category" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleRoomButton(oborozukiAcceptInteraction(guild) as never, services as never);

    expect(guild.channels.create).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("蜜月: 設定カテゴリが削除済みでも、パネルの親へ勝手にfallbackしない", async () => {
    const created = { id: "mitsu-vc", send: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), lockPermissions: vi.fn(async () => undefined) };
    const owner = { id: "owner", displayName: "owner", user: { bot: false }, voice: {}, roles: { cache: new Map() } };
    const guild = {
      client: { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send: vi.fn(async () => ({ id: "panel-msg" })) })) } },
      roles: { everyone: { id: "everyone" } },
      members: { fetch: vi.fn(async () => owner) },
      channels: {
        // 設定カテゴリは消えている。パネルの親カテゴリだけは生きている
        fetch: vi.fn(async (id: string) =>
          id === PANEL_CATEGORY_ID ? { id, type: ChannelType.GuildCategory } : null,
        ),
        create: vi.fn(async () => created),
      },
    };
    const services = {
      ledger: { balanceOf: vi.fn(() => 100000) },
      settings: {
        getString: vi.fn((key: string) =>
          key === "role:male" ? "male-role" : key === "channel:recruit" ? "recruit-channel" : key === "category:room_mitsugetsu" ? "cat-deleted" : undefined,
        ),
      },
      rooms: {
        priceFor: vi.fn(() => 5000),
        ownershipConflict: vi.fn(() => undefined),
        registerWithRecruit: vi.fn(),
        setRecruitPanel: vi.fn(),
        refundUnusedPaidRoom: vi.fn(),
        requestDelete: vi.fn(),
        cancelRecruit: vi.fn(),
        markDeleteFailed: vi.fn(),
        markDeletedAndClosed: vi.fn(),
      },
    };
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      customId: "room:recruit:male",
      user: { id: "owner" },
      guild,
      channel: { isDMBased: () => false, parentId: PANEL_CATEGORY_ID },
      fields: { getTextInputValue: vi.fn(() => "雑談") },
      deferReply: vi.fn(async () => undefined),
      editReply,
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleRecruitModal(interaction as never, services as never);

    // パネルの親カテゴリへ逃がさない。作らずに失敗させる
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(services.rooms.registerWithRecruit).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain("生成先カテゴリ設定");
    errorSpy.mockRestore();
  });
});
