import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { EMPLOYEE_OPERABLE_TIER_KEYS, RANKED_TABLE_TIERS, type GenericRankProfile } from "@meigokujo/core";
import { renderRankedTable } from "../casino/ranked-table-ui.js";
import { C_LOSE, C_MAMMON } from "../casino/ui.js";
import { isAdmin, isCasinoEmployee } from "../permissions.js";
import type { Services } from "../services.js";

/**
 * 🎴 賭博場従業員パネル（PR24 / 正本 §17）。
 *
 * 従業員は**卓運営係**であって、金銭を動かす役ではない。
 * このファイルには返金・配当・残高調整・house資金操作・強制精算・強制順位確定・
 * 裁定精算・担保移動・場代返還への入口を**一つも置かない**。
 * 卓の作成と開始前の取消だけが資金に触れる操作で、どちらも PR20〜23 の core API
 * （担保・場代・損失上限・日次上限・同時1卓・ソロ排他・段階開放・クールダウン）に
 * そのまま乗る。ここで独自の資金処理は一切書かない。
 */

export const EMPLOYEE_CUSTOM_PREFIX = "cemp:";
const OPEN_MODAL_PREFIX = "cemp:open-modal:";
const REPORT_MODAL_PREFIX = "cemp:report-modal:";

/**
 * 従業員が扱える卓ランク。正本は core の {@link EMPLOYEE_OPERABLE_TIER_KEYS}。
 * ここでは候補を絞るためだけに使い、実際の可否は毎回 core が判定する。
 */
const EMPLOYEE_TIER_KEYS = EMPLOYEE_OPERABLE_TIER_KEYS;

/** core が正本を持つゲーム。汎用卓は運営登録プロファイルから選ぶ */
const FIXED_GAMES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "gf", label: "GF（1対1）" },
  { key: "sanma", label: "三麻（3人）" },
  { key: "yonma", label: "四麻（4人）" },
];

const HISTORY_LIMIT = 10;

export const casinoEmployeeCommand = new SlashCommandBuilder()
  .setName("賭場運営")
  .setDescription("🎴 賭博場従業員パネル（卓の開催・掲示・開始前の閉鎖・問題報告・履歴）")
  .setDMPermission(false);

export function isCasinoEmployeeInteraction(customId: string): boolean {
  return customId.startsWith(EMPLOYEE_CUSTOM_PREFIX);
}

export async function handleCasinoEmployeeCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  if (!(await denyUnlessEmployee(interaction, services))) return;
  await interaction.reply({ ...renderEmployeePanel(services), flags: MessageFlags.Ephemeral });
}

/**
 * ボタン・選択・モーダルの共通入口。
 *
 * **すべての操作でここが権限を再確認する。** customId を直接叩かれても、
 * パネルを開けた事実があっても、1操作ごとに資格を見る（UIだけの制御にしない）。
 */
export async function handleCasinoEmployeeInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  if (!(await denyUnlessEmployee(interaction, services))) return;
  const customId = interaction.customId;
  try {
    if (interaction.isModalSubmit()) {
      if (customId.startsWith(OPEN_MODAL_PREFIX)) return await submitOpenTable(interaction, services);
      if (customId.startsWith(REPORT_MODAL_PREFIX)) return await submitReport(interaction, services);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (customId === "cemp:open:game") return await pickTier(interaction, services);
      if (customId.startsWith("cemp:open:tier:")) return await openTableModal(interaction);
      if (customId === "cemp:close:pick") return await closeTable(interaction, services);
      if (customId === "cemp:post:pick") return await postRecruitment(interaction, services);
      if (customId === "cemp:report:pick") return await reportModal(interaction, services);
      return;
    }
    if (customId === "cemp:guide") return await showGuide(interaction);
    if (customId === "cemp:open") return await pickGame(interaction, services);
    if (customId === "cemp:post") return await pickLiveTable(interaction, services, "post", "掲示する卓を選ぶ");
    if (customId === "cemp:close") return await pickLiveTable(interaction, services, "close", "閉じる卓を選ぶ（開始前のみ）");
    if (customId === "cemp:report") return await pickLiveTable(interaction, services, "report", "報告する卓を選ぶ");
    if (customId === "cemp:history") return await showHistory(interaction, services);
  } catch (error) {
    await replyError(interaction, error);
  }
}

// ── 権限 ────────────────────────────────────────────────

