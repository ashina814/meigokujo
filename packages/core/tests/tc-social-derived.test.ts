import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import {
  computeTcConversationSafe,
  computeTcReactionSafe,
  type TcConversationSafePayload,
} from "../src/tc-social/derived.js";
import { TcSocialObservations, type TcSurfaceKind } from "../src/tc-social/service.js";

const BASE_MS = new Date("2026-08-20T00:00:00+09:00").getTime();
const DAY = 86_400_000;
const WINDOW = {
  start: Math.floor(BASE_MS / 1000),
  end: Math.floor((BASE_MS + 10 * DAY) / 1000),
  observedAt: Math.floor((BASE_MS + 10 * DAY) / 1000),
};

function setup() {
  const db = openDb(":memory:");
  const observations = new TcSocialObservations(db);
  return { db, observations };
}

function message(
  observations: TcSocialObservations,
  id: string,
  authorId: string,
  at: number,
  options: {
    surfaceId?: string;
    areaId?: string;
    surfaceKind?: TcSurfaceKind;
    replyTo?: string | null;
    observedAt?: number;
    threadOwnerId?: string | null;
    threadCreatedAt?: number | null;
  } = {},
) {
  observations.recordMessage({
    messageId: id,
    authorId,
    surfaceId: options.surfaceId ?? "channel-1",
    areaId: options.areaId ?? options.surfaceId ?? "channel-1",
    surfaceKind: options.surfaceKind ?? "channel",
    replyToMessageId: options.replyTo ?? null,
    createdAtMs: at,
    observedAtMs: options.observedAt ?? at + 1,
    threadOwnerId: options.threadOwnerId ?? null,
    threadCreatedAtMs: options.threadCreatedAt ?? null,
  });
}

function conversation(db: ReturnType<typeof openDb>, userId = "subject", window = WINDOW): TcConversationSafePayload {
  return computeTcConversationSafe(db, window, [userId])[0]!.payload;
}

describe("starts — quiet/free-flow/explicit continuation", () => {
  it("quietBeforeMs・nextOtherGapMs・direct reply continuationをthreshold-neutralに保持する", () => {
    const { db, observations } = setup();
    message(observations, "prior", "other", BASE_MS + 10_000);
    message(observations, "seed", "subject", BASE_MS + 100_000);
    message(observations, "reply", "other", BASE_MS + 120_000, { replyTo: "seed" });
    expect(conversation(db).starts).toEqual([
      { date: "2026-08-20", quietBeforeMs: 90_000, nextOtherGapMs: 20_000, explicitContinuation: true },
    ]);
  });

  it("scope内最初でprior不明ならquietBeforeMs=null（Infinityへしない）", () => {
    const { db, observations } = setup();
    message(observations, "seed", "subject", BASE_MS + 100_000);
    expect(conversation(db).starts[0]?.quietBeforeMs).toBeNull();
  });

  it("same-author投稿だけではother continuationにしない", () => {
    const { db, observations } = setup();
    message(observations, "seed", "subject", BASE_MS + 100_000);
    message(observations, "self-next", "subject", BASE_MS + 120_000);
    expect(conversation(db).starts[0]).toMatchObject({ nextOtherGapMs: null, explicitContinuation: false });
  });

  it("既存public threadの通常messageはrevivalになってもstartsへ入れない", () => {
    const { db, observations } = setup();
    const thread = {
      surfaceId: "thread-a",
      areaId: "forum-parent",
      surfaceKind: "forum_post" as const,
      threadOwnerId: "other",
      threadCreatedAt: BASE_MS,
    };
    message(observations, "thread-old", "other", BASE_MS + 10_000, thread);
    message(observations, "thread-resume", "subject", BASE_MS + DAY + 10_000, thread);
    message(observations, "thread-continued", "other", BASE_MS + DAY + 20_000, thread);
    const payload = conversation(db);
    expect(payload.starts).toEqual([]);
    expect(payload.revivalConversations).toEqual([
      { revivals: [{ date: "2026-08-21", dormantBeforeMs: DAY, continuationGapMs: 10_000 }] },
    ]);
  });
});

