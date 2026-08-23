import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const END = BASE + 10 * 86_400;
const BASE_MS = BASE * 1000;

const CONVERSATION_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.tc-conversation-safe",
    catalog: "test",
    name: "test",
    emoji: "x",
    description: "test",
    sources: ["tc_conversation_safe"] as const,
    triggers: ["text_activity"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "test-theme",
    groupKey: "test-group",
    collectionDomainKey: "test-domain",
    scope: { type: "global" },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

const REACTION_RULE = defineTitleRule(
  { ...CONVERSATION_RULE.definition, key: "v2.test.tc-reaction-safe", sources: ["tc_reaction_safe"] as const },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

const ZERO_CONVERSATION = {
  starts: [],
  revivalConversations: [],
  areas: [],
  thirdPartyJoins: [],
  startedConversations: [],
  socialDays: [],
};
const ZERO_REACTION = { distinctReactors: 0, posts: [], days: [] };

function setup() {
  const db = openDb(":memory:");
  const observations = new TcSocialObservations(db);
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "setup" });
  clock = END;
  return {
    db,
    observations,
    store,
    conversationScope: () => resolveTitleScope(store, CONVERSATION_RULE.definition, END),
    reactionScope: () => resolveTitleScope(store, REACTION_RULE.definition, END),
  };
}

function message(
  observations: TcSocialObservations,
  id: string,
  authorId: string,
  atMs: number,
  options: { surface?: string; area?: string; replyTo?: string | null } = {},
) {
  observations.recordMessage({
    messageId: id,
    authorId,
    surfaceId: options.surface ?? "channel-secret-marker",
    areaId: options.area ?? options.surface ?? "channel-secret-marker",
    surfaceKind: "channel",
    replyToMessageId: options.replyTo ?? null,
    createdAtMs: atMs,
    observedAtMs: atMs + 1,
  });
}

