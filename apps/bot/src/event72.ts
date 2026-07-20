import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type Message,
  type TextChannel,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { renderCompletePng, renderCountdownGif, formatRemain, type Phase } from "./render/countdown-gif.js";
import type { Services } from "./services.js";

/**
 * 72時間耐久企画・最終24時間のイベント機能。
 *
 * - カウントダウンは「表示回数」ではなく常に eventEndAt と現在時刻の差から算出する
 *   （再起動・遅延があってもズレない。§優先順位1）
 * - 状態は既存の settings(key/value) に JSON で永続化する（スキーマ変更なし）
 * - パネルはチャンネル内に常に1件。ユーザー発言で最下部へ追従（デバウンス2秒・排他）
 * - 最終24時間中に対象VCへ通算60秒以上いた人へ、終了後に記念ロールを付与
 */
export const EVENT_CONFIG = {
  panelChannelId: "1469277899319410741",
  voiceChannelId: "1528008265844260954",
  finalPhaseStartAt: "2026-07-20T21:00:00+09:00",
  eventEndAt: "2026-07-21T21:00:00+09:00",
  notificationRoleId: "1528720773731057785", // 最終通知
  memorialRoleId: "1528721015138553946", // 七十二時の炎
  memorialMinimumStaySeconds: 60,
} as const;

const FINAL_START_MS = Date.parse(EVENT_CONFIG.finalPhaseStartAt);
const END_MS = Date.parse(EVENT_CONFIG.eventEndAt);

const STATE_KEY = "event72:state";
const LOG = "[72h]";

interface Event72State {
  panelMessageId: string | null;
  panelChannelId: string;
  tenMinuteNotificationSent: boolean;
  finalized: boolean;
  /** userId -> 累計滞在秒（確定分） */
  voiceParticipation: Record<string, number>;
  /** userId -> 入室時刻(ms)。未確定のセッション */
  activeVoiceSessions: Record<string, number>;
  lastPanelMoveAt: number;
}

const DEFAULT_STATE: Event72State = {
  panelMessageId: null,
  panelChannelId: EVENT_CONFIG.panelChannelId,
  tenMinuteNotificationSent: false,
  finalized: false,
  voiceParticipation: {},
  activeVoiceSessions: {},
  lastPanelMoveAt: 0,
};

function loadState(services: Services): Event72State {
  const s = services.settings.getJson<Partial<Event72State>>(STATE_KEY, {});
  return { ...DEFAULT_STATE, ...s, panelChannelId: EVENT_CONFIG.panelChannelId };
}

function saveState(services: Services, state: Event72State): void {
  services.settings.set(STATE_KEY, state, "system:event72");
}

/** 現在フェーズ。残り時間から判定する（表示回数に依存しない） */
export function phaseAt(nowMs: number): Phase {
  const remain = END_MS - nowMs;
  if (remain <= 0) return "done";
  if (remain <= 60_000) return "one";
  if (remain <= 10 * 60_000) return "ten";
  return "normal";
}

// ─────────────────────────────────────────────────────
// パネルの組み立て
// ─────────────────────────────────────────────────────

function vcStatusLine(vc: VoiceBasedChannel | null): string {
  const humans = vc ? vc.members.filter((m) => !m.user.bot).size : 0;
  if (humans > 0) {
    return [
      "### 🔥 バトン継続中",
      `いま **${humans}人** が灯を絶やさずつないでいます。`,
      "続く者が入れば、その灯はさらに先へ渡ります。",
    ].join("\n");
  }
  return [
    "### 次の継承者を待っています",
    "いま灯を持つ者はいません。**今ならあなたがバトンを引き継げます。**",
  ].join("\n");
}

