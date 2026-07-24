import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, registerDefaultTxTypes } from "@meigokujo/core";
import {
  buildDashboardEmbed,
  getEconomyHealthSummary,
  getLandSystemBreakdown,
  updateDashboard,
} from "../src/dashboard.js";
import type { Services } from "../src/services.js";

registerDefaultTxTypes();

type FakeServices = Services & { __settings: Map<string, string> };

function ensureLandBalance(db: Database.Database, accountId: string, amount: number): void {
  const kind = accountId.startsWith("user:") ? "user" : "system";
  db.prepare(
    "INSERT INTO accounts (id, kind, status, created_at) VALUES (?, ?, 'active', 1) ON CONFLICT(id) DO NOTHING",
  ).run(accountId, kind);
  db.prepare(
    "INSERT INTO balances (account_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET amount = excluded.amount",
  ).run(accountId, amount);
}

function setEtherBalance(db: Database.Database, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

function createServices(opts: {
  landMismatches?: Array<{ accountId: string; cached: number; computed: number }>;
  sessionMismatches?: Array<{ sessionId: string; expected: number; actual: number }>;
} = {}): FakeServices {
  const db = openDb(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS casino_escrow (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      game TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'house',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS casino_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      fund_mode TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS casino_market_bets (
      market_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  ensureLandBalance(db, "sys:treasury", -100_000);
  ensureLandBalance(db, "sys:dept:bank", 30_000);
  ensureLandBalance(db, "sys:escrow:ether", 7_000);
  ensureLandBalance(db, "sys:escrow:auction", 2_000);
  ensureLandBalance(db, "sys:escrow:chips", 0);

  setEtherBalance(db, "house", 50_000);
  setEtherBalance(db, "jackpot", 1_000);
  setEtherBalance(db, "relief", 500);
  setEtherBalance(db, "sys:escrow:quarantine", 0);

  const settings = new Map<string, string>();
  const services = {
    db,
    __settings: settings,
    settings: {
      getString: (key: string) => settings.get(key) ?? "",
      set: (key: string, value: string) => settings.set(key, String(value)),
    },
    ledger: {
      moneySupply: () => 100_000,
      balanceOf: (accountId: string) =>
        (db.prepare("SELECT amount FROM balances WHERE account_id = ?").get(accountId) as { amount: number } | undefined)
          ?.amount ?? 0,
      verifyIntegrity: () => ({
        ok: (opts.landMismatches ?? []).length === 0,
        mismatches: opts.landMismatches ?? [],
      }),
    },
    escrow: {
      verify: () => ({
        ok: (opts.sessionMismatches ?? []).length === 0,
        mismatches: opts.sessionMismatches ?? [],
      }),
    },
    entry: { queueSummary: () => ({ booked: 0, waiting: 0, oldestBookedAt: null }) },
    evaluation: { dueBetween: () => [], overdue: () => [] },
    tickets: { countOpen: () => 0, staleOpen: () => [] },
    rooms: { listOpen: () => [] },
    casino: { houseBalance: () => 50_000, jackpotPool: () => 1_000 },
    ether: {
      balanceOf: (holder: string) =>
        (db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(holder) as { amount: number } | undefined)
          ?.amount ?? 0,
      outstanding: () => 51_500,
      pool: () => 7_000,
      rate: () => 10,
    },
    departments: { listWithBalance: () => [{ key: "bank", name: "銀行", role_id: null, balance: 30_000 }] },
  };
  return services as unknown as FakeServices;
}

function fieldValue(embed: ReturnType<typeof buildDashboardEmbed>, name: string): string {
  const field = embed.toJSON().fields?.find((f) => f.name.includes(name));
  return field?.value ?? "";
}

function insertMarket(
  db: Database.Database,
  input: { id?: number; status: string; fundMode: string; pot?: number; escrow?: number },
): number {
  const info = input.id
    ? db.prepare("INSERT INTO casino_markets (id, status, fund_mode) VALUES (?, ?, ?)").run(input.id, input.status, input.fundMode)
    : db.prepare("INSERT INTO casino_markets (status, fund_mode) VALUES (?, ?)").run(input.status, input.fundMode);
  const id = input.id ?? Number(info.lastInsertRowid);
  if ((input.pot ?? 0) > 0) {
    db.prepare(
      "INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at) VALUES (?, 'u1', 0, ?, 1)",
    ).run(id, input.pot);
  }
  if ((input.escrow ?? 0) > 0) setEtherBalance(db, `escrow:market:${id}`, input.escrow!);
  return id;
}

describe("城の計器盤", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("全項目正常時は既存表示を保ち、健全性を短く表示する", () => {
    const services = createServices();
    const embed = buildDashboardEmbed(services);
    const json = embed.toJSON();

    expect(json.title).toBe("🏰 城の計器盤");
    expect(json.fields?.map((f) => f.name)).toEqual(
      expect.arrayContaining(["💰 経済", "🧭 経済健全性", "🚪 入城", "⚖️ 審判", "🛡 治安・運用", "🎰 賭場", "🏦 部署口座"]),
    );
    expect(fieldValue(embed, "経済")).toContain("部署口座合計: 30,000 Ld");
    expect(fieldValue(embed, "経済")).toContain("Ether準備Land: 7,000 Ld");
    expect(fieldValue(embed, "経済健全性")).toContain("会計検算: 正常");
    expect(fieldValue(embed, "経済健全性")).toContain("Escrow: 正常");
    expect(fieldValue(embed, "経済健全性")).toContain("市場異常: なし");
    expect(fieldValue(embed, "経済健全性")).toContain("隔離資金: なし");
  });

  it("Land不一致時は残高キャッシュ不一致件数を表示する", () => {
    const services = createServices({
      landMismatches: [{ accountId: "user:a", cached: 10, computed: 9 }],
    });

    expect(getEconomyHealthSummary(services).landMismatchCount).toBe(1);
    expect(fieldValue(buildDashboardEmbed(services), "経済健全性")).toContain("残高キャッシュ不一致 1件");
  });

  it("session Escrow不一致時は件数と差額を表示する", () => {
    const services = createServices({
      sessionMismatches: [{ sessionId: "s1", expected: 1_000, actual: 700 }],
    });

    expect(getEconomyHealthSummary(services).sessionEscrowMismatchDiff).toBe(300);
    expect(fieldValue(buildDashboardEmbed(services), "経済健全性")).toContain("session不一致 1件（差額 300◈）");
  });

  it("market Escrow不一致時はpotとholderの差額を表示する", () => {
    const services = createServices();
    insertMarket(services.db, { status: "open", fundMode: "escrow", pot: 1_000, escrow: 400 });

    const summary = getEconomyHealthSummary(services);
    expect(summary.marketEscrowMismatchCount).toBe(1);
    expect(summary.marketEscrowMismatchDiff).toBe(600);
    expect(fieldValue(buildDashboardEmbed(services), "経済健全性")).toContain("pot不一致 1件（差額 600◈）");
  });

  it("frozen・未知fund mode・quarantineを警告表示する", () => {
    const services = createServices();
    insertMarket(services.db, { status: "frozen", fundMode: "escrow", pot: 200, escrow: 200 });
    insertMarket(services.db, { status: "open", fundMode: "mystery", pot: 100, escrow: 0 });
    setEtherBalance(services.db, "sys:escrow:quarantine", 99);

    const health = fieldValue(buildDashboardEmbed(services), "経済健全性");
    expect(health).toContain("frozen 1件");
    expect(health).toContain("未知fund_mode 1件");
    expect(health).toContain("隔離資金: 99◈");
  });

  it("legacy_house市場が処理済みなら警告しない", () => {
    const services = createServices();
    insertMarket(services.db, { status: "settled", fundMode: "legacy_house", pot: 1_000, escrow: 0 });

    expect(getEconomyHealthSummary(services).activeLegacyHouseMarketCount).toBe(0);
    expect(fieldValue(buildDashboardEmbed(services), "経済健全性")).not.toContain("legacy未精算");
  });

  it("Landの旧chips口座は移動せず表示だけ行う", () => {
    const services = createServices();
    ensureLandBalance(services.db, "sys:escrow:chips", 545_000);

    expect(getLandSystemBreakdown(services).legacyChips).toBe(545_000);
    expect(fieldValue(buildDashboardEmbed(services), "経済")).toContain("旧chips: 545,000 Ld");
  });

  it("更新処理が同時実行された場合は同じ投稿処理に合流する", async () => {
    const services = createServices();
    services.__settings.set("channel:keikiban", "ch1");
    const pin = vi.fn().mockResolvedValue(undefined);
    let resolveSend!: () => void;
    const send = vi.fn(
      () =>
        new Promise<{ id: string; pin: typeof pin }>((resolve) => {
          resolveSend = () => resolve({ id: "msg1", pin });
        }),
    );
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn() }, send };
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;

    const first = updateDashboard(client, services);
    const second = updateDashboard(client, services);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    resolveSend();

    await expect(first).resolves.toMatchObject({ ok: true, action: "created", messageId: "msg1" });
    await expect(second).resolves.toMatchObject({ ok: true, action: "joined", messageId: "msg1" });
    expect(services.__settings.get("dashboard:message_id")).toBe("msg1");
  });

  it("メッセージ編集失敗時は失敗を返し、新規投稿しない", async () => {
    const services = createServices();
    services.__settings.set("channel:keikiban", "ch1");
    services.__settings.set("dashboard:message_id", "msg1");
    const edit = vi.fn().mockRejectedValue(new Error("edit failed"));
    const send = vi.fn();
    const channel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn().mockResolvedValue({ edit }) },
      send,
    };
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;

    await expect(updateDashboard(client, services)).resolves.toMatchObject({
      ok: false,
      action: "failed",
      messageId: "msg1",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
