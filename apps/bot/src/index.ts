import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { InviteTracker } from "./invite-tracker.js";
import { config } from "./config.js";
import { buildServices } from "./services.js";
import { handleAdminButton, handleAdminSelect, handleAdminModal } from "./commands/admin-payroll-recovery.js";
import { handleShopButton, handleShopModal, handleShopSelect } from "./commands/shop-panel.js";
import { handleShokanButton, handleShokanSelect, handleShokanModal } from "./commands/shokan.js";
import { handleApprovalButton, handleTransferButton } from "./commands/transfer.js";
import { handlePublicEventRecordButton } from "./commands/public-event-record.js";
import { handlePublicEventCompleteButton } from "./commands/public-event-complete.js";
import { handleRankPanelButton } from "./commands/rank-panel.js";
import { handleEtherButton, handleEtherModal } from "./commands/exchange-panel.js";
import { BANZUKE_SELECT_ID, renderBanzuke } from "./commands/banzuke.js";
import { handleBakutenButton, handleBakutenSelect } from "./commands/bakuten.js";
import { replyStocksPaused } from "./casino/stocks-pause.js";
import { handleAnnaiButton } from "./commands/annai.js";
import { handleCasinoHomeButton } from "./commands/casino-home.js";
import { handleVipButton } from "./commands/vip.js";
import {
  handleItaButton,
  handleItaEventButton,
  handleItaEventModal,
  handleItaEventSelect,
  handleItaModal,
  handleItaSelect,
} from "./commands/ita.js";
import {
  handleTakuButton,
  handleTakuVoiceUpdate,
  sweepStaleTables,
  trackTakuChannelDelete,
  trackTakuGuestPresence,
} from "./commands/takutate-panel.js";
import { handlePokerDuelButton, handlePokerDuelSelect } from "./casino/poker-duel.js";
import { denyIfCasinoClosed } from "./casino/gate.js";
import { handleCasinoPlayButton, handleCasinoPrimaryButton, isCasinoPlayButton, isCasinoPrimaryButton } from "./casino/play-route.js";
import {
  CASINO_AMOUNT_PICK_PREFIX,
  CASINO_AMOUNT_CUSTOM_PREFIX,
  CASINO_AMOUNT_MODAL_PREFIX,
  CASINO_GAME_SELECT_CUSTOM_ID,
  handleCasinoAmountPickButton,
  handleCasinoAmountButton,
  handleCasinoAmountModal,
  handleCasinoGameSelect,
} from "./casino/amount-picker.js";
import { handleCasinoResultButton, isCasinoResultButton } from "./casino/result-route.js";
import {
  handleBankButton,
  handleDeptPanelButton,
  handleDeptPanelModal,
  maybeRepostPanel,
} from "./commands/bank-panel.js";
import {
  handleEntryButton,
  handleEntryModal,
  handleMemberJoin,
  handleMemberRoleUpdate,
  handleVoiceAttendance,
} from "./commands/entry.js";
import {
  handleSessionScheduleAutocomplete,
} from "./commands/session-schedule.js";
import { refreshWaitersBoard } from "./waiters-board.js";
import { handleTicketButton } from "./commands/ticket-handler-safe.js";
import { handleReevalApprove, handleReevalReject } from "./commands/reeval.js";
import { handleReturnReasonSubmit, handleReturnTargetSelect } from "./commands/entry-return.js";
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
  handleEvaluationButton,
  handleEvaluationModal,
  handleEvaluationSelect,
} from "./commands/evaluation.js";
import { handleProfileButton } from "./commands/profile.js";
import { handleDepartmentAutocomplete } from "./commands/department.js";
import { handleFiscalButton } from "./commands/fiscal.js";
import { getActiveSlashCommandRoute } from "./commands/active-slash-command-routes.js";
import { getLegacyCompatSlashCommandRoute } from "./commands/legacy-compat-slash-command-routes.js";
import { handleRoomButton, handleRecruitModal, handleRoomRenameModal, handleRoomVoiceUpdate } from "./commands/rooms.js";
import { handleBumpMessage } from "./bump.js";
import { handleBoostRewardMessage, initializeBoostRewardRecovery } from "./boost-reward.js";
import { handleMessageXp, tickVoiceXp } from "./rank-tracker.js";
import { startupReconcileRankTitles } from "./rank-title-wiring.js";
import { trackVoiceState } from "./vc-tracking.js";
import { handleDenVoice } from "./dens.js";
import { handlePaydayButton } from "./payday.js";
import { startScheduler } from "./scheduler.js";
import { armExternalEffectStartupRecovery } from "./scheduler-recovery.js";
import { reconcileTimedAccessForClient, reconcileTimedAccessForGuild } from "./timed-access.js";
import { enforceConversationCourtRestrictionForGuild, handleConversationCourtVoiceUpdate } from "./conversation-court.js";
import { resumePendingFreeSpins } from "./casino/slots.js";
import { startInternalApi } from "./internal-api.js";
import { startOutboxWorker } from "./outbox.js";
import { postJoinLog, postLeaveLog } from "./member-log.js";
import { respondInteractionError } from "./interaction-errors.js";
import { runCasinoRecovery } from "./casino/recovery-run.js";
import {
  handleOriginalRoleTicketButton,
  handleOriginalRoleTicketModal,
  handleOriginalRoleTicketRoleSelect,
  handleOriginalRoleTicketSelect,
} from "./commands/original-role-ticket.js";
import { trackTitleTcMessage, trackTitleTcReaction } from "./tc-social-tracking.js";
import {
  initializeVcPublicSocialPresence,
  resumeVcPublicSocialGuild,
  resumeVcPublicSocialShard,
  startVcPublicSocialGuild,
  suspendVcPublicSocialGuild,
  suspendVcPublicSocialShard,
  trackVcPublicSocialChannelDelete,
  trackVcPublicSocialChannelUpdate,
  trackVcPublicSocialEveryoneRoleUpdate,
  trackVcPublicSocialGuildDelete,
  trackVcPublicSocialPresence,
} from "./vc-public-social-tracking.js";
import {
  initializeRoleFamilyTracking,
  refreshRoleFamilyGuildSnapshot,
  resumeRoleFamilyGuild,
  resumeRoleFamilyShard,
  suspendRoleFamilyGuild,
  suspendRoleFamilyShard,
  trackRoleFamilyMemberAdd,
  trackRoleFamilyMemberRemove,
  trackRoleFamilyMemberUpdate,
} from "./role-family-tracking.js";
import { runCasinoRecoveryBeforeRoleFamilyTracking } from "./startup-safety.js";