describe("revival explicit conversations", () => {
  it("reply root内のdormant gapとother continuation gapを保持する", () => {
    const { db, observations } = setup();
    message(observations, "root", "alice", BASE_MS + 10_000);
    message(observations, "resume", "subject", BASE_MS + DAY + 10_000, { replyTo: "root" });
    message(observations, "continued", "carol", BASE_MS + DAY + 20_000, { replyTo: "resume" });
    expect(conversation(db).revivalConversations).toEqual([
      { revivals: [{ date: "2026-08-21", dormantBeforeMs: DAY, continuationGapMs: 10_000 }] },
    ]);
  });

  it("resume後other continuation無しはnull", () => {
    const { db, observations } = setup();
    message(observations, "root", "alice", BASE_MS + 10_000);
    message(observations, "resume", "subject", BASE_MS + DAY, { replyTo: "root" });
    expect(conversation(db).revivalConversations[0]?.revivals[0]?.continuationGapMs).toBeNull();
  });

  it("同一conversationの複数resumeは同じanonymous group、異なるrootは別group", () => {
    const { db, observations } = setup();
    message(observations, "root-a", "alice", BASE_MS + 10_000);
    message(observations, "resume-a1", "subject", BASE_MS + DAY, { replyTo: "root-a" });
    message(observations, "resume-a2", "subject", BASE_MS + 2 * DAY, { replyTo: "resume-a1" });
    message(observations, "root-b", "bob", BASE_MS + 20_000, { surfaceId: "channel-2" });
    message(observations, "resume-b", "subject", BASE_MS + 3 * DAY, { surfaceId: "channel-2", replyTo: "root-b" });
    const groups = conversation(db).revivalConversations;
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.revivals.length)).toEqual([2, 1]);
    expect(groups.flatMap((group) => group.revivals.map((revival) => revival.date))).toEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
  });

  it("unresolved/cross-surface replyだけを除外し、trusted unrelated conversationを残す", () => {
    const { db, observations } = setup();
    message(observations, "broken", "subject", BASE_MS + 100, { replyTo: "missing" });
    message(observations, "root", "alice", BASE_MS + 200, { surfaceId: "good" });
    message(observations, "good", "subject", BASE_MS + 300, { surfaceId: "good", replyTo: "root" });
    expect(conversation(db).revivalConversations).toHaveLength(1);
  });
});