describe("TC safe source runtime", () => {
  it("single/bulk equivalenceとzero payload exact shape", () => {
    const { db, observations, conversationScope, reactionScope } = setup();
    message(observations, "post", "subject", BASE_MS + 10);
    message(observations, "reply", "other", BASE_MS + 20, { replyTo: "post" });
    observations.recordReaction("post", "reactor", BASE_MS + 30);

    const conversationSingle = readTitleSource(db, "tc_conversation_safe", "subject", conversationScope());
    const reactionSingle = readTitleSource(db, "tc_reaction_safe", "subject", reactionScope());
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "tc_conversation_safe", ["subject", "nobody"], conversationScope())).toEqual({ loaded: 2, readCalls: 1 });
    expect(cache.prefetch(db, "tc_reaction_safe", ["subject", "nobody"], reactionScope())).toEqual({ loaded: 2, readCalls: 1 });
    expect(cache.get(db, "tc_conversation_safe", "subject", conversationScope())).toEqual(conversationSingle);
    expect(cache.get(db, "tc_reaction_safe", "subject", reactionScope())).toEqual(reactionSingle);
    expect(cache.get(db, "tc_conversation_safe", "nobody", conversationScope())).toEqual(ZERO_CONVERSATION);
    expect(cache.get(db, "tc_reaction_safe", "nobody", reactionScope())).toEqual(ZERO_REACTION);
  });

  it("requested users以外をcacheへ混入させない", () => {
    const { db, observations, conversationScope } = setup();
    message(observations, "post", "subject", BASE_MS + 10);
    message(observations, "reply", "counterpart-secret-marker", BASE_MS + 20, { replyTo: "post" });
    const cache = new TitleSourceCache();
    const scope = conversationScope();
    cache.prefetch(db, "tc_conversation_safe", ["subject"], scope);
    const spy = vi.spyOn(db, "prepare");
    cache.get(db, "tc_conversation_safe", "counterpart-secret-marker", scope);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it("300-user chunkを両safe sourceで維持する", () => {
    const { db, conversationScope, reactionScope } = setup();
    const users = Array.from({ length: 301 }, (_, index) => `user-${index}`);
    expect(new TitleSourceCache().prefetch(db, "tc_conversation_safe", users, conversationScope())).toEqual({ loaded: 301, readCalls: 2 });
    expect(new TitleSourceCache().prefetch(db, "tc_reaction_safe", users, reactionScope())).toEqual({ loaded: 301, readCalls: 2 });
  });

  it("1200 surfaces/messages/reactionsをchunkし、message/reply/reaction N+1を作らない", () => {
    const { db, observations, conversationScope, reactionScope } = setup();
    db.transaction(() => {
      for (let index = 0; index < 1200; index += 1) {
        message(observations, `post-${index}`, "subject", BASE_MS + index * 10, {
          surface: `surface-${index}`,
          area: `area-${index}`,
        });
        observations.recordReaction(`post-${index}`, `reactor-${index}`, BASE_MS + index * 10 + 2);
      }
    })();
    const spy = vi.spyOn(db, "prepare");
    expect(readTitleSource(db, "tc_conversation_safe", "subject", conversationScope()).areas).toHaveLength(1200);
    expect(readTitleSource(db, "tc_reaction_safe", "subject", reactionScope()).posts).toHaveLength(1200);
    const sql = spy.mock.calls.map(([text]) => String(text));
    const areaQueries = sql.filter((text) => text.includes("area_id IN"));
    expect(areaQueries).toHaveLength(4);
    expect(Math.max(...areaQueries.map((text) => text.match(/\?/g)?.length ?? 0))).toBeLessThanOrEqual(303);
    expect(sql.filter((text) => text.includes("reply_to_message_id = ?"))).toHaveLength(0);
    expect(sql.filter((text) => text.includes("r.message_id = ?"))).toHaveLength(0);
    expect(sql.length).toBeLessThanOrEqual(8);
  });

  it("payload全階層をdeep freezeする", () => {
    const { db, observations, conversationScope, reactionScope } = setup();
    message(observations, "post", "subject", BASE_MS + 10);
    message(observations, "reply", "other", BASE_MS + 20, { replyTo: "post" });
    observations.recordReaction("post", "reactor", BASE_MS + 30);
    const conversation = readTitleSource(db, "tc_conversation_safe", "subject", conversationScope());
    const reaction = readTitleSource(db, "tc_reaction_safe", "subject", reactionScope());
    for (const value of [
      conversation,
      conversation.starts,
      conversation.starts[0],
      conversation.areas,
      conversation.areas[0],
      conversation.areas[0]?.socialDays,
      conversation.startedConversations,
      reaction,
      reaction.posts,
      reaction.posts[0],
      reaction.posts[0]?.reactionDays,
      reaction.days,
      reaction.days[0],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("raw restricted/safe derivedのexact contractとraw generic read拒否", () => {
    const { db, conversationScope } = setup();
    expect(TITLE_SOURCES.tc_message_observations).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      orderable: true,
      restrictedUse: "tc_safe_social_classification",
      rawUnit: "public_tc_message_observation",
    });
    expect(TITLE_SOURCES.tc_reaction_observations).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      orderable: false,
      restrictedUse: "tc_safe_social_classification",
      rawUnit: "public_tc_reaction_observation",
    });
    expect(TITLE_SOURCES.tc_conversation_safe).toMatchObject({
      origin: "derived",
      derivedFrom: ["tc_message_observations"],
      privacy: "safe",
      titleUsable: true,
      orderable: false,
    });
    expect(TITLE_SOURCES.tc_reaction_safe).toMatchObject({
      origin: "derived",
      derivedFrom: ["tc_message_observations", "tc_reaction_observations"],
      privacy: "safe",
      titleUsable: true,
      orderable: false,
    });
    expect(() => readTitleSource(db, "tc_message_observations" as never, "subject", conversationScope())).toThrow(/not usable/);
    expect(() => readTitleSource(db, "tc_reaction_observations" as never, "subject", conversationScope())).toThrow(/not usable/);
  });

  it("non-orderable sourceだけのruleがnon-null earnedAtを返すとfail-closed", () => {
    const { db, store } = setup();
    const badRule = defineTitleRule(
      { ...CONVERSATION_RULE.definition, key: "v2.test.tc-bad-earned-at" },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE + 1, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "subject", END)).toThrow(/non-orderable/);
  });

  it("safe payloadへidentity/content/emoji/raw message countを出さない", () => {
    const { db, observations, conversationScope, reactionScope } = setup();
    message(observations, "message-secret-marker", "author-secret-marker", BASE_MS + 10, {
      surface: "channel-secret-marker",
      area: "area-secret-marker",
    });
    message(observations, "reply-secret", "counterpart-secret-marker", BASE_MS + 20, {
      surface: "channel-secret-marker",
      area: "area-secret-marker",
      replyTo: "message-secret-marker",
    });
    observations.recordReaction("message-secret-marker", "reactor-secret-marker", BASE_MS + 30);
    const json = JSON.stringify({
      conversation: readTitleSource(db, "tc_conversation_safe", "author-secret-marker", conversationScope()),
      reaction: readTitleSource(db, "tc_reaction_safe", "author-secret-marker", reactionScope()),
    });
    for (const marker of [
      "message-secret-marker",
      "author-secret-marker",
      "counterpart-secret-marker",
      "channel-secret-marker",
      "area-secret-marker",
      "reactor-secret-marker",
    ]) {
      expect(json).not.toContain(marker);
    }
    for (const forbidden of [
      "messageId",
      "authorId",
      "reactorId",
      "channelId",
      "threadId",
      "areaId",
      "emoji",
      "content",
      "messageCount",
      "rawPostCount",
      "totalMessages",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
