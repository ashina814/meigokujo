import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelSelectMenuInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  RoleSelectMenuInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Message,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
} from "discord.js";
import {
  CASINO_OPENING_SETTING_KEYS,
  CasinoIntegrity,
  deptAccount,
  ChipLedgerError,
  HOUSE_HOLDER,
  LedgerError,
  RANKED_TABLE_TIERS,
  readCasinoOpeningConfig,
  type RefundSaga,
  type TicketPanel,
} from "@meigokujo/core";
import { reconcileMemberRank } from "../rank-sync.js";
import {
  backfillConfirm,
  handleBackfillRun,
  handlePromotionCatchUp,
  handleRedeliver,
  handleRoleRestore,
  promotionCatchUpPicker,
  recoveryHome,
  roleRestorePicker,
  undeliveredPicker,
} from "./recovery-hub.js";
import { isAdmin } from "../permissions.js";
import { registerTrustedRankedProfile } from "./casino-employee.js";
import { ROLE_SLOT_META, ROLE_SLOT_ORDER, getRoleIds, setRoleIds, type RoleSlot } from "../church-roles.js";
import {
  getSpecialProfiles,
  removeSpecialProfile,
  toggleSpecialProfile,
  upsertSpecialProfile,
  type SpecialStyle,
} from "../special-profile.js";
import { updateDashboard } from "../dashboard.js";
import { updateWaitersBoard, WAITERS_BOARD_CHANNEL_KEY } from "../waiters-board.js";
import { fmtEther, fmtLd } from "../format.js";
import { isSeatOccupied } from "../casino/common.js";
import { houseCapacityReport } from "../casino/capacity-report.js";
import { describeChipLedgerError, isFormallyOpen, openingBadge, openingNotice, openingPhase } from "../casino/opening.js";
import {
  handleOpeningOpsButton,
  handleOpeningOpsModal,
  isOpeningOpsCustomId,
  openingOpsField,
  openingOpsRows,
} from "../casino/opening-ops.js";
import { recoverCasinoWithPersistentTables } from "../casino/persistent-table-recovery.js";
import { ticketPanelMessageForPanel } from "./tickets.js";
import type { Services } from "../services.js";

/**
 * 運営操作ハブ /管理
 * ボタン + セレクト + モーダルの永続パネル方式で、既存の運営系スラッシュを畳む。
 */
export const adminCommand = new SlashCommandBuilder()
  .setName("管理")
  .setDescription("運営操作ハブ（設定・パネル・給与・徴収・部署・調整・計器盤・XP除外）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

// ---- ハブ ----

export function renderHub(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setTitle("🏛 冥獄城 管理コンソール")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "各カテゴリのボタンを押してください。応答はあなたにだけ表示されます。",
        "",
        "・**設定**: チャンネル/ロール/数値の設定",
        "・**パネル**: 常設パネルの設置・撤去（現在いるチャンネルに）",
        "・**給与**: 給与表の管理と今月支給",
        "・**徴収**: 冥府税・年金の実行",
        "・**部署**: 部署口座の作成・削除",
        "・**調整**: 残高の運営調整",
        "・**計器盤**: 手動更新",
        "・**待ち人**: 門番用の待ち人ボードを設置・更新",
        "・**XP除外**: 発言/浮上XPを付けないチャンネル・カテゴリ",
        "・**賭場**: マモンの賭場（胴元資金・売上精算）",
        "・**回収**: 未配送の再配送・階級ロールの復元など、既存データの手当て",
      ].join("\n"),
    );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:setting").setLabel("設定").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:panel").setLabel("パネル").setEmoji("🪧").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("給与").setEmoji("💰").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:fiscal").setLabel("徴収").setEmoji("🏛").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:dept").setLabel("部署").setEmoji("🏢").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:adjust").setLabel("調整").setEmoji("🔧").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:dashboard").setLabel("計器盤").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:waiters").setLabel("待ち人").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:xpex").setLabel("XP除外").setEmoji("🚫").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:casino").setLabel("賭場").setEmoji("🎰").setStyle(ButtonStyle.Secondary),
  );
  // 1行は5個まで。増やすときは必ず行を足す（超えると /管理 の描画自体が落ちる）
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:recover").setLabel("回収").setEmoji("🧰").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2, row3] };
}

const backButton = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:hub").setLabel("← ハブへ").setStyle(ButtonStyle.Secondary),
  );

// ---- /管理 コマンド本体 ----

export async function handleAdminCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ ...renderHub(), flags: MessageFlags.Ephemeral });
}

// ---- ボタン ディスパッチャ ----

