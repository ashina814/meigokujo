import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { EventLog } from "../src/events/service.js";
import { Weather, WEATHER_TYPES } from "../src/weather/service.js";
import { Chips } from "../src/chips/service.js";
import { Casino } from "../src/casino/service.js";

registerDefaultTxTypes();

describe("冥界の天気", () => {
  let db: ReturnType<typeof openDb>;
  let settings: Settings;
  let weather: Weather;
  beforeEach(() => {
    db = openDb(":memory:");
    settings = new Settings(db);
    weather = new Weather(settings);
  });

  it("roll は冪等：同じ日は同じ天気を返し、2回目は isNew=false", () => {
    const a = weather.roll("2026-07-05", "t", () => 0); // 先頭=clear
    expect(a.isNew).toBe(true);
    expect(a.def.key).toBe("clear");
    const b = weather.roll("2026-07-05", "t", () => 0.99);
    expect(b.isNew).toBe(false);
    expect(b.def.key).toBe("clear"); // 乱数を変えても保存済みを返す
  });

  it("重み付き抽選：rng で天気が選べる", () => {
    // clear(10)/fair(25)/cloudy(25)/fog(20)/storm(15)/eclipse(5)、合計100
    expect(weather.roll("d1", "t", () => 0.0).def.key).toBe("clear");
    expect(weather.roll("d2", "t", () => 0.5).def.key).toBe("cloudy"); // 50 → clear10+fair25=35..60 が cloudy
    expect(weather.roll("d3", "t", () => 0.99).def.key).toBe("eclipse"); // 末尾
  });

  it("未設定日は既定（晴れ・等倍）", () => {
    expect(weather.forDate("9999-99-99").key).toBe("fair");
    expect(weather.forDate("9999-99-99").mult).toBe(1.0);
  });

  it("天気の配当倍率がカジノの当たりに反映される", () => {
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const chips = new Chips(db, ledger, events);
    // 今日を月食(×1.25)に固定
    const today = new Date();
    const j = new Date(today.getTime() + 9 * 3600 * 1000);
    const ds = `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}`;
    settings.set(`weather:${ds}`, "eclipse", "t");
    expect(weather.payoutMult()).toBe(1.25);

    const casino = new Casino(db, chips, events, () => 0, () => weather.payoutMult());
    // 元手
    ledger.ensureAccount("user:p", "user");
    ledger.transfer({ from: TREASURY, to: "user:p", amount: 1_000_000, type: "initial", actor: "t", idempotencyKey: "x" });
    chips.buy("p", 500_000, "b1");
    ledger.ensureAccount("user:h", "user");
    ledger.transfer({ from: TREASURY, to: "user:h", amount: 1_000_000, type: "initial", actor: "t", idempotencyKey: "y" });
    chips.buy("h", 500_000, "b2");
    casino.fundHouse("h", chips.balanceOf("h"));

    // コイン当たり（rng=0→表）。通常1,950 → ×1.25 = 2,437
    const r = casino.coin("p", 1_000, "表");
    expect(r.win).toBe(true);
    expect(r.payout).toBe(Math.floor(1_950 * 1.25));
    // インフレしない（チップ総量不変）
    expect(chips.outstanding()).toBeGreaterThan(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("天気タイプの重み合計は100", () => {
    expect(WEATHER_TYPES.reduce((s, w) => s + w.weight, 0)).toBe(100);
  });
});
