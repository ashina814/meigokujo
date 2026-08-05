import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Settings } from "../src/settings/service.js";
import {
  CASINO_OPENING_SETTING_KEYS,
  clearCasinoOpeningConfig,
  readCasinoOpeningConfig,
  writeCasinoOpeningConfig,
} from "../src/casino/opening-settings.js";

function setup() {
  const db = openDb(":memory:");
  return { db, settings: new Settings(db) };
}

const VALID = {
  openingCapital: 10_000_000,
  openingHouse: 8_000_000,
  openingJackpot: 1_500_000,
  openingRelief: 500_000,
  minWorkingCapital: 1_000_000,
  remitRateBps: 0,
};

describe("casino opening settings", () => {
  it("未設定なら not_configured を返し、他のキーを読まない", () => {
    const { settings } = setup();
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.configured).toBe(false);
  });

  it("configured フラグが 'true' 以外の値では未設定扱い（0/1/false/空文字すべて）", () => {
    const { db, settings } = setup();
    for (const bogus of ["0", "1", "false", "", "TRUE", "True "]) {
      db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(CASINO_OPENING_SETTING_KEYS.configured, bogus);
      const result = readCasinoOpeningConfig(settings);
      expect(result.ok, `bogus=${JSON.stringify(bogus)}`).toBe(false);
      if (!result.ok) expect(result.configured).toBe(false);
    }
  });

  it("正常な設定を書いて読み戻せる", () => {
    const { settings } = setup();
    writeCasinoOpeningConfig(settings, VALID, "test-admin");
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({ configured: true, ...VALID });
    }
  });

  it("clearCasinoOpeningConfig で未設定へ戻る", () => {
    const { settings } = setup();
    writeCasinoOpeningConfig(settings, VALID, "test-admin");
    clearCasinoOpeningConfig(settings, "test-admin");
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
  });

  it("house + jackpot + relief != capital は invalid", () => {
    const { settings } = setup();
    writeCasinoOpeningConfig(settings, { ...VALID, openingRelief: 999 }, "test");
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid") {
      expect(result.errors.some((e) => e.includes("capital"))).toBe(true);
    }
  });

  it("capital <= 0 は invalid", () => {
    const { settings } = setup();
    writeCasinoOpeningConfig(settings, { ...VALID, openingCapital: 0, openingHouse: 0 }, "test");
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
  });

  it("house <= 0 は invalid", () => {
    const { settings } = setup();
    writeCasinoOpeningConfig(
      settings,
      { ...VALID, openingHouse: 0, openingJackpot: VALID.openingJackpot + VALID.openingHouse },
      "test",
    );
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
  });

  it("jackpot/relief が負は invalid", () => {
    const { settings } = setup();
    for (const patch of [{ openingJackpot: -1 }, { openingRelief: -1 }]) {
      const { settings: s2 } = setup();
      writeCasinoOpeningConfig(s2, { ...VALID, ...patch }, "test");
      const result = readCasinoOpeningConfig(s2);
      expect(result.ok).toBe(false);
    }
  });

  it("remitRateBps は 0..10000 の範囲外なら invalid", () => {
    for (const bps of [-1, 10_001]) {
      const { settings } = setup();
      writeCasinoOpeningConfig(settings, { ...VALID, remitRateBps: bps }, "test");
      const result = readCasinoOpeningConfig(settings);
      expect(result.ok).toBe(false);
    }
  });

  it("minWorkingCapital が負は invalid", () => {
    const { settings } = setup();
    writeCasinoOpeningConfig(settings, { ...VALID, minWorkingCapital: -1 }, "test");
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
  });

  it("敵対的: 小数・NaN・Infinity・空白・16進表記はすべて拒否する", () => {
    const { db, settings } = setup();
    const bad = ["1.5", "NaN", "Infinity", "-Infinity", " 100", "100 ", "0x10", "1e9", "", "  "];
    for (const raw of bad) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('${CASINO_OPENING_SETTING_KEYS.configured}', 'true', 0)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run();
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run(CASINO_OPENING_SETTING_KEYS.capital, raw);
      // 他の必須キーは正常値で埋める
      for (const [key, val] of Object.entries({
        [CASINO_OPENING_SETTING_KEYS.house]: VALID.openingHouse,
        [CASINO_OPENING_SETTING_KEYS.jackpot]: VALID.openingJackpot,
        [CASINO_OPENING_SETTING_KEYS.relief]: VALID.openingRelief,
        [CASINO_OPENING_SETTING_KEYS.minWorkingCapital]: VALID.minWorkingCapital,
        [CASINO_OPENING_SETTING_KEYS.remitRateBps]: VALID.remitRateBps,
      })) {
        db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(key, String(val));
      }
      const result = readCasinoOpeningConfig(settings);
      expect(result.ok, `raw=${JSON.stringify(raw)}`).toBe(false);
    }
  });

  it("敵対的: safe integer 範囲外は拒否する", () => {
    const { db, settings } = setup();
    writeCasinoOpeningConfig(settings, VALID, "test");
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      "99999999999999999999999999",
      CASINO_OPENING_SETTING_KEYS.capital,
    );
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
  });

  it("部分設定（configured=trueだが一部キー欠落）はエラーを列挙し、fail-closedになる", () => {
    const { db, settings } = setup();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', 0)").run(
      CASINO_OPENING_SETTING_KEYS.configured,
    );
    // capital だけ置き、他は置かない
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(
      CASINO_OPENING_SETTING_KEYS.capital,
      "100",
    );
    const result = readCasinoOpeningConfig(settings);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid") {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});
