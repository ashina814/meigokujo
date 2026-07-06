import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type TextChannel,
  type VoiceState,
} from "discord.js";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { jstNow } from "../scheduler.js";
import type { Services } from "../services.js";

// ---- パネル ----

export function entryPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("🚪 冥獄城 入城案内")
    .setDescription(
      [
        "**説明会場VCのどれかに入って**お待ちください。担当が来たら順番に面接します（時間の予約は不要です）。",
        "先に下のボタンで「誰の招待で来たか」を登録しておくとスムーズです（任意）。",
      ].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:book").setLabel("招待経路を登録する").setEmoji("🚪").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

// ---- 招待経路の登録（トラッキング用。時間予約はしない）----

function inviterStep() {
  const select = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId("entry:invsel").setPlaceholder("招待してくれた人を選ぶ"),
  );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:inv:disboard").setLabel("ディスボードから来た").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("entry:inv:none").setLabel("招待者なし・その他").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: "誰かの招待で来ましたか？（分かる範囲でOK・任意）",
    components: [select, buttons],
    embeds: [],
  };
}

export async function handleEntryButton(
  interaction: ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = interaction.customId;
  const userId = interaction.user.id;

  if (id === "entry:book" && interaction.isButton()) {
    await interaction.reply({ ...inviterStep(), flags: MessageFlags.Ephemeral });
    return;
  }

  if (id === "entry:invsel" && interaction.isUserSelectMenu()) {
    const inviterId = interaction.values[0];
    if (!inviterId) {
      await interaction.update({ content: "⌛ 途中で切れました。もう一度パネルからどうぞ。", components: [] });
      return;
    }
    if (inviterId === userId) {
      await interaction.reply({ content: "自分自身は招待者にできません。", flags: MessageFlags.Ephemeral });
      return;
    }
    finalizeBooking(services, userId, "open", { userId: inviterId, source: "user" });
    await interaction.update({ content: `✅ 登録しました（招待者: <@${inviterId}>）。**説明会場VCに入って**お待ちください。`, components: [] });
    return;
  }

  if ((id === "entry:inv:disboard" || id === "entry:inv:none") && interaction.isButton()) {
    const source = id.endsWith("disboard") ? ("disboard" as const) : ("none" as const);
    finalizeBooking(services, userId, "open", { source });
    await interaction.update({ content: "✅ 登録しました。**説明会場VCに入って**お待ちください。", components: [] });
    return;
  }

  if ((id.startsWith("entry:judgehold") || id.startsWith("entry:judgeskip")) && interaction.isUserSelectMenu()) {
    await handleJudgeSelect(interaction, services);
    return;
  }

  if (id.startsWith("entry:pass") && interaction.isButton()) {
    await handlePassButton(interaction, services);
  }
}

function finalizeBooking(
  services: Services,
  userId: string,
  slot: string,
  inviter: { userId?: string; source: "user" | "disboard" | "none" },
): void {
  services.entry.recordJoin(userId); // 参加記録が無い既存メンバーの申請にも対応
  services.entry.book(userId, slot, inviter);
}

// ---- 参加時の自動処理 ----

export async function handleMemberJoin(member: GuildMember, services: Services): Promise<void> {
  if (member.user.bot) return;
  services.entry.recordJoin(member.id);

  const waitRoleId = services.settings.getString("role:queue_wait");
  if (waitRoleId)
    await member.roles
      .add(waitRoleId)
      .catch((e) => console.warn(`[entry] 入城待ちロール付与に失敗（ボットのロールを階級より上へ）: ${(e as Error).message}`));

  const guideId = services.settings.getString("channel:entry_guide");
  if (guideId) {
    const channel = (await member.client.channels.fetch(guideId).catch(() => null)) as TextChannel | null;
    await channel
      ?.send(`👻 <@${member.id}> ようこそ冥獄城へ。上の案内パネルから説明会を予約してください。`)
      .catch(() => undefined);
  }
}

// ---- 出席の自動記録（voiceState）----

export function handleVoiceAttendance(
  _old: VoiceState,
  next: VoiceState,
  services: Services,
): void {
  if (!next.channelId || next.member?.user.bot) return;
  const sessionVcIds = [
    services.settings.getString("channel:session_vc"),
    services.settings.getString("channel:session_vc2"),
  ].filter((v): v is string => !!v);
  if (!sessionVcIds.includes(next.channelId)) return;

  const booking = services.entry.getBooking(next.id);
  if (!booking || booking.status !== "booked") return;

  // 現在時刻が予約枠のウィンドウ（開始5分前〜+60分）に入っているか
  const nowJst = jstNow();
  const candidates = new Set<string>([`${nowJst.dateStr} ${nowJst.hour}`]);
  if (nowJst.minute <= 5) {
    const prev = jstNow(new Date(Date.now() - 3_600_000));
    candidates.add(`${prev.dateStr} ${prev.hour}`);
  }
  if (nowJst.minute >= 55) {
    const nextH = jstNow(new Date(Date.now() + 3_600_000));
    candidates.add(`${nextH.dateStr} ${nextH.hour}`);
  }
  if (candidates.has(booking.slot)) {
    if (services.entry.markAttended(next.id)) {
      console.log(`[entry] 出席記録: ${next.id} (${booking.slot})`);
    }
  }
}

