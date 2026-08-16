import { afterEach, describe, expect, it } from "vitest";
import {
  cancelChallenge,
  claimChallenge,
  createChallenge,
  getOpenChallengeForChallenger,
  resetChallengesForTesting,
} from "../src/casino/pvp-challenge.js";

afterEach(() => resetChallengesForTesting());

function create(id: string, challengerId = "alice") {
  return createChallenge({
    id,
    challengerId,
    game: "chinchiro",
    bet: 500,
    channelId: "ch1",
    onExpire: () => undefined,
  });
}

describe("公開募集は挑戦者1人につき同時に1件", () => {
  it("同じ挑戦者の2件目を状態機械側でも拒否する", () => {
    create("c1");
    expect(() => create("c2")).toThrow("Challenger already has an open challenge");
    expect(getOpenChallengeForChallenger("alice")?.id).toBe("c1");
  });

  it("取消で終端へ倒れれば次の募集を出せる", () => {
    create("c1");
    expect(cancelChallenge("c1", "alice")?.state).toBe("cancelled");
    expect(() => create("c2")).not.toThrow();
    expect(getOpenChallengeForChallenger("alice")?.id).toBe("c2");
  });

  it("受諾で終端へ倒れれば次の募集を出せる", () => {
    create("c1");
    expect(claimChallenge("c1", "bob", false).ok).toBe(true);
    expect(() => create("c2")).not.toThrow();
  });
});