function panelEmbed(nowMs: number, phase: Phase, vc: VoiceBasedChannel | null): EmbedBuilder {
  const endUnix = Math.floor(END_MS / 1000);
  const color = phase === "done" ? 0xf0b429 : phase === "one" ? 0xff5a6e : phase === "ten" ? 0xff8a5c : 0x6b21a8;
  const embed = new EmbedBuilder().setColor(color).setImage("attachment://countdown.gif");

  if (phase === "done") {
    return embed
      .setTitle("🏰 七十二時間耐久 — 完走")
      .setImage("attachment://countdown.png")
      .setDescription(
        [
          "**72時間耐久企画は終了しました。**",
          "",
          "魔剣士から始まったこの灯は、最後まで絶えることなく渡り続けました。",
          "バトンをつないでくれたすべての人へ、心からの感謝を。",
          "",
          `最終24時間に対象VCへ集った者には、記念ロール **七十二時の炎** を刻みます。`,
          "",
          "またいつか、冥獄城で。",
        ].join("\n"),
      )
      .setFooter({ text: "72:00:00 — COMPLETE" });
  }

  if (phase === "one") {
    return embed
      .setTitle("⏳ 最後の一分")
      .setDescription([vcStatusLine(vc), "", "**この一分を、みんなで越える。**"].join("\n"))
      .setFooter({ text: "冥獄城 72時間耐久" });
  }

  if (phase === "ten") {
    return embed
      .setTitle("🔥 まもなく完走 — 残り10分")
      .setDescription(
        [
          vcStatusLine(vc),
          "",
          `終了 <t:${endUnix}:R>（<t:${endUnix}:T>）`,
          "",
          "最後のバトンをつなぎ、**72時間到達をその場で迎えましょう。**",
        ].join("\n"),
      )
      .setFooter({ text: "冥獄城 72時間耐久" });
  }

  return embed
    .setTitle("🔥 七十二時間耐久 — 最終24時間、バトンは全体へ")
    .setDescription(
      [
        "魔剣士たちが、三日間この灯を絶やさず守り抜いてきました。",
        "**最終24時間。そのバトンを、冥獄城全体へ引き渡します。**",
        "",
        "ここから先は役職を問いません。誰が継いでも構わない。",
        "少しだけ話す。次の誰かが来るまでつなぐ。抜けて、また戻る。",
        "**そのすべてが「つないだ」ということです。**",
        "",
        vcStatusLine(vc),
        "",
        `終了 <t:${endUnix}:R>（<t:${endUnix}:F>）`,
      ].join("\n"),
    )
    .setFooter({ text: "冥獄城 72時間耐久 — 最後の瞬間まで、バトンを絶やさない" });
}

function panelButtons(phase: Phase): ActionRowBuilder<ButtonBuilder>[] {
  if (phase === "done") return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("e72:baton").setLabel("バトンを引き継ぐ").setEmoji("🔥").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("e72:notify").setLabel("終了10分前に通知").setEmoji("🔔").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** 現在時刻に合わせたパネル本体（embed + 画像 + ボタン）を組み立てる */
function buildPanel(client: Client, nowMs: number) {
  const phase = phaseAt(nowMs);
  const vc = getVoiceChannel(client);
  let file: AttachmentBuilder;
  if (phase === "done") {
    file = new AttachmentBuilder(renderCompletePng(), { name: "countdown.png" });
  } else {
    // 次の1分ぶん（60フレーム）。秒が動いて見える
    file = new AttachmentBuilder(
      renderCountdownGif({ startMs: nowMs, endMs: END_MS, finalStartMs: FINAL_START_MS, phase }),
      { name: "countdown.gif" },
    );
  }
  return { embeds: [panelEmbed(nowMs, phase, vc)], components: panelButtons(phase), files: [file] };
}

function getVoiceChannel(client: Client): VoiceBasedChannel | null {
  const ch = client.channels.cache.get(EVENT_CONFIG.voiceChannelId);
  return ch && ch.isVoiceBased() ? ch : null;
}

async function getPanelChannel(client: Client): Promise<TextChannel | null> {
  const ch = await client.channels.fetch(EVENT_CONFIG.panelChannelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) {
    console.error(`${LOG} パネル投稿先が見つからないかテキストチャンネルではありません: ${EVENT_CONFIG.panelChannelId}`);
    return null;
  }
  return ch;
}

// ─────────────────────────────────────────────────────
// パネルの投稿・更新・追従
// ─────────────────────────────────────────────────────

let moveTimer: NodeJS.Timeout | null = null;
let panelBusy = false;
let movePending = false;

/** 既存パネルを編集。無ければ新規投稿。常に1件だけ残す */
async function updatePanel(client: Client, services: Services, opts: { repost?: boolean } = {}): Promise<void> {
  if (panelBusy) {
    // 追従(repost)要求だけは取りこぼさない。単なる再描画は次の定期更新で追いつくので捨てる
    if (opts.repost) movePending = true;
    return;
  }
  panelBusy = true;
  try {
    const channel = await getPanelChannel(client);
    if (!channel) return;
    const state = loadState(services);
    const nowMs = Date.now();
    const payload = buildPanel(client, nowMs);

    if (!opts.repost && state.panelMessageId) {
      const msg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
      if (msg) {
        // attachments:[] で既存の添付を必ず破棄する。付けないと編集のたびに添付が積み上がり、
        // 同名参照(attachment://countdown.gif)が古い画像に解決されてカウントダウンが止まって見える
        await msg.edit({ ...payload, attachments: [] });
        return;
      }
      console.warn(`${LOG} 既存パネル(${state.panelMessageId})が見つかりません。新規投稿します`);
    }

    const sent = await channel.send(payload);
    const oldId = state.panelMessageId;
    state.panelMessageId = sent.id;
    state.lastPanelMoveAt = nowMs;
    saveState(services, state);
    console.log(`${LOG} パネル${opts.repost ? "再投稿(追従)" : "作成"}: ${sent.id}`);

    if (oldId && oldId !== sent.id) {
      const old = await channel.messages.fetch(oldId).catch(() => null);
      if (old) {
        await old.delete().catch((e) => console.error(`${LOG} 古いパネルの削除に失敗(${oldId}):`, e?.message ?? e));
      }
    }
    await cleanupStrayPanels(channel, services, sent.id);
  } catch (e) {
    console.error(`${LOG} パネル更新に失敗:`, e);
  } finally {
    panelBusy = false;
    if (movePending) {
      movePending = false;
      // 処理中に来た分は、必要ならもう一度だけ追従
      setTimeout(() => void updatePanel(client, services, { repost: true }).catch(() => undefined), 300);
    }
  }
}

/** 取り残された古いパネルを回収（削除失敗などで複数残った場合の復旧） */
async function cleanupStrayPanels(channel: TextChannel, services: Services, keepId: string): Promise<void> {
  try {
    const recent = await channel.messages.fetch({ limit: 30 });
    const strays = recent.filter(
      (m) => m.id !== keepId && m.author.id === channel.client.user?.id && m.embeds.some((e) => (e.title ?? "").includes("七十二時間耐久") || (e.footer?.text ?? "").includes("72時間耐久")),
    );
    for (const [, m] of strays) {
      await m.delete().catch(() => undefined);
      console.log(`${LOG} 余分なパネルを回収: ${m.id}`);
    }
  } catch {
    /* 回収は best-effort */
  }
}

/** パネル投稿チャンネルにユーザー発言 → 2秒デバウンスで最下部へ移動 */
export function handleEvent72Message(message: Message, services: Services): void {
  if (message.channelId !== EVENT_CONFIG.panelChannelId) return;
  if (message.author.bot) return; // 自分の投稿で無限ループしない
  const nowMs = Date.now();
  if (nowMs >= END_MS) return;
  if (phaseAt(nowMs) === "one") return; // 残り1分は再投稿による事故を避けて追従停止
  const state = loadState(services);
  if (state.finalized) return;

  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    moveTimer = null;
    void updatePanel(message.client, services, { repost: true }).catch((e) => console.error(`${LOG} 追従失敗:`, e));
  }, 2000);
}