// ---- 判定（/審判）----

export const sessionCommand = new SlashCommandBuilder()
  .setName("審判")
  .setDescription("説明会の判定と昇格（面接担当・魔剣士・審・運営）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName("判定").setDescription("いま説明会VCにいる案内待ちの人を確認して一括で亡霊にする"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("昇格")
      .setDescription("面談合格者を魔人に昇格させる（審・運営）")
      .addUserOption((o) => o.setName("対象").setDescription("昇格させる亡霊").setRequired(true)),
  );

/** 審判を使えるのは 運営 / 面接担当 / 魔剣士 / 審 のいずれか */
const JUDGE_ROLE_KINDS = ["judge", "swordsman", "shin"] as const;
function isJudge(
  interaction: ChatInputCommandInteraction | ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  const member = interaction.member as GuildMember | null;
  if (!member) return false;
  return JUDGE_ROLE_KINDS.some((kind) => {
    const rid = services.settings.getString(`role:${kind}`);
    return rid ? member.roles.cache.has(rid) : false;
  });
}

/** いま説明会VC(1・2)にいる「案内待ち」のメンバーIDを集める */
async function presentWaiters(guild: Guild, services: Services): Promise<string[]> {
  const vcIds = [
    services.settings.getString("channel:session_vc"),
    services.settings.getString("channel:session_vc2"),
  ].filter((v): v is string => !!v);
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ids = new Set<string>();
  for (const vcId of vcIds) {
    const ch = await guild.channels.fetch(vcId).catch(() => null);
    if (!ch || !ch.isVoiceBased()) continue;
    for (const [, m] of ch.members) {
      if (m.user.bot) continue;
      const soul = services.entry.getSoul(m.id);
      // すでに階級が付いた人（亡霊/魔人等）は対象外。案内待ちロール or waiting の魂だけ
      if (soul && soul.status !== "waiting") continue;
      const hasWait = waitRoleId ? m.roles.cache.has(waitRoleId) : false;
      if (hasWait || soul?.status === "waiting") ids.add(m.id);
    }
  }
  return [...ids];
}

export async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当（運営・面接担当・魔剣士・審）の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 判定のみ（昇格は index 側で handlePromote に振り分け）
  const guild = interaction.guild!;
  const present = await presentWaiters(guild, services);
  if (present.length === 0) {
    await interaction.reply({
      content: "いま説明会場VCに案内待ちの人がいません。（`/設定 チャンネル 種別:説明会場VC` で対応VCを設定してください）",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  judgeState.set(interaction.user.id, { present, hold: new Set(), skip: new Set() });
  await interaction.reply({ ...renderJudgment(services, interaction.user.id), flags: MessageFlags.Ephemeral });
}

// ---- 判定UI: 保留/見送りの個別例外 ----

interface JudgeSel {
  present: string[]; // /審判 判定 実行時にVCにいた案内待ちのスナップショット
  hold: Set<string>; // 保留＝今回は通さない（案内待ちのまま。次回の判定で再度出る）
  skip: Set<string>; // 見送り＝案内待ちから外す（亡霊化しない）
}
const judgeState = new Map<string, JudgeSel>(); // key = 判定者のユーザーID

/** 判定メッセージ（今VCにいる案内待ち + 保留/見送りの選択UI）を組み立てる */
function renderJudgment(_services: Services, judgeId: string) {
  const st = judgeState.get(judgeId) ?? { present: [], hold: new Set<string>(), skip: new Set<string>() };
  const toGhost = st.present.filter((id) => !st.hold.has(id) && !st.skip.has(id));

  const line = (ids: string[]) => (ids.length > 0 ? ids.map((id) => `・<@${id}>`).join("\n") : "（なし）");
  const embed = new EmbedBuilder()
    .setTitle("⚖️ 説明会の判定（今VCにいる案内待ち）")
    .setColor(0x6b21a8)
    .setDescription(
      [
        `**亡霊にする ${toGhost.length}名**:`,
        line(toGhost),
        "",
        st.hold.size > 0 ? `⏸ **保留 ${st.hold.size}名**（今回は通さない・案内待ちのまま）:\n${line([...st.hold])}\n` : "",
        st.skip.size > 0 ? `🚫 **見送り ${st.skip.size}名**（案内待ちから外す）:\n${line([...st.skip])}\n` : "",
      ]
        .filter((s) => s !== "")
        .join("\n"),
    );

  const max = Math.min(25, Math.max(1, st.present.length));
  const rows: ActionRowBuilder<UserSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId("entry:judgehold").setPlaceholder("⏸ 保留にする人（今回通さない）").setMinValues(0).setMaxValues(max),
    ),
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId("entry:judgeskip").setPlaceholder("🚫 見送りにする人（案内待ちから外す）").setMinValues(0).setMaxValues(max),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("entry:pass").setLabel(`${toGhost.length}名を亡霊にする`).setStyle(ButtonStyle.Success).setDisabled(toGhost.length === 0),
    ),
  ];
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/** 保留/見送りの選択を反映してメッセージを更新 */
async function handleJudgeSelect(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const kind = interaction.customId.split(":")[1]; // judgehold | judgeskip
  const sel = judgeState.get(interaction.user.id);
  if (!sel) {
    await interaction.update({ content: "⌛ この判定は期限切れです。`/審判 判定` からやり直してください。", components: [], embeds: [] });
    return;
  }
  const picked = new Set(interaction.values);
  if (kind === "judgehold") {
    sel.hold = picked;
    for (const id of picked) sel.skip.delete(id); // 保留に入れたら見送りからは外す
  } else {
    sel.skip = picked;
    for (const id of picked) sel.hold.delete(id);
  }
  judgeState.set(interaction.user.id, sel);
  await interaction.update(renderJudgment(services, interaction.user.id));
}

