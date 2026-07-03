import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
  type GuildMember,
  type MessageCreateOptions,
  type TextChannel,
  type VoiceState,
} from "discord.js";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import { jstNow } from "../scheduler.js";
import type { Services } from "../services.js";

const SESSION_HOURS = [21, 22, 23] as const;

// ---- パネル ----

export function entryPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("🚪 冥獄城 入城案内")
    .setDescription(
      [
        "説明会は毎日 **21時 / 22時 / 23時** に開催されます。",
        "下のボタンから枠を予約してください（応答はあなたにだけ表示されます）。",
        "決まった時間に来られない方は「時間外・個別希望」からどうぞ。",
      ].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:book").setLabel("説明会を予約する").setEmoji("🚪").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("entry:flex").setLabel("時間外・個別希望").setEmoji("⏰").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

// ---- 予約フロー（枠選択 → 招待者 → 確定）----

/** 予約途中の状態（確定まで金銭・DBは動かないため、消えても再操作でOK） */
const pendingSlots = new Map<string, string>();

function slotLabel(slot: string): string {
  if (slot === "flex") return "時間外・個別希望";
  const [date, hour] = slot.split(" ");
  const [, m, d] = (date ?? "").split("-");
  return `${Number(m)}/${Number(d)} ${hour}時`;
}

function buildSlotOptions(): { label: string; value: string }[] {
  const nowJst = jstNow();
  const options: { label: string; value: string }[] = [];
  for (const dayOffset of [0, 1]) {
    const target = jstNow(new Date(Date.now() + dayOffset * 86_400_000));
    for (const hour of SESSION_HOURS) {
      // 開始10分前を過ぎた今日の枠は出さない
      if (dayOffset === 0 && (nowJst.hour > hour || (nowJst.hour === hour && nowJst.minute > 50))) continue;
      const value = `${target.dateStr} ${hour}`;
      options.push({ label: `${dayOffset === 0 ? "今日" : "明日"} ${hour}時`, value });
    }
  }
  return options;
}

function inviterStep(slot: string) {
  const select = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId("entry:invsel").setPlaceholder("招待してくれた人を選ぶ"),
  );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("entry:inv:disboard").setLabel("ディスボードから来た").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("entry:inv:none").setLabel("招待者なし・その他").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `📅 **${slotLabel(slot)}** ですね。最後に、誰かの招待で来ましたか？`,
    components: [select, buttons],
    embeds: [],
  };
}