export async function handleAdminButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const section = parts[1];
  const action = parts[2];
  const arg = parts[3];

  if (section === "hub") return void (await interaction.update(renderHub()));

  // ── 設定 ──
  if (section === "setting" && !action) return void (await interaction.update(await settingHome(services)));
  if (section === "setting" && action === "channel-select") return void (await openChannelSetup(interaction, services));
  if (section === "setting" && action === "category-select") return void (await openCategorySetup(interaction, services));
  if (section === "ranksync" && !action) return void (await interaction.update(rankSyncHome()));
  // ── 既存データの回収 ──
  if (section === "recover" && !action) return void (await interaction.update(recoveryHome()));
  if (section === "recover" && action === "shop") return void (await interaction.update(undeliveredPicker(services)));
  if (section === "recover" && action === "role") return void (await interaction.update(roleRestorePicker()));
  if (section === "recover" && action === "promo") return void (await interaction.update(promotionCatchUpPicker()));
  if (section === "recover" && action === "backfill") return void (await interaction.update(backfillConfirm(services)));
  if (section === "recover" && action === "backfill-run") return void (await handleBackfillRun(interaction, services));
  if (section === "setting" && action === "role-select") return void (await openRoleSetup(interaction, services));
  if (section === "setting" && action === "number-select") return void (await openNumberSetup(interaction, services));
  if (section === "setting" && action === "eval-cap") return void (await interaction.update(evaluationCapHome(services)));

  // ── 機関ロール（冥教会・他機関） ──
  if (section === "orgrole" && !action) return void (await interaction.update(orgRoleHome(services)));

  // ── 特別プロフィール（魔王など） ──
  if (section === "sprof" && !action) return void (await interaction.update(specialProfileHome(services)));

  // ── パネル ──
  if (section === "panel" && !action) return void (await interaction.update(panelHome(services)));
  if (section === "panel" && action === "install") return void (await interaction.update(panelInstallPicker()));
  if (section === "panel" && action === "remove") return void (await interaction.update(panelRemovePicker()));
  if (section === "tpanel" && !action) return void (await interaction.update(ticketPanelHome(services)));
  if (section === "tpanel" && action === "create") return void (await interaction.showModal(ticketPanelCreateModal()));
  if (section === "tpanel" && action === "edit") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:edit-pick", "内容を編集する受付を選ぶ")));
  if (section === "tpanel" && action === "install") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:install-pick", "設置・再設置する受付を選ぶ")));
  if (section === "tpanel" && action === "remove") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:remove-pick", "設置パネルを撤去する受付を選ぶ", "installed")));
  if (section === "tpanel" && action === "notify") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:notify-pick", "通知ロールを設定する受付を選ぶ")));
  if (section === "tpanel" && action === "staff") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:staff-pick", "対応ロールを設定する受付を選ぶ")));
  if (section === "tpanel" && action === "disable") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:disable-pick", "無効化する受付を選ぶ", "enabled")));
  if (section === "tpanel" && action === "enable") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:enable-pick", "再有効化する受付を選ぶ", "disabled")));
  if (section === "tpanel" && action === "delete") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:delete-pick", "削除・アーカイブする受付を選ぶ")));
  if (section === "tpanel" && action === "disable-confirm" && arg) return void (await setTicketPanelEnabled(interaction, services, arg, false));
  if (section === "tpanel" && action === "enable-confirm" && arg) return void (await setTicketPanelEnabled(interaction, services, arg, true));
  if (section === "tpanel" && action === "remove-confirm" && arg) return void (await uninstallTicketPanel(interaction, services, arg));
  if (section === "tpanel" && action === "delete-confirm" && arg) return void (await removeTicketPanelRegistration(interaction, services, arg));

  // ── 給与 ──
  if (section === "payroll" && !action) return void (await interaction.update(payrollHome(services)));
  if (section === "payroll" && action === "add-start")
    return void (await interaction.update(payrollAddRolePicker()));
  if (section === "payroll" && action === "pay") return void (await payrollPayNow(interaction, services));

  // ── 徴収 ──
  if (section === "fiscal" && !action) return void (await interaction.update(fiscalHome()));
  if (section === "fiscal" && action === "tax") return void (await interaction.showModal(taxModal()));
  if (section === "fiscal" && action === "pension") return void (await interaction.showModal(pensionModal()));

  // ── 部署 ──
  if (section === "dept" && !action) return void (await interaction.update(deptHome(services)));
  if (section === "dept" && action === "create") return void (await interaction.showModal(deptCreateModal()));
  if (section === "dept" && action === "role") return void (await interaction.update(deptRolePicker(services)));

  // ── 賭場（マモン） ──
  if (section === "casino" && !action) return void (await interaction.update(casinoHome(services)));
  if (section === "casino" && action === "opening") return void (await handleOpeningOpsButton(interaction, services));
  // 古いパネルのボタン（stale button）は残る。押された時点の版でも必ず確かめてから modal を開く
  if (section === "casino" && (action === "fund" || action === "settle") && !isFormallyOpen(services)) {
    return void (await interaction.reply({ content: openingNotice(services), flags: MessageFlags.Ephemeral }));
  }
  if (section === "casino" && action === "fund") return void (await interaction.showModal(casinoFundModal()));
  if (section === "casino" && action === "settle") return void (await interaction.showModal(casinoSettleModal()));
  if (section === "casino" && action === "refund-user") return void (await interaction.showModal(casinoRefundUserModal()));
  if (section === "casino" && action === "refund-all") {
    try {
      const saga = services.chipFlow.createRefundSaga({
        id: interaction.id,
        requestedBy: `user:${interaction.user.id}`,
        scope: "all",
      });
      return void (await interaction.update(casinoRefundConfirm(saga)));
    } catch (error) {
      return void (await interaction.reply({
        content: `❌ ${error instanceof Error ? error.message : "緊急返還案を作成できません"}`,
        flags: MessageFlags.Ephemeral,
      }));
    }
  }
  if (section === "casino" && action === "refund-cancel" && arg) {
    const cancelled = services.chipFlow.cancelRefundSaga(arg, `user:${interaction.user.id}`);
    return void (await interaction.update({
      content: cancelled ? "緊急返還案を取り消しました。" : "この緊急返還案は取り消せません。",
      embeds: [],
      components: [backButton()],
    }));
  }
  if (section === "casino" && action === "refund-execute" && arg) {
    try {
      const saga = services.chipFlow.executeRefundSaga(arg, `user:${interaction.user.id}`, {
        activeGameUsers: (userIds) => userIds.filter(isSeatOccupied),
        processingGroup: () => services.chipTx.isActive(),
        integrityBlocked: () => {
          const state = services.casinoStatus.current().status;
          return state === "integrity_halt" || state === "recovery_halt";
        },
      });
      return void (await interaction.update(casinoRefundResult(saga)));
    } catch (error) {
      return void (await interaction.reply({
        content: `❌ ${error instanceof Error ? error.message : "緊急返還を実行できません"}`,
        flags: MessageFlags.Ephemeral,
      }));
    }
  }
  if (section === "casino" && action === "halt") return void (await interaction.showModal(casinoHaltModal()));
  if (section === "casino" && action === "reopen") {
    // 古いパネルのボタンが残っていることがあるので、押された時点の状態でも確かめる
    const cur = services.casinoStatus.current();
    if (!REOPEN_LABEL[cur.status]) {
      return void (await interaction.reply({
        content:
          cur.status === "opening_reset"
            ? "❌ 開業準備中です。正式開業初期化の完了処理からしか開けられません。"
            : `❌ いまは ${CASINO_STATUS_LABEL[cur.status] ?? cur.status} なので、この導線では開けられません。`,
        flags: MessageFlags.Ephemeral,
      }));
    }
    return void (await interaction.showModal(casinoReopenModal(cur.reason)));
  }
  if (section === "casino" && action === "profile") return void (await interaction.showModal(rankedProfileModal()));
  if (section === "casino" && action === "unlock") return void (await interaction.update(rankedUnlockPanel(services)));
  if (section === "casino" && action === "unlock-toggle") {
    // 段階解放の切り替え。**資金は1 Ld も動かない**（開催可否の設定だけ）。
    // 極 → 冥獄 の順に1段ずつ入れる運用なので、極が閉じたまま冥獄だけ開けさせない。
    const tierKey = parts[3] ?? "";
    const key = RANKED_UNLOCK_SETTING[tierKey];
    if (!key) {
      return void (await interaction.reply({ content: "❌ 未知の卓ランクです。", flags: MessageFlags.Ephemeral }));
    }
    const next = services.settings.getNumber(key) === 1 ? 0 : 1;
    if (tierKey === "meigoku" && next === 1 && services.settings.getNumber("casino_extreme_enabled") !== 1) {
      return void (await interaction.reply({
        content: "❌ 冥獄卓は極卓を解放してからにしてください（段階解放は1段ずつ）。",
        flags: MessageFlags.Ephemeral,
      }));
    }
    if (tierKey === "extreme" && next === 0 && services.settings.getNumber("casino_meigoku_enabled") === 1) {
      return void (await interaction.reply({
        content: "❌ 冥獄卓が解放中です。先に冥獄卓を閉じてください。",
        flags: MessageFlags.Ephemeral,
      }));
    }
    services.settings.set(key, String(next), interaction.user.id);
    services.events.log("casino_ranked_tier_unlock_changed", {
      actor: interaction.user.id,
      target: tierKey,
      payload: { unlocked: next === 1 },
    });
    return void (await interaction.update(rankedUnlockPanel(services)));
  }
  if (section === "casino" && action === "baseline") {
    return void (await interaction.showModal(
      casinoBaselineModal(services.chips.pool(), services.ledger.lastTransactionId()),
    ));
  }
  if (section === "casino" && action === "rerecover") {
    // 起動時の復旧（S1〜S12）をもう一度通す（PR7・レビュー指摘）。
    // `recovery_halt` の唯一の出口。所有元の申告が読めるようになっていれば、
    // 収集 → 掃除 → 予約解放 → 全点検 → S12 まで進んで open に戻る。
    // 読めないままなら再び recovery_halt のままで、資金は1 Ld も動かない
    // 古い管理パネル／保存済み custom ID でも、押された時点の状態で必ず拒否する。
    // `recoverCasino()` は通常起動にも使うため、営業中などから呼ぶと復旧処理が
    // 資金・予約・状態へ触れてしまう。ここは recovery_halt 専用の入口にする。
    const cur = services.casinoStatus.current();
    if (cur.status !== "recovery_halt") {
      await interaction.reply({
        content: `❌ いまは ${CASINO_STATUS_LABEL[cur.status] ?? cur.status} です。復旧の再実行は「起動時の復旧が未完了」のときだけ実行できます。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // recoverCasino() 自体は S1〜S12 の予期しない例外を内部で recovery_halt へ変換するが、
    // 呼び出しそのもの（deps の組み立て等）で万一例外が出ても interaction を無応答で
    // 終わらせない・成功したかのような表示を出さないための防御（PR7監査・二次レビュー）。
    try {
      const r = await recoverCasinoWithPersistentTables(interaction.client, services);
      const detail = [
        `維持 ${r.keptHolders}件 / 孤児返金 ${r.refundedSessions}件 / 隔離 ${r.quarantined}件`,
        `不一致 ${r.mismatched.length}件 / 返金失敗 ${r.failedSessions.length}件`,
        r.releasedReservations.released ? `予約解放 ${r.releasedReservations.count}件` : "予約解放は未実行",
        `自由チップ返還 ${r.redeemedFreeChips.redeemed.length}名 / 失敗 ${r.redeemedFreeChips.failed.length}名`,
      ].join("\n");
      await interaction.reply({
        content:
          r.outcome === "opened"
            ? `🟢 復旧が完了し、賭場を開けました。\n${detail}`
            : `❌ 復旧は完了しませんでした（${r.outcome}）。\n${r.reason ?? ""}\n${detail}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await interaction.reply({
        content: `❌ 復旧の再実行中に予期しないエラーが発生しました: ${message}\n資金・状態は変更されていない可能性がありますが、必ず現在の状態を確認してください。`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
  if (section === "casino" && action === "recheck") {
    // 全点検（Land台帳 + 検算A〜D）。通れば検算停止だけを解ける（人が直したあとに押す想定）
    const report = services.casinoIntegrity.runFull();
    const cur = services.casinoStatus.current();
    if (cur.status === "integrity_halt") {
      services.casinoStatus.reopenAfterIntegrity("再点検で全点検が通った", interaction.user.id, report.ok);
    } else if (!report.ok && cur.status === "open") {
      services.casinoStatus.haltForIntegrity(CasinoIntegrity.describeFailure(report), interaction.user.id);
    }
    return void (await interaction.update(casinoHome(services)));
  }

  // ── 調整 ──
  if (section === "adjust" && !action) return void (await interaction.update(adjustHome()));

  // ── 計器盤 ──
  if (section === "dashboard" && !action) {
    await interaction.deferUpdate();
    const result = await updateDashboard(interaction.client, services).catch((e): { ok: false; reason: string } => {
      console.error("[計器盤] 手動更新に失敗:", e);
      return { ok: false, reason: e instanceof Error ? e.message : "不明なエラー" };
    });
    await interaction.editReply({
      content: result.ok
        ? "📊 計器盤を更新しました。"
        : `⚠️ 計器盤の更新に失敗しました: ${result.reason ?? "ログを確認してください"}`,
      embeds: [],
      components: [backButton()],
    });
    return;
  }

  // ── 待ち人ボード ──
  // 設置も更新も同じ操作。channel:waiters_board のチャンネルに1枚置き、以後は編集し続ける
  if (section === "waiters" && !action) {
    await interaction.deferUpdate();
    const channelId = services.settings.getString(WAITERS_BOARD_CHANNEL_KEY);
    if (!channelId) {
      await interaction.editReply({
        content: "⚠️ 先に `設定 → チャンネル → 門番用の待ち人ボード` で設置先を決めてください。",
        embeds: [],
        components: [backButton()],
      });
      return;
    }
    const result = await updateWaitersBoard(interaction.client, services).catch((e): { ok: false; reason: string } => {
      console.error("[待ち人ボード] 手動更新に失敗:", e);
      return { ok: false, reason: e instanceof Error ? e.message : "不明なエラー" };
    });
    await interaction.editReply({
      content: result.ok
        ? `🚪 待ち人ボードを${"action" in result && result.action === "created" ? "設置" : "更新"}しました → <#${channelId}>`
        : `⚠️ 待ち人ボードの更新に失敗しました: ${result.reason ?? "ログを確認してください"}`,
      embeds: [],
      components: [backButton()],
    });
    return;
  }

  // ── XP除外 ──
  if (section === "xpex" && !action) return void (await interaction.update(xpexHome(services)));
  if (section === "xpex" && action === "remove") return void (await xpexRemove(interaction, services, arg!));
}

export async function handleAdminSelect(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction | ChannelSelectMenuInteraction | RoleSelectMenuInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const section = parts[1];
  const action = parts[2];

  if (section === "setting" && action === "channel-key" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(await settingChannelPicker(interaction.values[0]!)));
  }
  if (section === "setting" && action === "category-key" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(await settingCategoryPicker(interaction.values[0]!)));
  }
  if (section === "setting" && action === "category-pick" && interaction.isChannelSelectMenu()) {
    const key = parts[3]!;
    services.settings.set(`category:${key}`, interaction.values[0]!, `user:${interaction.user.id}`);
    return void (await interaction.update({ content: `✅ **category:${key}** に <#${interaction.values[0]}> を設定しました。`, embeds: [], components: [backButton()] }));
  }
  if (section === "setting" && action === "channel-pick" && interaction.isChannelSelectMenu()) {
    const key = parts[3]!;
    services.settings.set(`channel:${key}`, interaction.values[0]!, `user:${interaction.user.id}`);
    return void (await interaction.update({ content: `✅ **${key}** に <#${interaction.values[0]}> を設定しました。`, embeds: [], components: [backButton()] }));
  }
  if (section === "setting" && action === "role-key" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(await settingRolePicker(interaction.values[0]!)));
  }
  if (section === "setting" && action === "role-pick" && interaction.isRoleSelectMenu()) {
    const key = parts[3]!;
    services.settings.set(`role:${key}`, interaction.values[0]!, `user:${interaction.user.id}`);
    return void (await interaction.update({ content: `✅ **${key}** に <@&${interaction.values[0]}> を設定しました。`, embeds: [], components: [backButton()] }));
  }
  if (section === "setting" && action === "number-key" && interaction.isStringSelectMenu()) {
    return void (await interaction.showModal(numberSetModal(interaction.values[0]!)));
  }
  if (section === "setting" && action === "eval-cap-pick" && interaction.isRoleSelectMenu()) {
    return void (await interaction.showModal(evaluationCapModal(services, interaction.values[0]!)));
  }
  // ── 機関ロール ──
  if (section === "orgrole" && action === "key" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(orgRolePicker(services, interaction.values[0]! as RoleSlot)));
  }
  if (section === "orgrole" && action === "set" && interaction.isRoleSelectMenu()) {
    const slot = parts[3]! as RoleSlot;
    setRoleIds(services, slot, [...interaction.values], `user:${interaction.user.id}`);
    const n = interaction.values.length;
    return void (await interaction.update({
      content: n > 0 ? `✅ **${ROLE_SLOT_META[slot].label}** に ${n}件 のロールを設定しました。` : `🗑 **${ROLE_SLOT_META[slot].label}** のロールをクリアしました。`,
      embeds: [],
      components: [backButton()],
      allowedMentions: { parse: [] },
    }));
  }
  // ── 特別プロフィール ──
  if (section === "recover" && action === "redeliver" && interaction.isStringSelectMenu()) {
    return void (await handleRedeliver(interaction, services));
  }
  if (section === "recover" && action === "role-target" && interaction.isUserSelectMenu()) {
    return void (await handleRoleRestore(interaction, services));
  }
  if (section === "recover" && action === "promo-target" && interaction.isUserSelectMenu()) {
    return void (await handlePromotionCatchUp(interaction, services));
  }
  if (section === "ranksync" && action === "target" && interaction.isUserSelectMenu()) {
    const targetId = interaction.values[0]!;
    if (!interaction.guild) {
      return void (await interaction.update({ content: "サーバー内で実行してください。", embeds: [], components: [backButton()] }));
    }
    // 自動同期と**同じ判定**を即時に走らせるだけ。任意 status を書き込む機能にはしない
    const outcome = await reconcileMemberRank(interaction.guild, services, targetId, `user:${interaction.user.id}`);
    const base =
      outcome.kind === "update"
        ? `✅ <@${targetId}> の階級を **${outcome.from} → ${outcome.to}** に合わせました。`
        : outcome.kind === "noop"
          ? `ℹ️ <@${targetId}> は既にロールと一致しています（${outcome.detail}）。変更していません。`
          : outcome.kind === "no_soul"
            ? `⚠️ <@${targetId}> の魂の記録がありません。入城処理を先に行ってください。変更していません。`
            : `⚠️ <@${targetId}> は自動で判断できません（${outcome.detail}）。変更していません。`;
    // status が一致していてもロール構成が異常なことがある（迷霊と通常階級の同居など）
    const message =
      outcome.anomalies && outcome.anomalies.length > 0
        ? `${base}\n⚠️ ロール構成に異常があります: ${outcome.anomalies.join(", ")}（余分な階級ロールを手で外してください）`
        : base;
    return void (await interaction.update({ content: message, embeds: [], components: [backButton()] }));
  }
  if (section === "sprof" && action === "pick" && interaction.isRoleSelectMenu()) {
    return void (await interaction.showModal(sprofModal(services, interaction.values[0]!)));
  }
  if (section === "sprof" && action === "toggle" && interaction.isStringSelectMenu()) {
    toggleSpecialProfile(services, interaction.values[0]!, `user:${interaction.user.id}`);
    return void (await interaction.update(specialProfileHome(services)));
  }
  if (section === "sprof" && action === "delete" && interaction.isStringSelectMenu()) {
    removeSpecialProfile(services, interaction.values[0]!, `user:${interaction.user.id}`);
    return void (await interaction.update(specialProfileHome(services)));
  }
  if (section === "panel" && action === "install-pick" && interaction.isStringSelectMenu()) {
    return void (await installPanel(interaction, services, interaction.values[0]!));
  }
  if (section === "panel" && action === "dept-pick" && interaction.isStringSelectMenu()) {
    return void (await installDeptPanel(interaction, services, interaction.values[0]!));
  }
  if (section === "panel" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await removePanel(interaction, services, interaction.values[0]!));
  }
  if (section === "tpanel" && action === "edit-pick" && interaction.isStringSelectMenu()) {
    const panel = services.tickets.getPanel(interaction.values[0]!);
    if (!panel || panel.archivedAt) {
      return void (await interaction.update({ content: "❌ 編集できる受付が見つかりません。", embeds: [], components: [backButton()] }));
    }
    return void (await interaction.showModal(ticketPanelEditModal(panel)));
  }
  if (section === "tpanel" && action === "install-pick" && interaction.isStringSelectMenu()) {
    return void (await installTicketPanel(interaction, services, interaction.values[0]!));
  }
  if (section === "tpanel" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "remove")));
  }
  if (section === "tpanel" && action === "notify-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelRolePicker(services, interaction.values[0]!, "notify")));
  }
  if (section === "tpanel" && action === "staff-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelRolePicker(services, interaction.values[0]!, "staff")));
  }
  if (section === "tpanel" && action === "disable-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "disable")));
  }
  if (section === "tpanel" && action === "enable-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "enable")));
  }
  if (section === "tpanel" && action === "delete-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "delete")));
  }
  if (section === "tpanel" && (action === "notify-roles" || action === "staff-roles") && interaction.isRoleSelectMenu()) {
    const panelId = parts[3]!;
    const type = action === "notify-roles" ? "notify" : "staff";
    const panel = services.tickets.setPanelRoles(panelId, type, [...interaction.values], `user:${interaction.user.id}`);
    const label = type === "notify" ? "通知ロール" : "対応ロール";
    return void (await interaction.update({
      content: panel ? `✅ 「${panel.name}」の${label}を ${interaction.values.length}件 設定しました。` : "❌ 受付が見つかりません。",
      embeds: [],
      components: [backButton()],
      allowedMentions: { parse: [] },
    }));
  }
  if (section === "dept" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await deptRemove(interaction, services, interaction.values[0]!));
  }
  if (section === "dept" && action === "role-pick" && interaction.isStringSelectMenu()) {
    const key = interaction.values[0]!;
    const dept = services.departments.get(key);
    if (!dept) {
      return void (await interaction.update({ content: "❌ 部署が見つかりません。", embeds: [], components: [backButton()] }));
    }
    return void (await interaction.update(deptRoleSetPicker(key, dept.name)));
  }
  if (section === "dept" && action === "role-set" && interaction.isRoleSelectMenu()) {
    const key = parts[3]!;
    const dept = services.departments.get(key);
    if (!dept) {
      return void (await interaction.update({ content: "❌ 部署が見つかりません。", embeds: [], components: [backButton()] }));
    }
    const roleId = interaction.values[0]!;
    services.departments.upsert(dept.key, dept.name, roleId);
    return void (await interaction.update({
      content: `✅ 「${dept.name}」の担当ロールを <@&${roleId}> に設定しました。`,
      embeds: [],
      components: [backButton()],
      allowedMentions: { parse: [] },
    }));
  }
  if (section === "adjust" && action === "target" && interaction.isUserSelectMenu()) {
    return void (await interaction.showModal(adjustAmountModal(interaction.values[0]!)));
  }
  if (section === "xpex" && action === "add" && interaction.isChannelSelectMenu()) {
    return void (await xpexAdd(interaction, services, interaction.values[0]!));
  }
  if (section === "payroll" && action === "add-role" && interaction.isRoleSelectMenu()) {
    return void (await interaction.showModal(payrollAddModal(interaction.values[0]!)));
  }
  if (section === "payroll" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await payrollRemove(interaction, services, interaction.values[0]!));
  }
}

