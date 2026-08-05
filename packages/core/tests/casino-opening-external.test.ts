import { describe, expect, it } from "vitest";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";

describe("FakeOpeningExternalAdapter", () => {
  it("同じidempotencyKeyの再呼び出しは実行回数を増やさず、同じ結果を返す", async () => {
    const adapter = new FakeOpeningExternalAdapter();
    const key = "casino-opening:hash1:disable-legacy";
    const r1 = await adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key });
    const r2 = await adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key });
    expect(r2).toEqual(r1);
    expect(adapter.attemptsFor(key)).toBe(1);
  });

  it("failTimesで指定回数だけ失敗し、その後成功する（リトライテスト）", async () => {
    const adapter = new FakeOpeningExternalAdapter({ failTimes: 2 });
    const key = "casino-opening:hash1:disable-legacy";
    await expect(adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key })).rejects.toThrow();
    await expect(adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key })).rejects.toThrow();
    const result = await adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key });
    expect(result.idempotencyKey).toBe(key);
    expect(adapter.attemptsFor(key)).toBe(3);
  });

  it("failAlwaysは恒久的に失敗する", async () => {
    const adapter = new FakeOpeningExternalAdapter({ failAlways: true });
    const key = "casino-opening:hash1:disable-legacy";
    await expect(adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key })).rejects.toThrow();
    await expect(adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: key })).rejects.toThrow();
  });

  it("異なるidempotencyKeyは独立して扱われる", async () => {
    const adapter = new FakeOpeningExternalAdapter();
    const r1 = await adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: "key-a" });
    const r2 = await adapter.disableLegacyCasino({ planHash: "hash1", idempotencyKey: "key-b" });
    expect(r1.disabledChannelIds).not.toEqual(r2.disabledChannelIds);
  });
});