export async function handleEntryButton(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = interaction.customId;
  const userId = interaction.user.id;

  if (id === "entry:book" && interaction.isButton()) {
    const options = buildSlotOptions();
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("entry:slot")
        .setPlaceholder("説明会の枠を選ぶ")
        .addOptions(options.map((o) => ({ label: o.label, value: o.value }))),
    );
    await interaction.reply({
      content: "📅 参加できる説明会の枠を選んでください。",
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (id === "entry:flex" && interaction.isButton()) {
    pendingSlots.set(userId, "flex");
    await interaction.reply({ ...inviterStep("flex"), flags: MessageFlags.Ephemeral });
    return;
  }

  if (id === "entry:slot" && interaction.isStringSelectMenu()) {
    const slot = interaction.values[0];
    if (!slot) return;
    pendingSlots.set(userId, slot);
    await interaction.update(inviterStep(slot));
    return;
  }

  if (id === "entry:invsel" && interaction.isUserSelectMenu()) {
    const inviterId = interaction.values[0];
    const slot = pendingSlots.get(userId);
    if (!slot || !inviterId) {
      await interaction.update({ content: "⌛ 途中で切れました。もう一度パネルからどうぞ。", components: [] });
      return;
    }
    if (inviterId === userId) {
      await interaction.reply({ content: "自分自身は招待者にできません。", flags: MessageFlags.Ephemeral });
      return;
    }
    finalizeBooking(services, userId, slot, { userId: inviterId, source: "user" });
    pendingSlots.delete(userId);
    await interaction.update({
      content: `✅ 予約しました: **${slotLabel(slot)}**（招待者: <@${inviterId}>）\n開始1時間前にお知らせします。`,
      components: [],
    });
    return;
  }

  if ((id === "entry:inv:disboard" || id === "entry:inv:none") && interaction.isButton()) {
    const slot = pendingSlots.get(userId);
    if (!slot) {
      await interaction.update({ content: "⌛ 途中で切れました。もう一度パネルからどうぞ。", components: [] });
      return;
    }
    const source = id.endsWith("disboard") ? ("disboard" as const) : ("none" as const);
    finalizeBooking(services, userId, slot, { source });
    pendingSlots.delete(userId);
    await interaction.update({
      content: `✅ 予約しました: **${slotLabel(slot)}**\n${slot === "flex" ? "スタッフから個別に連絡します。" : "開始1時間前にお知らせします。"}`,
      components: [],
    });
    return;
  }

  if (id.startsWith("entry:pass:") && interaction.isButton()) {
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
  if (waitRoleId) await member.roles.add(waitRoleId).catch((e) => console.error("[entry] ロール付与失敗:", e));

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
  const sessionVcId = services.settings.getString("channel:session_vc");
  if (next.channelId !== sessionVcId) return;

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

// ---- 判定（/説明会）----

export const sessionCommand = new SlashCommandBuilder()
  .setName("説明会")
  .setDescription("説明会の出席確認と判定（面接担当・運営専用）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("判定")
      .setDescription("指定枠の出席者を確認して一括で亡霊にする")
      .addStringOption((o) =>
        o
          .setName("日付")
          .setDescription("開催日")
          .setRequired(true)
          .addChoices({ name: "今日", value: "0" }, { name: "昨日", value: "-1" }),
      )
      .addIntegerOption((o) =>
        o
          .setName("時刻")
          .setDescription("開催時刻")
          .setRequired(true)
          .addChoices(...SESSION_HOURS.map((h) => ({ name: `${h}時`, value: h }))),
      ),
  )
  .addSubcommand((sub) => sub.setName("時間外一覧").setDescription("時間外・個別希望の待機者を表示"));

function isJudge(interaction: ChatInputCommandInteraction | ButtonInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const judgeRoleId = services.settings.getString("role:judge");
  if (!judgeRoleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(judgeRoleId) ?? false;
}

export async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand();

  if (sub === "時間外一覧") {
    const rows = services.entry.listBySlot("flex").slice(0, 25);
    const lines =
      rows.length > 0
        ? rows.map((r) => `・<@${r.user_id}>（欠席 ${r.no_show_count}回）`)
        : ["いません。"];
    await interaction.reply({
      content: `⏰ 時間外・個別希望の待機者:\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const dayOffset = Number(interaction.options.getString("日付", true));
  const hour = interaction.options.getInteger("時刻", true);
  const date = jstNow(new Date(Date.now() + dayOffset * 86_400_000)).dateStr;
  const slot = `${date} ${hour}`;

  const { attended, absent } = services.entry.judgeSlot(slot);
  if (attended.length === 0 && absent.length === 0) {
    await interaction.reply({ content: `${slotLabel(slot)} の予約者はいません。`, flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`⚖️ ${slotLabel(slot)} 説明会の判定`)
    .setDescription(
      [
        `**出席 ${attended.length}名**（[全員を亡霊にする] の対象）:`,
        attended.length > 0 ? attended.map((r) => `・<@${r.user_id}>`).join("\n") : "（なし）",
        "",
        `**欠席 ${absent.length}名**（欠席カウント+1 → 再予約案内）:`,
        absent.length > 0 ? absent.map((r) => `・<@${r.user_id}>（累計${r.no_show_count}回）`).join("\n") : "（なし）",
      ].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`entry:pass:${date}:${hour}`)
      .setLabel(`出席${attended.length}名を亡霊にする`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(attended.length === 0),
  );
  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handlePassButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const slot = `${parts[2]} ${parts[3]}`;
  const actor = `user:${interaction.user.id}`;

  await interaction.update({ content: "⏳ 亡霊化を実行中…", embeds: [], components: [] });

  const { attended, absent } = services.entry.judgeSlot(slot);
  const guild = interaction.guild!;
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ghostRoleId = services.settings.getString("role:ghost");
  const maleRoleId = services.settings.getString("role:male");
  const femaleRoleId = services.settings.getString("role:female");

  const passed: string[] = [];
  const failed: string[] = [];
  let totalGranted = 0;

  for (const row of attended) {
    try {
      const member = await guild.members.fetch(row.user_id);
      const gender = maleRoleId && member.roles.cache.has(maleRoleId)
        ? ("male" as const)
        : femaleRoleId && member.roles.cache.has(femaleRoleId)
          ? ("female" as const)
          : null;
      const result = services.entry.ghostify(row.user_id, actor, { inviteeGender: gender });
      if (waitRoleId) await member.roles.remove(waitRoleId).catch(() => undefined);
      if (ghostRoleId) await member.roles.add(ghostRoleId).catch(() => undefined);
      totalGranted += result.granted;
      passed.push(row.user_id);
    } catch (e) {
      console.error(`[entry] 亡霊化失敗 ${row.user_id}:`, e);
      failed.push(row.user_id);
    }
  }

  const rebook: string[] = [];
  const droppedList: string[] = [];
  for (const row of absent) {
    const r = services.entry.recordNoShow(row.user_id);
    (r.dropped ? droppedList : rebook).push(row.user_id);
  }

  // 欠席者への再予約案内（入城案内チャンネルで本人にだけ分かる形＝メンション）
  const guideId = services.settings.getString("channel:entry_guide");
  if (guideId && rebook.length > 0) {
    const channel = (await guild.client.channels.fetch(guideId).catch(() => null)) as TextChannel | null;
    await channel
      ?.send(
        `📅 ${rebook.map((id) => `<@${id}>`).join(" ")} 説明会に来られなかったようです。パネルからもう一度予約してください。`,
      )
      .catch(() => undefined);
  }

  const lines = [
    `✅ **${passed.length}名** を亡霊にしました（初期発行 計 ${fmtLd(totalGranted)}）。`,
    failed.length > 0 ? `❌ 失敗: ${failed.map((id) => `<@${id}>`).join(", ")}` : "",
    rebook.length > 0 ? `📅 欠席 → 再予約案内: ${rebook.length}名` : "",
    droppedList.length > 0 ? `🚫 3回連続欠席でキューから除外: ${droppedList.map((id) => `<@${id}>`).join(", ")}（対応は運営判断）` : "",
  ].filter(Boolean);
  await interaction.editReply({ content: lines.join("\n") });
}