describe("logical areas and third-party joins", () => {
  it("same area multiple messagesは1 group、2 public channelは2 group", () => {
    const { db, observations } = setup();
    message(observations, "a1", "subject", BASE_MS + 10, { surfaceId: "a", areaId: "a" });
    message(observations, "a2", "subject", BASE_MS + 20, { surfaceId: "a", areaId: "a" });
    message(observations, "b1", "subject", BASE_MS + 30, { surfaceId: "b", areaId: "b" });
    expect(conversation(db).areas).toHaveLength(2);
  });

  it("10 public threads under同じparentをarea 1へ畳む", () => {
    const { db, observations } = setup();
    for (let index = 0; index < 10; index += 1) {
      message(observations, `thread-${index}`, "subject", BASE_MS + index, {
        surfaceId: `thread-${index}`,
        areaId: "forum-parent",
        surfaceKind: "forum_post",
        threadOwnerId: "subject",
        threadCreatedAt: BASE_MS + index,
      });
    }
    expect(conversation(db).areas).toHaveLength(1);
  });

  it("同じforum parentでも別threadのtemporal adjacencyをexchangeにしない", () => {
    const { db, observations } = setup();
    message(observations, "subject-a", "subject", BASE_MS + 100_000, {
      surfaceId: "thread-a",
      areaId: "forum-parent",
      surfaceKind: "forum_post",
    });
    message(observations, "other-b", "other", BASE_MS + 101_000, {
      surfaceId: "thread-b",
      areaId: "forum-parent",
      surfaceKind: "forum_post",
    });
    const payload = conversation(db);
    expect(payload.areas).toEqual([{ socialDays: [{ date: "2026-08-20", bestOtherGapMs: null }] }]);
    expect(payload.socialDays).toEqual([]);
  });

  it("forum parentは1 areaのまま、同一thread内のotherだけをexchangeに使う", () => {
    const { db, observations } = setup();
    message(observations, "subject-a", "subject", BASE_MS + 100_000, {
      surfaceId: "thread-a",
      areaId: "forum-parent",
      surfaceKind: "forum_post",
    });
    message(observations, "other-b", "other", BASE_MS + 101_000, {
      surfaceId: "thread-b",
      areaId: "forum-parent",
      surfaceKind: "forum_post",
    });
    message(observations, "other-a", "other-2", BASE_MS + 110_000, {
      surfaceId: "thread-a",
      areaId: "forum-parent",
      surfaceKind: "forum_post",
    });
    const payload = conversation(db);
    expect(payload.areas).toEqual([{ socialDays: [{ date: "2026-08-20", bestOtherGapMs: 10_000 }] }]);
    expect(payload.socialDays).toEqual([{ date: "2026-08-20", bestOtherGapMs: 10_000 }]);
  });

  it("subject-only threadsと別threadの大量other投稿をsocial evidenceへ変換しない", () => {
    const { db, observations } = setup();
    for (const surfaceId of ["thread-a", "thread-b", "thread-c"]) {
      message(observations, `subject-${surfaceId}`, "subject", BASE_MS + 100_000, {
        surfaceId,
        areaId: "forum-parent",
        surfaceKind: "forum_post",
      });
    }
    for (let index = 0; index < 20; index += 1) {
      message(observations, `other-${index}`, `other-${index}`, BASE_MS + 100_001 + index, {
        surfaceId: "thread-d",
        areaId: "forum-parent",
        surfaceKind: "forum_post",
      });
    }
    const payload = conversation(db);
    expect(payload.areas).toHaveLength(1);
    expect(payload.areas[0]?.socialDays).toEqual([{ date: "2026-08-20", bestOtherGapMs: null }]);
    expect(payload.socialDays).toEqual([]);
  });

  it("prior authorをidentity distinctにし、priorSelfとnextOtherのgapを保持する", () => {
    const { db, observations } = setup();
    message(observations, "alice-1", "alice", BASE_MS + 10_000);
    message(observations, "alice-2", "alice", BASE_MS + 20_000);
    message(observations, "carol", "carol", BASE_MS + 30_000);
    message(observations, "self-old", "subject", BASE_MS + 35_000);
    message(observations, "join", "subject", BASE_MS + 40_000);
    message(observations, "continued", "alice", BASE_MS + 50_000);
    const join = conversation(db).thirdPartyJoins.find((entry) => entry.priorSelfGapMs === 5_000)!;
    expect(join.priorDistinctOtherGapMs).toEqual([10_000, 20_000]);
    expect(join.nextOtherGapMs).toBe(10_000);
  });

  it("same prior authorが2投稿してもdistinct prior otherは1人", () => {
    const { db, observations } = setup();
    message(observations, "alice-1", "alice", BASE_MS + 10_000);
    message(observations, "alice-2", "alice", BASE_MS + 20_000);
    message(observations, "join", "subject", BASE_MS + 30_000);
    expect(conversation(db).thirdPartyJoins.at(-1)?.priorDistinctOtherGapMs).toEqual([10_000]);
  });
});

describe("started explicit conversations", () => {
  it("reply-root starterのparticipants/day/span/max-gapを保持し、別conversationを混ぜない", () => {
    const { db, observations } = setup();
    message(observations, "root", "subject", BASE_MS + 10_000);
    message(observations, "alice", "alice", BASE_MS + DAY + 10_000, { replyTo: "root" });
    message(observations, "carol", "carol", BASE_MS + 3 * DAY + 10_000, { replyTo: "alice" });
    message(observations, "other-root", "dave", BASE_MS + 20_000, { surfaceId: "other" });
    message(observations, "other-later", "erin", BASE_MS + 8 * DAY, { surfaceId: "other", replyTo: "other-root" });
    expect(conversation(db).startedConversations).toEqual([
      {
        startDate: "2026-08-20",
        distinctOtherParticipants: 2,
        activeDates: ["2026-08-20", "2026-08-21", "2026-08-23"],
        spanMs: 3 * DAY,
        maxInterActivityGapMs: 2 * DAY,
      },
    ]);
  });

  it("public thread owner provenanceでstarterをexactに証明する", () => {
    const { db, observations } = setup();
    for (const [id, author, offset] of [["one", "subject", 10], ["two", "alice", DAY], ["three", "carol", 2 * DAY]] as const) {
      message(observations, id, author, BASE_MS + offset, {
        surfaceId: "thread",
        areaId: "forum",
        surfaceKind: "forum_post",
        threadOwnerId: "subject",
        threadCreatedAt: BASE_MS,
      });
    }
    expect(conversation(db).startedConversations[0]).toMatchObject({ distinctOtherParticipants: 2, spanMs: 2 * DAY });
  });
});