// ─────────────────────────────────────────────────────
// VC参加の記録
// ─────────────────────────────────────────────────────

function inWindow(ms: number): boolean {
  return ms >= FINAL_START_MS && ms <= END_MS;
}

/** セッションを閉じて滞在秒を加算する */
function closeSession(state: Event72State, userId: string, atMs: number): number {
  const joined = state.activeVoiceSessions[userId];
  if (joined === undefined) return 0;
  delete state.activeVoiceSessions[userId];
  const from = Math.max(joined, FINAL_START_MS);
  const to = Math.min(atMs, END_MS);
  const sec = Math.max(0, Math.floor((to - from) / 1000));
  if (sec > 0) state.voiceParticipation[userId] = (state.voiceParticipation[userId] ?? 0) + sec;
  return sec;
}

export function handleEvent72Voice(oldState: VoiceState, newState: VoiceState, services: Services): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;
  const target = EVENT_CONFIG.voiceChannelId;
  const was = oldState.channelId === target;
  const is = newState.channelId === target;
  if (!was && !is) return;

  const nowMs = Date.now();
  const state = loadState(services);

  if (!was && is) {
    if (!inWindow(nowMs)) return;
    state.activeVoiceSessions[member.id] = nowMs;
    saveState(services, state);
    console.log(`${LOG} VC入室: ${member.user.tag}`);
  } else if (was && !is) {
    const sec = closeSession(state, member.id, nowMs);
    saveState(services, state);
    const total = state.voiceParticipation[member.id] ?? 0;
    console.log(`${LOG} VC退室: ${member.user.tag} / 今回 ${sec}秒 / 通算 ${total}秒`);
  }
  // 状態表示を反映。入退室が連続してもGIF再生成と編集が集中しないよう5秒に集約する
  scheduleVcRefresh(newState.client, services);
}

let vcRefreshTimer: NodeJS.Timeout | null = null;

