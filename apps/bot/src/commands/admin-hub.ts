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
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
} from "discord.js";
import { deptAccount, LedgerError } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import { updateDashboard } from "../dashboard.js";
import { fmtLd } from "../format.js";
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

function renderHub(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
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
        "・**XP除外**: 発言/浮上XPを付けないチャンネル・カテゴリ",
      ].join("\n"),
    );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:setting").setLabel("設定").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:panel").setLabel("パネル").setEmoji("🪧").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:payroll").setLabel("給与").setEmoji("💰").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:fiscal").setLabel("徴収").setEmoji("🏛").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:dept").setLabel("部署").setEmoji("🏢").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:adjust").setLabel("調整").setEmoji("🔧").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:dashboard").setLabel("計器盤").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:xpex").setLabel("XP除外").setEmoji("🚫").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
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
  if (section === "setting" && action === "role-select") return void (await openRoleSetup(interaction, services));
  if (section === "setting" && action === "number-select") return void (await openNumberSetup(interaction, services));

  // ── パネル ──
  if (section === "panel" && !action) return void (await interaction.update(panelHome()));
  if (section === "panel" && action === "install") return void (await interaction.update(panelInstallPicker()));
  if (section === "panel" && action === "remove") return void (await interaction.update(panelRemovePicker()));

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

  // ── 調整 ──
  if (section === "adjust" && !action) return void (await interaction.update(adjustHome()));

  // ── 計器盤 ──
  if (section === "dashboard" && !action) {
    await interaction.deferUpdate();
    await updateDashboard(interaction.client, services).catch(() => undefined);
    await interaction.editReply({
      content: "📊 計器盤を更新しました。",
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
  if (section === "panel" && action === "install-pick" && interaction.isStringSelectMenu()) {
    return void (await installPanel(interaction, services, interaction.values[0]!));
  }
  if (section === "panel" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await removePanel(interaction, services, interaction.values[0]!));
  }
  if (section === "dept" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await deptRemove(interaction, services, interaction.values[0]!));
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
  const parts = interaction.customId.split(":");
  const section = parts[1];
  const action = parts[2];

  if (section === "setting" && action === "number") {
    const key = parts[3]!;
    const raw = interaction.fields.getTextInputValue("value").replaceAll(",", "").trim();
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      await interaction.reply({ content: "数値を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    services.settings.set(key, n, `user:${interaction.user.id}`);
    await interaction.reply({ content: `✅ **${key}** = ${n.toLocaleString()} に設定しました。`, flags: MessageFlags.Ephemeral });
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
  if (section === "dept" && action === "create") {
    const name = interaction.fields.getTextInputValue("name").trim();
    if (!name) {
      await interaction.reply({ content: "部署名を入れてください。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      services.departments.upsert(name, name, null);
      await interaction.reply({ content: `✅ 部署「${name}」を作成しました。担当ロールは /設定 相当の別UIで設定してください（未実装）。`, flags: MessageFlags.Ephemeral });
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
    new ButtonBuilder().setCustomId("mgmt:setting:role-select").setLabel("ロール").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:setting:number-select").setLabel("数値").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row, backButton()] };
}

const CHANNEL_KEYS: Array<[string, string]> = [
  ["public_log", "公開取引ログ"],
  ["kessai", "#決裁"],
  ["keikiban", "#城の計器盤"],
  ["audit_log", "監査ログ"],
  ["entry_guide", "入城案内"],
  ["session_vc", "説明会場VC"],
  ["session_vc2", "説明会場VC（2つ目）"],
  ["shokan", "冥界商館（ショップ配送通知）"],
  ["eval_forum", "評価フォーラム"],
  ["shurei", "集令"],
  ["announce", "昇格のお知らせ"],
  ["recruit", "蜜月の募集掲示"],
  ["charon_notify", "カロン通知"],
];

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
];

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

// ---- パネルサブパネル ----

const PANEL_KIND_CHOICES: Array<[string, string]> = [
  ["bank", "冥獄銀行"],
  ["entry", "入城申請"],
  ["entry_flex", "時間外希望受付"],
  ["rank", "ランク確認"],
  ["ticket_return", "出戻り申請"],
  ["ticket_consult", "個別相談"],
  ["room_normal", "宿"],
  ["room_mitsugetsu", "蜜月"],
  ["room_oborozuki", "朧月"],
  ["room_game", "ゲーム部屋"],
  ["dept", "部署運用"],
];

function panelHome() {
  const embed = new EmbedBuilder()
    .setTitle("🪧 パネル")
    .setColor(0x6b21a8)
    .setDescription("常設パネルを **今いるチャンネルに** 設置・撤去します。");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:panel:install").setLabel("設置").setEmoji("📌").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mgmt:panel:remove").setLabel("撤去").setEmoji("🗑").setStyle(ButtonStyle.Danger),
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
    .addOptions(PANEL_KIND_CHOICES.map(([v, name]) => ({ label: name, value: v })));
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
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("🪧 部署運用パネル設置")
          .setDescription("部署パネルは `/管理` からは設置できません（部署キー指定が必要）。\n将来のアップデートで対応予定です。"),
      ],
      components: [backButton()],
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
  const lines = list.length > 0 ? list.map((d) => `・${d.name}: ${fmtLd(d.balance)}`).join("\n") : "（部署なし）";
  const embed = new EmbedBuilder()
    .setTitle("🏢 部署")
    .setColor(0x6b21a8)
    .setDescription(`**現在の部署**\n${lines}`);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:dept:create").setLabel("作成").setStyle(ButtonStyle.Primary),
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
