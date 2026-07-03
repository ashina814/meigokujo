import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { config } from "./config.js";
import { buildServices } from "./services.js";
import { handleSettings } from "./commands/settings.js";
import { handleApprovalButton, handleTransfer, handleTransferButton } from "./commands/transfer.js";
import { handleBankButton, handlePanelCommand, maybeRepostPanel } from "./commands/bank-panel.js";
import { handleAdjust } from "./commands/adjust.js";
import { handleMigration, handleMigrationButton } from "./commands/migration.js";
import {
  handleEntryButton,
  handleMemberJoin,
  handleSessionCommand,
  handleVoiceAttendance,
} from "./commands/entry.js";
import { handleTicketButton } from "./commands/tickets.js";
import {
  handleCharonButton,
  handleEvaluationCommand,
  handleEvaluationModal,
  handleEvaluationSelect,
} from "./commands/evaluation.js";
import { trackVoiceState } from "./vc-tracking.js";
import { handleSalaryTable } from "./commands/salary-table.js";
import { handlePaydayCommand } from "./commands/payday-command.js";
import { handlePaydayButton } from "./payday.js";
import { startScheduler } from "./scheduler.js";
import { startOutboxWorker } from "./outbox.js";

const services = buildServices();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (ready) => {
  console.log(`⚔️ 冥獄城ボット 起動: ${ready.user.tag}`);
  startOutboxWorker(client, services);
  startScheduler(client, services);

  // 起動時に必ず帳簿を検算する（経済設計.md §8）
  const integrity = services.ledger.verifyIntegrity();
  if (!integrity.ok) {
    console.error("🚨 台帳の検算に失敗しました。至急確認してください:", integrity.mismatches);
  } else {
    console.log(`📗 検算OK / 通貨発行残高 ${services.ledger.moneySupply().toLocaleString()} Ld`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case "設定":
          await handleSettings(interaction, services);
          return;
        case "送金":
          await handleTransfer(interaction, services);
          return;
        case "パネル設置":
          await handlePanelCommand(interaction, services);
          return;
        case "調整":
          await handleAdjust(interaction, services);
          return;
        case "給与表":
          await handleSalaryTable(interaction, services);
          return;
        case "給与支給":
          await handlePaydayCommand(interaction, services);
          return;
        case "移行":
          await handleMigration(interaction, services);
          return;
        case "説明会":
          await handleSessionCommand(interaction, services);
          return;
        case "評価":
          await handleEvaluationCommand(interaction, services);
          return;
      }
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === "eval:modal") {
      await handleEvaluationModal(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("eval:")) {
      await handleEvaluationSelect(interaction, services);
      return;
    }
    if (
      (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) &&
      interaction.customId.startsWith("entry:")
    ) {
      await handleEntryButton(interaction, services);
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("entry:")) {
        await handleEntryButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("ticket:")) {
        await handleTicketButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("charon:")) {
        await handleCharonButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("tf:")) {
        await handleTransferButton(interaction, services);
      } else if (interaction.customId.startsWith("apv:")) {
        await handleApprovalButton(interaction, services);
      } else if (interaction.customId.startsWith("bank:")) {
        await handleBankButton(interaction, services);
      } else if (interaction.customId.startsWith("pay:")) {
        await handlePaydayButton(interaction, services);
      } else if (interaction.customId.startsWith("mig:")) {
        await handleMigrationButton(interaction, services);
      }
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

// パネル自動再掲（UX原則8）
client.on(Events.MessageCreate, (message) => {
  void maybeRepostPanel(message, services).catch((err) =>
    console.error("[panel] 再掲失敗:", err),
  );
});

// 入城導線: 参加時のロール付与・案内
client.on(Events.GuildMemberAdd, (member) => {
  void handleMemberJoin(member, services).catch((err) => console.error("[entry] 参加処理失敗:", err));
});

// VC計測（全VC）+ 入城導線の説明会出席記録
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    trackVoiceState(oldState, newState, services);
    handleVoiceAttendance(oldState, newState, services);
  } catch (err) {
    console.error("[vc] 記録失敗:", err);
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