export async function handleAdminModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) return;
  if (isOpeningOpsCustomId(interaction.customId)) return void (await handleOpeningOpsModal(interaction, services));
  const parts = interaction.customId.split(":");
  const section = parts[1];
  const action = parts[2];

  if (section === "casino" && action === "profile") {
    // 汎用順位卓の順位配分は**運営だけ**が登録できる（PR24）。従業員は登録済みから選ぶだけ。
    // 妥当性（ゼロ和・整数Land・受取非負・プール保存）は core の validateRankProfile がそのまま判定する
    const profileKey = interaction.fields.getTextInputValue("profile_key").trim();
    const label = interaction.fields.getTextInputValue("label").trim();
    const deltas = parseRankDeltaTokens(interaction.fields.getTextInputValue("deltas"));
    if (!deltas) {
      await interaction.reply({
        content: [
          "順位配分は**10進整数だけ**を2つ以上、カンマか空白区切りで入力してください。",
          "例: `10000, 0, -10000`",
          "小数・指数表記・16進数・数字以外の語が1つでも混ざっていれば登録しません（読み飛ばしません）。",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const result = registerTrustedRankedProfile(interaction, services, {
      profileKey,
      label,
      participantCount: deltas.length,
      rankDeltaBps: deltas,
    });
    await interaction.reply({
      content: result.ok
        ? `順位配分「${label}」(\`${profileKey}\`) を登録しました。従業員パネルの「卓を開く」から選べます。`
        : `❌ 登録できません: ${result.reason}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (section === "casino" && action === "refund-user") {
    const targetId = interaction.fields.getTextInputValue("user_id").trim();
    if (!/^\d{15,22}$/.test(targetId)) {
      await interaction.reply({ content: "Discord利用者IDを入力してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const saga = services.chipFlow.createRefundSaga({
        id: interaction.id,
        requestedBy: `user:${interaction.user.id}`,
        scope: "user",
        userId: targetId,
      });
      await interaction.reply({ ...casinoRefundConfirm(saga), flags: MessageFlags.Ephemeral });
    } catch (error) {
      await interaction.reply({
        content: `❌ ${error instanceof Error ? error.message : "緊急返還案を作成できません"}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (section === "tpanel" && action === "create") {
    const id = interaction.fields.getTextInputValue("id").trim().toLowerCase();
    const name = interaction.fields.getTextInputValue("name").trim();
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const buttonLabel = interaction.fields.getTextInputValue("button_label").trim();
    try {
      const panel = services.tickets.upsertPanel({ id, name, title, description, buttonLabel, enabled: true }, `user:${interaction.user.id}`);
      await interaction.reply({ content: `✅ チケット受付「${panel.name}」を保存しました。続けて **通知ロール** と **対応ロール** を設定してください。未設定の間は旧 ticket_staff にフォールバックします。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `❌ 保存に失敗しました。IDは英小文字・数字・_・- の2〜49文字で指定してください。${e instanceof Error ? ` (${e.message})` : ""}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (section === "tpanel" && action === "edit") {
    const id = parts[3]!;
    const current = services.tickets.getPanel(id);
    if (!current || current.archivedAt) {
      await interaction.reply({ content: "❌ 編集できる受付が見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.fields.getTextInputValue("name").trim();
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const buttonLabel = interaction.fields.getTextInputValue("button_label").trim();
    try {
      const panel = services.tickets.upsertPanel({ id, name, title, description, buttonLabel, buttonEmoji: current.buttonEmoji, notifyRoleIds: current.notifyRoleIds, staffRoleIds: current.staffRoleIds, enabled: current.enabled }, `user:${interaction.user.id}`);
      let warning = "";
      if (panel.channelId && panel.messageId) {
        let channelFetchFailed = false;
        const channel = await interaction.client.channels.fetch(panel.channelId).catch((error) => {
          channelFetchFailed = true;
          console.warn("[ticket-panel] 内容編集後の設置チャンネル取得に失敗しました", { panelId: panel.id, channelId: panel.channelId, error });
          return null;
        });
        if (channelFetchFailed) {
          warning = "設置チャンネルの取得に失敗しました。設置情報は維持しています。時間を置いて再試行してください。";
        } else if (channel?.isTextBased() && "messages" in channel) {
          const fetched = await fetchPanelMessage(channel, panel.messageId);
          if (fetched.ok && fetched.message) {
            const rendered = ticketPanelMessageForPanel(panel);
            await fetched.message.edit({ embeds: rendered.embeds, components: rendered.components }).catch(() => { warning = "設置済みメッセージの表示更新に失敗しました。再設置してください。"; });
          } else if (fetched.ok) {
            services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing message");
            warning = "設置済みメッセージが見つからなかったため未設置へ戻しました。";
          } else warning = "設置済みメッセージの取得に失敗しました。設定内容と設置情報は維持しています。";
        } else {
          services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing channel");
          warning = "設置チャンネルが見つからなかったため未設置へ戻しました。";
        }
      }
      await interaction.reply({ content: `✅ チケット受付「${panel.name}」を更新しました。${warning ? `\n⚠️ ${warning}` : ""}`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `❌ 更新に失敗しました。${e instanceof Error ? ` (${e.message})` : ""}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (section === "setting" && action === "number") {
    const key = parts[3]!;
    const raw = interaction.fields.getTextInputValue("value").replaceAll(",", "").trim();
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      await interaction.reply({ content: "数値を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (POSITIVE_INTEGER_NUMBER_KEYS.has(key) && (!Number.isInteger(n) || n <= 0)) {
      await interaction.reply({ content: "昇格印・低評価印の必要数は、1以上の整数で入力してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (NON_NEGATIVE_NUMBER_KEYS.has(key) && n < 0) {
      await interaction.reply({ content: "招待印の換算値・上限は、0以上の数値で入力してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    services.settings.set(key, n, `user:${interaction.user.id}`);
    await interaction.reply({ content: `✅ **${key}** = ${n.toLocaleString()} に設定しました。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (section === "setting" && action === "eval-cap-save") {
    const roleId = parts[3]!;
    const raw = interaction.fields.getTextInputValue("value").replaceAll(",", "").trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 25) {
      await interaction.reply({ content: "最大印数は 0〜25 の整数で入力してください（0で設定削除）。", flags: MessageFlags.Ephemeral });
      return;
    }
    const caps = evalMarkCapsByRole(services);
    if (n === 0) delete caps[roleId];
    else caps[roleId] = n;
    services.settings.set("eval_mark_caps_by_role", caps, `user:${interaction.user.id}`);
    await interaction.reply({
      content: n === 0 ? `🗑 <@&${roleId}> の評価印上限設定を削除しました。` : `✅ <@&${roleId}> の評価印上限を **${n}印** に設定しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (section === "sprof" && action === "save") {
    const roleId = parts[3]!;
    const name = interaction.fields.getTextInputValue("name").trim();
    const priority = Number(interaction.fields.getTextInputValue("priority").replaceAll(",", "").trim());
    const desc = (interaction.fields.getTextInputValue("desc") || "").trim();
    const styleRaw = (interaction.fields.getTextInputValue("style") || "").trim().toLowerCase();
    const enabledRaw = (interaction.fields.getTextInputValue("enabled") || "").trim();
    if (!name || !Number.isFinite(priority)) {
      await interaction.reply({ content: "表示名と、数値の優先度を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const style: SpecialStyle = (["maou", "gold", "crimson", "plain"].includes(styleRaw) ? styleRaw : "maou") as SpecialStyle;
    const enabled = !/^(no|false|0|off|オフ|無効|いいえ|×)$/i.test(enabledRaw);
    upsertSpecialProfile(services, { roleId, name, priority, desc, style, enabled }, `user:${interaction.user.id}`);
    await interaction.reply({
      content: `✅ 特別プロフィール **${name}**（<@&${roleId}> / 優先度${priority} / ${style} / ${enabled ? "有効" : "無効"}）を保存しました。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (section === "adjust" && action === "amount") {
    const targetId = parts[3]!;
    const amount = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
    const reason = interaction.fields.getTextInputValue("reason").trim();
    if (!Number.isFinite(amount) || amount === 0) {
      await interaction.reply({ content: "金額は0以外の数値で。マイナスも可（回収方向）。", flags: MessageFlags.Ephemeral });
      return;
    }
    const account = `user:${targetId}`;
    services.ledger.ensureAccount(account, "user");
    try {
      services.ledger.transfer({
        from: amount > 0 ? "sys:treasury" : account,
        to: amount > 0 ? account : "sys:treasury",
        amount: Math.abs(amount),
        type: "adjust",
        actor: `user:${interaction.user.id}`,
        reason: reason || undefined,
        idempotencyKey: `adjust:${interaction.id}`,
        approvedBy: `user:${interaction.user.id}`,
      });
      await interaction.reply({
        content: `✅ <@${targetId}> の残高を **${amount >= 0 ? "+" : "-"}${fmtLd(Math.abs(amount))}** 調整しました${reason ? `（${reason}）` : ""}。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      const msg = e instanceof LedgerError ? e.code : "処理失敗";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (section === "casino" && (action === "fund" || action === "settle")) {
    // 停止中は運営卓からも資金を動かさない（資金層でも弾かれるが、理由を先に見せる）
    const deny = services.casinoStatus.denyMessage();
    if (deny) {
      await interaction.reply({ content: `⛔ ${deny}`, flags: MessageFlags.Ephemeral });
      return;
    }
    // 古いパネルから開いた modal（stale modal）の着地点。正式開業前・未知版は
    // generic な失敗ではなく、専用の文面で断る（PR8監査・項目8）
    if (!isFormallyOpen(services)) {
      await interaction.reply({ content: openingNotice(services), flags: MessageFlags.Ephemeral });
      return;
    }
  }
  if (section === "casino" && action === "fund") {
    const amt = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
    if (!Number.isSafeInteger(amt) || amt <= 0) {
      await interaction.reply({ content: "金額は正の整数で。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const r = services.chips.fundFromAccount(deptAccount(CASINO_DEPT_KEY), amt, HOUSE_HOLDER, `casino:fund:${interaction.id}`);
      await interaction.reply({
        content: `✅ 胴元へ **${fmtLd(r.land)}** を投入し、**${fmtEther(r.ether)}** になりました（胴元残 ${fmtEther(services.casino.houseBalance())}）。`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      const msg =
        e instanceof LedgerError && e.code === "ERR_INSUFFICIENT"
          ? `部署「${CASINO_DEPT_KEY}」の残高が足りません（${fmtLd(services.departments.balanceOf(CASINO_DEPT_KEY))}）。`
          : e instanceof ChipLedgerError
            ? describeChipLedgerError(e, services, HOUSE_HOLDER)
            : "処理に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (section === "casino" && action === "settle") {
    const raw = interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim();
    const held = services.casino.houseBalance();
    // 進行中ゲームの最大配当は予約で押さえてある。その裏付けは精算できない（PR5）。
    // **金額未入力でも全残高ではなく精算可能額だけ**を対象にする
    const settleable = services.chips.settleableBalance(HOUSE_HOLDER);
    const reserved = held - settleable;
    const amt = raw === "" ? settleable : Number(raw);
    if (!Number.isSafeInteger(amt) || amt <= 0) {
      const why =
        held === 0
          ? "胴元残高が 0 です。"
          : settleable === 0
            ? `いま精算できる額は 0 です（残高 ${fmtEther(held)} は全額が進行中ゲームの予約 ${fmtEther(reserved)} の裏付けです）。`
            : "金額は正の整数で。";
      await interaction.reply({ content: why, flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const r = services.chips.redeemFairToAccount(HOUSE_HOLDER, amt, deptAccount(CASINO_DEPT_KEY), `casino:settle:${interaction.id}`);
      await interaction.reply({
        content: `✅ 胴元の **${fmtEther(r.ether)}** を精算し、部署「${CASINO_DEPT_KEY}」へ **${fmtLd(r.land)}** を戻しました（胴元残 ${fmtEther(services.casino.houseBalance())}）。`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      const msg =
        e instanceof ChipLedgerError && e.code === "ERR_RESERVED_FUNDS"
          ? `進行中ゲームの予約 ${fmtEther(reserved)} は精算できません（いま精算できるのは ${fmtEther(settleable)} まで）。`
          : e instanceof ChipLedgerError
            ? describeChipLedgerError(e, services, HOUSE_HOLDER)
            : "処理に失敗しました。";
      await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (section === "casino" && action === "halt") {
    const reason = interaction.fields.getTextInputValue("reason").trim();
    services.casinoStatus.haltManually(reason, interaction.user.id);
    await interaction.reply({
      content: `⛔ 賭場を止めました（${reason}）。以降、チップが動く操作はすべて理由付きで断ります。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (section === "casino" && action === "reopen") {
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const cur = services.casinoStatus.current();
    // 開ける前に必ず全点検する。NG のまま開けると壊れた帳簿の上に取引を積むことになる
    const report = services.casinoIntegrity.runFull();
    if (!report.ok) {
      await interaction.reply({
        content: `❌ 全点検が通らないので開けられません。\n${CasinoIntegrity.describeFailure(report)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // 状態ごとの経路で開ける（メンテ終了の導線で検算停止を開けたりできない）
    const result =
      cur.status === "manual_halt"
        ? services.casinoStatus.reopenFromManualHalt(reason, interaction.user.id)
        : cur.status === "integrity_halt"
          ? services.casinoStatus.reopenAfterIntegrity(reason, interaction.user.id, report.ok)
          : cur.status === "maintenance"
            ? services.casinoStatus.endMaintenance(reason, interaction.user.id)
            : // opening_reset を含む残りはここへ落ちる。開業準備中は正式開業初期化（PR12）の
              // 完了処理からしか open にできない
              { ok: false, reason: `いまは ${cur.status} なので、この導線では開けられない` };
    await interaction.reply({
      content: result.ok ? `🟢 賭場を開けました（${reason}）。` : `❌ ${result.reason}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (section === "casino" && action === "baseline") {
    if (interaction.fields.getTextInputValue("confirm").trim() !== "確定") {
      await interaction.reply({ content: "❌ 「確定」と入力されなかったので何もしていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const poolLand = services.chips.pool();
    const ledgerTxId = services.ledger.lastTransactionId();
    const version = services.chipTx.currentVersion();
    const placed = services.chipTx.establishOpeningLandBaseline(version, poolLand, ledgerTxId);
    services.events.log("casino_opening_land_baseline", {
      actor: interaction.user.id,
      payload: { version, poolLand, fromLedgerTxId: ledgerTxId, placed },
    });
    await interaction.reply({
      content: placed
        ? `📌 版 ${version} の検算B基準を確定しました（準備プール ${fmtLd(poolLand)} / 境界取引 #${ledgerTxId}）。これ以降の準備口座の出入りを監査します。`
        : "既に基準が入っているため、何も変更していません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (section === "dept" && action === "create") {
    const name = interaction.fields.getTextInputValue("name").trim();
    if (!name) {
      await interaction.reply({ content: "部署名を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      services.departments.upsert(name, name, null);
      await interaction.reply({
        content: `✅ 部署「${name}」を作成しました。続けて **担当ロール** ボタンから担当ロールを設定してください。`,
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      await interaction.reply({ content: "❌ 作成に失敗しました（キーが不正または既存の可能性）。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (section === "payroll" && action === "add") {
    const roleId = parts[3]!;
    const label = interaction.fields.getTextInputValue("label").trim();
    const amount = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
    if (!label || !Number.isFinite(amount) || amount < 0) {
      await interaction.reply({ content: "ラベルと0以上の金額を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      services.payroll.setSalary(roleId, label, amount, `user:${interaction.user.id}`);
      await interaction.reply({ content: `✅ 給与表: <@&${roleId}> = ${label} / ${fmtLd(amount)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (e) {
      await interaction.reply({ content: `❌ ${e instanceof Error ? e.message : "設定失敗"}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (section === "fiscal" && (action === "tax" || action === "pension")) {
    const period = interaction.fields.getTextInputValue("period").trim() || new Date().toISOString().slice(0, 7);
    try {
      if (action === "tax") {
        const threshold = Number(interaction.fields.getTextInputValue("threshold").replaceAll(",", "").trim());
        const rateBps = Number(interaction.fields.getTextInputValue("rate_bps").replaceAll(",", "").trim());
        if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(rateBps) || rateBps <= 0 || rateBps > 10000) {
          await interaction.reply({ content: "閾値(0以上) と 税率bps(1〜10000) を入れてください。", flags: MessageFlags.Ephemeral });
          return;
        }
        const run = services.fiscal.generateTaxDraft(period, { threshold, rateBps }, `user:${interaction.user.id}`);
        services.fiscal.approve(run.id, `user:${interaction.user.id}`);
        const rep = services.fiscal.execute(run.id, `user:${interaction.user.id}`);
        await interaction.reply({ content: `✅ 冥府税 ${period}: 徴収 ${fmtLd(rep.total)}（対象 ${rep.succeeded}名）`, flags: MessageFlags.Ephemeral });
      } else {
        const minDays = Number(interaction.fields.getTextInputValue("min_days").replaceAll(",", "").trim());
        const amount = Number(interaction.fields.getTextInputValue("amount").replaceAll(",", "").trim());
        if (!Number.isFinite(minDays) || minDays < 0 || !Number.isFinite(amount) || amount <= 0) {
          await interaction.reply({ content: "最低在城日数(0以上) と 支給額(1以上) を入れてください。", flags: MessageFlags.Ephemeral });
          return;
        }
        const run = services.fiscal.generatePensionDraft(period, { minDays, amount }, `user:${interaction.user.id}`);
        services.fiscal.approve(run.id, `user:${interaction.user.id}`);
        const rep = services.fiscal.execute(run.id, `user:${interaction.user.id}`);
        await interaction.reply({ content: `✅ 年金 ${period}: 支給 ${fmtLd(rep.total)}（対象 ${rep.succeeded}名）`, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      await interaction.reply({ content: `❌ ${e instanceof Error ? e.message : "実行失敗"}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
}

// ---- 設定サブパネル ----

async function settingHome(_services: Services) {
  const embed = new EmbedBuilder()
    .setTitle("⚙️ 設定")
    .setDescription(["変更したい項目を選んでください。", "現在の設定一覧は /計器盤 または DB を直接確認してください。"].join("\n"))
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:setting:channel-select").setLabel("チャンネル").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:setting:category-select").setLabel("カテゴリ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:setting:role-select").setLabel("ロール").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:setting:number-select").setLabel("数値").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:orgrole").setLabel("機関ロール").setEmoji("⛪").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:sprof").setLabel("特別プロフィール").setEmoji("👑").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:setting:eval-cap").setLabel("評価印上限").setEmoji("🪬").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:ranksync").setLabel("階級の再同期").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row, row2, backButton()] };
}

function evalMarkCapsByRole(services: Services): Record<string, number> {
  const raw = services.settings.getJson<Record<string, unknown>>("eval_mark_caps_by_role", {});
  return Object.fromEntries(
    Object.entries(raw)
      .map(([roleId, value]) => [roleId, Math.trunc(Number(value))] as const)
      .filter(([, value]) => Number.isInteger(value) && value > 0),
  );
}

function evaluationCapHome(services: Services) {
  const caps = evalMarkCapsByRole(services);
  const lines = Object.entries(caps)
    .sort((a, b) => b[1] - a[1])
    .map(([roleId, cap]) => `・<@&${roleId}>: 最大 **${cap}印**`);
  const embed = new EmbedBuilder()
    .setTitle("🪬 評価印上限")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "魔剣士の階級ロールごとに、1回の評価で付けられる最大印数を設定します。",
        "複数ロールを持つ評価員は、設定された上限のうち最大値を使用します。",
        "未設定ロールは従来通り最大1印です。",
        "",
        lines.length > 0 ? lines.join("\n") : "現在の個別設定はありません（全員 最大1印）。",
      ].join("\n"),
    );
  const picker = new RoleSelectMenuBuilder()
    .setCustomId("mgmt:setting:eval-cap-pick")
    .setPlaceholder("上限を設定・変更するロールを選ぶ");
  return { embeds: [embed], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker), backButton()], allowedMentions: { parse: [] } };
}

function evaluationCapModal(services: Services, roleId: string) {
  const current = evalMarkCapsByRole(services)[roleId] ?? 1;
  return new ModalBuilder()
    .setCustomId(`mgmt:setting:eval-cap-save:${roleId}`)
    .setTitle("評価印上限")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel("最大印数（0で設定削除）")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(current))
          .setMaxLength(2),
      ),
    );
}

const CHANNEL_KEYS: Array<[string, string]> = [
  ["public_log", "公開取引ログ"],
  ["kessai", "#決裁"],
  ["keikiban", "#城の計器盤"],
  ["audit_log", "監査ログ"],
  ["entry_guide", "入城案内"],
  ["waiters_board", "門番用の待ち人ボード"],
  ["session_vc", "説明会場VC"],
  ["session_vc2", "説明会場VC（2つ目）"],
  ["shokan", "冥界商館（ショップ配送通知）"],
  ["promotion_call", "昇格面談呼び出し"],
  ["rank_notify", "称号レベルアップ通知"],
  ["eval_forum", "評価フォーラム"],
  ["shurei", "集令"],
  ["announce", "昇格のお知らせ"],
  ["recruit", "蜜月の募集掲示"],
  ["charon_notify", "カロン通知"],
  ["bigwin", "大勝ち速報"],
  ["member_log", "入退室ログ"],
  ["confession", "トートの耳（匿名タレコミ）"],
  ["court_forum", "冥府裁判所フォーラム（送致先）"],
  ["emergency_reports", "緊急対応の通知先"],
  ["handoff_notify", "対応先変更・大司教呼出の通知先（省略時はトートの耳）"],
];

/**
 * カテゴリ設定。**チャンネルとは別扱いにする**。
 *
 * ここへ入れた値は「その機能が作るVCの置き場所」を決める。
 * パネルの位置など、そのときのDiscordの状態に依存させないための設定なので、
 * 選ばせる対象もカテゴリだけに絞る。
 *
 * `category:eval_den` は以前から読まれていたのに設定する導線が無く、
 * 実質いつも未設定だった。同じ仕組みなのでここへまとめる。
 */
const CATEGORY_KEYS: Array<[string, string]> = [
  ["rooms", "宿ぜんぶの既定カテゴリ（種別ごとの指定が無いとき）"],
  ["room_normal", "通常宿の生成先"],
  ["room_mitsugetsu", "蜜月の生成先"],
  ["room_oborozuki", "朧月（秘密の宿）の生成先"],
  ["room_game", "ゲーム部屋の生成先"],
  ["eval_den", "巣穴（評価VC）の生成先"],
];

/**
 * 階級の再同期。
 *
 * Discord の階級ロールを正として `souls.status` を合わせ直す回収手段。
 * 自動同期(debounce)が取りこぼした場合や、一括変更のあとに使う。
 * **強制的に任意の階級を書き込む機能ではない。** 自動同期で曖昧と判断される
 * ケース（階級ロールが無い・入城処理を迂回する遷移）は、ここでも理由を出して何もしない。
 */
function rankSyncHome() {
  const embed = new EmbedBuilder()
    .setTitle("🔄 階級の再同期")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "Discord の階級ロールに合わせて、記録上の階級を確認し直します。",
        "",
        "優先順位: **迷霊**（懲罰）が最優先。通常階級は 魔族 > 眷魔 > 魔人 > 亡霊 の上位を採ります。",
        "",
        "-# 階級ロールが1つも無い場合や、入城処理を飛ばすことになる変更は、理由を出して何もしません。",
        "-# ここでは階級を直接指定できません。ロールを先に正しくしてから実行してください。",
      ].join("\n"),
    );
  const menu = new UserSelectMenuBuilder().setCustomId("mgmt:ranksync:target").setPlaceholder("再同期する対象を選ぶ");
  return { embeds: [embed], components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu), backButton()] };
}

async function openCategorySetup(interaction: ButtonInteraction, _services: Services) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:setting:category-key")
    .setPlaceholder("設定するカテゴリ種別を選ぶ")
    .addOptions(CATEGORY_KEYS.map(([v, name]) => ({ label: name.slice(0, 100), value: v })));
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle("⚙️ カテゴリ設定")
        .setDescription(
          [
            "種別を選んでからカテゴリを指定します。",
            "",
            "宿のVCはここで指定したカテゴリへ作られます。未設定のあいだは、これまでどおり",
            "パネルが置かれているカテゴリへ作られます（朧月はDMから作るためカテゴリ無しになります）。",
            "",
            "-# XP・浮上報酬から外したい宿は、生成先を決めたうえで **XP除外** にそのカテゴリを追加してください。",
          ].join("\n"),
        ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  });
}

async function settingCategoryPicker(key: string) {
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(`mgmt:setting:category-pick:${key}`)
    .setPlaceholder("カテゴリを選ぶ")
    .addChannelTypes(ChannelType.GuildCategory);
  return {
    embeds: [new EmbedBuilder().setTitle(`⚙️ ${key}`).setDescription("このカテゴリの中へVCが作られます。")],
    components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(picker), backButton()],
  };
}

async function openChannelSetup(interaction: ButtonInteraction, _services: Services) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:setting:channel-key")
    .setPlaceholder("設定するチャンネル種別を選ぶ")
    .addOptions(CHANNEL_KEYS.map(([v, name]) => ({ label: name, value: v })));
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("⚙️ チャンネル設定").setDescription("種別を選んでからチャンネルを指定します。")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  });
}

async function settingChannelPicker(key: string) {
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(`mgmt:setting:channel-pick:${key}`)
    .setPlaceholder("チャンネルを選ぶ")
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildCategory);
  return {
    embeds: [new EmbedBuilder().setTitle(`⚙️ ${key} のチャンネル選択`).setColor(0x6b21a8)],
    components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(picker), backButton()],
  };
}

const ROLE_KEYS: Array<[string, string]> = [
  ["admin", "運営（管理ロール）"],
  ["queue_wait", "入城案内待ち"],
  ["ghost", "亡霊"],
  ["meirei", "迷霊"],
  ["majin", "魔人"],
  ["kenma", "眷魔"],
  ["mazoku", "魔族"],
  ["judge", "門番"],
  ["judge_lead", "門番統括"],
  ["judge_extra", "門番（予備）"],
  ["shin", "審"],
  ["mendan", "面談待ち"],
  ["ticket_staff", "チケット対応"],
  ["male", "男性属性"],
  ["female", "女性属性"],
  ["bump_notify", "紹介協力者"],
  ["casino_vip", "賭場VIP"],
  ["emergency_staff", "緊急対応担当"],
];

async function openRoleSetup(interaction: ButtonInteraction, _services: Services) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:setting:role-key")
    .setPlaceholder("設定するロール種別を選ぶ")
    .addOptions(ROLE_KEYS.slice(0, 25).map(([v, name]) => ({ label: name, value: v })));
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("⚙️ ロール設定").setDescription("種別を選んでからロールを指定します。")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  });
}

async function settingRolePicker(key: string) {
  const picker = new RoleSelectMenuBuilder().setCustomId(`mgmt:setting:role-pick:${key}`).setPlaceholder("ロールを選ぶ");
  return {
    embeds: [new EmbedBuilder().setTitle(`⚙️ ${key} のロール選択`).setColor(0x6b21a8)],
    components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker), backButton()],
  };
}

const NUMBER_KEYS: Array<[string, string]> = [
  ["initial_grant", "亡霊化時の初期発行"],
  ["salary_period_days", "給与支給間隔（日）"],
  ["eval_base_period_days", "評価期限（日）"],
  ["invite_extend_days_male", "招待延長：男（日）"],
  ["invite_extend_days_female", "招待延長：女（日）"],
  ["invite_extend_cap_days", "招待延長 上限（日）"],
  ["invite_mark_per_person", "招待→昇格印（人あたり）"],
  ["invite_mark_cap", "招待→昇格印 上限"],
  ["promotion_marks_required", "昇格印 必要数"],
  ["demotion_marks_threshold", "低評価印 閾値"],
  ["approval_threshold", "承認閾値（Land）"],
  ["room_slot_price", "宿の枠+1価格"],
  ["room_mitsugetsu_price", "蜜月価格"],
  ["room_oborozuki_price", "朧月価格"],
  ["room_empty_grace_min", "空室からの削除猶予（分）"],
  ["room_recruit_expire_hours", "蜜月募集の失効（時間）"],
  ["room_recruit_refund", "蜜月失効の返金"],
  ["bump_reward", "bump報酬（Land）"],
  ["ether_rate_base", "旧制度の固定比率（互換設定）"],
  ["ether_fuku_scale", "福の重みスケール"],
  ["vip_price", "VIP月会費（Land）"],
  ["vip_days", "VIP日数"],
  ["vip_bet_cap_mult", "VIP賭け上限倍率"],
  ["confession_body_retention_days", "トート本文の保持日数"],
  ["confession_court_retention_days", "トート送致案件の本文保持日数"],
];

const POSITIVE_INTEGER_NUMBER_KEYS = new Set(["promotion_marks_required", "demotion_marks_threshold"]);
const NON_NEGATIVE_NUMBER_KEYS = new Set(["invite_mark_per_person", "invite_mark_cap"]);

async function openNumberSetup(interaction: ButtonInteraction, _services: Services) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:setting:number-key")
    .setPlaceholder("変更する数値項目を選ぶ")
    .addOptions(NUMBER_KEYS.slice(0, 25).map(([v, name]) => ({ label: name, value: v })));
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("⚙️ 数値設定").setDescription("項目を選ぶとモーダルが開きます。")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  });
}

function numberSetModal(key: string) {
  return new ModalBuilder()
    .setCustomId(`mgmt:setting:number:${key}`)
    .setTitle(`${key} の値`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("value").setLabel("数値").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
    );
}

// ---- 機関ロール（冥教会・他機関）サブパネル ----

function orgRoleHome(services: Services) {
  const lines = ROLE_SLOT_ORDER.map((slot) => {
    const ids = getRoleIds(services, slot);
    const val = ids.length > 0 ? ids.map((id) => `<@&${id}>`).join("・") : "（未設定）";
    return `・**${ROLE_SLOT_META[slot].label}**\n　${val}`;
  }).join("\n");
  const embed = new EmbedBuilder()
    .setTitle("⛪ 冥教会・機関ロールの対応付け")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "こちらで作成済みのDiscordロールを、トートの通知先・対応資格・案件管理へ対応付けます。",
        "**Botはロールを作成・削除しません。** 既存ロールを選ぶだけです。",
        "新着通知・対応先変更の通知は、ここで設定したロールへ振り分けられます。",
        "",
        lines,
      ].join("\n"),
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:orgrole:key")
    .setPlaceholder("設定する区分を選ぶ")
    .addOptions(
      ROLE_SLOT_ORDER.map((slot) => ({
        label: ROLE_SLOT_META[slot].label.slice(0, 100),
        description: ROLE_SLOT_META[slot].hint.slice(0, 100),
        value: slot,
      })),
    );
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()] };
}

function orgRolePicker(services: Services, slot: RoleSlot) {
  const meta = ROLE_SLOT_META[slot];
  const current = getRoleIds(services, slot);
  const picker = new RoleSelectMenuBuilder()
    .setCustomId(`mgmt:orgrole:set:${slot}`)
    .setPlaceholder(meta.multi ? "ロールを選ぶ（複数可・選び直しで上書き）" : "ロールを選ぶ（選び直しで上書き）")
    .setMinValues(0)
    .setMaxValues(meta.multi ? 10 : 1);
  const embed = new EmbedBuilder()
    .setTitle(`⛪ ${meta.label}`)
    .setColor(0x6b21a8)
    .setDescription(
      [
        meta.hint,
        "",
        `現在: ${current.length > 0 ? current.map((id) => `<@&${id}>`).join("・") : "（未設定）"}`,
        "",
        "選び直すと **上書き** されます（何も選ばず確定すると解除）。",
      ].join("\n"),
    );
  return { embeds: [embed], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker), backButton()] };
}

// ---- 特別プロフィール（魔王など）サブパネル ----

function specialProfileHome(services: Services) {
  const entries = getSpecialProfiles(services).slice().sort((a, b) => b.priority - a.priority);
  const lines =
    entries.length > 0
      ? entries.map((e) => `・${e.enabled ? "🟢" : "⚪"} **${e.name}** ｜ 優先度 ${e.priority} ｜ 装飾 \`${e.style}\` ｜ <@&${e.roleId}>`).join("\n")
      : "（特別プロフィールは未設定）";
  const embed = new EmbedBuilder()
    .setTitle("👑 特別プロフィール役職")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "既存のDiscordロールを、プロフィール上の特別役職へ対応付けます（表示名・優先度・説明・装飾・有効/無効）。",
        "対象ロールを選ぶと、追加または編集のモーダルが開きます。優先度が大きいほど上位に表示されます。",
        "",
        lines,
      ].join("\n"),
    );
  const pick = new RoleSelectMenuBuilder().setCustomId("mgmt:sprof:pick").setPlaceholder("追加・編集する対象ロールを選ぶ");
  const components: ActionRowBuilder<RoleSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<RoleSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder>().addComponents(pick),
  ];
  if (entries.length > 0) {
    const toggle = new StringSelectMenuBuilder()
      .setCustomId("mgmt:sprof:toggle")
      .setPlaceholder("有効／無効を切り替える")
      .addOptions(entries.slice(0, 25).map((e) => ({ label: `${e.name}（${e.enabled ? "有効→無効" : "無効→有効"}）`.slice(0, 100), value: e.roleId })));
    const del = new StringSelectMenuBuilder()
      .setCustomId("mgmt:sprof:delete")
      .setPlaceholder("対応付けを削除する")
      .addOptions(entries.slice(0, 25).map((e) => ({ label: `${e.name} を削除`.slice(0, 100), value: e.roleId })));
    components.push(new ActionRowBuilder<RoleSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder>().addComponents(toggle));
    components.push(new ActionRowBuilder<RoleSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder>().addComponents(del));
  }
  components.push(new ActionRowBuilder<RoleSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:hub").setLabel("← ハブへ").setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components };
}

function sprofModal(services: Services, roleId: string) {
  const existing = getSpecialProfiles(services).find((e) => e.roleId === roleId);
  const nameInput = new TextInputBuilder().setCustomId("name").setLabel("表示名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40);
  if (existing) nameInput.setValue(existing.name);
  const priInput = new TextInputBuilder()
    .setCustomId("priority")
    .setLabel("表示優先度（数値・大きいほど上位）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(6)
    .setValue(String(existing?.priority ?? 100));
  const descInput = new TextInputBuilder().setCustomId("desc").setLabel("説明文").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);
  if (existing?.desc) descInput.setValue(existing.desc);
  const styleInput = new TextInputBuilder()
    .setCustomId("style")
    .setLabel("装飾スタイル: maou / gold / crimson / plain")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(12)
    .setValue(existing?.style ?? "maou");
  const enabledInput = new TextInputBuilder()
    .setCustomId("enabled")
    .setLabel("有効？（はい / いいえ）")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(6)
    .setValue(existing ? (existing.enabled ? "はい" : "いいえ") : "はい");
  return new ModalBuilder()
    .setCustomId(`mgmt:sprof:save:${roleId}`)
    .setTitle("特別プロフィール設定")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(priInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(styleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(enabledInput),
    );
}

// ---- パネルサブパネル ----

const PANEL_KIND_CHOICES: Array<[string, string]> = [
  ["bank", "冥獄銀行"],
  ["entry", "入城申請"],
  ["rank", "ランク確認"],
  ["shop", "公式ショップ"],
  ["takutate", "卓建て"],
  ["ticket_return", "出戻り申請"],
  ["ticket_consult", "個別相談"],
  ["confession", "トートの耳（匿名タレコミ）"],
  ["room_normal", "宿"],
  ["room_mitsugetsu", "蜜月"],
  ["room_oborozuki", "朧月"],
  ["room_game", "ゲーム部屋"],
  ["dept", "部署運用"],
];

// 廃止済みで新規設置はできないが、既に設置してあるものを撤去する必要がある種別
const RETIRED_PANEL_KIND_CHOICES: Array<[string, string]> = [["entry_flex", "時間外希望受付（廃止・撤去用）"]];

function panelHome(services: Services) {
  const ticketPanels = services.tickets.listPanels().length;
  const embed = new EmbedBuilder()
    .setTitle("🪧 パネル")
    .setColor(0x6b21a8)
    .setDescription([
      "常設パネルを **今いるチャンネルに** 設置・撤去します。",
      "",
      `チケット受付は設定データとして管理します（登録 ${ticketPanels}件）。`,
    ].join("\n"));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:panel:install").setLabel("設置").setEmoji("📌").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mgmt:panel:remove").setLabel("撤去").setEmoji("🗑").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mgmt:tpanel").setLabel("チケット受付").setEmoji("🎫").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row, backButton()] };
}

function panelInstallPicker() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:panel:install-pick")
    .setPlaceholder("設置するパネルを選ぶ")
    .addOptions(PANEL_KIND_CHOICES.map(([v, name]) => ({ label: name, value: v })));
  return {
    embeds: [new EmbedBuilder().setTitle("🪧 パネル設置").setDescription("今いるチャンネルに設置します。")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  };
}

function panelRemovePicker() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:panel:remove-pick")
    .setPlaceholder("撤去するパネルを選ぶ")
    .addOptions(
      [...PANEL_KIND_CHOICES, ...RETIRED_PANEL_KIND_CHOICES].map(([v, name]) => ({ label: name, value: v })),
    );
  return {
    embeds: [new EmbedBuilder().setTitle("🪧 パネル撤去").setDescription("今いるチャンネルから撤去します。")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  };
}

async function installPanel(
  interaction: StringSelectMenuInteraction,
  services: Services,
  kind: string,
): Promise<void> {
  // 既存の bank-panel の panelMessageFor / handlePanelCommand ロジックを内包
  const { panelMessageForKind, savePanelSetting } = await import("./bank-panel.js").then((m) => ({
    panelMessageForKind: m.panelMessageForExternal,
    savePanelSetting: m.savePanelSettingExternal,
  }));
  if (kind === "dept") {
    const list = services.departments.listWithBalance();
    if (list.length === 0) {
      await interaction.update({
        content: "❌ 部署がまだありません。先に `/管理 → 部署 → 作成` で部署を作ってください。",
        embeds: [],
        components: [backButton()],
      });
      return;
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId("mgmt:panel:dept-pick")
      .setPlaceholder("パネルにする部署を選ぶ")
      .addOptions(list.slice(0, 25).map((d) => ({ label: d.name, value: d.key })));
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("🪧 部署運用パネル設置")
          .setDescription("このチャンネルに設置する部署を選んでください。"),
      ],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
    });
    return;
  }
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await interaction.update({ content: "テキストチャンネルで実行してください。", embeds: [], components: [backButton()] });
    return;
  }
  const msg = panelMessageForKind(kind, services, channel.id);
  const sent = await channel.send(msg);
  await sent.pin().catch(() => undefined);
  savePanelSetting(services, kind, channel.id, sent.id, interaction.user.id);
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("✅ 設置しました").setDescription(`種別: **${kind}** をこのチャンネルに設置`)],
    components: [backButton()],
  });
}

async function installDeptPanel(
  interaction: StringSelectMenuInteraction,
  services: Services,
  deptKey: string,
): Promise<void> {
  const dept = services.departments.get(deptKey);
  if (!dept) {
    await interaction.update({ content: "❌ 部署が見つかりません。", embeds: [], components: [backButton()] });
    return;
  }
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await interaction.update({ content: "テキストチャンネルで実行してください。", embeds: [], components: [backButton()] });
    return;
  }
  const { panelMessageForKind, savePanelSetting } = await import("./bank-panel.js").then((m) => ({
    panelMessageForKind: m.panelMessageForExternal,
    savePanelSetting: m.savePanelSettingExternal,
  }));
  const actor = `user:${interaction.user.id}`;
  services.settings.set(`dept_panel_channel:${channel.id}`, deptKey, actor);
  const msg = panelMessageForKind("dept", services, channel.id);
  const sent = await channel.send(msg);
  await sent.pin().catch(() => undefined);
  savePanelSetting(services, "dept", channel.id, sent.id, interaction.user.id);
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("✅ 設置しました").setDescription(`「${dept.name}」の運用パネルをこのチャンネルに設置しました。`)],
    components: [backButton()],
  });
}

async function removePanel(
  interaction: StringSelectMenuInteraction,
  services: Services,
  kind: string,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !("id" in channel)) return;
  const key = `panel:${kind}:${channel.id}`;
  const msgId = services.settings.getString(key);
  if (!msgId) {
    await interaction.update({ content: `${kind} パネルはこのチャンネルに設置されていません。`, embeds: [], components: [backButton()] });
    return;
  }
  if (channel.isTextBased() && "messages" in channel) {
    const m = await channel.messages.fetch(msgId).catch(() => null);
    await m?.delete().catch(() => undefined);
  }
  services.settings.delete(key, `user:${interaction.user.id}`);
  if (kind === "dept") services.settings.delete(`dept_panel_channel:${channel.id}`, `user:${interaction.user.id}`);
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("🗑 撤去しました").setDescription(`種別: **${kind}**`)],
    components: [backButton()],
  });
}

function ticketPanelSummary(panel: TicketPanel): string {
  const placement = panel.channelId && panel.messageId ? `<#${panel.channelId}>` : "未設置";
  const state = panel.archivedAt ? "📦 アーカイブ済み" : panel.enabled ? panel.channelId && panel.messageId ? "🟢 有効・設置済み" : "🟡 有効・未設置" : panel.channelId && panel.messageId ? "⚫ 無効・設置済み" : "⚪ 無効・未設置";
  return [`・${state} **${panel.name}** (\`${panel.id}\`)`, `設置: ${placement}`, `通知 ${panel.notifyRoleIds.length}件 / 対応 ${panel.staffRoleIds.length}件`].join(" / ");
}

function ticketPanelHome(services: Services) {
  const panels = services.tickets.listPanels(true, true);
  const list = panels.length > 0 ? panels.slice(0, 12).map(ticketPanelSummary).join("\n") : "（受付なし）";
  const embed = new EmbedBuilder().setTitle("🎫 チケット受付パネル").setColor(0x0ea5e9).setDescription([
    "受付ごとに表示文・設置先・通知ロール・対応ロールを持たせます。",
    "無効化は受付停止、撤去はDiscordメッセージだけを削除、削除/アーカイブは登録自体の終了です。",
    "対応ロールは「対応する」「クローズ」の権限判定にも使います。",
    "通知ロールは新着時にメンションされ、プライベートスレッドへ追加されます。対応・クローズ操作はできませんが、本文は閲覧できます。",
    "", list, "", "履歴のない独自受付だけ完全削除し、利用履歴または旧来互換がある受付はアーカイブします。",
  ].join("\n"));
  const primary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:tpanel:create").setLabel("新規作成").setEmoji("➕").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:edit").setLabel("内容編集").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:notify").setLabel("通知ロール").setEmoji("📣").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:staff").setLabel("対応ロール").setEmoji("🛡").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:install").setLabel("設置/再設置").setEmoji("📌").setStyle(ButtonStyle.Success),
  );
  const lifecycle = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:tpanel:remove").setLabel("設置パネル撤去").setEmoji("🧹").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:disable").setLabel("無効化").setEmoji("🛑").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mgmt:tpanel:enable").setLabel("再有効化").setEmoji("▶️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mgmt:tpanel:delete").setLabel("削除/アーカイブ").setEmoji("🗑").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [primary, lifecycle, backButton()] };
}

type TicketPanelPickerFilter = "all" | "enabled" | "disabled" | "installed";

function ticketPanelPicker(services: Services, customId: string, placeholder: string, filter: TicketPanelPickerFilter = "all") {
  let panels = services.tickets.listPanels();
  if (filter === "enabled") panels = panels.filter((panel) => panel.enabled);
  if (filter === "disabled") panels = panels.filter((panel) => !panel.enabled);
  if (filter === "installed") panels = panels.filter((panel) => panel.channelId && panel.messageId);
  if (panels.length === 0) return { content: `対象となる受付がありません。${placeholder}`, embeds: [], components: [backButton()] };
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(panels.slice(0, 25).map((p) => ({ label: `${p.enabled ? "🟢" : "⚫"} ${p.name}`.slice(0, 100), description: `ID: ${p.id}${p.channelId ? ` / #${p.channelId.slice(-6)}` : " / 未設置"}`.slice(0, 100), value: p.id })));
  return { embeds: [new EmbedBuilder().setTitle("🎫 チケット受付を選択").setDescription(placeholder)], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()] };
}

export function ticketPanelRolePicker(services: Services, panelId: string, type: "notify" | "staff") {
  const panel = services.tickets.getPanel(panelId);
  const label = type === "notify" ? "通知ロール" : "対応ロール";
  if (!panel || panel.archivedAt) return { content: "❌ 受付が見つからないか、アーカイブ済みです。", embeds: [], components: [backButton()] };
  const picker = new RoleSelectMenuBuilder().setCustomId(`mgmt:tpanel:${type}-roles:${panel.id}`).setPlaceholder(`${panel.name} の${label}を選ぶ（複数可 / 空でフォールバック）`).setMinValues(0).setMaxValues(10);
  return { embeds: [new EmbedBuilder().setTitle(`🎭 ${label}設定`).setDescription([`対象: **${panel.name}** (\`${panel.id}\`)`, "", type === "notify" ? "新着時にメンションされ、プライベートスレッドへ追加されるロールです。対応・クローズ操作はできませんが、本文は閲覧できます。空にすると対応ロールへフォールバックします。" : "「対応する」「クローズ」を許可し、プライベートスレッドへ招待するロールです。空にすると旧 ticket_staff へフォールバックします。"].join("\n"))], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker), backButton()] };
}

function ticketPanelCreateModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:tpanel:create")
    .setTitle("チケット受付を作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("id").setLabel("受付ID（英数字/_/-）").setPlaceholder("ex: return_request").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(49)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("管理用名称").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("title").setLabel("表示タイトル").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("description").setLabel("説明文").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("button_label").setLabel("ボタン名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
    );
}

function ticketPanelEditModal(panel: TicketPanel) {
  return new ModalBuilder()
    .setCustomId(`mgmt:tpanel:edit:${panel.id}`)
    .setTitle("チケット受付を編集")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("管理用名称").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(panel.name)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("title").setLabel("表示タイトル").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setValue(panel.title)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("description").setLabel("説明文").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000).setValue(panel.description)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("button_label").setLabel("ボタン名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(panel.buttonLabel)),
    );
}

export function isUnknownMessageError(error: unknown): boolean {
  const maybe = error as { code?: unknown; status?: unknown; rawError?: { code?: unknown } };
  return maybe.code === 10008 || maybe.rawError?.code === 10008 || maybe.status === 404;
}

type FetchPanelMessageResult =
  | { ok: true; message: Message | null }
  | { ok: false; error: unknown };

async function fetchPanelMessage(
  channel: { messages: { fetch: (messageId: string) => Promise<Message> } },
  messageId: string,
): Promise<FetchPanelMessageResult> {
  try {
    return { ok: true, message: await channel.messages.fetch(messageId) };
  } catch (e) {
    if (isUnknownMessageError(e)) return { ok: true, message: null };
    return { ok: false, error: e };
  }
}

export async function installTicketPanel(
  interaction: StringSelectMenuInteraction,
  services: Services,
  panelId: string,
): Promise<void> {
  const panel = services.tickets.getPanel(panelId);
  if (!panel) {
    await interaction.update({ content: "❌ 受付が見つかりません。", embeds: [], components: [backButton()] });
    return;
  }
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await interaction.update({ content: "テキストチャンネルで実行してください。", embeds: [], components: [backButton()] });
    return;
  }

  const msg = ticketPanelMessageForPanel(panel);
  const oldPlacement = panel.channelId && panel.messageId ? { channelId: panel.channelId, messageId: panel.messageId } : null;
  const samePlacement = oldPlacement?.channelId === channel.id;
  let sent: Message;
  let editedExisting = false;

  if (samePlacement && oldPlacement.messageId && "messages" in channel) {
    const fetched = await fetchPanelMessage(channel, oldPlacement.messageId);
    if (!fetched.ok) {
      console.warn("[ticket-panel] 既存パネル取得に失敗したため再設置を中止します", {
        panelId: panel.id,
        channelId: channel.id,
        messageId: oldPlacement.messageId,
        error: fetched.error,
      });
      await interaction.update({
        content: "⚠️ 既存パネルの取得に失敗したため、重複防止のため再設置を中止しました。時間を置いて再試行してください。",
        embeds: [],
        components: [backButton()],
      });
      return;
    }
    if (fetched.message) {
      sent = await fetched.message.edit({ embeds: msg.embeds, components: msg.components });
      editedExisting = true;
    } else {
      sent = await channel.send(msg);
    }
  } else {
    try {
      sent = await channel.send(msg);
    } catch (e) {
      console.warn("[ticket-panel] 新規パネル送信に失敗しました。旧パネルは残します", {
        panelId: panel.id,
        channelId: channel.id,
        oldPlacement,
        error: e,
      });
      await interaction.update({
        content: "❌ 新しいパネルの送信に失敗しました。既存パネルは削除していません。",
        embeds: [],
        components: [backButton()],
      });
      return;
    }
  }

  await sent.pin().catch(() => undefined);
  try {
    const saved = services.tickets.setPanelMessage(panel.id, channel.id, sent.id, `user:${interaction.user.id}`);
    if (!saved) throw new Error("ticket panel placement was not saved");
  } catch (e) {
    if (!editedExisting) {
      await sent.delete().catch((deleteError) =>
        console.error("[ticket-panel] DB保存失敗後の新規パネル削除にも失敗しました", {
          panelId: panel.id,
          channelId: channel.id,
          messageId: sent.id,
          error: deleteError,
        }),
      );
    }
    console.error("[ticket-panel] パネル設置情報のDB保存に失敗しました", {
      panelId: panel.id,
      channelId: channel.id,
      messageId: sent.id,
      editedExisting,
      error: e,
    });
    await interaction.update({
      content: editedExisting
        ? "❌ 既存パネルの表示更新後、設置情報の保存に失敗しました。DBは更新されていません。"
        : "❌ パネル送信後に設置情報の保存に失敗したため、新しいメッセージを削除しました。既存パネルは残しています。",
      embeds: [],
      components: [backButton()],
    });
    return;
  }

  let warning = "";
  let staleOldPanelPossible = false;
  if (oldPlacement && oldPlacement.channelId !== channel.id) {
    let oldChannelFetchFailed = false;
    const oldChannel = await interaction.client.channels.fetch(oldPlacement.channelId).catch((e) => {
      oldChannelFetchFailed = true;
      console.warn("[ticket-panel] 移設後の旧チャンネル取得に失敗しました", { panelId: panel.id, oldPlacement, error: e });
      return null;
    });
    if (oldChannelFetchFailed) {
      staleOldPanelPossible = true;
      warning = "旧パネルのチャンネル取得に失敗し、旧パネルが残っている可能性があります。手動確認が必要です。";
    } else if (oldChannel?.isTextBased() && "messages" in oldChannel) {
      const old = await fetchPanelMessage(oldChannel, oldPlacement.messageId);
      if (old.ok) {
        if (old.message) {
          const disabledOld = ticketPanelMessageForPanel({ ...panel, enabled: false });
          let oldDisabled = false;
          try {
            await old.message.edit({ embeds: disabledOld.embeds, components: disabledOld.components });
            oldDisabled = true;
          } catch (e) {
            console.warn("[ticket-panel] 移設後の旧パネル無効化に失敗しました", { panelId: panel.id, oldPlacement, error: e });
          }
          await old.message.delete().catch((e) => {
            warning = oldDisabled
              ? "旧パネルの削除に失敗しましたが、受付ボタンは無効化しました。手動削除してください。"
              : "旧パネルの無効化と削除に失敗しました。";
            if (!oldDisabled) staleOldPanelPossible = true;
            console.warn("[ticket-panel] 移設後の旧パネル削除に失敗しました", { panelId: panel.id, oldPlacement, oldDisabled, error: e });
          });
        }
      } else {
        staleOldPanelPossible = true;
        warning = "旧パネルの取得に失敗し、旧パネルが残っている可能性があります。";
        console.warn("[ticket-panel] 移設後の旧パネル取得に失敗しました", { panelId: panel.id, oldPlacement, error: old.error });
      }
    } else {
      warning = oldChannel
        ? "旧パネルのチャンネルがテキストチャンネルではありません。手動確認してください。"
        : "旧パネルのチャンネルが見つかりませんでした。";
      console.warn("[ticket-panel] 移設後の旧パネルチャンネルを処理できません", { panelId: panel.id, oldPlacement });
    }
  }

  if (staleOldPanelPossible) {
    try {
      const disabled = services.tickets.setPanelEnabled(panel.id, false, `user:${interaction.user.id}`);
      if (!disabled) throw new Error("ticket panel could not be disabled after stale placement risk");
      const disabledNew = ticketPanelMessageForPanel(disabled);
      await sent.edit({ embeds: disabledNew.embeds, components: disabledNew.components }).catch((e) =>
        console.warn("[ticket-panel] 安全停止後の新パネル表示更新に失敗しました", { panelId: panel.id, error: e }),
      );
      warning = `${warning} 安全のため受付登録を無効化しました。旧パネルを確認後、再有効化してください。`.trim();
    } catch (e) {
      console.error("[ticket-panel] 旧パネル残存リスク検出後の自動無効化に失敗しました", { panelId: panel.id, error: e });
      warning = `${warning} 受付登録の自動無効化にも失敗しました。直ちに手動で無効化してください。`.trim();
    }
  }

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ 設置しました")
        .setDescription(`「${panel.name}」をこのチャンネルに${editedExisting ? "再描画" : "設置"}しました。${warning ? `\n⚠️ ${warning}` : ""}`),
    ],
    components: [backButton()],
  });
}

type TicketPanelConfirmAction = "disable" | "enable" | "remove" | "delete";

function ticketPanelConfirm(services: Services, panelId: string, action: TicketPanelConfirmAction) {
  const panel = services.tickets.getPanel(panelId);
  if (!panel || panel.archivedAt) return { content: "❌ 対象の受付が見つからないか、既にアーカイブ済みです。", embeds: [], components: [backButton()] };
  const counts = services.tickets.panelTicketCounts(panel.id);
  const copy = {
    disable: { title: "🛑 受付を無効化しますか？", description: "登録と設置メッセージを残したまま、新規受付を停止します。後から再有効化できます。", label: "無効化する" },
    enable: { title: "▶️ 受付を再有効化しますか？", description: "設置済みメッセージが存在する場合は、受付ボタンも再び有効にします。", label: "再有効化する" },
    remove: { title: "🧹 設置パネルを撤去しますか？", description: "Discord上の受付メッセージと設置情報だけを削除します。登録内容は残り、後から再設置できます。", label: "撤去する" },
    delete: { title: "🗑 受付登録を終了しますか？", description: counts.total === 0 && !["return", "consult"].includes(panel.id) ? "利用履歴がないため登録を完全削除します。" : `利用履歴または旧来互換があるためアーカイブします（全${counts.total}件 / 未完了${counts.active}件）。既存チケットは変更しません。`, label: counts.total === 0 && !["return", "consult"].includes(panel.id) ? "完全削除する" : "アーカイブする" },
  }[action];
  const confirm = new ButtonBuilder().setCustomId(`mgmt:tpanel:${action}-confirm:${panel.id}`).setLabel(copy.label).setStyle(action === "enable" ? ButtonStyle.Success : ButtonStyle.Danger);
  const cancel = new ButtonBuilder().setCustomId("mgmt:tpanel").setLabel("キャンセル").setStyle(ButtonStyle.Secondary);
  return { embeds: [new EmbedBuilder().setTitle(copy.title).setDescription([`対象: **${panel.name}** (\`${panel.id}\`)`, "", copy.description].join("\n"))], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)] };
}

export async function setTicketPanelEnabled(interaction: ButtonInteraction, services: Services, panelId: string, enabled: boolean): Promise<void> {
  const before = services.tickets.getPanel(panelId);
  if (!before || before.archivedAt) { await interaction.update({ content: "❌ 受付が見つからないか、アーカイブ済みです。", embeds: [], components: [backButton()] }); return; }
  const actor = `user:${interaction.user.id}`;
  let warning = "";
  if (before.channelId && before.messageId) {
    let channelFetchFailed = false;
    const channel = await interaction.client.channels.fetch(before.channelId).catch((error) => { channelFetchFailed = true; console.warn("[ticket-panel] 状態変更前のチャンネル取得に失敗しました", { panelId, enabled, error }); return null; });
    if (channelFetchFailed) { await interaction.update({ content: "⚠️ 設置チャンネルの取得に失敗したため、状態変更を中止しました。時間を置いて再試行してください。", embeds: [], components: [backButton()] }); return; }
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      services.tickets.clearPanelMessage(panelId, actor, "state change found missing channel");
      warning = "設置チャンネルが見つからなかったため、未設置状態へ戻しました。";
    } else {
      const fetched = await fetchPanelMessage(channel, before.messageId);
      if (!fetched.ok) { await interaction.update({ content: "⚠️ 設置済みメッセージの取得に失敗したため、状態変更を中止しました。時間を置いて再試行してください。", embeds: [], components: [backButton()] }); return; }
      if (!fetched.message) {
        services.tickets.clearPanelMessage(panelId, actor, "state change found missing message");
        warning = "設置済みメッセージが見つからなかったため、未設置状態へ戻しました。";
      } else {
        const preview: TicketPanel = { ...before, enabled };
        const previewMessage = ticketPanelMessageForPanel(preview);
        try { await fetched.message.edit({ embeds: previewMessage.embeds, components: previewMessage.components }); }
        catch (error) { console.warn("[ticket-panel] 状態変更前のメッセージ更新に失敗しました", { panelId, enabled, error }); await interaction.update({ content: "❌ 設置済みメッセージを更新できなかったため、DB上の状態は変更していません。", embeds: [], components: [backButton()] }); return; }
        try {
          const changed = services.tickets.setPanelEnabled(panelId, enabled, actor);
          if (!changed) throw new Error("panel state update returned no row");
        } catch (error) {
          const rollback = ticketPanelMessageForPanel(before);
          await fetched.message.edit({ embeds: rollback.embeds, components: rollback.components }).catch((rollbackError) => console.error("[ticket-panel] 状態変更DB失敗後の表示ロールバックにも失敗しました", { panelId, enabled, error: rollbackError }));
          console.error("[ticket-panel] 状態変更のDB保存に失敗しました", { panelId, enabled, error });
          await interaction.update({ content: "❌ 状態変更の保存に失敗しました。可能な範囲で表示を元に戻しました。", embeds: [], components: [backButton()] });
          return;
        }
        await interaction.update({ content: `${enabled ? "▶️" : "🛑"} 「${before.name}」を${enabled ? "再有効化" : "無効化"}しました。既存チケットは変更していません。`, embeds: [], components: [backButton()] });
        return;
      }
    }
  }
  const panel = services.tickets.setPanelEnabled(panelId, enabled, actor);
  await interaction.update({ content: panel ? `${enabled ? "▶️" : "🛑"} 「${panel.name}」を${enabled ? "再有効化" : "無効化"}しました。現在は未設置です。${warning ? `\n⚠️ ${warning}` : ""}` : "❌ 状態変更に失敗しました。", embeds: [], components: [backButton()] });
}

export async function disableTicketPanel(
  interaction: StringSelectMenuInteraction,
  services: Services,
  panelId: string,
): Promise<void> {
  const panel = services.tickets.disablePanel(panelId, `user:${interaction.user.id}`);
  if (!panel) {
    await interaction.update({ content: "❌ 受付が見つかりません。", embeds: [], components: [backButton()] });
    return;
  }
  let warning = "";
  if (panel.channelId && panel.messageId) {
    const channel = await interaction.client.channels.fetch(panel.channelId).catch(() => null);
    if (channel?.isTextBased() && "messages" in channel) {
      const fetched = await fetchPanelMessage(channel, panel.messageId);
      if (fetched.ok && fetched.message) {
        const rendered = ticketPanelMessageForPanel(panel);
        await fetched.message.edit({ embeds: rendered.embeds, components: rendered.components }).catch(() => {
          warning = "設置済みパネルの無効表示への更新に失敗しました。";
        });
      } else if (fetched.ok) warning = "設置済みパネルのメッセージが見つかりませんでした。";
      else warning = "設置済みパネルの取得に失敗しました。";
    } else warning = "設置済みパネルのチャンネルが見つかりません。";
  }
  await interaction.update({ content: `🛑 「${panel.name}」を無効化しました。既存チケットは残ります。${warning ? `
⚠️ ${warning}` : ""}`, embeds: [], components: [backButton()] });
}

async function detachTicketPanelMessage(interaction: ButtonInteraction, services: Services, panel: TicketPanel, actor: string): Promise<{ warning: string; forcedDisabled: boolean }> {
  if (!panel.channelId || !panel.messageId) { services.tickets.clearPanelMessage(panel.id, actor, "already uninstalled"); return { warning: "既に未設置でした。", forcedDisabled: false }; }
  let channelFetchFailed = false;
  const channel = await interaction.client.channels.fetch(panel.channelId).catch((error) => { channelFetchFailed = true; console.warn("[ticket-panel] 撤去時のチャンネル取得に失敗しました", { panelId: panel.id, error }); return null; });
  if (channelFetchFailed) { services.tickets.clearPanelMessage(panel.id, actor, "channel fetch failed during uninstall", true); return { warning: "設置チャンネルを取得できず旧メッセージが残る可能性があるため、登録を安全のため無効化しました。手動確認後に再有効化してください。", forcedDisabled: true }; }
  if (!channel || !channel.isTextBased() || !("messages" in channel)) { services.tickets.clearPanelMessage(panel.id, actor, "channel missing during uninstall"); return { warning: "設置チャンネルが存在しなかったため、古い設置情報だけ解除しました。", forcedDisabled: false }; }
  const fetched = await fetchPanelMessage(channel, panel.messageId);
  if (!fetched.ok) { services.tickets.clearPanelMessage(panel.id, actor, "message fetch failed during uninstall", true); return { warning: "設置メッセージを取得できず残存の可能性があるため、登録を安全のため無効化しました。手動確認後に再有効化してください。", forcedDisabled: true }; }
  if (!fetched.message) { services.tickets.clearPanelMessage(panel.id, actor, "message missing during uninstall"); return { warning: "設置メッセージは既に削除されていたため、古い設置情報だけ解除しました。", forcedDisabled: false }; }
  const disabledMessage = ticketPanelMessageForPanel({ ...panel, enabled: false });
  await fetched.message.edit({ embeds: disabledMessage.embeds, components: disabledMessage.components }).catch((error) => console.warn("[ticket-panel] 撤去前のボタン無効化に失敗しました", { panelId: panel.id, error }));
  try { await fetched.message.delete(); services.tickets.clearPanelMessage(panel.id, actor, "manual uninstall"); return { warning: "", forcedDisabled: false }; }
  catch (error) { console.warn("[ticket-panel] 設置メッセージ削除に失敗しました", { panelId: panel.id, error }); services.tickets.clearPanelMessage(panel.id, actor, "message delete failed during uninstall", true); return { warning: "メッセージ削除に失敗したため設置情報を解除し、残ったボタンから受付できないよう登録を無効化しました。手動削除してください。", forcedDisabled: true }; }
}

export async function uninstallTicketPanel(interaction: ButtonInteraction, services: Services, panelId: string): Promise<void> {
  const panel = services.tickets.getPanel(panelId);
  if (!panel || panel.archivedAt) { await interaction.update({ content: "❌ 受付が見つからないか、アーカイブ済みです。", embeds: [], components: [backButton()] }); return; }
  const result = await detachTicketPanelMessage(interaction, services, panel, `user:${interaction.user.id}`);
  await interaction.update({ content: `🧹 「${panel.name}」の設置パネルを撤去しました。受付登録と既存チケットは残っています。${result.warning ? `\n⚠️ ${result.warning}` : ""}`, embeds: [], components: [backButton()] });
}

export async function removeTicketPanelRegistration(interaction: ButtonInteraction, services: Services, panelId: string): Promise<void> {
  const panel = services.tickets.getPanel(panelId);
  if (!panel || panel.archivedAt) { await interaction.update({ content: "❌ 受付が見つからないか、既にアーカイブ済みです。", embeds: [], components: [backButton()] }); return; }
  const detach = await detachTicketPanelMessage(interaction, services, panel, `user:${interaction.user.id}`);
  const result = services.tickets.removePanelRegistration(panelId, `user:${interaction.user.id}`);
  if (!result) { await interaction.update({ content: "❌ 受付登録の削除・アーカイブに失敗しました。", embeds: [], components: [backButton()] }); return; }
  await interaction.update({ content: result.mode === "deleted" ? `🗑 「${panel.name}」の受付登録を完全削除しました。${detach.warning ? `\n⚠️ ${detach.warning}` : ""}` : `📦 「${panel.name}」をアーカイブしました（履歴 ${result.totalTickets}件 / 未完了 ${result.activeTickets}件）。既存チケットは変更していません。${detach.warning ? `\n⚠️ ${detach.warning}` : ""}`, embeds: [], components: [backButton()] });
}

// ---- 給与サブパネル ----

function payrollHome(services: Services) {
  const rows = services.payroll.listSalaries();
  const list =
    rows.length > 0
      ? rows.map((r) => `・<@&${r.role_id}> **${r.label}**: ${fmtLd(r.amount)}`).join("\n")
      : "（給与表は空）";
  const embed = new EmbedBuilder()
    .setTitle("💰 給与")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "**給与表**（ロールごとに月額を設定）",
        list,
        "",
        "月次自動支給は毎月1日に `#決裁` へドラフトが流れます。ここからの「今月手動支給」は draft→approve→execute を一気通貫。",
      ].join("\n"),
    );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:payroll:add-start").setLabel("行追加").setEmoji("➕").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:payroll:pay").setLabel("今月手動支給").setEmoji("💸").setStyle(ButtonStyle.Success),
  );
  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [buttons];
  if (rows.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("mgmt:payroll:remove-pick")
      .setPlaceholder("削除する行を選ぶ")
      .addOptions(rows.slice(0, 25).map((r) => ({ label: `${r.label}: ${r.amount.toLocaleString()}`, value: r.role_id })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  components.push(backButton());
  return { embeds: [embed], components };
}

function payrollAddRolePicker() {
  const menu = new RoleSelectMenuBuilder().setCustomId("mgmt:payroll:add-role").setPlaceholder("給与を付けるロールを選ぶ");
  return {
    embeds: [new EmbedBuilder().setTitle("➕ 給与表 行追加").setColor(0x6b21a8).setDescription("対象ロールを選ぶとラベル・月額のモーダルが開きます。")],
    components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu), backButton()],
  };
}

function payrollAddModal(roleId: string) {
  return new ModalBuilder()
    .setCustomId(`mgmt:payroll:add:${roleId}`)
    .setTitle("給与表 行追加")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("label").setLabel("ラベル（例: 銀行員月給）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("月額（Land）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
    );
}

async function payrollRemove(
  interaction: StringSelectMenuInteraction,
  services: Services,
  roleId: string,
): Promise<void> {
  services.payroll.removeSalary(roleId, `user:${interaction.user.id}`);
  await interaction.update({ content: `🗑 給与表からロール <@&${roleId}> を削除しました。`, embeds: [], components: [backButton()], allowedMentions: { parse: [] } });
}

async function payrollPayNow(interaction: ButtonInteraction, services: Services): Promise<void> {
  await interaction.deferUpdate();
  const period = new Date().toISOString().slice(0, 7);
  try {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: "❌ ギルド情報が取得できません。", embeds: [], components: [backButton()] });
      return;
    }
    const memberCol = await guild.members.fetch();
    const members = memberCol
      .filter((m) => !m.user.bot)
      .map((m) => ({ userId: m.id, roleIds: m.roles.cache.map((r) => r.id) }));
    const run = services.payroll.generateDraft(period, members, `user:${interaction.user.id}`);
    services.payroll.approve(run.id, `user:${interaction.user.id}`);
    const rep = services.payroll.execute(run.id, `user:${interaction.user.id}`);
    await interaction.editReply({
      content: `✅ ${period} を手動支給しました（総額 ${fmtLd(rep.totalPaid)} / 成功 ${rep.succeeded}件 / スキップ ${rep.skippedAsPaid}件${rep.failed.length > 0 ? ` / 失敗 ${rep.failed.length}件` : ""}）`,
      embeds: [],
      components: [backButton()],
    });
  } catch (e) {
    await interaction.editReply({
      content: `❌ ${e instanceof Error ? e.message : "支給失敗"}`,
      embeds: [],
      components: [backButton()],
    });
  }
}

// ---- 徴収サブパネル ----

function fiscalHome() {
  const embed = new EmbedBuilder()
    .setTitle("🏛 徴収")
    .setColor(0x6b21a8)
    .setDescription(
      [
        "運営が主導する徴収（税・年金）を、パラメータ指定 → **draft→承認→実行** を1発で回します。",
        "",
        "・**冥府税**: 残高が閾値を超えた住人から、超過分×税率(bps) を徴収",
        "・**年金**: 在城 N日 以上の魂に定額を支給",
        "",
        "対象期間は空欄で今月（YYYY-MM）。同じ期間で2回目は上書きされずエラーになります。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:fiscal:tax").setLabel("冥府税を実行").setEmoji("🏛").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mgmt:fiscal:pension").setLabel("年金を実行").setEmoji("💴").setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row, backButton()] };
}

function taxModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:fiscal:tax")
    .setTitle("冥府税 実行")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("threshold").setLabel("閾値（Land・これを超える残高が対象）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("rate_bps").setLabel("税率 bps（例: 500=5%）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6).setPlaceholder("100 = 1%"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("period").setLabel("対象期間 YYYY-MM（空欄で今月）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7),
      ),
    );
}

function pensionModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:fiscal:pension")
    .setTitle("年金 実行")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("min_days").setLabel("最低在城日数").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("支給額（Land）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("period").setLabel("対象期間 YYYY-MM（空欄で今月）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7),
      ),
    );
}

// ---- 部署サブパネル ----

function deptHome(services: Services) {
  const list = services.departments.listWithBalance();
  const lines =
    list.length > 0
      ? list
          .map((d) => `・${d.name}: ${fmtLd(d.balance)}${d.role_id ? ` — 担当 <@&${d.role_id}>` : " — 担当未設定"}`)
          .join("\n")
      : "（部署なし）";
  const embed = new EmbedBuilder()
    .setTitle("🏢 部署")
    .setColor(0x6b21a8)
    .setDescription(`**現在の部署**\n${lines}`);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:dept:create").setLabel("作成").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:dept:role").setLabel("担当ロール").setEmoji("🎭").setStyle(ButtonStyle.Secondary).setDisabled(list.length === 0),
  );
  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [buttons];
  if (list.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("mgmt:dept:remove-pick")
      .setPlaceholder("削除する部署（残高0のみ）")
      .addOptions(list.slice(0, 25).map((d) => ({ label: `${d.name} (${d.balance.toLocaleString()})`, value: d.key })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  components.push(backButton());
  return { embeds: [embed], components };
}

function deptRolePicker(services: Services) {
  const list = services.departments.listWithBalance();
  const menu = new StringSelectMenuBuilder()
    .setCustomId("mgmt:dept:role-pick")
    .setPlaceholder("担当ロールを設定する部署を選ぶ")
    .addOptions(
      list.slice(0, 25).map((d) => ({
        label: d.name,
        description: d.role_id ? `現在の担当: ロール設定済み` : "担当未設定",
        value: d.key,
      })),
    );
  return {
    embeds: [new EmbedBuilder().setTitle("🎭 部署の担当ロール設定").setDescription("担当ロールを変更・設定する部署を選んでください。")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()],
  };
}

function deptRoleSetPicker(deptKey: string, deptName: string) {
  const menu = new RoleSelectMenuBuilder().setCustomId(`mgmt:dept:role-set:${deptKey}`).setPlaceholder("担当にするロールを選ぶ");
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`🎭 「${deptName}」の担当ロール`)
        .setDescription("この部署の口座を操作できるロールを選んでください（既存の設定は上書きされます）。"),
    ],
    components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu), backButton()],
  };
}

function deptCreateModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:dept:create")
    .setTitle("部署の作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("部署名（例: 冥界商館）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
      ),
    );
}

async function deptRemove(
  interaction: StringSelectMenuInteraction,
  services: Services,
  key: string,
): Promise<void> {
  const bal = services.departments.balanceOf(key);
  if (bal !== 0) {
    await interaction.update({ content: `❌ 残高が 0 ではないため削除できません（残 ${fmtLd(bal)}）。`, embeds: [], components: [backButton()] });
    return;
  }
  services.departments.remove(key);
  await interaction.update({ content: `🗑 部署「${key}」を削除しました。`, embeds: [], components: [backButton()] });
}

// ---- 賭場（マモン）サブパネル ----

const CASINO_DEPT_KEY = "賭博場";

/**
 * 状態ごとの「開ける」ボタンの文言。ここに無い状態は開けるボタンを出さない。
 * 経路を1本ずつに分けるのは、検算NGで止めた賭場を「メンテ終了」の導線から開けさせないため。
 *
 * `opening_reset` は**意図的に無い**。正式開業初期化は R0 停止 → R1〜R11 初期化 →
 * R12 同一トランザクション内の検算 → R13 成功時のみ COMMIT → R14 open という一続きの処理で、
 * 全点検A〜Dが通っただけで通常の再開導線から解除してよいものではない（PR12 で実装する）。
 * `open` / `startup_check` も同様にボタンを出さない。
 */
const REOPEN_LABEL: Partial<Record<string, string>> = {
  manual_halt: "営業再開",
  integrity_halt: "検算通過で再開",
  maintenance: "改装終了",
};

/** 稼働状態の見出し（運営が一目で「いま開いているか・なぜ閉じたか」を掴めるように） */
const CASINO_STATUS_LABEL: Record<string, string> = {
  open: "🟢 営業中",
  startup_check: "🟡 点検中",
  integrity_halt: "🔴 停止（検算NG）",
  recovery_halt: "🔴 停止（起動時の復旧が未完了）",
  manual_halt: "🔴 停止（手動）",
  maintenance: "🔧 改装中",
  opening_reset: "🚧 開業準備中",
};

/** ソロゲーム名。`LIABILITY_MODELS`（packages/core）・`/遊ぶ` のサブコマンド名と揃える */
const CAPACITY_REPORT_GAMES = ["スロット", "丁半", "クラッシュ", "チンチロ", "ブラックジャック", "ポーカー", "ホールデム"];

/**
 * PR13: 運転資金の目安（`houseCapacityReport`）を運営卓へ表示する。
 *
 * 最低運転資金は `casino_opening_settings`（PR12・SELECT専用）から読む。未設定なら
 * 推測で埋めず「未設定」と出す（CLAUDE.md §7・運営設定値を推測で埋めない）。
 * 各ゲームの1件最大予約額・人数別必要額は `liabilityModelFor` から導出し、
 * ここへ数値を手入力しない。
 */
function capacityWorksheetLine(services: Services): string {
  const openingConfig = readCasinoOpeningConfig(services.settings);
  // PR13監査: 未設定を0として計算に使わない（`houseCapacityReport`が`null`のまま
  // `recommendedOpeningHouse`を計算しないので、ここで推測して埋めない）。
  const minWorkingCapital = openingConfig.ok ? openingConfig.config.minWorkingCapital : null;
  const report = houseCapacityReport(minWorkingCapital, CAPACITY_REPORT_GAMES);
  const worst = report.games.reduce((a, b) => (b.maximumReservation > a.maximumReservation ? b : a), report.games[0]!);
  return [
    `最低運転資金: ${openingConfig.ok ? fmtLd(minWorkingCapital!) : `未設定（\`${CASINO_OPENING_SETTING_KEYS.minWorkingCapital}\` 未設定・開業設定前）`}`,
    `最大予約（1件）: ${fmtLd(worst.maximumReservation)}（${worst.game}）`,
    `同時10人時の必要額（同ゲーム）: ${fmtLd(worst.users[10])}`,
    `推奨house残高: ${report.recommendedOpeningHouse === null ? "未設定（最低運転資金が未確定）" : `**${fmtLd(report.recommendedOpeningHouse)}**`}`,
  ].join("\n");
}

function casinoHome(services: Services) {
  const ether = services.chips;
  const casino = services.casino;
  const dept = services.departments.get(CASINO_DEPT_KEY);
  const deptBal = dept ? services.departments.balanceOf(CASINO_DEPT_KEY) : null;
  const status = services.casinoStatus.current();
  // 稼働状態が open でも、正式開業初期化（PR12）が終わるまで資金は動かせない。
  // 「🟢 営業中」だけを見せると運営卓が実態と食い違う（PR8監査・項目8）
  const phase = openingPhase(services);
  // 起動時・営業再開・再点検・計器盤はすべて同じ全点検（Land台帳 + 検算A〜D）を使う
  const report = services.casinoIntegrity.runFull();
  const checkLines = [
    `　${report.ledger.ok ? "✅" : "⚠️"} Land台帳: ${report.ledger.detail}`,
    ...report.checks.map((c) => `　${c.ok ? "✅" : "⚠️"} 検算${c.id}（${c.name}）: ${c.detail}`),
  ];
  const embed = new EmbedBuilder()
    .setTitle("🎰 マモンの賭場 運営卓")
    .setColor(status.status === "open" ? 0xc9a227 : 0x991b1b)
    .setDescription(
      [
        `**稼働状態**: ${CASINO_STATUS_LABEL[status.status] ?? status.status}`,
        `　理由: ${status.reason}（${status.changedBy}）`,
        `**開業状態**: ${openingBadge(services)}`,
        ...(phase === "formal" ? [] : ["", openingNotice(services)]),
        "",
        `**胴元残高**: ${fmtEther(casino.houseBalance())} （テーブルリミットの原資）`,
        `**ジャックポット積立**: ${fmtEther(casino.jackpotPool())}`,
        // 1:1 は opening_v1 後にだけ動く約束。それ以前に断言すると運営が誤操作する
        phase === "formal" ? `**チップ比率**: 1 チップ = 1 Ld` : `**チップ比率**: 停止中（opening_v1 確定後に 1 チップ = 1 Ld）`,
        phase === "unknown"
          ? `**準備プール**: 読み取り不可（版が異常）`
          : `**準備プール**: ${fmtLd(ether.pool())} ／ **発行済みチップ**: ${fmtEther(ether.outstanding())}`,
        "",
        dept
          ? `**部署「${CASINO_DEPT_KEY}」残高**: ${fmtLd(deptBal!)}`
          : `⚠️ 部署「${CASINO_DEPT_KEY}」が未作成です。先に 部署→作成 で作ってください。`,
      ].join("\n"),
    )
    .addFields(
      { name: report.ok ? "▸ 全点検（正常）" : "▸ 全点検（**要対応**）", value: checkLines.join("\n"), inline: false },
      { name: "▸ 運転資金目安（PR13）", value: capacityWorksheetLine(services), inline: false },
      openingOpsField(services),
    );
  // 停止中は資金投入・売上精算も押せない（押しても資金層で弾かれるが、UIでも見せる）。
  // 正式開業前・未知版も同じ扱いにする。押せてしまうと、必ず断られる操作を運営に踏ませる
  const closed = status.status !== "open" || phase !== "formal";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:casino:fund").setLabel("資金投入").setEmoji("🔸").setStyle(ButtonStyle.Primary).setDisabled(!dept || closed),
    new ButtonBuilder().setCustomId("mgmt:casino:settle").setLabel("売上精算").setEmoji("🔹").setStyle(ButtonStyle.Secondary).setDisabled(!dept || closed),
    new ButtonBuilder().setCustomId("mgmt:casino:recheck").setLabel("再点検").setEmoji("🔎").setStyle(ButtonStyle.Secondary),
    // 復旧未完了は「再点検して開ける」種類の停止ではない。S4〜S12 をやり直す専用導線（PR7）
    ...(status.status === "recovery_halt"
      ? [
          new ButtonBuilder()
            .setCustomId("mgmt:casino:rerecover")
            .setLabel("復旧を再実行")
            .setEmoji("♻️")
            .setStyle(ButtonStyle.Primary),
        ]
      : []),
    ...(closed
      ? []
      : [new ButtonBuilder().setCustomId("mgmt:casino:halt").setLabel("営業停止").setEmoji("⛔").setStyle(ButtonStyle.Danger)]),
    // 開ける経路は状態ごとに1本ずつ。generic な「営業再開」で全部開けられないようにする
    ...(REOPEN_LABEL[status.status]
      ? [
          new ButtonBuilder()
            .setCustomId("mgmt:casino:reopen")
            .setLabel(REOPEN_LABEL[status.status]!)
            .setEmoji("🟢")
            .setStyle(ButtonStyle.Success),
        ]
      : []),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [row];
  rows.push(...openingOpsRows(services));
  // PR10 emergency refund is a persistent preview/draft saga. Creating or viewing the
  // confirmation never moves funds; execution rechecks balances and ownership.
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("mgmt:casino:refund-user")
        .setLabel("緊急返還（個人）")
        .setEmoji("🚨")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(phase !== "formal"),
      new ButtonBuilder()
        .setCustomId("mgmt:casino:refund-all")
        .setLabel("緊急返還（全利用者）")
        .setEmoji("🚨")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(phase !== "formal"),
    ),
  );
  // PR24: 汎用順位卓の順位配分を登録する（資金は動かない。従業員へ選択肢を配るだけ）
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("mgmt:casino:profile")
        .setLabel("汎用順位卓の配分を登録")
        .setEmoji("🧮")
        .setStyle(ButtonStyle.Secondary),
      // 極卓・冥獄卓の段階解放。開催可否だけを変える（資金は動かない）
      new ButtonBuilder()
        .setCustomId("mgmt:casino:unlock")
        .setLabel("順位卓の段階解放")
        .setEmoji("🔓")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  // 検算Bの基準が無い版（PR2 以前から動いていたDB）だけ、明示的な基準確定を出す
  if (services.chipTx.openingLandBaseline() === null) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("mgmt:casino:baseline")
          .setLabel("検算Bの基準を確定（移行）")
          .setEmoji("📌")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return { embeds: [embed], components: [...rows, backButton()] };
}

/**
 * 段階解放の対象と、対応する設定キー。
 *
 * 見習〜超高卓は通常営業なので**ここに載せない**（設定を持たない＝常に開ける）。
 * 一律の時間クールダウンは廃止した。時間で勝手に開くと「いま開けてよいか」の判断が
 * 運営の手を離れるうえ、設定値が未投入だと逆に全ランクが死ぬ事故が起きたため。
 */
const RANKED_UNLOCK_SETTING: Readonly<Record<string, "casino_extreme_enabled" | "casino_meigoku_enabled">> = {
  extreme: "casino_extreme_enabled",
  meigoku: "casino_meigoku_enabled",
};

/** 段階解放パネル。ここでの操作は開催可否だけを変え、資金には一切触れない */
function rankedUnlockPanel(services: Services) {
  const tiers = RANKED_TABLE_TIERS.filter((tier) => RANKED_UNLOCK_SETTING[tier.key]);
  const state = (tierKey: string): boolean => services.settings.getNumber(RANKED_UNLOCK_SETTING[tierKey]!) === 1;
  const embed = new EmbedBuilder()
    .setTitle("🔓 順位卓の段階解放")
    .setColor(0xc9a227)
    .setDescription(
      [
        "見習卓〜**超高卓（30,000 Ld）** までは従業員が通常営業で開けます。設定は要りません。",
        "**極卓・冥獄卓は運営が解放したときだけ**開けます。解放は極 → 冥獄の順に1段ずつ。",
        "",
        ...tiers.map((tier) => `${state(tier.key) ? "🟢 解放中" : "🔒 未解放"}　**${tier.label}**（${tier.baseAmount.toLocaleString("ja-JP")} Ld）`),
        "",
        "-# 解放しても、担保・場代・日次損失上限・残高確認はこれまでどおり効きます。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...tiers.map((tier) =>
      new ButtonBuilder()
        .setCustomId(`mgmt:casino:unlock-toggle:${tier.key}`)
        .setLabel(`${tier.label}を${state(tier.key) ? "閉じる" : "解放する"}`)
        .setEmoji(state(tier.key) ? "🔒" : "🔓")
        .setStyle(state(tier.key) ? ButtonStyle.Danger : ButtonStyle.Success),
    ),
  );
  return {
    embeds: [embed],
    components: [row, new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mgmt:casino").setLabel("賭場へ戻る").setEmoji("◀").setStyle(ButtonStyle.Secondary),
    )],
  };
}

/**
 * 順位配分の入力を**全件 strict に**解釈する（PR24 レビュー BLOCKER 3）。
 *
 * 配分式は配当に直結する信頼設定なので、読めない語を黙って捨ててはいけない。
 * 以前は `.map(Number).filter(Number.isFinite)` だったため
 * `10000, foo, -10000` が 2人卓 `[10000, -10000]` として登録されえた。
 *
 * いまは1トークンでも10進整数でなければ**入力全体を拒否**する。
 * したがって人数は「有効だったトークン数」ではなく、常に入力された順位トークンの件数になる。
 * 小数(`1.5`)・指数(`1e4`)・16進(`0x100`)・`NaN`・`Infinity`・語句はすべて弾く。
 */
export function parseRankDeltaTokens(raw: string): number[] | null {
  const tokens = raw.split(/[\s,]+/).filter((token) => token !== "");
  if (tokens.length < 2) return null;
  const values: number[] = [];
  for (const token of tokens) {
    if (!/^[+-]?\d+$/.test(token)) return null;
    const value = Number(token);
    if (!Number.isSafeInteger(value)) return null;
    values.push(value);
  }
  return values;
}

function rankedProfileModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:casino:profile")
    .setTitle("汎用順位卓の順位配分を登録")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("profile_key").setLabel("識別子（英小文字・数字・_-）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("label").setLabel("表示名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("deltas")
          .setLabel("1位から順の増減bps（合計0・例: 10000,-10000）")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120),
      ),
    );
}

function casinoRefundUserModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:casino:refund-user")
    .setTitle("緊急返還（個人）")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("user_id")
          .setLabel("返還対象のDiscord利用者ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(22),
      ),
    );
}

function casinoRefundConfirm(saga: RefundSaga) {
  const target = saga.scope === "all" ? "全利用者" : `<@${saga.targetUserId}>`;
  return {
    content: [
      "🚨 **緊急返還の実行前確認**",
      `対象: ${target} / **${saga.targetCount}人・${fmtLd(saga.targetTotal)}**`,
      "この時点では資金を動かしていません。",
      "自由チップだけをLandへ返還します。卓・板の預託、house、JP、relief、quarantine、free-spin claimは対象外です。",
      "実行時に残高・進行中ゲーム・予約・預託・検算状態を再確認し、staleなら開始しません。",
    ].join("\n"),
    embeds: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:casino:refund-execute:${saga.id}`)
          .setLabel("この内容で実行")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`mgmt:casino:refund-cancel:${saga.id}`)
          .setLabel("やめる")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function casinoRefundResult(saga: RefundSaga) {
  const completed = saga.targets.filter((target) => target.status === "completed");
  const failed = saga.targets.filter((target) => target.status !== "completed");
  return {
    content:
      saga.status === "completed"
        ? `✅ 緊急返還が完了しました。対象 ${completed.length}人 / 確認額 ${fmtLd(saga.targetTotal)}。`
        : `⛔ 緊急返還は完了していません（${saga.failure ?? saga.status}）。返還済み ${completed.length}人 / 未完了 ${failed.length}人。`,
    embeds: [],
    // 取消は core 側で draft のときだけ通る（監査項目12）。blocked/executing で
    // 「取り消す」を出すと、押しても必ず失敗する死んだボタンになる。
    // 出口は「安全確認後に再開」だけにして、UI と実際の遷移可能集合を一致させる。
    components:
      saga.status === "completed" || saga.status === "cancelled"
        ? [backButton()]
        : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`mgmt:casino:refund-execute:${saga.id}`)
                .setLabel("安全確認後に再開")
                .setStyle(ButtonStyle.Danger),
              ...(saga.status === "draft"
                ? [
                    new ButtonBuilder()
                      .setCustomId(`mgmt:casino:refund-cancel:${saga.id}`)
                      .setLabel("取り消す")
                      .setStyle(ButtonStyle.Secondary),
                  ]
                : []),
            ),
            backButton(),
          ],
  };
}

function casinoHaltModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:casino:halt")
    .setTitle("賭場を止める")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("理由（利用者と監査ログに残る）")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
    );
}

function casinoReopenModal(currentReason: string) {
  // Discord の TextInput label は45文字まで。いまの停止理由は placeholder へ逃がす
  return new ModalBuilder()
    .setCustomId("mgmt:casino:reopen")
    .setTitle("賭場を開ける")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("再開の理由（監査ログに残る）")
          .setPlaceholder(`いまの停止理由: ${currentReason}`.slice(0, 100))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
    );
}

/** 検算Bの基準確定（移行操作）。押した人と時点が監査に残る */
function casinoBaselineModal(poolLand: number, ledgerTxId: number) {
  return new ModalBuilder()
    .setCustomId("mgmt:casino:baseline")
    .setTitle("検算Bの基準を確定する")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("confirm")
          .setLabel("確認のため「確定」と入力")
          .setPlaceholder(`準備プール ${poolLand} Ld / 境界取引 #${ledgerTxId} を出発点にします`.slice(0, 100))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10),
      ),
    );
}

function casinoFundModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:casino:fund")
    .setTitle("胴元へ資金投入（賭博場口座→胴元）")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("投入する Land").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
      ),
    );
}

function casinoSettleModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:casino:settle")
    .setTitle("売上精算（胴元→賭博場口座）")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("精算する自由チップ（空欄=全額）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(15),
      ),
    );
}

// ---- 調整サブパネル ----

function adjustHome() {
  const embed = new EmbedBuilder()
    .setTitle("🔧 調整")
    .setColor(0x6b21a8)
    .setDescription("対象者を選んで金額を入力してください。マイナスで回収、プラスで発行になります。");
  const menu = new UserSelectMenuBuilder().setCustomId("mgmt:adjust:target").setPlaceholder("対象を選ぶ");
  return { embeds: [embed], components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu), backButton()] };
}

function adjustAmountModal(targetId: string) {
  return new ModalBuilder()
    .setCustomId(`mgmt:adjust:amount:${targetId}`)
    .setTitle("残高調整")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("金額（±可）").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("理由（監査ログに残る）").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200),
      ),
    );
}

// ---- XP除外サブパネル ----

function xpexHome(services: Services) {
  const list = services.settings.getJson<string[]>("xp_excluded_channels", []);
  const listText =
    list.length > 0
      ? list.map((id) => `・<#${id}> (\`${id}\`)`).join("\n")
      : "（除外なし・すべてXP対象）";
  const embed = new EmbedBuilder()
    .setTitle("🚫 XP除外チャンネル/カテゴリ")
    .setColor(0x6b21a8)
    .setDescription([
      "ここに登録したチャンネル（またはカテゴリ）は、発言XP・浮上XPの対象外になります。",
      "",
      "**現在の除外リスト**:",
      listText,
    ].join("\n"));
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId("mgmt:xpex:add")
    .setPlaceholder("除外に追加するチャンネル/カテゴリ")
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory);
  const components: ActionRowBuilder<ButtonBuilder | ChannelSelectMenuBuilder>[] = [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(picker),
  ];
  if (list.length > 0) {
    // 削除ボタン群（先頭5個まで）
    const removeRow = new ActionRowBuilder<ButtonBuilder>();
    for (const id of list.slice(0, 5)) {
      removeRow.addComponents(
        new ButtonBuilder().setCustomId(`mgmt:xpex:remove:${id}`).setLabel(`削除 ${id.slice(-4)}`).setStyle(ButtonStyle.Danger),
      );
    }
    components.push(removeRow);
  }
  components.push(backButton());
  return { embeds: [embed], components };
}

async function xpexAdd(
  interaction: ChannelSelectMenuInteraction,
  services: Services,
  channelId: string,
): Promise<void> {
  const list = services.settings.getJson<string[]>("xp_excluded_channels", []);
  if (!list.includes(channelId)) list.push(channelId);
  services.settings.set("xp_excluded_channels", list, `user:${interaction.user.id}`);
  await interaction.update(xpexHome(services));
}

async function xpexRemove(interaction: ButtonInteraction, services: Services, channelId: string): Promise<void> {
  const list = services.settings.getJson<string[]>("xp_excluded_channels", []);
  const filtered = list.filter((id) => id !== channelId);
  services.settings.set("xp_excluded_channels", filtered, `user:${interaction.user.id}`);
  await interaction.update(xpexHome(services));
}
