import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  SessionCalendarError,
  addJstDays,
  describeSessionSchedule,
  formatJstDate,
  jstDateStr,
  sessionStartAt,
  type SessionOverrideRow,
} from "@meigokujo/core";
import { isJudge } from "./entry.js";
import { refreshWaitersBoard } from "../waiters-board.js";
import type { Services } from "../services.js";

/**
 * `/説明会` — 開催予定の確認と、日付ごとの休止・臨時追加。
 *
 * 予定の正本は core の SessionCalendar（通常枠 × 例外の合成）。ここは入力の受け取りと
 * 表示だけを持つ。日付・時刻・取消対象はすべて補完候補から選ばせ、手入力の失敗を潰す。
 */
export const sessionScheduleCommand = new SlashCommandBuilder()
  .setName("説明会")
  .setDescription("説明会の開催予定を見る・休止する・臨時に追加する（門番・門番統括・運営）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("予定")
      .setDescription("今後の開催予定を見る")
      .addIntegerOption((o) => o.setName("日数").setDescription("何日先まで見るか（既定7日・最大30日）").setMinValue(1).setMaxValue(30)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("休止")
      .setDescription("通常の開催枠を休みにする（時刻を省略するとその日を全休）")
      .addStringOption((o) => o.setName("日付").setDescription("休みにする日").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName("時刻").setDescription("休みにする枠（省略でその日を全休）").setAutocomplete(true))
      .addStringOption((o) => o.setName("理由").setDescription("記録に残す理由（任意）").setMaxLength(100)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("追加")
      .setDescription("臨時の説明会を追加する（通常は休みの曜日にも足せる）")
      .addStringOption((o) => o.setName("日付").setDescription("開催する日").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName("時刻").setDescription("開始時刻（JST・0〜23時）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("理由").setDescription("記録に残す理由（任意）").setMaxLength(100)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("取消")
      .setDescription("登録した休止・臨時追加を取り消す（通常の予定に戻る）")
      .addIntegerOption((o) => o.setName("対象").setDescription("取り消す予定変更").setRequired(true).setAutocomplete(true)),
  );

const DENIED = "この操作には門番（運営・門番・門番統括）の権限が必要です。";
/** 補完に出す日付の範囲。運用上、翌々週まで決め打ちできれば足りる */
const AUTOCOMPLETE_DAYS = 14;

export async function handleSessionScheduleCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isJudge(interaction, services)) {
    await interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === "予定") await replySchedule(interaction, services);
    else if (sub === "休止") await replySkip(interaction, services);
    else if (sub === "追加") await replyAdd(interaction, services);
    else if (sub === "取消") await replyCancel(interaction, services);
  } catch (e) {
    if (e instanceof SessionCalendarError) {
      await interaction.reply({ content: `⚠️ ${e.message}`, flags: MessageFlags.Ephemeral });
      return;
    }
    throw e;
  }
}

// ---- /説明会 予定 ----

async function replySchedule(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const days = interaction.options.getInteger("日数") ?? 7;
  const now = new Date();
  const schedule = services.sessions.schedule();
  const next = services.sessions.nextOccurrence(now);
  const nextTs = next ? Math.floor(next.at.getTime() / 1000) : null;

  const embed = new EmbedBuilder()
    .setTitle("📅 説明会の予定")
    .setColor(0x6b21a8)
    .addFields({
      name: "🕯️ 次の説明会",
      value: nextTs ? `<t:${nextTs}:F>（<t:${nextTs}:R>）` : "予定がありません",
    })
    .addFields({ name: `今後${days}日`, value: renderDays(services, now, days).join("\n").slice(0, 1024) })
    .setFooter({ text: `通常枠: ${describeSessionSchedule(schedule)}` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** 日ごとの予定行。休止は取り消し線、臨時追加は ＋ を付けて通常枠と区別する */
function renderDays(services: Services, from: Date, days: number): string[] {
  const schedule = services.sessions.schedule();
  const startDate = jstDateStr(from);
  const overrides = services.sessions.listOverrides(startDate, addJstDays(startDate, days - 1));
  const lines: string[] = [];

  for (let offset = 0; offset < days; offset++) {
    const date = addJstDays(startDate, offset);
    const dayOverrides = overrides.filter((o) => o.date === date);
    const fullSkip = dayOverrides.find((o) => o.kind === "skip" && o.hour === null);
    const skipped = new Map(
      dayOverrides.filter((o) => o.kind === "skip" && o.hour !== null).map((o) => [o.hour as number, o]),
    );
    const extras = dayOverrides.filter((o) => o.kind === "add" && o.hour !== null);
    const regular = services.sessions.regularHours(date, schedule);

    const parts: string[] = [];
    for (const hour of regular) {
      parts.push(fullSkip || skipped.has(hour) ? `~~${hour}:00~~` : `${hour}:00`);
    }
    for (const extra of extras.sort((a, b) => (a.hour ?? 0) - (b.hour ?? 0))) {
      parts.push(`**＋${extra.hour}:00**`);
    }

    const reasons = [fullSkip, ...skipped.values(), ...extras]
      .filter((o): o is SessionOverrideRow => !!o && !!o.reason)
      .map((o) => o.reason as string);
    const body = parts.length > 0 ? parts.join(" / ") : "定例なし";
    const note = fullSkip ? "（全休）" : "";
    lines.push(`\`${formatJstDate(date)}\` ${body}${note}${reasons.length > 0 ? ` — ${[...new Set(reasons)].join("・")}` : ""}`);
  }
  return lines;
}

// ---- /説明会 休止・追加・取消 ----

async function replySkip(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const date = interaction.options.getString("日付", true);
  const hour = interaction.options.getInteger("時刻");
  const reason = interaction.options.getString("理由");
  const row = services.sessions.skip({ date, hour, reason, actor: `user:${interaction.user.id}` });
  refreshWaitersBoard(interaction.client, services);

  const target = row.hour === null ? "の説明会を**すべて**" : ` **${row.hour}:00** の説明会を`;
  await interaction.reply({
    content: [
      `✅ **${formatJstDate(row.date)}**${target}休止しました。${reason ? `（理由: ${reason}）` : ""}`,
      "この枠の5分前通知は出ません。案内DM・「いまの自分の状態を見る」にも出なくなります。",
      "戻すときは `/説明会 取消` から選んでください。",
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

async function replyAdd(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const date = interaction.options.getString("日付", true);
  const hour = interaction.options.getInteger("時刻", true);
  const reason = interaction.options.getString("理由");
  const row = services.sessions.add({ date, hour, reason, actor: `user:${interaction.user.id}` });
  refreshWaitersBoard(interaction.client, services);
  const ts = Math.floor(sessionStartAt(row.date, row.hour!).getTime() / 1000);
  const isRestDay = services.sessions.regularHours(row.date).length === 0;

  await interaction.reply({
    content: [
      `✅ **${formatJstDate(row.date)} ${row.hour}:00**（<t:${ts}:F>）に臨時の説明会を追加しました。${reason ? `（理由: ${reason}）` : ""}`,
      isRestDay ? "この曜日は通常お休みですが、この枠だけ開催になります。" : "",
      "開始5分前に入城案内チャンネルへ通知が出ます。",
    ]
      .filter(Boolean)
      .join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

async function replyCancel(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const id = interaction.options.getInteger("対象", true);
  const row = services.sessions.cancel(id, `user:${interaction.user.id}`);
  refreshWaitersBoard(interaction.client, services);
  // 取り消した結果どうなったかは、固定文ではなく**取消後の実際の開催状態**から作る。
  // 全休と個別休止が重なっている場合、「通常どおり開催します」が事実と食い違うため。
  // 0時開催も拾うため直前から探す。起点が前日になるので2日分見てその日だけ残す
  const dayStart = new Date(sessionStartAt(row.date, 0).getTime() - 1);
  const remaining = services.sessions.occurrences({ from: dayStart, days: 2 }).filter((o) => o.date === row.date);
  const dayState =
    remaining.length > 0
      ? `この日の開催: ${remaining.map((o) => `**${o.hour}:00**${o.extra ? "（臨時）" : ""}`).join(" / ")}`
      : "この日の開催はありません";

  const occurring = row.hour === null ? null : services.sessions.isOccurring(row.date, row.hour);
  const slotState =
    row.hour === null
      ? null
      : row.kind === "skip"
        ? occurring
          ? `**${row.hour}:00** は開催します`
          : `**${row.hour}:00** は開催しません（別の休止が残っています）`
        : occurring
          ? `**${row.hour}:00** は通常枠として開催します`
          : `**${row.hour}:00** の臨時開催は無くなりました`;

  await interaction.reply({
    content: [
      `✅ **${formatJstDate(row.date)}** の${row.kind === "skip" ? "休止" : "臨時追加"}を取り消しました。`,
      slotState,
      dayState,
    ]
      .filter(Boolean)
      .join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 補完 ----

export async function handleSessionScheduleAutocomplete(
  interaction: AutocompleteInteraction,
  services: Services,
): Promise<void> {
  // 補完は権限を持たない人にも出しうるので、ここでも門番判定を通す
  if (!isJudge(interaction, services)) {
    await interaction.respond([]);
    return;
  }
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused(true);
  const today = jstDateStr();

  if (focused.name === "日付") {
    const choices: Array<{ name: string; value: string }> = [];
    for (let offset = 0; offset < AUTOCOMPLETE_DAYS; offset++) {
      const date = addJstDays(today, offset);
      const regular = services.sessions.regularHours(date);
      // 休止できるのは通常枠がある日だけ。臨時追加は休みの日にも足せる
      if (sub === "休止" && regular.length === 0) continue;
      const label = sub === "休止" ? `${formatJstDate(date)} — ${regular.map((h) => `${h}時`).join("/")}` : formatJstDate(date);
      choices.push({ name: `${label}`.slice(0, 100), value: date });
    }
    await interaction.respond(filterChoices(choices, String(focused.value)).slice(0, 25));
    return;
  }

  if (focused.name === "時刻") {
    const date = interaction.options.getString("日付");
    if (!date) {
      await interaction.respond([{ name: "先に日付を選んでください", value: -1 }]);
      return;
    }
    const hours =
      sub === "休止"
        ? services.sessions.regularHours(date).filter((h) => services.sessions.isOccurring(date, h))
        : Array.from({ length: 24 }, (_, h) => h).filter((h) => !services.sessions.isOccurring(date, h));
    const now = new Date();
    const choices = hours
      .filter((h) => sessionStartAt(date, h).getTime() > now.getTime())
      .map((h) => ({ name: `${h}:00`, value: h }));
    await interaction.respond(
      (choices.length > 0 ? choices : [{ name: sub === "休止" ? "休止できる枠がありません" : "空いている枠がありません", value: -1 }]).slice(0, 25),
    );
    return;
  }

  if (focused.name === "対象") {
    const rows = services.sessions.listOverrides(today, addJstDays(today, 60));
    const choices = rows.map((row) => ({
      name: `${formatJstDate(row.date)} ${row.hour === null ? "全休" : `${row.hour}:00 ${row.kind === "skip" ? "休止" : "臨時追加"}`}${row.reason ? `（${row.reason}）` : ""}`.slice(0, 100),
      value: row.id,
    }));
    await interaction.respond(
      (choices.length > 0 ? choices : [{ name: "取り消せる予定変更はありません", value: -1 }]).slice(0, 25),
    );
  }
}

function filterChoices<T extends { name: string }>(choices: T[], input: string): T[] {
  const text = input.trim();
  if (!text) return choices;
  return choices.filter((c) => c.name.includes(text) || ("value" in c && String((c as { value: unknown }).value).includes(text)));
}