async function handlePassButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const actor = `user:${interaction.user.id}`;
  const sel = judgeState.get(interaction.user.id);
  if (!sel) {
    await interaction.update({ content: "⌛ この判定は期限切れです。`/審判 判定` からやり直してください。", components: [], embeds: [] });
    return;
  }
  await interaction.update({ content: "⏳ 判定を実行中…", embeds: [], components: [] });

  const guild = interaction.guild!;
  const toGhost = sel.present.filter((id) => !sel.hold.has(id) && !sel.skip.has(id));
  const skipped = sel.present.filter((id) => sel.skip.has(id));

  // 見送り: 案内待ちロールを外してキューから除外（亡霊化しない）
  const waitRoleId = services.settings.getString("role:queue_wait");
  for (const id of skipped) {
    services.entry.skipBooking(id, actor);
    if (waitRoleId) {
      const m = await guild.members.fetch(id).catch(() => null);
      await m?.roles.remove(waitRoleId).catch(() => undefined);
    }
  }

  const passed: string[] = [];
  const failed: string[] = [];
  let totalGranted = 0;
  for (const id of toGhost) {
    const r = await ghostifyOne(guild, services, id, actor);
    if (r.ok) {
      totalGranted += r.granted;
      passed.push(id);
    } else failed.push(id);
  }

  judgeState.delete(interaction.user.id);

  const lines = [
    `✅ **${passed.length}名** を亡霊にしました（初期発行 計 ${fmtLd(totalGranted)}）。`,
    failed.length > 0 ? `❌ 失敗: ${failed.map((id) => `<@${id}>`).join(", ")}` : "",
    sel.hold.size > 0 ? `⏸ 保留（案内待ちのまま）: ${sel.hold.size}名` : "",
    skipped.length > 0 ? `🚫 見送り（案内待ちから除外）: ${skipped.map((id) => `<@${id}>`).join(", ")}` : "",
  ].filter(Boolean);
  await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
}

// ---- 亡霊化（1人分の共通処理: 判定バッチ・時間外チケット両方から使う）----

async function ghostifyOne(
  guild: Guild,
  services: Services,
  userId: string,
  actor: string,
): Promise<{ ok: boolean; granted: number }> {
  try {
    const member = await guild.members.fetch(userId);
    const maleRoleId = services.settings.getString("role:male");
    const femaleRoleId = services.settings.getString("role:female");
    const gender =
      maleRoleId && member.roles.cache.has(maleRoleId)
        ? ("male" as const)
        : femaleRoleId && member.roles.cache.has(femaleRoleId)
          ? ("female" as const)
          : null;
    const result = services.entry.ghostify(userId, actor, { inviteeGender: gender });
    const waitRoleId = services.settings.getString("role:queue_wait");
    const ghostRoleId = services.settings.getString("role:ghost");
    if (waitRoleId) await member.roles.remove(waitRoleId).catch(() => undefined);
    if (ghostRoleId) await member.roles.add(ghostRoleId).catch(() => undefined);
    return { ok: true, granted: result.granted };
  } catch (e) {
    console.error(`[entry] 亡霊化失敗 ${userId}:`, e);
    return { ok: false, granted: 0 };
  }
}

// ---- （時間外チケット機能は 2026-07-06 廃止。判定は「今VCにいる案内待ち」ベースに一本化）----
