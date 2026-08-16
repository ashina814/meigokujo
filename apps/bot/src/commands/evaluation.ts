import {
  ActionRowBuilder,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type AnyThreadChannel,
  type ForumChannel,
  type Guild,
  type GuildMember,
} from "discord.js";
import { EvaluationForumStore } from "@meigokujo/core/evaluation/forum";
import { isAdmin } from "../permissions.js";
import { evaluationCommand, evaluationReferenceText, threadTitleFor } from "../evaluation-forum-view.js";
export { evaluationCommand, evaluationForumThresholdsForTesting, evaluationReferenceText, threadTitleFor } from "../evaluation-forum-view.js";
import type { Services } from "../services.js";

const TARGETS_PER_MENU = 25;
const MAX_TARGET_MENUS = 5;
const MEMBER_FETCH_BATCH = 100;

/** 同じBotプロセス内で、同一評価サイクルのDiscord threadを二重生成しない。 */
const threadCreationLocks = new Map<string, Promise<AnyThreadChannel | null>>();

// ---- 権限 ----

export function isSwordsman(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const roleId = services.settings.getString("role:swordsman");
  if (!roleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(roleId) ?? false;
}

// ---- /評価（旧入力フォームは廃止。運営が常設パネルを置くための入口だけ残す） ----

function panelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("eval:open")
      .setLabel("評価する亡霊を選択")
      .setStyle(ButtonStyle.Primary),
  );
}

