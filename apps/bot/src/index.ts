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
import { handleAsobuCommand } from "./commands/asobu.js";
import { handleDailyCommand } from "./commands/daily.js";
import { handlePassportCommand } from "./commands/passport.js";
import { handleBanzukeCommand } from "./commands/banzuke.js";
import { handleShobuCommand } from "./commands/shobu.js";
import { handleBakutenButton, handleBakutenCommand, handleBakutenSelect } from "./commands/bakuten.js";
import { handleStocksButton, handleStocksCommand, handleStocksModal, handleStocksSelect } from "./commands/stocks.js";
import { handleKeibaCommand } from "./commands/keiba.js";
import { handleAnnaiButton, handleAnnaiCommand } from "./commands/annai.js";
import { handleVipButton, handleVipCommand } from "./commands/vip.js";
import { handleNagareboshiCommand } from "./commands/nagareboshi.js";
import { handleItaButton, handleItaCommand, handleItaModal, handleItaSelect } from "./commands/ita.js";
import { handleTakuButton, handleTakuVoiceUpdate, sweepStaleTables } from "./commands/takutate-panel.js";
import { handlePokerDuelButton, handlePokerDuelSelect } from "./casino/poker-duel.js";
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
  handleConfessionButton,
  handleConfessionModal,
  handleConfessionSelect,
  handleConfessionStringSelect,
  handleConfessionUserSelect,
  relayStaffMessage,
} from "./commands/confession.js";
import {
  handleCharonButton,
  handleEvaluationCommand,
  handleEvaluationModal,
  handleEvaluationSelect,
} from "./commands/evaluation.js";
import { handlePromote } from "./commands/promote.js";
import { handleProfile, handleProfileButton } from "./commands/profile.js";
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
import { startInternalApi } from "./internal-api.js";
import { handleEvent72Button, handleEvent72Message, handleEvent72Voice, startEvent72 } from "./event72.js";
import { startOutboxWorker } from "./outbox.js";
import { postJoinLog, postLeaveLog } from "./member-log.js";

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
  // 経済観測用の読み取り専用内部API（ログBot向け・ホスト内限定）
  startInternalApi(services);
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

  // 72時間耐久・最終24時間イベント（パネル復旧・カウントダウン・VC記録）
  void startEvent72(client, services).catch((e) => console.error("[72h] 起動失敗:", e));

  // 起動時に卓建て空VCを sweep
  void sweepStaleTables(client, services).then((n) => {
    if (n > 0) console.log(`[taku] 起動時 sweep: ${n}件 の空VCを削除`);
  }).catch((e) => console.error("[taku] sweep失敗:", e));
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
        case "遊ぶ":
          await handleAsobuCommand(interaction, services);
          return;
        case "福分け":
          await handleDailyCommand(interaction, services);
          return;
        case "通行証":
          await handlePassportCommand(interaction, services);
          return;
        case "賭場番付":
          await handleBanzukeCommand(interaction, services);
          return;
        case "勝負":
          await handleShobuCommand(interaction, services);
          return;
        case "賭場商店":
          await handleBakutenCommand(interaction, services);
          return;
        case "株":
          await handleStocksCommand(interaction, services);
          return;
        case "競馬":
          await handleKeibaCommand(interaction, services);
          return;
        case "案内":
          await handleAnnaiCommand(interaction, services);
          return;
        case "vip":
          await handleVipCommand(interaction, services);
          return;
        case "流れ星":
          await handleNagareboshiCommand(interaction, services);
          return;
        case "板":
          await handleItaCommand(interaction, services);
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
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("mimi:")) {
      await handleConfessionSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("mimi:")) {
      await handleConfessionStringSelect(interaction, services);
      return;
    }
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith("mimi:")) {
      await handleConfessionUserSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("shop:")) {
      await handleShopSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("bakuten:")) {
      await handleBakutenSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("stocks:")) {
      await handleStocksSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("pkr:")) {
      await handlePokerDuelSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ita:")) {
      await handleItaSelect(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("mimi:")) {
      await handleConfessionModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ita:")) {
      await handleItaModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("stocks:")) {
      await handleStocksModal(interaction, services);
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
      // 72時間耐久イベント（パネル再投稿でMessage IDが変わっても動くよう customId で処理）
      if (interaction.customId.startsWith("e72:")) {
        await handleEvent72Button(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("entry:")) {
        await handleEntryButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("ticket:")) {
        await handleTicketButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("mimi:")) {
        await handleConfessionButton(interaction, services);
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
      if (interaction.customId.startsWith("bakuten:")) {
        await handleBakutenButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("stocks:")) {
        await handleStocksButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("annai:")) {
        await handleAnnaiButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("vip:")) {
        await handleVipButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("ita:")) {
        await handleItaButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("pkr:")) {
        await handlePokerDuelButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("prof:")) {
        await handleProfileButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("taku:")) {
        await handleTakuButton(interaction, services);
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
  // トートの耳: 対応スレッドの運営メッセージを告発者DMへ匿名中継
  void relayStaffMessage(client, services, message).catch((err) => console.error("[mimi] 中継失敗:", err));
  // 72時間耐久: パネルを会話の最下部へ追従（デバウンス2秒）
  try {
    handleEvent72Message(message, services);
  } catch (err) {
    console.error("[72h] 追従処理失敗:", err);
  }
});

// 入城導線: 参加時のロール付与・案内・招待リンク自動検出 + 入退室ログ
client.on(Events.GuildMemberAdd, (member) => {
  void (async () => {
    const detection = await inviteTracker.detectInvite(member.guild).catch(() => null);
    await handleMemberJoin(member, services, detection?.inviterId ?? null);
    await postJoinLog(client, services, member, detection).catch((err) =>
      console.error("[member-log] 入城ログ投稿失敗:", err),
    );
  })().catch((err) => console.error("[entry] 参加処理失敗:", err));
});

// 退城ログ
client.on(Events.GuildMemberRemove, (member) => {
  void postLeaveLog(client, services, member).catch((err) =>
    console.error("[member-log] 退城ログ投稿失敗:", err),
  );
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
    void handleTakuVoiceUpdate(oldState, newState, services).catch((err) => console.error("[taku] 処理失敗:", err));
    handleEvent72Voice(oldState, newState, services);
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
