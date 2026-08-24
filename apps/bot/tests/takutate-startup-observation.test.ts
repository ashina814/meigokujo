import { Collection, ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../src/services.js";
import { sweepStaleTables } from "../src/commands/takutate-panel.js";

const table = (channelId: string) => ({
  channel_id: channelId,
  guild_id: "guild-main",
  owner_id: `owner-${channelId}`,
  table_type: "duel",
  created_at: 1,
});

function voice(channelId: string, guestId: string) {
  return {
    id: channelId,
    type: ChannelType.GuildVoice,
    members: new Collection([
      [guestId, { id: guestId, user: { bot: false } }],
    ]),
    delete: vi.fn(),
  };
}

function setup(tables: ReturnType<typeof table>[], fetchChannel: (channelId: string) => Promise<unknown>) {
  const observeCurrentGuest = vi.fn();
  const takutate = {
    list: vi.fn(() => tables),
    untrack: vi.fn(),
    observeCurrentGuest,
  };
  const guild = { channels: { fetch: vi.fn(fetchChannel) } };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return {
    client: client as never,
    services: { takutate } as unknown as Services,
    observeCurrentGuest,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("takutate startup current-cache observation", () => {
  it("AN: channel fetch完了前の時間をtrusted guest stayへ含めない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    let finishFetch!: (value: unknown) => void;
    const pendingChannel = new Promise<unknown>((resolve) => { finishFetch = resolve; });
    const { client, services, observeCurrentGuest } = setup([table("table-a")], async () => pendingChannel);

    const sweep = sweepStaleTables(client, services);
    await vi.waitFor(() => expect(client.guilds.fetch).toHaveBeenCalled());
    expect(observeCurrentGuest).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(130_000));
    finishFetch(voice("table-a", "guest-a"));
    await sweep;

    expect(observeCurrentGuest).toHaveBeenCalledOnce();
    expect(observeCurrentGuest).toHaveBeenCalledWith("table-a", "guest-a", false, 130);
  });

  it("AO: 各卓を実際にfetchしたchannel単位の観測時刻から開始する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const fetchedAt = new Map([
      ["table-a", 130_000],
      ["table-b", 175_000],
    ]);
    const { client, services, observeCurrentGuest } = setup(
      [table("table-a"), table("table-b")],
      async (channelId) => {
        vi.setSystemTime(new Date(fetchedAt.get(channelId)!));
        return voice(channelId, `guest-${channelId}`);
      },
    );

    await sweepStaleTables(client, services);

    expect(observeCurrentGuest.mock.calls).toEqual([
      ["table-a", "guest-table-a", false, 130],
      ["table-b", "guest-table-b", false, 175],
    ]);
  });
});
