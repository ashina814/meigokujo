import { Client, GatewayIntentBits } from "discord.js";
import { EventLog, Ledger, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { config } from "./config.js";
import { collectTimedAccessLegacyExpectations } from "./timed-access-legacy-migration.js";

const EXPECTED_ITEMS = [
  { itemId: 1, expectedCount: 7 },
  { itemId: 3, expectedCount: 5 },
] as const;
const MIGRATION_KEY = "shop-timed-access-v2-role-only-2026-08";
const ACTOR = "system:timed-access-legacy-migration";
const REASON = "V2移行時点で対象Discordロールを持ち、active契約がない既存利用者の30日無償移行";

const execute = process.argv.slice(2).includes("--execute");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--execute");
if (unknownArgs.length > 0) throw new Error(`unknown arguments: ${unknownArgs.join(", ")}`);

registerDefaultTxTypes();
const db = openDb(config.dbPath);
const settings = new Settings(db);
const shop = new Shop(db, new Ledger(db), new EventLog(db));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

try {
  await client.login(config.token);
  const guildId = settings.getString("guild:main");
  if (!guildId) throw new Error("timed_access_legacy:guild_main_missing");
  const guild = await client.guilds.fetch(guildId);
  const expectations = await collectTimedAccessLegacyExpectations(guild, shop, EXPECTED_ITEMS);
  if (shop.hasTimedAccessLegacyMigration(MIGRATION_KEY)) {
    const result = shop.migrateTimedAccessLegacy({
      migrationKey: MIGRATION_KEY,
      expectations,
      actor: ACTOR,
      reason: REASON,
    });
    console.log(`[期限付きアクセス移行] 既に実行済み: ${result.imports.length}件`);
  } else {
    const plan = shop.planTimedAccessLegacyMigration(expectations);
    for (const item of plan.items) {
      console.log(
        `[期限付きアクセス移行] item #${item.itemId}: expected=${item.expectedCount} actual=${item.actualCount}`,
      );
    }
    if (!plan.matchesExpected) {
      throw new Error("timed_access_legacy:count_mismatch; productionは変更していません");
    }
    if (!execute) {
      console.log("[期限付きアクセス移行] dry-runのみ。実行する場合は --execute を付けてください。");
    } else {
      // startedAtは件数をforce fetchして照合した直後に一度だけ確定する。
      const result = shop.migrateTimedAccessLegacy({
        migrationKey: MIGRATION_KEY,
        expectations,
        actor: ACTOR,
        reason: REASON,
        startedAt: Math.floor(Date.now() / 1000),
      });
      console.log(`[期限付きアクセス移行] 完了: ${result.imports.length}件`);
    }
  }
} finally {
  client.destroy();
  db.close();
}
