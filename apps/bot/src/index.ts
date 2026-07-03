import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { config } from "./config.js";
import { buildServices } from "./services.js";
import { handleSettings } from "./commands/settings.js";
import { startOutboxWorker } from "./outbox.js";

const services = buildServices();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (ready) => {
  console.log(`⚔️ 冥獄城ボット 起動: ${ready.user.tag}`);
  startOutboxWorker(client, services);

  // 週次検算の代わりに、起動時にも必ず帳簿を検算する（経済設計.md §8）
  const integrity = services.ledger.verifyIntegrity();
  if (!integrity.ok) {
    console.error("🚨 台帳の検算に失敗しました。至急確認してください:", integrity.mismatches);
  } else {
    console.log(`📗 検算OK / 通貨発行残高 ${services.ledger.moneySupply().toLocaleString()} Ld`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "設定") {
      await handleSettings(interaction, services);
    }
  } catch (err) {
    console.error("[interaction] 処理失敗:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "処理に失敗しました。時間をおいて再度お試しください。", flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
});

function shutdown(): void {
  console.log("冥獄城ボットを停止します…");
  client.destroy();
  services.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(config.token);
