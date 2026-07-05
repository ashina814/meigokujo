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

  if ((id.startsWith("entry:judgehold:") || id.startsWith("entry:judgeskip:")) && interaction.isUserSelectMenu()) {
    await handleJudgeSelect(interaction, services);
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

// ---- 判定（/審判）----

export const sessionCommand = new SlashCommandBuilder()
  .setName("審判")
  .setDescription("説明会の判定・担当と昇格（面接担当・審・運営）")
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
  .addSubcommand((sub) =>
    sub
      .setName("担当")
      .setDescription("説明会の担当スタッフを割り当てる（30分前に本人へ通知）")
      .addStringOption((o) =>
        o
          .setName("日付")
          .setDescription("開催日")
          .setRequired(true)
          .addChoices({ name: "今日", value: "0" }, { name: "明日", value: "1" }),
      )
      .addIntegerOption((o) =>
        o
          .setName("時刻")
          .setDescription("開催時刻")
          .setRequired(true)
          .addChoices(...SESSION_HOURS.map((h) => ({ name: `${h}時`, value: h }))),
      )
      .addUserOption((o) => o.setName("担当").setDescription("担当スタッフ").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("時間外一覧").setDescription("時間外・個別希望の待機者を表示"))
  .addSubcommand((sub) =>
    sub
      .setName("昇格")
      .setDescription("面談合格者を魔人に昇格させる（審・運営）")
      .addUserOption((o) => o.setName("対象").setDescription("昇格させる亡霊").setRequired(true)),
  );

function isJudge(
  interaction: ChatInputCommandInteraction | ButtonInteraction | UserSelectMenuInteraction,
  services: Services,
): boolean {
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

  if (sub === "担当") {
    const dayOffset = Number(interaction.options.getString("日付", true));
    const hour = interaction.options.getInteger("時刻", true);
    const staff = interaction.options.getUser("担当", true);
    const date = jstNow(new Date(Date.now() + dayOffset * 86_400_000)).dateStr;
    const slot = `${date} ${hour}`;
    services.settings.set(`entry:staff:${slot}`, staff.id, `user:${interaction.user.id}`);
    await interaction.reply({
      content: `✅ ${slotLabel(slot)} の説明会の担当を <@${staff.id}> にしました（開始30分前に本人へ通知します）。`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

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

  // この判定用の保留/見送り状態をリセットして描画
  judgeState.set(judgeKey(interaction.user.id, slot), { hold: new Set(), skip: new Set() });
  await interaction.reply({ ...renderJudgment(services, slot, interaction.user.id), flags: MessageFlags.Ephemeral });
}

// ---- 判定UI: 保留/見送りの個別例外 ----

interface JudgeSel {
  hold: Set<string>; // 保留＝今回は通さず attended のまま（次回の判定で再度出る）
  skip: Set<string>; // 見送り＝dropped にしてキューから外す（亡霊化しない）
}
const judgeState = new Map<string, JudgeSel>();
const judgeKey = (judgeId: string, slot: string) => `${judgeId}:${slot}`;

/** 判定メッセージ（出席・欠席・保留・見送りの分類 + 選択UI）を組み立てる */
function renderJudgment(services: Services, slot: string, judgeId: string) {
  const [date, hour] = slot.split(" ");
  const { attended, absent } = services.entry.judgeSlot(slot);
  const sel = judgeState.get(judgeKey(judgeId, slot)) ?? { hold: new Set(), skip: new Set() };
  const toGhost = attended.filter((r) => !sel.hold.has(r.user_id) && !sel.skip.has(r.user_id));

  const line = (rows: { user_id: string }[]) => (rows.length > 0 ? rows.map((r) => `・<@${r.user_id}>`).join("\n") : "（なし）");
  const embed = new EmbedBuilder()
    .setTitle(`⚖️ ${slotLabel(slot)} 説明会の判定`)
    .setColor(0x6b21a8)
    .setDescription(
      [
        `**亡霊にする ${toGhost.length}名**:`,
        line(toGhost),
        "",
        sel.hold.size > 0 ? `⏸ **保留 ${sel.hold.size}名**（次回に持ち越し）:\n${line([...sel.hold].map((id) => ({ user_id: id })))}\n` : "",
        sel.skip.size > 0 ? `🚫 **見送り ${sel.skip.size}名**（キューから外す）:\n${line([...sel.skip].map((id) => ({ user_id: id })))}\n` : "",
        `**欠席 ${absent.length}名**（欠席+1 → 再予約案内）:`,
        absent.length > 0 ? absent.map((r) => `・<@${r.user_id}>（累計${r.no_show_count}回）`).join("\n") : "（なし）",
      ]
        .filter((s) => s !== "")
        .join("\n"),
    );

  const rows: ActionRowBuilder<UserSelectMenuBuilder | ButtonBuilder>[] = [];
  if (attended.length > 0) {
    const max = Math.min(25, attended.length);
    rows.push(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId(`entry:judgehold:${date}:${hour}`).setPlaceholder("⏸ 保留にする人（次回持ち越し）").setMinValues(0).setMaxValues(max),
      ),
    );
    rows.push(
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId(`entry:judgeskip:${date}:${hour}`).setPlaceholder("🚫 見送りにする人（今回通さない）").setMinValues(0).setMaxValues(max),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`entry:pass:${date}:${hour}`)
        .setLabel(`${toGhost.length}名を亡霊にする`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(toGhost.length === 0),
    ),
  );
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/** 保留/見送りの選択を反映してメッセージを更新 */
async function handleJudgeSelect(interaction: UserSelectMenuInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":"); // entry:judgehold:date:hour
  const kind = parts[1]; // judgehold | judgeskip
  const slot = `${parts[2]} ${parts[3]}`;
  const key = judgeKey(interaction.user.id, slot);
  const sel = judgeState.get(key) ?? { hold: new Set<string>(), skip: new Set<string>() };
  const picked = new Set(interaction.values);
  if (kind === "judgehold") {
    sel.hold = picked;
    for (const id of picked) sel.skip.delete(id); // 保留に入れたら見送りからは外す
  } else {
    sel.skip = picked;
    for (const id of picked) sel.hold.delete(id);
  }
  judgeState.set(key, sel);
  await interaction.update(renderJudgment(services, slot, interaction.user.id));
}

async function handlePassButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: "この操作には面接担当の権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const parts = interaction.customId.split(":");
  const slot = `${parts[2]} ${parts[3]}`;
  const actor = `user:${interaction.user.id}`;
  const sel = judgeState.get(judgeKey(interaction.user.id, slot)) ?? { hold: new Set<string>(), skip: new Set<string>() };

  await interaction.update({ content: "⏳ 判定を実行中…", embeds: [], components: [] });

  const { attended, absent } = services.entry.judgeSlot(slot);
  // 見送りはキューから外す（亡霊化しない）。保留は attended のまま残す（次回に持ち越し）
  const skipped: string[] = [];
  for (const row of attended) {
    if (sel.skip.has(row.user_id)) {
      services.entry.skipBooking(row.user_id, actor);
      skipped.push(row.user_id);
    }
  }
  const toGhost = attended.filter((r) => !sel.hold.has(r.user_id) && !sel.skip.has(r.user_id));

  const guild = interaction.guild!;
  const waitRoleId = services.settings.getString("role:queue_wait");
  const ghostRoleId = services.settings.getString("role:ghost");
  const maleRoleId = services.settings.getString("role:male");
  const femaleRoleId = services.settings.getString("role:female");

  const passed: string[] = [];
  const failed: string[] = [];
  let totalGranted = 0;

  for (const row of toGhost) {
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

  judgeState.delete(judgeKey(interaction.user.id, slot));

  const lines = [
    `✅ **${passed.length}名** を亡霊にしました（初期発行 計 ${fmtLd(totalGranted)}）。`,
    failed.length > 0 ? `❌ 失敗: ${failed.map((id) => `<@${id}>`).join(", ")}` : "",
    sel.hold.size > 0 ? `⏸ 保留（次回持ち越し）: ${sel.hold.size}名` : "",
    skipped.length > 0 ? `🚫 見送り（キューから除外）: ${skipped.map((id) => `<@${id}>`).join(", ")}` : "",
    rebook.length > 0 ? `📅 欠席 → 再予約案内: ${rebook.length}名` : "",
    droppedList.length > 0 ? `🚫 3回連続欠席でキューから除外: ${droppedList.map((id) => `<@${id}>`).join(", ")}（対応は運営判断）` : "",
  ].filter(Boolean);
  await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
}