describe("message knowledge cutoff", () => {
  it("future observed rowを同じhistorical snapshotへ混ぜない", () => {
    const { db, observations } = setup();
    const cutoffMs = BASE_MS + DAY;
    message(observations, "known", "subject", BASE_MS + 10, { observedAt: BASE_MS + 20 });
    message(observations, "future-known", "subject", BASE_MS + 30, { observedAt: cutoffMs + 1 });
    const window = { ...WINDOW, observedAt: Math.floor(cutoffMs / 1000), end: Math.floor((BASE_MS + 2 * DAY) / 1000) };
    expect(conversation(db, "subject", window).starts).toHaveLength(1);
  });
});

describe("reaction safe distribution", () => {
  it("post/day/global reactorをdistinct集計し、same reactor across postsはglobal 1", () => {
    const { db, observations } = setup();
    message(observations, "post-1", "subject", BASE_MS + 10);
    message(observations, "post-2", "subject", BASE_MS + 20);
    observations.recordReaction("post-1", "reactor-a", BASE_MS + 100);
    observations.recordReaction("post-1", "reactor-b", BASE_MS + DAY + 100);
    observations.recordReaction("post-2", "reactor-a", BASE_MS + DAY + 200);
    const payload = computeTcReactionSafe(db, WINDOW, ["subject"])[0]!.payload;
    expect(payload.distinctReactors).toBe(2);
    expect(payload.posts).toEqual([
      { reactionDays: ["2026-08-20", "2026-08-21"], distinctReactors: 2 },
      { reactionDays: ["2026-08-21"], distinctReactors: 1 },
    ]);
    expect(payload.days).toEqual([
      { date: "2026-08-20", distinctPosts: 1, distinctReactors: 1 },
      { date: "2026-08-21", distinctPosts: 2, distinctReactors: 2 },
    ]);
  });

  it("self/unobserved reactionは0、future observationはsnapshotへ入れない", () => {
    const { db, observations } = setup();
    message(observations, "post", "subject", BASE_MS + 10);
    observations.recordReaction("post", "subject", BASE_MS + 20);
    observations.recordReaction("missing", "reactor", BASE_MS + 20);
    observations.recordReaction("post", "future-reactor", BASE_MS + DAY + 1);
    const cutoff = { ...WINDOW, observedAt: Math.floor((BASE_MS + DAY) / 1000), end: Math.floor((BASE_MS + 2 * DAY) / 1000) };
    expect(computeTcReactionSafe(db, cutoff, ["subject"])[0]!.payload).toEqual({ distinctReactors: 0, posts: [], days: [] });
  });

  it("safe JSONへrestricted identity markersを一切出さない", () => {
    const { db, observations } = setup();
    message(observations, "message-secret-marker", "author-secret-marker", BASE_MS + 10, {
      surfaceId: "channel-secret-marker",
      areaId: "area-secret-marker",
    });
    observations.recordReaction("message-secret-marker", "reactor-secret-marker", BASE_MS + 20);
    const json = JSON.stringify(computeTcReactionSafe(db, WINDOW, ["author-secret-marker"])[0]!.payload);
    for (const marker of ["reactor-secret-marker", "author-secret-marker", "message-secret-marker", "channel-secret-marker", "area-secret-marker"]) {
      expect(json).not.toContain(marker);
    }
  });
});