export async function handleEvaluationCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isSwordsman(interaction, services)) {
    await interaction.reply({ content: "評価フォーラムは魔剣士のみ利用できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  // 運営だけは /評価 を「常設パネルをこのチャンネルへ置く」ためにも使える。
  // 魔剣士の日常操作はこのコマンドではなく、設置済みパネルから行う。
  if (isAdmin(interaction, services) && interaction.channel?.isTextBased() && "send" in interaction.channel) {
    const message = await interaction.channel.send({
      content: ["## 【亡霊評価】", "評価期間中の亡霊と、期限超過で判定待ちの亡霊を確認できます。"].join("\n"),
      components: [panelRow()],
    });
    services.settings.set("eval_forum_panel_channel", interaction.channel.id, interaction.user.id);
    services.settings.set("eval_forum_panel_message", message.id, interaction.user.id);
    await interaction.reply({ content: `評価対象パネルを設置しました: ${message.url}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    content: "評価は現在、評価フォーラムへ直接記入する方式です。評価対象パネルから対象者を選んでください。",
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 評価対象パネル ----

function fmtJstDate(ts: number | null): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
  }).format(new Date(ts * 1000));
}

function fmtJstShortDate(ts: number | null): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  }).format(new Date(ts * 1000));
}

function fmtDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

function isPendingJudgement(deadlineAt: number | null, nowSec: number): boolean {
  return deadlineAt !== null && deadlineAt <= nowSec;
}

function discordErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Number((error as { code?: unknown }).code);
  return Number.isFinite(code) ? code : undefined;
}

async function fetchEvaluationMembers(
  guild: Guild,
  userIds: string[],
): Promise<{ members: Map<string, GuildMember>; unresolvedIds: Set<string> }> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const members = new Map<string, GuildMember>();
  const unresolvedIds = new Set<string>();

  for (let offset = 0; offset < ids.length; offset += MEMBER_FETCH_BATCH) {
    const chunk = ids.slice(offset, offset + MEMBER_FETCH_BATCH);
    try {
      // サーバー全員ではなく、現在の評価サイクルにいる対象だけをまとめて取得する。
      const fetched = await guild.members.fetch({ user: chunk });
      for (const [userId, member] of fetched) members.set(userId, member);
      continue;
    } catch (error) {
      console.warn(
        `[eval-forum] targeted member fetch failed; falling back to per-user fetch (${chunk.length} targets)`,
        error,
      );
    }

    await Promise.all(
      chunk.map(async (userId) => {
        try {
          const member = await guild.members.fetch({ user: userId, force: true });
          members.set(userId, member);
        } catch (error) {
          // DiscordのUnknown Memberは「退城済み」として正常に一覧から除外する。
          if (discordErrorCode(error) === 10007) return;

          // 一時的なAPI/Gateway失敗では、既に観測済みのcacheを使って一覧全体を殺さない。
          const cached = guild.members.cache.get(userId);
          if (cached) {
            members.set(userId, cached);
            console.warn(`[eval-forum] member fetch failed; using cache user=${userId}`, error);
            return;
          }

          unresolvedIds.add(userId);
          console.error(`[eval-forum] member fetch failed user=${userId}`, error);
        }
      }),
    );
  }

  return { members, unresolvedIds };
}

async function targetMenus(
  guild: Guild,
  services: Services,
  excludeUserId?: string,
): Promise<{
  rows: ActionRowBuilder<StringSelectMenuBuilder>[];
  total: number;
  shown: number;
  activeTotal: number;
  activeShown: number;
  pendingTotal: number;
  pendingShown: number;
  memberIds: Set<string>;
  unresolvedIds: Set<string>;
}> {
  const store = new EvaluationForumStore(services.db);
  const cycles = store.listCurrentCycles();
  if (cycles.length === 0) {
    return {
      rows: [],
      total: 0,
      shown: 0,
      activeTotal: 0,
      activeShown: 0,
      pendingTotal: 0,
      pendingShown: 0,
      memberIds: new Set(),
      unresolvedIds: new Set(),
    };
  }

  // Guild在籍を正本として一覧を作る。ただし全Guild member取得には依存せず、評価対象だけを照会する。
  // excludeUserIdも在籍再確認には必要なので、fetch対象からは除外しない。
  const { members, unresolvedIds } = await fetchEvaluationMembers(guild, cycles.map((cycle) => cycle.userId));
  const memberIds = new Set(members.keys());
  const presentCycles = cycles.filter((cycle) => cycle.userId !== excludeUserId && memberIds.has(cycle.userId));
  const nowSec = Math.floor(Date.now() / 1000);
  const activeCycles = presentCycles.filter((cycle) => !isPendingJudgement(cycle.deadlineAt, nowSec));
  const pendingCycles = presentCycles.filter((cycle) => isPendingJudgement(cycle.deadlineAt, nowSec));
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  // 判定待ちがいる場合は最低1行を必ず残す。通常対象が多くても判定待ちを一覧から隠さない。
  const maxActiveRows = pendingCycles.length > 0 ? MAX_TARGET_MENUS - 1 : MAX_TARGET_MENUS;
  const activeShownCycles = activeCycles.slice(0, maxActiveRows * TARGETS_PER_MENU);
  for (let offset = 0; offset < activeShownCycles.length; offset += TARGETS_PER_MENU) {
    const chunk = activeShownCycles.slice(offset, offset + TARGETS_PER_MENU);
    const index = Math.floor(offset / TARGETS_PER_MENU);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`eval:target:active:${index}`)
          .setPlaceholder(index === 0 ? "評価期間中の亡霊" : `評価期間中の亡霊（${index + 1}）`)
          .addOptions(
            chunk.map((cycle) => {
              const member = members.get(cycle.userId);
              if (!member) throw new Error(`guild member disappeared while rendering evaluation target: ${cycle.userId}`);
              const deadline = cycle.deadlineAt ? `期限 ${fmtJstShortDate(cycle.deadlineAt)}` : "期限未設定";
              return { label: member.displayName.slice(0, 100), value: cycle.userId, description: deadline.slice(0, 100) };
            }),
          ),
      ),
    );
  }

  const pendingRowBudget = MAX_TARGET_MENUS - rows.length;
  const pendingShownCycles = pendingCycles.slice(0, pendingRowBudget * TARGETS_PER_MENU);
  for (let offset = 0; offset < pendingShownCycles.length; offset += TARGETS_PER_MENU) {
    const chunk = pendingShownCycles.slice(offset, offset + TARGETS_PER_MENU);
    const index = Math.floor(offset / TARGETS_PER_MENU);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`eval:target:pending:${index}`)
          .setPlaceholder(index === 0 ? "⏳ 期限超過・判定待ち" : `⏳ 期限超過・判定待ち（${index + 1}）`)
          .addOptions(
            chunk.map((cycle) => {
              const member = members.get(cycle.userId);
              if (!member) throw new Error(`guild member disappeared while rendering evaluation target: ${cycle.userId}`);
              const deadline = `期限超過 ${fmtJstShortDate(cycle.deadlineAt)} / 判定待ち`;
              return { label: member.displayName.slice(0, 100), value: cycle.userId, description: deadline.slice(0, 100) };
            }),
          ),
      ),
    );
  }

  return {
    rows,
    total: presentCycles.length,
    shown: activeShownCycles.length + pendingShownCycles.length,
    activeTotal: activeCycles.length,
    activeShown: activeShownCycles.length,
    pendingTotal: pendingCycles.length,
    pendingShown: pendingShownCycles.length,
    memberIds,
    unresolvedIds,
  };
}

async function replyWithTargetMenus(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  // member取得が遅れてもDiscordの3秒制限でinteractionを失わないよう、先に応答を確保する。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let menus: Awaited<ReturnType<typeof targetMenus>>;
  try {
    menus = await targetMenus(interaction.guild, services);
  } catch (error) {
    console.error("[eval-forum] target menu build failed", error);
    await interaction.editReply({
      content: "評価対象一覧の作成に失敗しました。もう一度押してください。",
      components: [],
    });
    return;
  }
  if (menus.total === 0) {
    await interaction.editReply({
      content:
        menus.unresolvedIds.size > 0
          ? `評価対象 ${menus.unresolvedIds.size}名の在籍確認に失敗しました。もう一度押してください。`
          : "現在、サーバーに在籍している評価対象・判定待ちの亡霊はいません。",
      components: [],
    });
    return;
  }
  const omitted = menus.total - menus.shown;
  const summary = `評価期間中 **${menus.activeTotal}名** / ⏳ 期限超過・判定待ち **${menus.pendingTotal}名**`;
  const unresolved = menus.unresolvedIds.size > 0
    ? `\n⚠️ 在籍確認できなかった評価対象が ${menus.unresolvedIds.size}名います。確認できた対象だけ表示しています。`
    : "";
  await interaction.editReply({
    content:
      (omitted > 0
        ? `${summary}です。Discordの表示上限のため、評価期間中 ${menus.activeShown}/${menus.activeTotal}名・判定待ち ${menus.pendingShown}/${menus.pendingTotal}名を表示しています。`
        : `${summary}です。対象を選んでください。`) + unresolved,
    components: menus.rows,
  });
}

export async function handleEvaluationButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  if (interaction.customId !== "eval:open") return;
  if (!isSwordsman(interaction, services)) {
    await interaction.reply({ content: "評価フォーラムは魔剣士のみ利用できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  await replyWithTargetMenus(interaction, services);
}

export async function handleEvaluationSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  if (!isSwordsman(interaction, services)) {
    await interaction.reply({ content: "評価フォーラムは魔剣士のみ利用できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === "eval:open") {
    // deploy前に設置された旧1択selectも、同じ最新一覧へ案内してinteraction failureを避ける。
    await replyWithTargetMenus(interaction, services);
    return;
  }

  if (!interaction.customId.startsWith("eval:target:")) {
    await interaction.reply({
      content: "この評価入力UIは旧方式です。現在は評価対象パネルから対象者を選び、フォーラムへ直接記入してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetId = interaction.values[0];
  if (!targetId) {
    await interaction.update({ content: "対象を取得できませんでした。パネルから一覧を開き直してください。", components: [] });
    return;
  }

  await interaction.deferUpdate();

  let menus: Awaited<ReturnType<typeof targetMenus>>;
  try {
    menus = await targetMenus(interaction.guild, services, targetId);
  } catch (error) {
    console.error("[eval-forum] target menu refresh failed", error);
    await interaction.editReply({
      content: "評価対象一覧の作成に失敗しました。もう一度パネルの［評価する亡霊を選択］を押してください。",
      components: [],
    });
    return;
  }

  const store = new EvaluationForumStore(services.db);
  const cycle = store.currentCycle(targetId);
  if (!cycle) {
    await interaction.editReply({
      content: "この人は現在の評価対象ではありません。最新の一覧から選び直してください。",
      components: menus.rows,
    });
    return;
  }
  if (menus.unresolvedIds.has(targetId)) {
    await interaction.editReply({
      content: "この人の在籍確認に失敗しました。もう一度パネルから開き直してください。",
      components: menus.rows,
    });
    return;
  }
  if (!menus.memberIds.has(targetId)) {
    await interaction.editReply({
      content: [
        "この人は現在サーバーに在籍していないため、評価対象一覧から外れました。",
        menus.total > 0 ? "**続けて別の亡霊も選択できます。**" : "現在ほかに選択できる亡霊はいません。",
      ].join("\n\n"),
      components: menus.rows,
    });
    return;
  }

  try {
    const thread = await ensureEvaluationThread(interaction.guild, services, targetId);
    const pending = isPendingJudgement(cycle.deadlineAt, Math.floor(Date.now() / 1000));
    await interaction.editReply({
      content: thread
        ? [
            `評価フォーラムを開きました: ${thread.toString()}`,
            pending ? "⏳ **この対象は期限超過・判定待ちです。** 評価内容を確認し、人間側で最終判断してください。" : "以降はフォーラムへ通常のDiscordメッセージとして自由に評価を書いてください。",
            menus.total > 0 ? "**続けて別の亡霊も選択できます。**" : "現在ほかに選択できる亡霊はいません。",
          ].join("\n\n")
        : "評価フォーラムを作成できませんでした。対象の在籍状況と `channel:eval_forum` の設定を確認してください。",
      components: menus.rows,
    });
  } catch (error) {
    await interaction.editReply({
      content: `評価フォーラムを開けませんでした: ${error instanceof Error ? error.message : String(error)}`,
      components: menus.rows,
    });
  }
}

// ---- フォーラム生成・客観情報 ----

async function swordsmanIds(guild: Guild, services: Services): Promise<string[]> {
  const roleId = services.settings.getString("role:swordsman");
  if (!roleId) return [];
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  return [...members.values()].filter((m) => !m.user.bot && m.roles.cache.has(roleId)).map((m) => m.id);
}

async function starterContent(guild: Guild, services: Services, targetId: string): Promise<string | null> {
  const store = new EvaluationForumStore(services.db);
  const cycle = store.currentCycle(targetId);
  if (!cycle) return null;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return null;
  const displayName = member.displayName;
  const inviteCount = store.inviteCountSinceCycle(targetId, cycle.startedAt);
  const denParentId = services.settings.getString("category:eval_den");
  const nowSec = Math.floor(Date.now() / 1000);

  const lines: string[] = [`👻 **${threadTitleFor(displayName)}**`];
  if (cycle.origin === "return") lines.push("", "🔄 **出戻り**");
  if (isPendingJudgement(cycle.deadlineAt, nowSec)) lines.push("", "⏳ **期限超過・判定待ち**");
  lines.push("", `評価開始：${fmtJstDate(cycle.startedAt)}`, `評価期限：${fmtJstDate(cycle.deadlineAt)}`, "", "🐾 **冥獣の巣**");

  if (!denParentId) {
    lines.push("集計設定（`category:eval_den`）が見つかりません。", "", "💭 **参考**", "冥獣の巣の集計設定を確認してください。");
  } else {
    const presence = store.presenceForCycle({
      userId: targetId,
      swordsmanIds: await swordsmanIds(guild, services),
      denParentId,
      startedAt: cycle.startedAt,
    });
    lines.push(
      `参加：${presence.denDays}日`,
      `滞在：${fmtDuration(presence.denSeconds)}`,
      `魔剣士との同席：${presence.swordsmanDays}日 / ${fmtDuration(presence.swordsmanSeconds)}`,
      "",
      "💭 **参考**",
      evaluationReferenceText(presence),
    );
  }

  lines.push("", "📨 **招待**", `今回の評価開始後：${inviteCount}人`);
  return lines.join("\n");
}

async function refreshThread(
  guild: Guild,
  services: Services,
  thread: AnyThreadChannel,
  targetId: string,
): Promise<void> {
  const content = await starterContent(guild, services, targetId);
  if (!content) return;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return;
  const expectedName = threadTitleFor(member.displayName);
  if (thread.archived) await thread.setArchived(false).catch(() => undefined);
  if (thread.name !== expectedName) await thread.setName(expectedName).catch(() => undefined);

  const starter = await thread.messages.fetch(thread.id).catch(() => null);
  if (starter) {
    await starter.edit({ content, embeds: [] });
  } else {
    // 起点メッセージを取得できない場合だけ、最新情報を1件追加する。
    await thread.send({ content });
  }
}

async function ensureEvaluationThreadUnlocked(
  guild: Guild,
  services: Services,
  targetId: string,
  cycleStartedAt: number,
): Promise<AnyThreadChannel | null> {
  const store = new EvaluationForumStore(services.db);
  const current = store.currentCycle(targetId);
  if (!current || current.startedAt !== cycleStartedAt) return null;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return null;

  const forumId = services.settings.getString("channel:eval_forum");
  if (!forumId) return null;
  const forum = (await guild.client.channels.fetch(forumId).catch(() => null)) as ForumChannel | null;
  if (!forum || forum.type !== ChannelType.GuildForum) return null;

  const existingId = store.threadFor(targetId, cycleStartedAt);
  if (existingId) {
    const existing = (await guild.client.channels.fetch(existingId).catch(() => null)) as AnyThreadChannel | null;
    if (existing?.isThread()) {
      await refreshThread(guild, services, existing, targetId);
      return existing;
    }
  }

  const content = await starterContent(guild, services, targetId);
  if (!content) return null;
  const thread = await forum.threads.create({
    name: threadTitleFor(member.displayName),
    message: { content },
  });
  store.setThread(targetId, cycleStartedAt, thread.id);
  return thread;
}

export async function ensureEvaluationThread(
  guild: Guild,
  services: Services,
  targetId: string,
): Promise<AnyThreadChannel | null> {
  const store = new EvaluationForumStore(services.db);
  const cycle = store.currentCycle(targetId);
  if (!cycle) return null;

  const key = `${targetId}:${cycle.startedAt}`;
  const running = threadCreationLocks.get(key);
  if (running) return running;

  const task = ensureEvaluationThreadUnlocked(guild, services, targetId, cycle.startedAt);
  threadCreationLocks.set(key, task);
  try {
    return await task;
  } finally {
    if (threadCreationLocks.get(key) === task) threadCreationLocks.delete(key);
  }
}

/** 日次更新用。フォーラムは自動生成せず、現在サイクルに既にあるものだけ更新する。 */
export async function refreshEvaluationForumForUser(guild: Guild, services: Services, targetId: string): Promise<boolean> {
  const store = new EvaluationForumStore(services.db);
  const cycle = store.currentCycle(targetId);
  if (!cycle) return false;
  const threadId = store.threadFor(targetId, cycle.startedAt);
  if (!threadId) return false;
  const thread = (await guild.client.channels.fetch(threadId).catch(() => null)) as AnyThreadChannel | null;
  if (!thread?.isThread()) return false;
  await refreshThread(guild, services, thread, targetId);
  return true;
}

/** 旧Modalから遅れて送信されたinteractionは記録せず、新方式へ案内する。 */
export async function handleEvaluationModal(interaction: ModalSubmitInteraction, _services: Services): Promise<void> {
  await interaction.reply({
    content: "評価入力フォームは終了しました。現在は評価フォーラムへ通常のメッセージとして記入してください。",
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 旧カロンの自動評価執行は停止 ----

/**
 * 互換export。新方式では制度判断をBotへ戻さないため自動執行には使わない。
 * 他モジュールが直接呼んでも事故らないよう、明示的に例外にする。
 */
export async function executeDemotion(
  _services: Services,
  _guild: Guild,
  _targetId: string,
  _reason: string,
): Promise<void> {
  throw new Error("automatic evaluation demotion is disabled; review the evaluation forum and decide manually");
}

export async function handleCharonButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "承認は運営のみ可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({
    content: [
      "⚖️ この自動執行は停止しました。",
      "現在の評価制度では、アリ数や評価点からBotが迷霊落ちを判断しません。対象者の評価フォーラムを確認し、人間側で最終判断してください。",
    ].join("\n"),
    components: [],
    embeds: [],
  });
}