const services = buildServices();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent, // bump検知（掲示板ボットのembed読取に必要）
    GatewayIntentBits.GuildInvites, // 招待リンクトラッキング
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

const inviteTracker = new InviteTracker(client);
inviteTracker.wire();

client.once(Events.ClientReady, async (ready) => {
  console.log(`⚔️ 冥獄城ボット 起動: ${ready.user.tag}`);

  // **他の何より先に、外部効果の関門を張る。**
  //
  // 前のプロセスが残した `held` の実行権を収束できるのは再起動直後だけ。
  // ところがこの ready ハンドラの中でも、下の期限つきアクセス収束や、
  // 既に登録済みの interaction / GuildMemberAdd から配送が走りうる。
  // 関門を先に張っておけば、それらは収束の完了を待ってから取得しにいく。
  //
  // 関門はプロセス内の順序づけだけで、所有権の正本ではない（正本はDB）。
  armExternalEffectStartupRecovery(ready, services);

  initializeVcPublicSocialPresence(ready, services);
  // 外部Discord APIへ触る復旧より先に、同期の賭場安全確認を必ず完了させる。
  // 再起動直後にstatus=openのまま外部I/O待ちになるfail-open窓を作らない。
  await runCasinoRecoveryBeforeRoleFamilyTracking(
    () => { runCasinoRecovery(services); },
    () => initializeRoleFamilyTracking(ready, services).then(() => undefined).catch((error) =>
      console.error("[role-family] startup observation failed", error),
    ),
  );
  // 位名(rank title) live wiringの取りこぼしをローカルDBだけで自己修復する（PR D2）。
  // 外部Discord APIは使わない・失敗してもBot起動は継続する（内部でcatch済み）。
  // startup成功はdaily reconcileのmarkerを立てない——別概念（startup repair と
  // daily scheduled repair は独立、その日のdaily reconcileは別途動く）。
  startupReconcileRankTitles(services);
  await initializeBoostRewardRecovery(ready, services).catch((e) =>
    console.error("[boost] 起動時復旧失敗:", e),
  );
  // 前回のプロセスで払い切れなかった無料スピンを精算する（PR3）。
  // 出目は獲得時に確定・保存してあるので、再起動しても表示も配当も変わらない。
  // 賭場が停止中なら資金グループが作れず失敗するが、権利は pending のまま残る
  try {
    const resumed = resumePendingFreeSpins(services);
    if (resumed.total > 0) {
      console.log(
        `[casino] 保留中の無料スピン ${resumed.total}件のうち ${resumed.settled}件を精算（計 ${resumed.paid.toLocaleString("ja-JP")}◈）` +
          (resumed.failed.length > 0 ? ` / 未払い ${resumed.failed.length}件は権利を保持` : ""),
      );
    }
  } catch (e) {
    console.error("[casino] 保留中の無料スピンの再開に失敗（権利は保持）:", e);
  }
  startOutboxWorker(client, services);
  // 経済観測用の読み取り専用内部API（ログBot向け・ホスト内限定）
  startInternalApi(services);
  startScheduler(client, services);

  // 招待キャッシュを初期化（全ギルド）
  for (const [, guild] of ready.guilds.cache) {
    void inviteTracker.initGuild(guild).catch((e) => console.error("[invite] 初期化失敗:", e));
    void enforceConversationCourtRestrictionForGuild(guild, services, new Date(), "startup").catch((e) =>
      console.error("[conversation-court] startup scan failed", e),
    );
  }
  // 期限付きアクセスはschedulerと同じguild:mainだけを正本にする。
  void reconcileTimedAccessForClient(ready, services).catch((e) =>
    console.error("[ショップ] 起動時の期限付きアクセス収束失敗:", e),
  );

  // 起動時に必ず帳簿を検算する（経済設計.md §8）
  const integrity = services.ledger.verifyIntegrity();
  if (!integrity.ok) {
    console.error("🚨 台帳の検算に失敗しました。至急確認してください:", integrity.mismatches);
  } else {
    console.log(`📗 検算OK / 通貨発行残高 ${services.ledger.moneySupply().toLocaleString()} Ld`);
  }

  // 起動時に門番用の待ち人ボードを最新化（未設置なら何もしない）
  refreshWaitersBoard(client, services);

  // 起動時に卓建て空VCを sweep
  void sweepStaleTables(client, services).then((n) => {
    if (n > 0) console.log(`[taku] 起動時 sweep: ${n}件 の空VCを削除`);
  }).catch((e) => console.error("[taku] sweep失敗:", e));
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 賭場が停止していれば、チップを動かしうる操作はここで全部止める（理由付きで返す）
    if (await denyIfCasinoClosed(interaction, services)) return;
    if (interaction.isChatInputCommand()) {
      const route = getActiveSlashCommandRoute(interaction.commandName)
        ?? getLegacyCompatSlashCommandRoute(interaction.commandName);
      if (route) await route(interaction, services);
      return;
    }
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "部署") {
        await handleDepartmentAutocomplete(interaction, services);
      } else if (interaction.commandName === "説明会") {
        await handleSessionScheduleAutocomplete(interaction, services);
      }
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "ret:target") {
      await handleReturnTargetSelect(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ret:reason:")) {
      await handleReturnReasonSubmit(interaction, services);
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
    if (interaction.isModalSubmit() && interaction.customId.startsWith("entry:")) {
      await handleEntryModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("shop:")) {
      await handleShopModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ether:")) {
      await handleEtherModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(CASINO_AMOUNT_MODAL_PREFIX)) {
      await handleCasinoAmountModal(interaction, services);
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
    if (interaction.isStringSelectMenu() && interaction.customId === BANZUKE_SELECT_ID) {
      await interaction.update(renderBanzuke(services, interaction.values[0] ?? "balance", interaction.user.id));
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("stocks:")) {
      await replyStocksPaused(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("pkr:")) {
      await handlePokerDuelSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === CASINO_GAME_SELECT_CUSTOM_ID) {
      await handleCasinoGameSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ita:")) {
      await handleItaSelect(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("itaevt:")) {
      await handleItaEventSelect(interaction, services);
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
    if (interaction.isModalSubmit() && interaction.customId.startsWith("orole:")) {
      if (await handleOriginalRoleTicketModal(interaction, services)) return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("itaevt:")) {
      await handleItaEventModal(interaction, services);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("stocks:")) {
      await replyStocksPaused(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("orole:")) {
      if (await handleOriginalRoleTicketSelect(interaction, services)) return;
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("orole:")) {
      if (await handleOriginalRoleTicketRoleSelect(interaction, services)) return;
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
      if (interaction.customId.startsWith("orole:")) {
        if (await handleOriginalRoleTicketButton(interaction, services)) return;
      }
      if (interaction.customId.startsWith("entry:")) {
        await handleEntryButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("reeval:")) {
        const action = interaction.customId.split(":")[1];
        if (action === "approve") await handleReevalApprove(interaction, services);
        else if (action === "reject") await handleReevalReject(interaction, services);
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
      if (interaction.customId === "eval:open") {
        await handleEvaluationButton(interaction, services);
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
        await replyStocksPaused(interaction);
        return;
      }
      if (interaction.customId.startsWith("annai:")) {
        await handleAnnaiButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith("casino:home:") || interaction.customId.startsWith("casino:daily:")) {
        await handleCasinoHomeButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith(CASINO_AMOUNT_CUSTOM_PREFIX)) {
        await handleCasinoAmountButton(interaction, services);
        return;
      }
      if (interaction.customId.startsWith(CASINO_AMOUNT_PICK_PREFIX)) {
        await handleCasinoAmountPickButton(interaction, services);
        return;
      }
      if (isCasinoResultButton(interaction.customId)) {
        await handleCasinoResultButton(interaction, services);
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
      if (interaction.customId.startsWith("itaevt:")) {
        await handleItaEventButton(interaction, services);
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
      if (isCasinoPlayButton(interaction.customId)) {
        await handleCasinoPlayButton(interaction, services);
        return;
      }
      if (isCasinoPrimaryButton(interaction.customId)) {
        await handleCasinoPrimaryButton(interaction, services);
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
      } else if (interaction.customId.startsWith("pev:")) {
        await handlePublicEventRecordButton(interaction, services);
      } else if (interaction.customId.startsWith("pevc:")) {
        await handlePublicEventCompleteButton(interaction, services);
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
    await respondInteractionError(interaction);
  }
});

// パネル自動再掲（UX原則8）+ boost/bump/up 検知
client.on(Events.MessageCreate, (message) => {
  void trackTitleTcMessage(message, services).catch((err) =>
    console.error("[tc-social] message observation failed", err),
  );
  void maybeRepostPanel(message, services).catch((err) =>
    console.error("[panel] 再掲失敗:", err),
  );
  void handleBoostRewardMessage(message, services).catch((err) => console.error("[boost] 処理失敗:", err));
  void handleBumpMessage(message, services).catch((err) => console.error("[bump] 処理失敗:", err));
  void handleMessageXp(message, services).catch((err) => console.error("[rank] 発言XP付与失敗:", err));
  void relayStaffMessage(client, services, message).catch((err) => console.error("[mimi] 中継失敗:", err));
});

// Recoverable gateway closeはShardReconnecting、unrecoverable closeはShardDisconnect。
// どちらもmain guildをshard-localにsuspendし、replay完了/新session ready後のcacheからだけ再開する。
client.on(Events.ShardReconnecting, (shardId) => {
  suspendVcPublicSocialShard(client, shardId, services);
  suspendRoleFamilyShard(client, shardId, services);
});
client.on(Events.ShardDisconnect, (_event, shardId) => {
  suspendVcPublicSocialShard(client, shardId, services);
  suspendRoleFamilyShard(client, shardId, services);
});
client.on(Events.ShardResume, (shardId) => {
  resumeVcPublicSocialShard(client, shardId, services);
  void resumeRoleFamilyShard(client, shardId, services).catch((error) =>
    console.error("[role-family] shard resume snapshot failed", error),
  );
});
client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
  resumeVcPublicSocialShard(client, shardId, services, undefined, unavailableGuilds);
  void resumeRoleFamilyShard(client, shardId, services, unavailableGuilds).catch((error) =>
    console.error("[role-family] shard ready snapshot failed", error),
  );
});
client.on(Events.GuildUnavailable, (guild) => {
  suspendVcPublicSocialGuild(guild, services);
  suspendRoleFamilyGuild(guild, services, "guild_unavailable");
});
client.on(Events.GuildAvailable, (guild) => {
  resumeVcPublicSocialGuild(guild, services);
  void resumeRoleFamilyGuild(guild, services).catch((error) =>
    console.error("[role-family] guild available snapshot failed", error),
  );
});
client.on(Events.GuildDelete, (guild) => {
  trackVcPublicSocialGuildDelete(guild, services);
  suspendRoleFamilyGuild(guild, services, "guild_delete");
});
client.on(Events.GuildCreate, (guild) => {
  startVcPublicSocialGuild(guild, services);
  void refreshRoleFamilyGuildSnapshot(guild, services).catch((error) =>
    console.error("[role-family] guild create snapshot failed", error),
  );
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  void trackTitleTcReaction(reaction, user, services).catch((err) =>
    console.error("[tc-social] reaction sidecar failed", err),
  );
});

client.on(Events.GuildMemberAdd, (member) => {
  trackRoleFamilyMemberAdd(member, services);
  void (async () => {
    const detection = await inviteTracker.detectInvite(member.guild).catch(() => null);
    await handleMemberJoin(member, services, detection?.inviterId ?? null).catch((err) =>
      console.error("[entry] 参加処理失敗:", err),
    );
    await reconcileTimedAccessForGuild(member.guild, services, member.id).catch((err) =>
      console.error("[ショップ] 再参加時の期限付きアクセス復元失敗:", err),
    );
    await postJoinLog(client, services, member, detection).catch((err) =>
      console.error("[member-log] 入城ログ投稿失敗:", err),
    );
  })().catch((err) => console.error("[entry] 参加処理失敗:", err));
});

client.on(Events.GuildMemberRemove, (member) => {
  trackRoleFamilyMemberRemove(member, services);
  if (!member.user?.bot) {
    try {
      services.returns.recordDeparture(member.id);
    } catch (err) {
      console.error("[entry] 退出記録に失敗:", err);
    }
  }
  void postLeaveLog(client, services, member).catch((err) =>
    console.error("[member-log] 退城ログ失敗:", err),
  );
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  void trackRoleFamilyMemberUpdate(oldMember, newMember, services).catch((err) =>
    console.error("[role-family] member observation failed", err),
  );
  if (oldMember.partial) return;
  void handleMemberRoleUpdate(oldMember, newMember, services).catch((err) =>
    console.error("[entry] ロール変更処理失敗:", err),
  );
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  trackVcPublicSocialPresence(oldState, newState, services);
  try {
    trackTakuGuestPresence(oldState, newState, services);
  } catch (err) {
    console.error("[taku] guest observation失敗:", err);
  }
  try {
    trackVoiceState(oldState, newState, services);
    handleVoiceAttendance(oldState, newState, services);
    handleRoomVoiceUpdate(oldState, newState, services);
    void handleConversationCourtVoiceUpdate(oldState, newState, services).catch((err) =>
      console.error("[conversation-court] voice state handling failed", err),
    );
    void handleDenVoice(oldState, newState, services).catch((err) => console.error("[den] 処理失敗:", err));
    void handleTakuVoiceUpdate(oldState, newState, services).catch((err) => console.error("[taku] 処理失敗:", err));
  } catch (err) {
    console.error("[vc] 記録失敗:", err);
  }
});

client.on(Events.ChannelUpdate, (_oldChannel, newChannel) => {
  if (newChannel.isDMBased()) return;
  trackVcPublicSocialChannelUpdate(newChannel, services);
});

client.on(Events.ChannelDelete, (deletedChannel) => {
  if (deletedChannel.isDMBased()) return;
  trackVcPublicSocialChannelDelete(deletedChannel, services);
  try {
    trackTakuChannelDelete(deletedChannel, services);
  } catch (err) {
    console.error("[taku] channel delete observation失敗:", err);
  }
});

client.on(Events.GuildRoleUpdate, (_oldRole, newRole) => {
  trackVcPublicSocialEveryoneRoleUpdate(newRole, services);
});

function shutdown(): void {
  console.log("冥獄城ボットを停止します…");
  try {
    services.vcPublicSocial.closeAllObserved(Math.floor(Date.now() / 1000));
  } catch (error) {
    console.error("[vc-public-social] graceful close failed", error);
  }
  try {
    services.takutate.closeAllGuestObservations(Math.floor(Date.now() / 1000));
  } catch (error) {
    console.error("[taku] graceful close failed", error);
  }
  client.destroy();
  services.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(config.token);