/** VC状態変化によるパネル再描画をまとめる（レート制限とCPUの保護） */
function scheduleVcRefresh(client: Client, services: Services): void {
  if (vcRefreshTimer) return; // 既に予約済みなら束ねる
  vcRefreshTimer = setTimeout(() => {
    vcRefreshTimer = null;
    if (Date.now() >= END_MS) return;
    void updatePanel(client, services).catch(() => undefined);
  }, 5000);
}

/** 起動時、既に対象VCにいる人のセッションを復旧する */
function recoverSessions(client: Client, services: Services): void {
  const nowMs = Date.now();
  if (!inWindow(nowMs)) return;
  const vc = getVoiceChannel(client);
  if (!vc) return;
  const state = loadState(services);
  let n = 0;
  for (const [, m] of vc.members) {
    if (m.user.bot) continue;
    if (state.activeVoiceSessions[m.id] === undefined) {
      state.activeVoiceSessions[m.id] = nowMs;
      n++;
    }
  }
  if (n > 0) {
    saveState(services, state);
    console.log(`${LOG} 復旧: 対象VC在室 ${n}名のセッションを再開`);
  }
}

// ─────────────────────────────────────────────────────
// ボタン
// ─────────────────────────────────────────────────────

export async function handleEvent72Button(interaction: ButtonInteraction, services: Services): Promise<void> {
  const action = interaction.customId.split(":")[1];

  if (action === "baton") {
    const guildId = interaction.guildId;
    const link = guildId ? `https://discord.com/channels/${guildId}/${EVENT_CONFIG.voiceChannelId}` : null;
    await interaction.reply({
      content: [
        "### 🔥 バトンを受け取りました",
        `下のVCへ入れば、その瞬間からあなたが灯の担い手です。`,
        "",
        link ? `**→ ${link}**` : `**→ <#${EVENT_CONFIG.voiceChannelId}>**`,
        "",
        "一言でも、少しの時間でも構いません。次の誰かへ渡すまでが、あなたの番です。",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "notify") {
    const member = interaction.member as GuildMember | null;
    if (!member) {
      await interaction.reply({ content: "サーバー内で押してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const has = member.roles.cache.has(EVENT_CONFIG.notificationRoleId);
    try {
      if (has) {
        await member.roles.remove(EVENT_CONFIG.notificationRoleId);
        console.log(`${LOG} 最終通知ロール解除: ${member.user.tag}`);
        await interaction.reply({ content: "最終通知を解除しました。", flags: MessageFlags.Ephemeral });
      } else {
        await member.roles.add(EVENT_CONFIG.notificationRoleId);
        console.log(`${LOG} 最終通知ロール付与: ${member.user.tag}`);
        await interaction.reply({ content: "終了10分前の通知を設定しました。", flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error(`${LOG} 最終通知ロールの変更に失敗（Botのロール順位/Manage Rolesを確認）:`, e);
      await interaction.reply({
        content: "ロールを変更できませんでした。運営へ連絡してください（Botの権限不足の可能性）。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
}

// ─────────────────────────────────────────────────────
// 残り10分通知・終了処理
// ─────────────────────────────────────────────────────

async function sendTenMinuteNotice(client: Client, services: Services): Promise<void> {
  const state = loadState(services);
  if (state.tenMinuteNotificationSent) return;
  const channel = await getPanelChannel(client);
  if (!channel) return;
  // 先に永続化して二重送信を防ぐ
  state.tenMinuteNotificationSent = true;
  saveState(services, state);
  await channel
    .send({
      content: `<@&${EVENT_CONFIG.notificationRoleId}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(0xff8a5c)
          .setTitle("🔔 残り10分 — 最後のバトンへ")
          .setDescription(
            [
              "**72時間耐久の終了まで、残り10分。**",
              "",
              "最後のバトンをつなぎ、72時間到達をその場で一緒に迎えましょう。",
              `**→ <#${EVENT_CONFIG.voiceChannelId}>**`,
            ].join("\n"),
          ),
      ],
      allowedMentions: { roles: [EVENT_CONFIG.notificationRoleId] },
    })
    .catch((e) => console.error(`${LOG} 残り10分通知の送信に失敗:`, e));
  console.log(`${LOG} 残り10分通知を送信しました`);
}

/** 終了処理（多重実行防止つき） */
async function finalize(client: Client, services: Services): Promise<void> {
  let state = loadState(services);
  if (state.finalized) return;
  // 先に立てて二重実行を防ぐ
  state.finalized = true;
  saveState(services, state);
  console.log(`${LOG} 終了処理を開始します`);

  // 進行中セッションを確定
  state = loadState(services);
  const nowMs = Date.now();
  for (const userId of Object.keys(state.activeVoiceSessions)) {
    const sec = closeSession(state, userId, nowMs);
    if (sec > 0) console.log(`${LOG} 滞在確定: ${userId} +${sec}秒`);
  }
  saveState(services, state);

  // 完走パネルへ差し替え
  await updatePanel(client, services).catch((e) => console.error(`${LOG} 完走パネルへの差し替え失敗:`, e));

  const guild = client.guilds.cache.get((await getPanelChannel(client))?.guildId ?? "") ?? null;
  if (!guild) {
    console.error(`${LOG} ギルドを取得できず、ロール処理をスキップしました`);
    return;
  }

  // 記念ロール付与
  let granted = 0;
  let skipped = 0;
  let failed = 0;
  for (const [userId, sec] of Object.entries(state.voiceParticipation)) {
    if (sec < EVENT_CONFIG.memorialMinimumStaySeconds) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      failed++;
      console.error(`${LOG} 七十二時の炎: メンバー取得失敗 ${userId}（退出済み？）`);
      continue;
    }
    if (member.roles.cache.has(EVENT_CONFIG.memorialRoleId)) {
      skipped++;
      continue;
    }
    try {
      await member.roles.add(EVENT_CONFIG.memorialRoleId);
      granted++;
      console.log(`${LOG} 七十二時の炎を付与: ${member.user.tag}（${sec}秒）`);
    } catch (e) {
      failed++;
      console.error(`${LOG} 七十二時の炎の付与に失敗 ${member.user.tag}（Botのロール順位を確認）:`, e);
    }
  }
  console.log(`${LOG} 記念ロール: 付与${granted} / 既保持${skipped} / 失敗${failed}`);

  // 最終通知ロールを全員から解除（ロール自体は消さない）
  let removed = 0;
  const holders = guild.roles.cache.get(EVENT_CONFIG.notificationRoleId)?.members;
  if (holders) {
    for (const [, m] of holders) {
      try {
        await m.roles.remove(EVENT_CONFIG.notificationRoleId);
        removed++;
      } catch (e) {
        console.error(`${LOG} 最終通知ロールの解除に失敗 ${m.user.tag}:`, e);
      }
    }
  }
  console.log(`${LOG} 最終通知ロールを ${removed}名から解除しました`);
  console.log(`${LOG} 終了処理が完了しました（最終パネルは記録として残します）`);
}

// ─────────────────────────────────────────────────────
// 起動・定期実行
// ─────────────────────────────────────────────────────

let loopTimer: NodeJS.Timeout | null = null;

function scheduleNext(client: Client, services: Services): void {
  // 毎分の頭に合わせる（GIFが60秒ぶんなので1分間隔で十分）
  const now = Date.now();
  const delay = Math.max(1000, 60_000 - (now % 60_000));
  loopTimer = setTimeout(() => void loop(client, services), delay);
}

async function loop(client: Client, services: Services): Promise<void> {
  try {
    const nowMs = Date.now();
    const state = loadState(services);

    if (nowMs >= END_MS) {
      if (!state.finalized) await finalize(client, services);
      if (loopTimer) clearTimeout(loopTimer);
      loopTimer = null;
      console.log(`${LOG} イベント終了。定期更新を停止しました`);
      return;
    }

    const remain = END_MS - nowMs;
    if (remain <= 10 * 60_000 && !state.tenMinuteNotificationSent) {
      await sendTenMinuteNotice(client, services);
    }
    await updatePanel(client, services);
  } catch (e) {
    console.error(`${LOG} 定期更新でエラー:`, e);
  } finally {
    if (Date.now() < END_MS) scheduleNext(client, services);
  }
}

/** 起動時のエントリポイント。ClientReady から呼ぶ */
export async function startEvent72(client: Client, services: Services): Promise<void> {
  const nowMs = Date.now();
  const state = loadState(services);

  if (nowMs >= END_MS) {
    if (!state.finalized) {
      console.log(`${LOG} 復旧: 終了時刻を過ぎています。終了処理を実行します`);
      await finalize(client, services);
    } else {
      console.log(`${LOG} イベントは終了済みです（何もしません）`);
    }
    return;
  }
  if (nowMs < FINAL_START_MS) {
    const wait = FINAL_START_MS - nowMs;
    console.log(`${LOG} 最終24時間の開始まで ${formatRemain(wait / 1000)}。開始時刻に起動します`);
    setTimeout(() => void startEvent72(client, services), Math.min(wait, 2_147_000_000));
    return;
  }

  console.log(`${LOG} 起動: 残り ${formatRemain((END_MS - nowMs) / 1000)} / フェーズ ${phaseAt(nowMs)}`);
  recoverSessions(client, services);
  await updatePanel(client, services);
  scheduleNext(client, services);
}
