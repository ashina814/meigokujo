import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { InviteTracker } from "./invite-tracker.js";
import { config } from "./config.js";
import { buildServices } from "./services.js";
import { handleAdminCommand, handleAdminButton, handleAdminSelect, handleAdminModal } from "./commands/admin-hub.js";
import { handleShopButton, handleShopSelect } from "./commands/shop-panel.js";
import { handleShokanCommand, handleShokanButton, handleShokanSelect, handleShokanModal } from "./commands/shokan.js";
import { handleApprovalButton, handleTransfer, handleTransferButton } from "./commands/transfer.js";
import { handleTip } from "./commands/tip.js";
import { handleRankingCommand } from "./commands/ranking.js";
import { handleRankPanelButton } from "./commands/rank-panel.js";
import { handleEtherButton, handleEtherModal } from "./commands/exchange-panel.js";
import {
  handleBankButton,
  handleDeptPanelButton,
  handleDeptPanelModal,
  maybeRepostPanel,
} from "./commands/bank-panel.js";
import {
  handleEntryButton,
  handleMemberJoin,
  handleMemberRoleUpdate,
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
import { handlePromote } from "./commands/promote.js";
import { handleProfile } from "./commands/profile.js";
import { handleDepartment, handleDepartmentAutocomplete } from "./commands/department.js";
import { handleFiscalButton } from "./commands/fiscal.js";
import { handleHelpCommand } from "./commands/help.js";
import { handleRoomButton, handleRecruitModal, handleRoomRenameModal } from "./commands/rooms.js";
import { handleBumpMessage } from "./bump.js";
import { handleMessageXp, tickVoiceXp } from "./rank-tracker.js";
import { trackVoiceState } from "./vc-tracking.js";
import { handleDenVoice } from "./dens.js";
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
    GatewayIntentBits.MessageContent, // bump検知（掲示板ボットのembed読取に必要）
    GatewayIntentBits.GuildInvites, // 招待リンクトラッキング
  ],
});

const inviteTracker = new InviteTracker(client);
inviteTracker.wire();

client.once(Events.ClientReady, (ready) => {
  console.log(`⚔️ 冥獄城ボット 起動: ${ready.user.tag}`);
  startOutboxWorker(client, services);
  startScheduler(client, services);

  // 招待キャッシュを初期化（全ギルド）
  for (const [, guild] of ready.guilds.cache) {
    void inviteTracker.initGuild(guild).catch((e) => console.error("[invite] 初期化失敗:", e));
  }

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
        case "管理":
          await handleAdminCommand(interaction, services);
          return;
        case "商館":
          await handleShokanCommand(interaction, services);
          return;
        case "送金":
          await handleTransfer(interaction, services);
          return;
        case "投げ銭":
          await handleTip(interaction, services);
          return;
        case "審判":
          if (interaction.options.getSubcommand() === "昇格") await handlePromote(interaction, services);
          else await handleSessionCommand(interaction, services);
          return;
        case "評価":
          await handleEvaluationCommand(interaction, services);
          return;
        case "プロフィール":
          await handleProfile(interaction, services);
          return;
        case "部署":
          await handleDepartment(interaction, services);
          return;
        case "ランキング":
          await handleRankingCommand(interaction, services);
          return;
        case "あそびかた":
          await handleHelpCommand(interaction, services);
          return;
      }
      return;
    }
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "部署") {
        await handleDepartmentAutocomplete(interaction, services);
      }
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === "eval:modal") {
      await handleEvaluationModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("room:recruit:")) {
      await handleRecruitModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("dept:modal:")) {
      await handleDeptPanelModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("room:renamemodal:")) {
      await handleRoomRenameModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("mgmt:")) {
      await handleAdminModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("shokan:")) {
      await handleShokanModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ether:")) {
      await handleEtherModal(interaction, services);
      return;
    }
    if (
      (interaction.isStringSelectMenu() ||
        interaction.isUserSelectMenu() ||
        interaction.isChannelSelectMenu() ||
        interaction.isRoleSelectMenu()) &&
      interaction.customId.startsWith("mgmt:")
    ) {
      await handleAdminSelect(interaction, services);
      return;
    }
    if (
      (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu()) &&
      interaction.customId.startsWith("shokan:")
    ) {
      await handleShokanSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("shop:")) {
      await handleShopSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("eval:")) {
      await handleEvaluationSelect(interaction, services);
      return;
    }
    if (
      (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) &&
      interaction.customId.startsWith("room:")
    ) {
      await handleRoomButton(interaction, services);
      return;
    }
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith("entry:")) {
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
      if (interaction.customId.startsWith("room:")) {
        await handleRoomButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("mgmt:")) {
        await handleAdminButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("shokan:")) {
        await handleShokanButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("shop:")) {
        await handleShopButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("rank:")) {
        await handleRankPanelButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("ether:")) {
        await handleEtherButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("dept:")) {
        await handleDeptPanelButton(interaction, services);
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
      } else if (interaction.customId.startsWith("fis:")) {
        await handleFiscalButton(interaction, services);
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

// パネル自動再掲（UX原則8）+ bump/up 検知
client.on(Events.MessageCreate, (message) => {
  void maybeRepostPanel(message, services).catch((err) =>
    console.error("[panel] 再掲失敗:", err),
  );
  void handleBumpMessage(message, services).catch((err) => console.error("[bump] 処理失敗:", err));
  void handleMessageXp(message, services).catch((err) => console.error("[rank] 発言XP付与失敗:", err));
});

// 入城導線: 参加時のロール付与・案内・招待リンク自動検出
client.on(Events.GuildMemberAdd, (member) => {
  void (async () => {
    const inviterId = await inviteTracker.detectInviter(member.guild).catch(() => null);
    await handleMemberJoin(member, services, inviterId);
  })().catch((err) => console.error("[entry] 参加処理失敗:", err));
});

// 亡霊ロール手動付与検知・性別ロール後付けで招待延長
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (oldMember.partial) return;
  void handleMemberRoleUpdate(oldMember, newMember, services).catch((err) =>
    console.error("[entry] ロール変更処理失敗:", err),
  );
});

// VC計測（全VC）+ 入城導線の説明会出席記録
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    trackVoiceState(oldState, newState, services);
    handleVoiceAttendance(oldState, newState, services);
    void handleDenVoice(oldState, newState, services).catch((err) => console.error("[den] 処理失敗:", err));
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