async function denyUnlessEmployee(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  services: Services,
): Promise<boolean> {
  if (isCasinoEmployee(interaction, services)) return true;
  await interaction.reply({
    content: "このパネルは賭博場従業員専用です。（運営ボードの「賭博場従業員ロール」で設定します）",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

// ── 1. 固定説明 ──────────────────────────────────────────

function renderEmployeePanel(services: Services) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 従業員卓" })
    .setColor(C_MAMMON)
    .setTitle("🎴 賭博場従業員パネル")
    .setDescription(
      [
        "**あなたは卓運営係です。**",
        "",
        "・**金銭を動かす権限はありません**（返金・配当・残高調整・資金投入はこのパネルにありません）",
        "・**結果を勝手に確定しません**。順位は対局者が入力し、対局者が承認します",
        "・開けるのは**高卓まで**。超高卓・極卓・冥獄卓は運営の管轄です",
        "・**開始済みの卓は無理に閉じません**。閉じられるのは募集中・準備確認までです",
        "・異議が出た卓は裁定（`/casino-arbitration`）の管轄です。従業員は触りません",
        "・困ったら**問題報告**を使ってください。運営へ届きます",
      ].join("\n"),
    )
    .setFooter({ text: openingFooter(services) });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("cemp:guide").setLabel("説明").setEmoji("📖").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cemp:open").setLabel("卓を開く").setEmoji("🆕").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cemp:post").setLabel("募集を出す").setEmoji("📣").setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("cemp:close").setLabel("卓を閉じる").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cemp:report").setLabel("問題報告").setEmoji("🚩").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("cemp:history").setLabel("履歴").setEmoji("🗂").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

function openingFooter(services: Services): string {
  try {
    const phase = services.chipTx.openingPhase();
    if (phase !== "formal") return "正式開業前です。卓の開催は開業後に有効になります";
    const status = services.casinoStatus.current();
    return status.status === "open" ? "賭場は営業中" : `資金操作停止中: ${status.reason}`;
  } catch {
    return "賭場の状態を確認できません";
  }
}

async function showGuide(interaction: ButtonInteraction): Promise<void> {
  await interaction.reply({
    content: [
      "**従業員の仕事**",
      "1. 卓を開く（高卓まで）",
      "2. 募集を掲示する",
      "3. 開始前の卓を閉じる",
      "4. 問題を報告する",
      "5. 履歴を見る",
      "",
      "**やらないこと**: 返金・配当・順位の確定・異議の解決・資金の出し入れ。すべて運営と裁定の管轄です。",
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

// ── 2. 卓を開く ──────────────────────────────────────────

async function pickGame(interaction: ButtonInteraction, services: Services): Promise<void> {
  const options = [
    ...FIXED_GAMES.map((g) => ({ label: g.label, value: g.key })),
    ...listGenericProfiles(services).map((p) => ({
      label: `${p.label}（${p.participantCount}人・運営登録）`.slice(0, 100),
      value: p.profileKey,
    })),
  ].slice(0, 25);
  const select = new StringSelectMenuBuilder().setCustomId("cemp:open:game").setPlaceholder("ゲームを選ぶ").addOptions(options);
  await interaction.reply({
    content: "開く卓のゲームを選んでください。汎用順位卓は運営が登録した配分のみ選べます。",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

function listGenericProfiles(services: Services) {
  try {
    return services.rankedProfiles.list();
  } catch {
    return [];
  }
}

async function pickTier(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const gameKey = interaction.values[0]!;
  // 開けるランクは core の判定に聞く（UIで隠すだけにしない）。従業員資格で照会する
  const availability = services.rankedTables.rankedTierAvailability("employee");
  const options = RANKED_TABLE_TIERS.filter((tier) => EMPLOYEE_TIER_KEYS.includes(tier.key)).map((tier) => {
    const row = availability.find((a) => a.tierKey === tier.key);
    const open = row?.available === true;
    return {
      label: `${tier.label}（基準額 ${tier.baseAmount.toLocaleString("ja-JP")} Ld）${open ? "" : " ─ いま開けません"}`.slice(0, 100),
      description: (open ? "選べます" : (row?.reason ?? "利用できません")).slice(0, 100),
      value: tier.key,
    };
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cemp:open:tier:${gameKey}`)
    .setPlaceholder("卓ランクを選ぶ（高卓まで）")
    .addOptions(options);
  await interaction.update({
    content: `ゲーム: **${gameLabel(gameKey, services)}**\n卓ランクを選んでください。実際の可否は開く瞬間にもう一度判定します。`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

async function openTableModal(interaction: StringSelectMenuInteraction): Promise<void> {
  const gameKey = interaction.customId.slice("cemp:open:tier:".length);
  const tierKey = interaction.values[0]!;
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${OPEN_MODAL_PREFIX}${gameKey}:${tierKey}`)
      .setTitle("卓を開く")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("note")
            .setLabel("メモ（任意・掲示には出ません）")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(80),
        ),
      ),
  );
}

async function submitOpenTable(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const [gameKey, tierKey] = interaction.customId.slice(OPEN_MODAL_PREFIX.length).split(":");
  if (!gameKey || !tierKey) {
    await interaction.reply({ content: "卓の指定が壊れています。もう一度やり直してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 汎用卓は運営登録の信頼プロファイルだけ。未登録なら core が fail-closed で落とす
  let profile: GenericRankProfile | undefined;
  if (!FIXED_GAMES.some((g) => g.key === gameKey)) {
    profile = services.rankedProfiles.requiredProfile(gameKey);
  }
  const snapshot = services.rankedTables.create({
    gameKey,
    tierKey,
    ...(profile ? { profile } : {}),
    creatorId: interaction.user.id,
    operatorId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    operationId: interaction.id,
    // 段階開放・クールダウン・権限の判定は core が行う。従業員資格で申請する
    authority: "employee",
  });
  await interaction.reply({
    content: `卓を開きました（\`${snapshot.table.tableId}\`）。「募集を出す」で掲示できます。`,
    ...renderRankedTable(snapshot, services.rankedDisputes.publicStatus(snapshot.table.tableId)),
    flags: MessageFlags.Ephemeral,
  });
}

// ── 3. 募集メッセージ ─────────────────────────────────────

/**
 * 従業員が扱ってよい卓か（PR24 レビュー BLOCKER 2）。
 *
 * 判定は2つ。**このサーバーの卓か**と、**従業員資格のランク範囲内か**。
 * manager が開いた超高卓・極卓・冥獄卓は、開始前でも従業員からは触らせない。
 * 引継ぎができるよう「自分が開いた卓だけ」には絞らない（ランクで見る）。
 */
function employeeMayOperate(services: Services, tableId: string, guildId: string | null): { ok: true } | { ok: false; reason: string } {
  const table = services.persistentTables.get(tableId);
  if (!table) return { ok: false, reason: "その卓は見つかりません。" };
  if (!guildId || !table.guildId || table.guildId !== guildId) {
    return { ok: false, reason: "その卓はこのサーバーの卓ではありません。" };
  }
  let baseAmount: number;
  try {
    baseAmount = services.rankedTables.snapshot(tableId).config.baseAmount;
  } catch {
    return { ok: false, reason: "その卓の設定を確認できません。" };
  }
  const tier = RANKED_TABLE_TIERS.find((t) => t.baseAmount === baseAmount);
  if (!tier || !EMPLOYEE_TIER_KEYS.includes(tier.key)) {
    return { ok: false, reason: "その卓は従業員が扱える卓ランクを超えています（高卓まで）。運営の管轄です。" };
  }
  return { ok: true };
}

/** 従業員が扱ってよい生きている卓だけ（サーバー内・高卓まで） */
function employeeOperableLiveTables(services: Services, guildId: string | null) {
  const live = services.persistentTables.listLiveTables();
  return live.filter((table) => employeeMayOperate(services, table.tableId, guildId).ok);
}

async function pickLiveTable(
  interaction: ButtonInteraction,
  services: Services,
  action: "post" | "close" | "report",
  placeholder: string,
): Promise<void> {
  const tables = employeeOperableLiveTables(services, interaction.guildId);
  if (tables.length === 0) {
    await interaction.reply({ content: "いま従業員が扱える卓はありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const options = tables.slice(0, 25).map((table) => ({
    label: `${gameLabel(table.gameKey, services)} / ${stateLabel(table.state)}`.slice(0, 100),
    description: table.tableId.slice(0, 100),
    value: table.tableId,
  }));
  const select = new StringSelectMenuBuilder().setCustomId(`cemp:${action}:pick`).setPlaceholder(placeholder).addOptions(options);
  await interaction.reply({
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * 募集をチャンネルへ掲示する。
 *
 * 表示は DB の卓状態（`rankedTables.snapshot()`）だけから作る。掲示メッセージを
 * 別の真実として持たない。既存の `bindMessage()` で卓とメッセージを結び付けるので、
 * 再起動後の復旧・同期（PR20〜22）もそのまま効く。
 */
async function postRecruitment(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const tableId = interaction.values[0]!;
  // 選択値は古いことがある。掲示する直前にもう一度、卓を取り直して権限境界を見る
  const allowed = employeeMayOperate(services, tableId, interaction.guildId);
  if (!allowed.ok) {
    await interaction.update({ content: allowed.reason, components: [], embeds: [] });
    return;
  }
  const snapshot = services.rankedTables.snapshot(tableId);
  const payload = renderRankedTable(snapshot, services.rankedDisputes.publicStatus(tableId));
  const channel = interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") {
    await interaction.update({ content: "このチャンネルには掲示できません。", components: [] });
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.update({ content: "サーバー内でのみ掲示できます。", components: [] });
    return;
  }
  const posted = (await channel.send(payload)) as Message;
  services.persistentTables.bindMessage(tableId, { guildId, channelId: posted.channelId, messageId: posted.id });
  await interaction.update({ content: `募集を掲示しました（\`${tableId}\`）。`, components: [] });
}

// ── 4. 卓を閉じる ────────────────────────────────────────

/**
 * 開始前の卓だけを閉じる。
 *
 * 実処理は core の `cancelBeforeStart()` で、許すのは `recruiting` / `ready_check` のみ。
 * `playing` / `pending_approval` / `disputed` は core が拒否するので、ここでは
 * 「問題報告へ回してください」と案内するだけ。UI で状態を隠して済ませない。
 */
async function closeTable(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const tableId = interaction.values[0]!;
  // 選択値は古いことがある。閉じる直前に卓を取り直して権限境界を見る。
  // core 側でも authority / guild を再判定するので、ここは二重の防波堤かつ理由の説明用
  const allowed = employeeMayOperate(services, tableId, interaction.guildId);
  if (!allowed.ok) {
    await interaction.update({ content: allowed.reason, components: [], embeds: [] });
    return;
  }
  try {
    const snapshot = services.rankedTables.cancelBeforeStart({
      tableId,
      actorId: interaction.user.id,
      operationId: interaction.id,
      reason: "closed by casino employee",
      // 資格とサーバー境界は core 側でも判定させる。UIで候補を隠すだけにしない
      authority: "employee",
      expectedGuildId: interaction.guildId,
    });
    await interaction.update({
      content: `卓を閉じました（\`${tableId}\`）。参加者の預託は全額返しています。`,
      ...renderRankedTable(snapshot, services.rankedDisputes.publicStatus(tableId)),
    });
  } catch (error) {
    await interaction.update({
      content: [
        `この卓は従業員からは閉じられません（\`${tableId}\`）。`,
        `理由: ${message(error)}`,
        "",
        "対局中・承認待ち・異議中の卓の資金は、従業員操作では動かせません。**問題報告**から運営へ回してください。",
      ].join("\n"),
      components: [],
      embeds: [],
    });
  }
}

// ── 5. 問題報告 ──────────────────────────────────────────

async function reportModal(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const tableId = interaction.values[0]!;
  const allowed = employeeMayOperate(services, tableId, interaction.guildId);
  if (!allowed.ok) {
    await interaction.update({ content: allowed.reason, components: [], embeds: [] });
    return;
  }
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${REPORT_MODAL_PREFIX}${tableId}`)
      .setTitle("問題報告")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("何が起きているか（短く）")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(300),
        ),
      ),
  );
}

/**
 * 運営へ報告するだけ。**ここから返金・勝者決定・場代返還・参加者処分は一切起きない。**
 * 卓の状態も1ミリも変えない（`snapshot()` は読み取りのみ）。
 */
async function submitReport(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const tableId = interaction.customId.slice(REPORT_MODAL_PREFIX.length);
  // モーダルの customId も直接叩けるので、報告対象がこのサーバーの扱える卓かを再確認する
  const allowed = employeeMayOperate(services, tableId, interaction.guildId);
  if (!allowed.ok) {
    await interaction.reply({ content: allowed.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  const reason = interaction.fields.getTextInputValue("reason").trim().slice(0, 300);
  const table = services.persistentTables.get(tableId);
  const at = Math.floor(Date.now() / 1000);
  services.events.log("casino_employee_report", {
    actor: interaction.user.id,
    target: tableId,
    payload: { tableId, state: table?.state ?? "unknown", reason, reportedAt: at },
  });
  const delivered = await deliverReport(interaction, services, {
    tableId,
    state: table?.state ?? "unknown",
    reason,
    at,
  });
  await interaction.reply({
    content: delivered
      ? `報告しました（\`${tableId}\`）。運営が確認します。卓の状態は変えていません。`
      : `報告を記録しました（\`${tableId}\`）。運営チャンネルが未設定のため、記録のみです。`,
    flags: MessageFlags.Ephemeral,
  });
}

async function deliverReport(
  interaction: ModalSubmitInteraction,
  services: Services,
  report: { tableId: string; state: string; reason: string; at: number },
): Promise<boolean> {
  const channelId = services.settings.getString("channel:casino_ops");
  if (!channelId) return false;
  try {
    const channel = interaction.client.channels.cache.get(channelId) ?? (await interaction.client.channels.fetch(channelId));
    if (!channel || !("send" in channel) || typeof channel.send !== "function") return false;
    const embed = new EmbedBuilder()
      .setColor(C_LOSE)
      .setTitle("🚩 賭場・従業員からの問題報告")
      .setDescription(
        [
          `卓: \`${report.tableId}\``,
          `状態: ${stateLabel(report.state)}`,
          `報告者: <@${interaction.user.id}>`,
          `日時: <t:${report.at}:f>`,
          "",
          report.reason,
        ].join("\n"),
      )
      .setFooter({ text: "これは裁定ではありません。資金は動いていません" });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

// ── 6. 履歴 ──────────────────────────────────────────────

/**
 * 読み取り専用の卓履歴。
 *
 * 個人の損得は出さない（PR19 の「個人損失は公開しない」原則）。
 * 証拠・異議の中身・運営向けの内部文言（異議理由・失敗理由・復旧エラーの各カラム）も
 * 出さない。出すのは卓の素性と状態だけ。
 *
 * ここで何を出さないかは `casino-employee-panel.test.ts` がソース走査で固定している。
 */
async function showHistory(interaction: ButtonInteraction, services: Services): Promise<void> {
  const rows = services.persistentTables.listRecentTables(HISTORY_LIMIT, interaction.guildId);
  if (rows.length === 0) {
    await interaction.reply({ content: "まだ卓の記録がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = rows.map((row) => {
    const started = row.startedAt ? `開始 <t:${row.startedAt}:R>` : "未開始";
    return [
      `\`${row.tableId}\` ${gameLabel(row.gameKey, services)} / ${tierLabelFor(services, row.tableId)}`,
      `　${stateLabel(row.state)}・${outcomeLabel(row.state)}｜作成 <@${row.creatorId}> <t:${row.createdAt}:R>・${started}`,
    ].join("\n");
  });
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 従業員卓" })
    .setColor(C_MAMMON)
    .setTitle(`🗂 卓履歴（直近 ${rows.length} 件）`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "読み取り専用。個人の損益・証拠・異議の内容は表示しません" });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── 表示ヘルパー ─────────────────────────────────────────

function gameLabel(gameKey: string, services: Services): string {
  const fixed = FIXED_GAMES.find((g) => g.key === gameKey);
  if (fixed) return fixed.label.replace(/（.*/, "");
  try {
    return services.rankedProfiles.get(gameKey)?.label ?? gameKey;
  } catch {
    return gameKey;
  }
}

function tierLabelFor(services: Services, tableId: string): string {
  try {
    const config = services.rankedTables.snapshot(tableId).config;
    return RANKED_TABLE_TIERS.find((t) => t.baseAmount === config.baseAmount)?.label ?? `${config.baseAmount.toLocaleString("ja-JP")} Ld`;
  } catch {
    return "―";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "recruiting": return "募集中";
    case "ready_check": return "準備確認";
    case "playing": return "対局中";
    case "pending_approval": return "結果承認待ち";
    case "disputed": return "異議対応中";
    case "settled": return "精算済み";
    case "cancelled": return "取消";
    case "cancelled_by_admin": return "運営取消";
    case "cancelled_fault": return "過失取消";
    default: return state;
  }
}

function outcomeLabel(state: string): string {
  if (state === "settled") return "決着";
  if (state === "disputed") return "裁定待ち";
  if (state.startsWith("cancelled")) return "不成立";
  return "進行中";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function replyError(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  error: unknown,
): Promise<void> {
  const content = `操作できませんでした: ${message(error)}`;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

/** 運営が汎用順位卓の信頼プロファイルを登録する入口（/管理 から呼ぶ。従業員は呼べない） */
export function registerTrustedRankedProfile(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  services: Services,
  input: { profileKey: string; label: string; participantCount: number; rankDeltaBps: number[] },
): { ok: true } | { ok: false; reason: string } {
  if (!isAdmin(interaction, services)) return { ok: false, reason: "運営のみが順位配分を登録できます。" };
  try {
    services.rankedProfiles.register({
      ...input,
      actorId: interaction.user.id,
      operationId: interaction.id,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
}
