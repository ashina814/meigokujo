import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
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
    .setColor(0x6b21a8)
    .addFields(
      {
        name: "📅 説明会の時間",
        value: [
          "**月・木を除く 21時 / 22時 / 23時** に開催しています。",
          "開始 **30分前** と **5分前** にこのチャンネルでお知らせします。",
        ].join("\n"),
      },
      {
        name: "🎯 参加の流れ",
        value: [
          "時間になったら **説明会場VC** に入って担当をお待ちください。",
          "招待リンク経由で来た方は **自動的に招待者が記録** されるので、追加操作は不要です。",
        ].join("\n"),
      },
      {
        name: "🚪 招待経路を登録（自動検出できなかった方向け）",
        value: [
          "ディスボード・ルミナ経由で来た方や、招待者を手動で指定したい方は下のボタンから登録できます。",
          "自動検出済みの方はこのボタンを押す必要はありません。",
        ].join("\n"),
      },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:book").setLabel("招待経路を登録する").setEmoji("🚪").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

/** 時間外・個別希望の単独パネル */
export function entryFlexPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("⏰ 時間外・個別希望 受付")
    .setColor(0xdb2777)
    .setDescription(
      [
        "**月・木を除く 21/22/23時** の説明会に来られない方は、こちらから個別希望を出せます。",
        "ボタンを押すと、あなたとスタッフだけの非公開スレッドが開きます。都合のいい時間帯を書いてください。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:flex").setLabel("時間外・個別希望を出す").setEmoji("⏰").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

// ---- 招待経路の登録（トラッキング用。時間予約はしない）----

/** 招待経路 入力UI（案内パネル・DM・審判の代打入力で共用） */
function inviterStep() {
  const select = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId("entry:invsel").setPlaceholder("招待してくれた人を選ぶ"),
  );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:inv:disboard").setLabel("ディスボード").setEmoji("🅱").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("entry:inv:lumina").setLabel("ルミナ").setEmoji("✨").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("entry:inv:none").setLabel("その他（誰の招待でもない）").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: "**誰かの招待で来ましたか？** どれか1つ選んで押してください（必ずお願いします）。",
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

  if (id === "entry:flex" && interaction.isButton()) {
    await openFlexTicket(interaction, services, userId);
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

  if (
    (id === "entry:inv:disboard" || id === "entry:inv:lumina" || id === "entry:inv:none") &&
    interaction.isButton()
  ) {
    const source = id.endsWith("disboard")
      ? ("disboard" as const)
      : id.endsWith("lumina")
        ? ("lumina" as const)
        : ("none" as const);
    finalizeBooking(services, userId, "open", { source });
    await interaction.update({ content: "✅ 登録しました。**説明会場VCに入って**お待ちください。", components: [] });
    return;
  }

  if (id.startsWith("entry:judgehold") && interaction.isUserSelectMenu()) {
    await handleJudgeSelect(interaction, services);
    return;
  }

  if (id.startsWith("entry:pass") && interaction.isButton()) {
    await handlePassButton(interaction, services);
    return;
  }

  if (id === "entry:invremind" && interaction.isButton()) {
    await handleInviteRemind(interaction, services);
  }
}

function finalizeBooking(
  services: Services,
  userId: string,
  slot: string,
  inviter: { userId?: string; source: "user" | "disboard" | "lumina" | "none" },
): void {
  services.entry.recordJoin(userId); // 参加記録が無い既存メンバーの申請にも対応
  services.entry.book(userId, slot, inviter);
}

// ---- 参加時の自動処理 ----

export async function handleMemberJoin(
  member: GuildMember,
  services: Services,
  inviterId?: string | null,
): Promise<void> {
  if (member.user.bot) return;
  services.entry.recordJoin(member.id);

  const waitRoleId = services.settings.getString("role:queue_wait");
  if (waitRoleId)
    await member.roles
      .add(waitRoleId)
      .catch((e) => console.warn(`[entry] 入城待ちロール付与に失敗（ボットのロールを階級より上へ）: ${(e as Error).message}`));

  // 招待リンクから招待者を自動記録
  if (inviterId && inviterId !== member.id) {
    finalizeBooking(services, member.id, "open", { userId: inviterId, source: "user" });
    console.log(`[invite] 自動検出: ${member.id} は ${inviterId} の招待リンクで入城`);
  }

  // 入城案内chで本人メンション + パネル誘導（DMは使わない）
  const guideId = services.settings.getString("channel:entry_guide");
  if (guideId) {
    const channel = (await member.client.channels.fetch(guideId).catch(() => null)) as TextChannel | null;
    const invLine =
      inviterId && inviterId !== member.id
        ? `**招待者を自動検出しました**（<@${inviterId}> の招待リンク）。追加の登録は不要です。`
        : "**上の案内パネル**から「招待経路を登録する（必須）」を押してから来てください。";
    await channel
      ?.send({
        content: [
          `👻 <@${member.id}> ようこそ冥獄城へ。`,
          invLine,
          "説明会は **月・木を除く 21/22/23 時** です（30分前と5分前にこのチャンネルで案内します）。**説明会場VC**でお待ちください。",
        ].join("\n"),
        allowedMentions: { users: [member.id] },
      })
      .catch(() => undefined);
  }
}

// ---- ロール変更検知: 亡霊ロールが手動付与された時にghostify・性別ロール後付けで招待延長 ----

export async function handleMemberRoleUpdate(
  oldMember: GuildMember,
  newMember: GuildMember,
  services: Services,
): Promise<void> {
  if (newMember.user.bot) return;
  const before = oldMember.roles.cache;
  const after = newMember.roles.cache;
  const added = after.filter((r) => !before.has(r.id));
  const removed = before.filter((r) => !after.has(r.id));

  const ghostRoleId = services.settings.getString("role:ghost");
  const maleRoleId = services.settings.getString("role:male");
  const femaleRoleId = services.settings.getString("role:female");
  const majinRoleId = services.settings.getString("role:majin");
  const mazokuRoleId = services.settings.getString("role:mazoku");
  const meireiRoleId = services.settings.getString("role:meirei");
  const waitRoleId = services.settings.getString("role:queue_wait");

  // ① 亡霊ロールが手動付与された → ghostify（冪等）
  if (added.size > 0 && ghostRoleId && added.has(ghostRoleId)) {
    const soul = services.entry.getSoul(newMember.id);
    if (!soul || soul.status !== "ghost") {
      const r = await ghostifyOne(newMember.guild, services, newMember.id, "system:role-add");
      if (r.ok) console.log(`[entry] 亡霊ロール手動付与検知 → ghostify: ${newMember.id}`);
    }
  }

  // ② 性別ロールが後付けされた → 招待延長を後追い適用
  if (added.size > 0 && maleRoleId && added.has(maleRoleId)) {
    const ext = services.entry.applyInviteeGenderExtension(newMember.id, "male");
    if (ext > 0) console.log(`[entry] 後追い招待延長(男): +${ext}日 for ${newMember.id}`);
  }
  if (added.size > 0 && femaleRoleId && added.has(femaleRoleId)) {
    const ext = services.entry.applyInviteeGenderExtension(newMember.id, "female");
    if (ext > 0) console.log(`[entry] 後追い招待延長(女): +${ext}日 for ${newMember.id}`);
  }

  // ③ 亡霊ロールが剥奪された（他の階級ロールが同時に付いていない）→ 案内待ちにリセット
  if (removed.size > 0 && ghostRoleId && removed.has(ghostRoleId)) {
    const hasOther =
      (majinRoleId && after.has(majinRoleId)) ||
      (mazokuRoleId && after.has(mazokuRoleId)) ||
      (meireiRoleId && after.has(meireiRoleId));
    if (!hasOther) {
      services.entry.resetToWaiting(newMember.id, "system:role-remove");
      if (waitRoleId) await newMember.roles.add(waitRoleId).catch(() => undefined);
      console.log(`[entry] 亡霊ロール剥奪 → 案内待ちにリセット: ${newMember.id}`);
    }
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
const JUDGE_ROLE_KINDS = ["judge", "judge_lead", "judge_extra"] as const;
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

/**
 * いま説明会VC(1・2)にいる「案内待ち」のメンバーIDを集める。
 * ロール優先: 案内待ちロール保持者は対象。魂がghost等でズレていた場合は自動修復する。
 * ロール無しでも魂が waiting なら対象（ロール付与失敗の救済）。
 * 案内待ちロール保持でも高階級ロール(魔族/魔人/迷霊)がある場合は対象外（誤操作防止）。
 */
async function presentWaiters(guild: Guild, services: Services): Promise<string[]> {
  const vcIds = [
    services.settings.getString("channel:session_vc"),
    services.settings.getString("channel:session_vc2"),
  ].filter((v): v is string => !!v);
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ghostRoleId = services.settings.getString("role:ghost");
  const majinRoleId = services.settings.getString("role:majin");
  const mazokuRoleId = services.settings.getString("role:mazoku");
  const meireiRoleId = services.settings.getString("role:meirei");
  const ids = new Set<string>();
  for (const vcId of vcIds) {
    const ch = await guild.channels.fetch(vcId).catch(() => null);
    if (!ch || !ch.isVoiceBased()) continue;
    for (const [, m] of ch.members) {
      if (m.user.bot) continue;
      const roles = m.roles.cache;
      const hasWait = !!(waitRoleId && roles.has(waitRoleId));
      const hasGhost = !!(ghostRoleId && roles.has(ghostRoleId));
      const hasHigher =
        (majinRoleId && roles.has(majinRoleId)) ||
        (mazokuRoleId && roles.has(mazokuRoleId)) ||
        (meireiRoleId && roles.has(meireiRoleId));
      if (hasHigher || hasGhost) continue; // 亡霊以上は判定対象外
      const soul = services.entry.getSoul(m.id);
      if (hasWait) {
        // 案内待ちロール保持者は対象。魂とのズレを見つけたら修復
        if (soul && soul.status !== "waiting") {
          services.entry.resetToWaiting(m.id, "system:role-sync");
          console.log(`[entry] 魂のズレを修復: ${m.id} (${soul.status} → waiting、案内待ちロール保持のため)`);
        }
        ids.add(m.id);
        continue;
      }
      // ロール無しでも魂が waiting なら救済
      if (soul?.status === "waiting") ids.add(m.id);
    }
  }
  return [...ids];
}

export async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番（運営・門番・門番統括）の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 判定のみ（昇格は index 側で handlePromote に振り分け）
  const guild = interaction.guild!;
  const vc1 = services.settings.getString("channel:session_vc");
  const vc2 = services.settings.getString("channel:session_vc2");
  if (!vc1 && !vc2) {
    await interaction.reply({
      content: "説明会場VCが未設定です。`/設定 チャンネル 種別:説明会場VC` で登録してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const present = await presentWaiters(guild, services);
  if (present.length === 0) {
    const vcMentions = [vc1, vc2].filter(Boolean).map((id) => `<#${id}>`).join(" / ");
    await interaction.reply({
      content: [
        `いま ${vcMentions} に「案内待ち」の人がいません。`,
        "（対象は **入城案内待ちロール保持者** か **魂の状態が waiting** の人だけ。既に亡霊/魔人などになっている人は対象外です）",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // 招待経路の登録有無で切り分け（未登録者は判定対象から外し、DM催促の対象にする）
  const ready: string[] = [];
  const missing: string[] = [];
  for (const uid of present) {
    const booking = services.entry.getBooking(uid);
    if (booking && booking.inviter_source) ready.push(uid);
    else missing.push(uid);
  }
  judgeState.set(interaction.user.id, { present: ready, missing, hold: new Set() });
  await interaction.reply({ ...renderJudgment(services, interaction.user.id), flags: MessageFlags.Ephemeral });
}

// ---- 判定UI: 保留/合格/招待未登録 ----

interface JudgeSel {
  present: string[]; // 招待経路登録済み・判定対象
  missing: string[]; // 招待経路が未登録・判定不可（DM催促の対象）
  hold: Set<string>; // 保留＝今回は通さない（案内待ちのまま。次回の判定で再度出る）
}
const judgeState = new Map<string, JudgeSel>(); // key = 判定者のユーザーID

/** 判定メッセージ（今VCにいる案内待ち + 保留の選択UI）を組み立てる */
function renderJudgment(_services: Services, judgeId: string) {
  const st = judgeState.get(judgeId) ?? ({ present: [], missing: [], hold: new Set<string>() } as JudgeSel);
  const toGhost = st.present.filter((id) => !st.hold.has(id));

  const line = (ids: string[]) => (ids.length > 0 ? ids.map((id) => `・<@${id}>`).join("\n") : "（なし）");
  const embed = new EmbedBuilder()
    .setTitle("⚖️ 説明会の判定（今VCにいる案内待ち）")
    .setColor(0x6b21a8)
    .setDescription(
      [
        `**合格→亡霊にする ${toGhost.length}名**:`,
        line(toGhost),
        "",
        st.hold.size > 0 ? `⏸ **保留 ${st.hold.size}名**（今回は通さない・案内待ちのまま）:\n${line([...st.hold])}\n` : "",
        st.missing.length > 0
          ? `⚠️ **招待経路 未登録 ${st.missing.length}名**（判定不可・下のボタンで催促）:\n${line(st.missing)}\n`
          : "",
      ]
        .filter((s) => s !== "")
        .join("\n"),
    );

  const max = Math.min(25, Math.max(1, st.present.length));
  const rows: ActionRowBuilder<UserSelectMenuBuilder | ButtonBuilder>[] = [];
  if (st.present.length > 0) {
    rows.push(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId("entry:judgehold").setPlaceholder("⏸ 保留にする人（今回通さない）").setMinValues(0).setMaxValues(max),
      ),
    );
  }
  const bottom = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:pass").setLabel(`${toGhost.length}名を合格（亡霊化）`).setStyle(ButtonStyle.Success).setDisabled(toGhost.length === 0),
  );
  if (st.missing.length > 0) {
    bottom.addComponents(
      new ButtonBuilder().setCustomId("entry:invremind").setLabel(`⚠️ ${st.missing.length}名に招待経路を催促`).setStyle(ButtonStyle.Secondary),
    );
  }
  rows.push(bottom);
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/** 招待未登録者を入城案内chでメンション催促する */
async function handleInviteRemind(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sel = judgeState.get(interaction.user.id);
  if (!sel || sel.missing.length === 0) {
    await interaction.reply({ content: "催促する対象がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guideId = services.settings.getString("channel:entry_guide");
  if (!guideId) {
    await interaction.editReply({ content: "入城案内チャンネルが未設定です。`/設定 チャンネル 種別:入城案内` で設定してください。" });
    return;
  }
  const guide = (await interaction.client.channels.fetch(guideId).catch(() => null)) as TextChannel | null;
  if (!guide?.isTextBased()) {
    await interaction.editReply({ content: "入城案内チャンネルが見つかりません。" });
    return;
  }
  const mentions = sel.missing.map((id) => `<@${id}>`).join(" ");
  await guide
    .send({
      content: `📮 ${mentions}\n判定を進めるため、**上の案内パネル**から「招待経路を登録する」を押してください（必須）。`,
      allowedMentions: { users: sel.missing },
    })
    .catch(() => undefined);
  await interaction.editReply({
    content: `📨 入城案内チャンネルで **${sel.missing.length}名** に催促しました。`,
    allowedMentions: { parse: [] },
  });
}

/** 保留の選択を反映してメッセージを更新 */
async function handleJudgeSelect(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sel = judgeState.get(interaction.user.id);
  if (!sel) {
    await interaction.update({ content: "⌛ この判定は期限切れです。`/審判 判定` からやり直してください。", components: [], embeds: [] });
    return;
  }
  sel.hold = new Set(interaction.values);
  judgeState.set(interaction.user.id, sel);
  await interaction.update(renderJudgment(services, interaction.user.id));
}

async function handlePassButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には門番の権限が必要です。", flags: MessageFlags.Ephemeral });
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
  const toGhost = sel.present.filter((id) => !sel.hold.has(id));

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
    `✅ **${passed.length}名** を合格→亡霊にしました（初期発行 計 ${fmtLd(totalGranted)}）。`,
    failed.length > 0 ? `❌ 失敗: ${failed.map((id) => `<@${id}>`).join(", ")}` : "",
    sel.hold.size > 0 ? `⏸ 保留（案内待ちのまま）: ${sel.hold.size}名` : "",
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

    // 招待者への波及処理: 称号評価 + 招待による昇格印の閾値到達チェック
    const inviteeSoul = services.entry.getSoul(userId);
    const inviterId = inviteeSoul?.inviter_user_id;
    if (inviterId) {
      // 称号評価（勧誘者・冥獄の伝道師）
      const newlyGranted = services.titles.evaluate(inviterId);
      if (newlyGranted.length > 0) {
        const inviter = await guild.members.fetch(inviterId).catch(() => null);
        await inviter
          ?.send(
            `🎉 <@${userId}> さんを招待した実績で新たな称号を獲得しました:\n${newlyGranted.map((t) => `${t.emoji} **${t.name}** — ${t.desc}`).join("\n")}`,
          )
          .catch(() => undefined);
      }
      // 招待による昇格印スコアが閾値に達したか（招待者が亡霊で評価期間中の場合のみ）
      await checkInvitePromotion(guild, services, inviterId).catch((e) =>
        console.error(`[entry] 招待昇格チェック失敗 ${inviterId}:`, e),
      );
    }
    return { ok: true, granted: result.granted };
  } catch (e) {
    console.error(`[entry] 亡霊化失敗 ${userId}:`, e);
    return { ok: false, granted: 0 };
  }
}

/**
 * 招待による昇格印スコアが閾値に到達したかチェック（招待者が亡霊のみ対象）。
 * 到達していたら面談待ちロールを付与し、集令チャンネルで審に通知する。
 * 冪等: 既に面談待ちロールを持っていれば何もしない。
 */
async function checkInvitePromotion(guild: Guild, services: Services, inviterId: string): Promise<void> {
  const soul = services.entry.getSoul(inviterId);
  if (!soul || soul.status !== "ghost") return; // 亡霊以外は昇格対象外
  const score = services.evaluation.promotionScore(inviterId);
  const required = services.settings.getNumber("promotion_marks_required");
  if (score.total < required) return;

  const member = await guild.members.fetch(inviterId).catch(() => null);
  if (!member) return;
  const mendanRoleId = services.settings.getString("role:mendan");
  if (mendanRoleId && member.roles.cache.has(mendanRoleId)) return; // 既に面談待ちなら通知しない
  if (mendanRoleId) await member.roles.add(mendanRoleId).catch(() => undefined);

  // 昇格面談呼び出し: channel:promotion_call（未設定なら channel:shurei にフォールバック）
  const callChId =
    services.settings.getString("channel:promotion_call") ?? services.settings.getString("channel:shurei");
  const shinRoleId = services.settings.getString("role:shin");
  if (callChId) {
    const channel = await guild.client.channels.fetch(callChId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await channel
        .send(
          `⚔️ ${shinRoleId ? `<@&${shinRoleId}> ` : ""}<@${inviterId}> の昇格印が **${score.total}/${required}** に到達しました（評価${score.evalMarks} + 招待${score.inviteScore}）。昇格面談をお願いします。`,
        )
        .catch(() => undefined);
    }
  }
  await member.send(`🎉 招待実績で昇格印が **${score.total}/${required}** に到達しました。面談待ちロールが付き、審に通知されました。`).catch(() => undefined);
  console.log(`[entry] 招待経由で面談待ち到達: ${inviterId} (score=${score.total})`);
}

// ---- 時間外・個別希望: チケット（非公開スレッド）で柔軟に面接 ----

async function openFlexTicket(
  interaction: ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
  userId: string,
): Promise<void> {
  const guild = interaction.guild!;
  const guideId = services.settings.getString("channel:entry_guide");
  const guide = guideId ? await guild.channels.fetch(guideId).catch(() => null) : null;
  const base = (guide?.isTextBased() ? guide : interaction.channel) as TextChannel | null;
  if (!base || !("threads" in base)) {
    await interaction.reply({
      content: "✅ 時間外希望を受け付けました。スタッフから個別に連絡します。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const member = await guild.members.fetch(userId).catch(() => null);
  const thread = await base.threads
    .create({
      name: `時間外希望-${member?.displayName ?? "案内待ち"}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    })
    .catch(() => null);
  if (!thread) {
    await interaction.reply({
      content: "✅ 時間外希望を受け付けました。スタッフから連絡します。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await thread.members.add(userId).catch(() => undefined);

  // 門番（judge/lead/extra）と運営のロールが付いていれば全て呼ぶ
  const judgeRoleIds = ["judge", "judge_lead", "judge_extra"]
    .map((k) => services.settings.getString(`role:${k}`))
    .filter((v): v is string => !!v);
  const adminRoleId = services.settings.getString("role:admin");
  const rolesToPing = [...new Set([...judgeRoleIds, ...(adminRoleId ? [adminRoleId] : [])])];

  await thread
    .send({
      content: [
        `${rolesToPing.map((r) => `<@&${r}>`).join(" ")} <@${userId}> さんの**時間外・個別希望**です。`,
        "**都合のいい曜日・時間帯**を書いてください。門番が合わせて調整します。",
        "調整した時間に本人が **説明会場VC** に来たら、通常通り `/審判 判定` で合格にしてください。",
      ].join("\n"),
      allowedMentions: { users: [userId], roles: rolesToPing },
    })
    .catch(() => undefined);

  await interaction.reply({
    content: `✅ 時間外の受付を作りました → ${thread.toString()}\nそちらで門番と時間を決めてください。`,
    flags: MessageFlags.Ephemeral,
  });
}
