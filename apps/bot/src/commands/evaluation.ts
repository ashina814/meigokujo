import {
  ActionRowBuilder,
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type AnyThreadChannel,
  type ForumChannel,
  type Guild,
  type GuildMember,
} from "discord.js";
import { EvaluationForumStore, type EvaluationPresenceSummary } from "@meigokujo/core/evaluation/forum";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

const DEN_LOW_SECONDS = 30 * 60;
const SWORDSMAN_LOW_SECONDS = 15 * 60;
const TARGETS_PER_MENU = 25;
const MAX_TARGET_MENUS = 5;

/** 同じBotプロセス内で、同一評価サイクルのDiscord threadを二重生成しない。 */
const threadCreationLocks = new Map<string, Promise<AnyThreadChannel | null>>();

// ---- 権限 ----

export function isSwordsman(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const roleId = services.settings.getString("role:swordsman");
  if (!roleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(roleId) ?? false;
}

// ---- /評価（旧入力フォームは廃止。運営が常設パネルを置くための入口だけ残す） ----

export const evaluationCommand = new SlashCommandBuilder()
  .setName("評価")
  .setDescription("評価フォーラム方式の案内を表示する")
  .setDMPermission(false);

function panelRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("eval:open")
      .setPlaceholder("評価する亡霊を選択")
      .addOptions({ label: "評価する亡霊を選択", value: "open", description: "現在の評価対象一覧を開きます" }),
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
      content: ["## 【亡霊評価】", "現在評価期間中の亡霊を選んでください。"].join("\n"),
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

export function evaluationReferenceText(summary: EvaluationPresenceSummary): string {
  if (summary.denSeconds < DEN_LOW_SECONDS) {
    return "巣穴での活動がまだ少なく、評価材料が不足している可能性があります。";
  }
  if (summary.swordsmanSeconds < SWORDSMAN_LOW_SECONDS) {
    return "巣穴への参加はありますが、魔剣士との同席が少なく、評価機会が不足している可能性があります。";
  }
  return "魔剣士との同席機会があります。評価できる材料があるか確認してみてください。";
}

async function targetMenus(guild: Guild, services: Services): Promise<{
  rows: ActionRowBuilder<StringSelectMenuBuilder>[];
  total: number;
  shown: number;
}> {
  const store = new EvaluationForumStore(services.db);
  const cycles = store.listCurrentCycles();
  if (cycles.length === 0) return { rows: [], total: 0, shown: 0 };

  // 表示名を一括取得。取得に失敗した人も user_id で選択できるよう落とさない。
  await guild.members.fetch().catch(() => undefined);
  const shownCycles = cycles.slice(0, TARGETS_PER_MENU * MAX_TARGET_MENUS);
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let offset = 0; offset < shownCycles.length; offset += TARGETS_PER_MENU) {
    const chunk = shownCycles.slice(offset, offset + TARGETS_PER_MENU);
    const index = Math.floor(offset / TARGETS_PER_MENU);
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`eval:target:${index}`)
          .setPlaceholder(index === 0 ? "現在の亡霊から選択" : `現在の亡霊から選択（${index + 1}）`)
          .addOptions(
            chunk.map((cycle) => {
              const member = guild.members.cache.get(cycle.userId);
              const label = (member?.displayName ?? cycle.userId).slice(0, 100);
              const deadline = cycle.deadlineAt ? `期限 ${fmtJstShortDate(cycle.deadlineAt)}` : "期限未設定";
              return { label, value: cycle.userId, description: deadline.slice(0, 100) };
            }),
          ),
      ),
    );
  }
  return { rows, total: cycles.length, shown: shownCycles.length };
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
    const menus = await targetMenus(interaction.guild, services);
    if (menus.total === 0) {
      await interaction.reply({ content: "現在、評価期間中の亡霊はいません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const omitted = menus.total - menus.shown;
    await interaction.reply({
      content:
        omitted > 0
          ? `現在の評価対象は ${menus.total}名です。Discordの表示上限のため先頭${menus.shown}名を表示しています。`
          : `現在の評価対象は ${menus.total}名です。対象を選んでください。`,
      components: menus.rows,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.customId.startsWith("eval:target:")) {
    // deploy直後に残った旧 /評価 select を触っても interaction failure にせず新方式へ案内する。
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

  const store = new EvaluationForumStore(services.db);
  const cycle = store.currentCycle(targetId);
  if (!cycle) {
    await interaction.update({
      content: "この人は現在の評価対象ではありません。パネルから一覧を開き直してください。",
      components: [],
    });
    return;
  }

  await interaction.update({ content: "評価フォーラムを確認しています…", components: [] });
  try {
    const thread = await ensureEvaluationThread(interaction.guild, services, targetId);
    await interaction.editReply({
      content: thread
        ? `評価フォーラムを開きました: ${thread.toString()}\n以降はフォーラムへ通常のDiscordメッセージとして自由に評価を書いてください。`
        : "評価フォーラムを作成できませんでした。`channel:eval_forum` の設定を確認してください。",
      components: [],
    });
  } catch (error) {
    await interaction.editReply({
      content: `評価フォーラムを開けませんでした: ${error instanceof Error ? error.message : String(error)}`,
      components: [],
    });
  }
}

// ---- フォーラム生成・客観情報 ----

export function threadTitleFor(displayName: string, _deadlineTs?: number | null): string {
  const suffix = "｜亡霊評価";
  return `${displayName.slice(0, Math.max(1, 95 - suffix.length))}${suffix}`.slice(0, 95);
}

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
  const displayName = member?.displayName ?? targetId;
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
  const expectedName = threadTitleFor(member?.displayName ?? targetId);
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
  const content = await starterContent(guild, services, targetId);
  if (!content) return null;
  const thread = await forum.threads.create({
    name: threadTitleFor(member?.displayName ?? targetId),
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

export const evaluationForumThresholdsForTesting = {
  denLowSeconds: DEN_LOW_SECONDS,
  swordsmanLowSeconds: SWORDSMAN_LOW_SECONDS,
};
