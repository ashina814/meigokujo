import {
  ActionRowBuilder,
  ButtonInteraction,
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
import {
  currentGuildEvaluationTargets,
  evaluationCommand,
  evaluationPanelRow,
  evaluationReferenceText,
  threadTitleFor,
} from "../evaluation-forum-view.js";
export {
  currentGuildEvaluationTargets,
  evaluationCommand,
  evaluationForumThresholdsForTesting,
  evaluationPanelRow,
  evaluationReferenceText,
  threadTitleFor,
} from "../evaluation-forum-view.js";
import type { Services } from "../services.js";

const TARGETS_PER_MENU = 25;
const MAX_TARGET_MENUS = 5;

/** 同じBotプロセス内で、同一評価サイクルのDiscord threadを二重生成しない。 */
const threadCreationLocks = new Map<string, Promise<AnyThreadChannel | null>>();

// ---- 権限 ----

export function isSwordsman(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | ButtonInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const roleId = services.settings.getString("role:swordsman");
  if (!roleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(roleId) ?? false;
}

// ---- /評価（旧入力フォームは廃止。運営が常設パネルを置くための入口だけ残す） ----

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
      content: ["## 【亡霊評価】", "現在評価期間中の亡霊を選んでください。"].join("\n"),
      components: [evaluationPanelRow()],
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

async function targetMenus(
  guild: Guild,
  services: Services,
  omitUserId?: string,
): Promise<{
  rows: ActionRowBuilder<StringSelectMenuBuilder>[];
  total: number;
  shown: number;
}> {
  const store = new EvaluationForumStore(services.db);
  const cycles = store.listCurrentCycles();
  if (cycles.length === 0) return { rows: [], total: 0, shown: 0 };

  // 一覧の正本は「DB上で評価中 AND 現在Guildに在籍」。
  // member fetchに失敗した時はID表示へフォールバックせず、呼び出し元へ失敗を返す。
  const members = await guild.members.fetch();
  const targets = currentGuildEvaluationTargets(cycles, members, omitUserId);
  const shownTargets = targets.slice(0, TARGETS_PER_MENU * MAX_TARGET_MENUS);
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let offset = 0; offset < shownTargets.length; offset += TARGETS_PER_MENU) {
    const chunk = shownTargets.slice(offset, offset + TARGETS_PER_MENU);
    const index = Math.floor(offset / TARGETS_PER_MENU);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`eval:target:${index}`)
          .setPlaceholder(index === 0 ? "現在の亡霊から選択" : `現在の亡霊から選択（${index + 1}）`)
          .addOptions(
            chunk.map((target) => {
              const deadline = target.deadlineAt ? `期限 ${fmtJstShortDate(target.deadlineAt)}` : "期限未設定";
              return {
                label: target.displayName.slice(0, 100),
                value: target.userId,
                description: deadline.slice(0, 100),
              };
            }),
          ),
      ),
    );
  }
  return { rows, total: targets.length, shown: shownTargets.length };
}

function targetListContent(total: number, shown: number): string {
  const omitted = total - shown;
  return omitted > 0
    ? `現在の評価対象は ${total}名です。Discordの表示上限のため先頭${shown}名を表示しています。`
    : `現在の評価対象は ${total}名です。対象を選んでください。`;
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
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    const menus = await targetMenus(interaction.guild, services);
    if (menus.total === 0) {
      await interaction.reply({ content: "現在、サーバーに在籍している評価期間中の亡霊はいません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: targetListContent(menus.total, menus.shown),
      components: menus.rows,
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    await interaction.reply({
      content: "亡霊一覧の取得に失敗しました。もう一度［評価する亡霊を選択］を押してください。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function editWithFreshTargets(
  interaction: StringSelectMenuInteraction,
  services: Services,
  content: string,
  omitUserId?: string,
): Promise<void> {
  try {
    const menus = await targetMenus(interaction.guild!, services, omitUserId);
    const continuation =
      menus.total > 0
        ? "\n\n**続けて別の亡霊も選択できます。**"
        : "\n\n現在、ほかにサーバー在籍中の評価対象はいません。";
    await interaction.editReply({ content: `${content}${continuation}`, components: menus.rows });
  } catch {
    await interaction.editReply({
      content: `${content}\n\n亡霊一覧の再取得に失敗しました。常設パネルの［評価する亡霊を選択］をもう一度押してください。`,
      components: [],
    });
  }
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

  if (!interaction.customId.startsWith("eval:target:")) {
    // deploy直後に残った旧 /評価 select を触っても interaction failure にせず新方式へ案内する。
    await interaction.reply({
      content: "この評価入力UIは旧方式です。常設パネルの［評価する亡霊を選択］から対象を選んでください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetId = interaction.values[0];
  if (!targetId) {
    await interaction.reply({ content: "対象を取得できませんでした。常設パネルから開き直してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const store = new EvaluationForumStore(services.db);
  const cycle = store.currentCycle(targetId);
  if (!cycle) {
    await editWithFreshTargets(
      interaction,
      services,
      "この人は現在の評価対象ではなくなりました。最新の一覧に更新しました。",
    );
    return;
  }

  // ephemeral一覧を開いた後の退城も弾く。DB statusは出戻り用に保持されるのでGuild在籍を別途確認する。
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    await editWithFreshTargets(
      interaction,
      services,
      "選択した亡霊は現在サーバーに在籍していません。最新の一覧に更新しました。",
    );
    return;
  }

  try {
    const thread = await ensureEvaluationThread(interaction.guild, services, targetId);
    if (!thread) {
      await editWithFreshTargets(
        interaction,
        services,
        "評価フォーラムを作成できませんでした。`channel:eval_forum` の設定を確認してください。",
      );
      return;
    }
    await editWithFreshTargets(
      interaction,
      services,
      `**${member.displayName}** の評価フォーラムを開きました → ${thread.toString()}\nフォーラムへ通常のDiscordメッセージとして自由に評価を書いてください。`,
      targetId,
    );
  } catch (error) {
    await editWithFreshTargets(
      interaction,
      services,
      `評価フォーラムを開けませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
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

  const lines: string[] = [`👻 **${threadTitleFor(displayName)}**`];
  if (cycle.origin === "return") lines.push("", "🔄 **出戻り**");
  lines.push("", `評価開始：${fmtJstDate(cycle.startedAt)}`, `現在期限：${fmtJstDate(cycle.deadlineAt)}`, "", "🐾 **冥獣の巣**");

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

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) throw new Error("target_member_not_found");
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
