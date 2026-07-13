import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type User,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET } from "./common.js";
import { collectStakes, refundAll, settlePvp, settleProportional } from "./pvp-common.js";
import { C_JACKPOT, C_LOSE, C_MAMMON, C_WIN } from "./ui.js";

/**
 * 🃏 5枚交換ポーカー（casino-bot 準拠 PvP）。
 * サシ（相手指定・1v1）と オープン（未指定・2〜6人募集）の2モード。
 * - 5枚配布 → 各自 select menu で 0〜5枚を交換 → 全員確定で開示
 * - 最強役の勝者が pot 総取り。同役は tiebreak（category + kicker）比較
 * - 完全同点の場合は勝者間で山分け
 * - 場代 3% → JPプール（pvp-common の settlePvp / settleProportional 経由）
 */
const RAKE_PCT = 0.03;
const MIN_OPEN = 2;
const MAX_OPEN = 6;
const OPEN_LOBBY_MS = 5 * 60_000; // 5分募集
const DEAL_TIMEOUT_MS = 3 * 60_000; // 配布後の交換猶予

// ─── カード / 役判定 ────────────────────────────────
const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANK_LABEL = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
type Suit = (typeof SUITS)[number];
interface Card {
  suit: Suit;
  rank: number; // 2..14
}
const showCard = (c: Card) => `${c.suit}${RANK_LABEL[c.rank]}`;
const handStr = (h: Card[]) => h.map(showCard).join("  ");

function newDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ suit: s, rank: r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}

interface HandEval {
  category: number; // 1..10 (10=ロイヤル)
  tiebreak: number[];
  label: string;
}
const CAT_LABELS = [
  "",
  "ハイカード",
  "ペア",
  "ツーペア",
  "3カード",
  "ストレート",
  "フラッシュ",
  "フルハウス",
  "4カード",
  "ストレートフラッシュ",
  "ロイヤルフラッシュ",
] as const;

function evaluate5(hand: Card[]): HandEval {
  const ranks = hand.map((c) => c.rank).sort((a, b) => b - a);
  const suitCount: Record<string, number> = {};
  for (const c of hand) suitCount[c.suit] = (suitCount[c.suit] ?? 0) + 1;
  const isFlush = Object.values(suitCount).some((n) => n === 5);
  const unique = Array.from(new Set(ranks)).sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) {
      isStraight = true;
      straightHigh = unique[0]!;
    } else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      isStraight = true;
      straightHigh = 5;
    }
  }
  const rankCount: Record<number, number> = {};
  for (const r of ranks) rankCount[r] = (rankCount[r] ?? 0) + 1;
  const groups = Object.entries(rankCount)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  let cat = 1;
  let tb: number[] = ranks;
  if (isStraight && isFlush && straightHigh === 14) {
    cat = 10;
    tb = [14];
  } else if (isStraight && isFlush) {
    cat = 9;
    tb = [straightHigh];
  } else if (groups[0]!.count === 4) {
    cat = 8;
    tb = [groups[0]!.rank, groups[1]!.rank];
  } else if (groups[0]!.count === 3 && groups[1]?.count === 2) {
    cat = 7;
    tb = [groups[0]!.rank, groups[1]!.rank];
  } else if (isFlush) {
    cat = 6;
    tb = ranks;
  } else if (isStraight) {
    cat = 5;
    tb = [straightHigh];
  } else if (groups[0]!.count === 3) {
    cat = 4;
    tb = [groups[0]!.rank, ...groups.slice(1).map((g) => g.rank)];
  } else if (groups[0]!.count === 2 && groups[1]?.count === 2) {
    cat = 3;
    tb = [groups[0]!.rank, groups[1]!.rank, groups[2]!.rank];
  } else if (groups[0]!.count === 2) {
    cat = 2;
    tb = [groups[0]!.rank, ...groups.slice(1).map((g) => g.rank)];
  }
  return { category: cat, tiebreak: tb, label: CAT_LABELS[cat] ?? "不明" };
}

function compareEval(a: HandEval, b: HandEval): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const x = a.tiebreak[i] ?? 0;
    const y = b.tiebreak[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ─── セッション ────────────────────────────────────
interface PlayerState {
  hand: Card[];
  discardDone: boolean;
  finalHand?: Card[];
  ev?: HandEval;
}
interface Session {
  id: string;
  mode: "sashi" | "open";
  bet: number;
  hostId: string;
  opponentId?: string; // sashi のみ
  channelId: string;
  messageId?: string;
  phase: "pending" | "open" | "dealt" | "settled" | "void";
  players: Map<string, PlayerState>; // key: userId
  createdAt: number;
}
const sessions = new Map<string, Session>();

const setPhase = (s: Session, p: Session["phase"]) => { s.phase = p; };

// ─── エントリ ─────────────────────────────────────
export async function playPokerDuel(
  interaction: ChatInputCommandInteraction,
  services: Services,
  opponent: User | null,
  bet: number,
): Promise<void> {
  const uid = interaction.user.id;
  if (bet < MIN_BET || bet > MAX_BET) {
    await interaction.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (opponent && (opponent.bot || opponent.id === uid)) {
    await interaction.reply({ content: "自分やボットには挑めない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.ether.balanceOf(uid) < bet) {
    await interaction.reply({ content: "自分のエテル残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.id;
  const session: Session = {
    id,
    mode: opponent ? "sashi" : "open",
    bet,
    hostId: uid,
    opponentId: opponent?.id,
    channelId: interaction.channelId,
    phase: opponent ? "pending" : "open",
    players: new Map(),
    createdAt: Date.now(),
  };

  if (session.mode === "sashi") {
    await interaction.reply({
      content: `<@${opponent!.id}>`,
      embeds: [buildSashiInvite(session, opponent!.id)],
      components: [sashiRow(id)],
    });
  } else {
    // オープン: host は自動参加でエスクロー
    if (!collectStakes(services, [uid], bet)) {
      await interaction.reply({ content: "エテル徴収に失敗した。", flags: MessageFlags.Ephemeral });
      return;
    }
    session.players.set(uid, { hand: [], discardDone: false });
    await interaction.reply({ embeds: [buildOpenLobby(session)], components: openLobbyRow(id) });
  }
  const msg = (await interaction.fetchReply()) as Message;
  session.messageId = msg.id;
  sessions.set(id, session);

  // タイムアウト: sashi は 5分無応答で void、open は 5分で自動締切試行 or void
  setTimeout(() => tryTimeout(interaction.client, id, services), OPEN_LOBBY_MS).unref();
}

async function tryTimeout(client: import("discord.js").Client, id: string, services: Services): Promise<void> {
  const s = sessions.get(id);
  if (!s || s.phase !== "pending" && s.phase !== "open") return;
  if (s.phase === "pending") {
    // sashi 未応答 → void
    setPhase(s, "void");
    await editMessage(client, s, {
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "マモンの賭場 · ポーカー" })
          .setColor(C_LOSE)
          .setTitle("🃏  不成立")
          .setDescription(`<@${s.opponentId}> が受けなかった。挑戦は流れた。`),
      ],
      components: [],
    });
    sessions.delete(id);
    return;
  }
  // open: 参加者数チェック
  if (s.players.size >= MIN_OPEN) {
    // 自動締切
    await autoDeal(client, s, services);
    return;
  } else {
    // 参加不足 → 全員返金
    setPhase(s, "void");
    for (const uid of s.players.keys()) refundAll(services, [uid], s.bet);
    await editMessage(client, s, {
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "マモンの賭場 · ポーカー" })
          .setColor(C_LOSE)
          .setTitle("🃏  不成立")
          .setDescription(`5分で ${MIN_OPEN}人集まらなかった。参加者に全額返金。`),
      ],
      components: [],
    });
    sessions.delete(id);
  }
}

// ─── サシ ─────────────────────────────────────────
function buildSashiInvite(s: Session, opponentId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · ポーカー" })
    .setColor(C_MAMMON)
    .setTitle(`🃏  サシ勝負  ·  ${fmtEther(s.bet).replace(" ◈", "◈")}`)
    .setDescription(
      [
        `<@${s.hostId}> が <@${opponentId}> にポーカーを挑んだ。`,
        "",
        `**賭け金**: ${fmtEther(s.bet)}（両者から徴収・勝者総取り）`,
        `**受ける** で対戦開始（5分無応答は不成立）`,
      ].join("\n"),
    )
    .addFields({
      name: "▸ 遊び方",
      value: "　5枚配布 → 0〜5枚を交換 → 役比較で勝者総取り\n　場代 3% は JPプールへ",
      inline: false,
    });
}

function sashiRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pkr:accept:${id}`).setLabel("受ける").setStyle(ButtonStyle.Success).setEmoji("🃏"),
    new ButtonBuilder().setCustomId(`pkr:decline:${id}`).setLabel("辞退").setStyle(ButtonStyle.Secondary),
  );
}

// ─── オープン ─────────────────────────────────────
function buildOpenLobby(s: Session): EmbedBuilder {
  const players = [...s.players.keys()];
  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · ポーカー" })
    .setColor(C_MAMMON)
    .setTitle(`🃏  オープン募集  ·  ${fmtEther(s.bet).replace(" ◈", "◈")}`)
    .setDescription(
      [
        `立て主: <@${s.hostId}>  ·  参加費: **${fmtEther(s.bet).replace(" ◈", "◈")}**`,
        "",
        `参加者（${players.length}/${MAX_OPEN}人）:`,
        players.length === 0 ? "　（まだいない）" : players.map((p) => `　・<@${p}>`).join("\n"),
      ].join("\n"),
    )
    .addFields({
      name: "▸ 遊び方",
      value: `　**${MIN_OPEN}人以上**集まれば立て主が「🎴 締切→配布」で開始\n　5枚配布 → 0〜5枚を交換 → 役比較で勝者総取り（場代3%）`,
      inline: false,
    })
    .setFooter({ text: `${MAX_OPEN}人まで  ·  5分で自動締切（${MIN_OPEN}人未満なら不成立）` });
}

function openLobbyRow(id: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pkr:join:${id}`).setLabel("🃏 参加").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pkr:leave:${id}`).setLabel("🚪 抜ける").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`pkr:deal:${id}`).setLabel("🎴 締切→配布").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`pkr:cancel:${id}`).setLabel("❌ 中止").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ─── ボタン ハンドラ ─────────────────────────────
export async function handlePokerDuelButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // pkr:action:id[:extra]
  const action = parts[1]!;
  const id = parts[2]!;
  const s = sessions.get(id);
  if (!s) {
    await interaction.reply({ content: "その勝負はもう無い。", flags: MessageFlags.Ephemeral });
    return;
  }
  switch (action) {
    case "accept": return sashiAccept(interaction, services, s);
    case "decline": return sashiDecline(interaction, s);
    case "join": return openJoin(interaction, services, s);
    case "leave": return openLeave(interaction, services, s);
    case "deal": return openDeal(interaction, services, s);
    case "cancel": return openCancel(interaction, services, s);
    case "hand": return showHand(interaction, s);
  }
}

async function sashiAccept(interaction: ButtonInteraction, services: Services, s: Session): Promise<void> {
  if (s.mode !== "sashi") return;
  if (interaction.user.id !== s.opponentId) {
    await interaction.reply({ content: "申し込まれた本人だけが受けられる。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (s.phase !== "pending") {
    await interaction.reply({ content: "もう受付は終わっている。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 両者から徴収
  if (!collectStakes(services, [s.hostId, s.opponentId], s.bet)) {
    await interaction.reply({ content: "どちらかのエテル残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }
  s.players.set(s.hostId, { hand: [], discardDone: false });
  s.players.set(s.opponentId, { hand: [], discardDone: false });
  await interaction.deferUpdate();
  await dealHands(interaction, s, services);
}

async function sashiDecline(interaction: ButtonInteraction, s: Session): Promise<void> {
  if (s.mode !== "sashi") return;
  if (interaction.user.id !== s.opponentId) {
    await interaction.reply({ content: "申し込まれた本人だけが操作できる。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (s.phase !== "pending") {
    await interaction.reply({ content: "もう受付は終わっている。", flags: MessageFlags.Ephemeral });
    return;
  }
  setPhase(s, "void");
  await interaction.update({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ポーカー" })
        .setColor(C_LOSE)
        .setTitle("🃏  辞退")
        .setDescription(`<@${s.opponentId}> が辞退した。挑戦は流れた。`),
    ],
    components: [],
  });
  sessions.delete(s.id);
}

async function openJoin(interaction: ButtonInteraction, services: Services, s: Session): Promise<void> {
  if (s.mode !== "open" || s.phase !== "open") {
    await interaction.reply({ content: "もう募集していない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const uid = interaction.user.id;
  if (s.players.has(uid)) {
    await interaction.reply({ content: "もう参加している。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (s.players.size >= MAX_OPEN) {
    await interaction.reply({ content: `定員 ${MAX_OPEN}人。`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (services.ether.balanceOf(uid) < s.bet) {
    await interaction.reply({ content: "エテル残高が足りない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!collectStakes(services, [uid], s.bet)) {
    await interaction.reply({ content: "徴収に失敗した。", flags: MessageFlags.Ephemeral });
    return;
  }
  s.players.set(uid, { hand: [], discardDone: false });
  await interaction.update({ embeds: [buildOpenLobby(s)], components: openLobbyRow(s.id) });
}

async function openLeave(interaction: ButtonInteraction, services: Services, s: Session): Promise<void> {
  if (s.mode !== "open" || s.phase !== "open") {
    await interaction.reply({ content: "もう抜けられない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const uid = interaction.user.id;
  if (!s.players.has(uid)) {
    await interaction.reply({ content: "まだ参加していない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (uid === s.hostId) {
    await interaction.reply({ content: "立て主は「❌ 中止」で全員返金してから。", flags: MessageFlags.Ephemeral });
    return;
  }
  refundAll(services, [uid], s.bet);
  s.players.delete(uid);
  await interaction.update({ embeds: [buildOpenLobby(s)], components: openLobbyRow(s.id) });
}

async function openCancel(interaction: ButtonInteraction, services: Services, s: Session): Promise<void> {
  if (s.mode !== "open" || s.phase !== "open") {
    await interaction.reply({ content: "もう中止できない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== s.hostId) {
    await interaction.reply({ content: "立て主だけが中止できる。", flags: MessageFlags.Ephemeral });
    return;
  }
  setPhase(s, "void");
  for (const uid of s.players.keys()) refundAll(services, [uid], s.bet);
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ポーカー" })
        .setColor(C_LOSE)
        .setTitle("🃏  中止")
        .setDescription("立て主が中止した。参加者に全額返金。"),
    ],
    components: [],
  });
  sessions.delete(s.id);
}

async function openDeal(interaction: ButtonInteraction, services: Services, s: Session): Promise<void> {
  if (s.mode !== "open" || s.phase !== "open") {
    await interaction.reply({ content: "もう締切は受け付けない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== s.hostId) {
    await interaction.reply({ content: "立て主だけが締切れる。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (s.players.size < MIN_OPEN) {
    await interaction.reply({ content: `最低 ${MIN_OPEN}人 必要。`, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  await dealHands(interaction, s, services);
}

async function autoDeal(client: import("discord.js").Client, s: Session, services: Services): Promise<void> {
  if (s.phase !== "open" || s.players.size < MIN_OPEN) return;
  await dealHandsFromClient(client, s, services);
}

// ─── 配布 ────────────────────────────────────────
async function dealHands(interaction: ButtonInteraction, s: Session, services: Services): Promise<void> {
  const deck = newDeck();
  for (const p of s.players.values()) {
    p.hand = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
    p.discardDone = false;
  }
  setPhase(s, "dealt");
  await interaction.editReply({ embeds: [buildDealtPanel(s)], components: [dealtRow(s.id)] });
  // 交換フェーズのタイムアウト → 未確定分をオール・ステイで強制精算
  setTimeout(() => void forceSettle(interaction.client, s.id, services), DEAL_TIMEOUT_MS).unref();
}

async function dealHandsFromClient(client: import("discord.js").Client, s: Session, services: Services): Promise<void> {
  const deck = newDeck();
  for (const p of s.players.values()) {
    p.hand = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
    p.discardDone = false;
  }
  setPhase(s, "dealt");
  await editMessage(client, s, { embeds: [buildDealtPanel(s)], components: [dealtRow(s.id)] });
  setTimeout(() => void forceSettle(client, s.id, services), DEAL_TIMEOUT_MS).unref();
}

function buildDealtPanel(s: Session): EmbedBuilder {
  const players = [...s.players.entries()];
  const pot = s.bet * players.length;
  return new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · ポーカー" })
    .setColor(C_MAMMON)
    .setTitle(`🎴  配布完了  ·  Pot ${fmtEther(pot).replace(" ◈", "◈")}`)
    .setDescription(
      [
        `参加 ${players.length}人  ·  賭け ${fmtEther(s.bet).replace(" ◈", "◈")}  ·  場代 ${Math.round(RAKE_PCT * 100)}%`,
        "",
        players.map(([uid, p]) => `${p.discardDone ? "✋ 確定" : "…待機"}  <@${uid}>`).join("\n"),
        "",
        "下の **「🃏 手札を見る」** から自分の手札を見て0〜5枚を交換する。",
        `全員が確定したら自動で開示（3分で強制精算）。`,
      ].join("\n"),
    );
}

function dealtRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pkr:hand:${id}`).setLabel("🃏 手札を見る / 交換").setStyle(ButtonStyle.Primary),
  );
}

// ─── 手札表示 / 交換選択 ─────────────────────────
async function showHand(interaction: ButtonInteraction, s: Session): Promise<void> {
  if (s.phase !== "dealt") {
    await interaction.reply({ content: "いまは手札を見られない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const p = s.players.get(interaction.user.id);
  if (!p) {
    await interaction.reply({ content: "この勝負に参加していない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (p.discardDone) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "マモンの賭場 · ポーカー" })
          .setColor(C_MAMMON)
          .setTitle("🃏  手札（確定済み）")
          .setDescription(`${handStr(p.finalHand ?? p.hand)}\n\n*もう交換は終わっている。他の人を待て。*`),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const sel = new StringSelectMenuBuilder()
    .setCustomId(`pkr:discard:${s.id}`)
    .setPlaceholder("交換したい札を選ぶ（0〜5枚）")
    .setMinValues(0)
    .setMaxValues(5)
    .addOptions(p.hand.map((c, i) => ({ label: showCard(c), description: `${i + 1}枚目`, value: String(i) })));
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ポーカー" })
        .setColor(C_MAMMON)
        .setTitle("🃏  お前の手札")
        .setDescription(
          [
            `**${handStr(p.hand)}**`,
            "",
            "交換したい札を選んで **決定**。何も選ばずに決定でオール・ステイ。",
          ].join("\n"),
        ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── select 送信 ─────────────────────────────────
export async function handlePokerDuelSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const parts = interaction.customId.split(":"); // pkr:discard:id
  if (parts[1] !== "discard") return;
  const id = parts[2]!;
  const s = sessions.get(id);
  if (!s || s.phase !== "dealt") {
    await interaction.reply({ content: "いまは交換できない。", flags: MessageFlags.Ephemeral });
    return;
  }
  const p = s.players.get(interaction.user.id);
  if (!p) {
    await interaction.reply({ content: "この勝負に参加していない。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (p.discardDone) {
    await interaction.reply({ content: "もう交換は終わっている。", flags: MessageFlags.Ephemeral });
    return;
  }
  const indices = interaction.values.map(Number).filter((n) => n >= 0 && n < 5);

  // 全プレイヤーの手札を使用済みとし、残りから補充
  const used = new Set<string>();
  for (const pp of s.players.values()) for (const c of pp.hand) used.add(`${c.suit}${c.rank}`);
  const remaining = newDeck().filter((c) => !used.has(`${c.suit}${c.rank}`));
  const newHand = p.hand.map((c, i) => (indices.includes(i) ? remaining.pop()! : c));

  p.finalHand = newHand;
  p.ev = evaluate5(newHand);
  p.discardDone = true;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ポーカー" })
        .setColor(C_WIN)
        .setTitle(`🃏  交換完了  ·  ${indices.length}枚`)
        .setDescription(
          [
            `お前の手  ·  **${handStr(newHand)}**`,
            `役  ·  **${p.ev.label}**`,
            "",
            "*他の人を待て。全員終わったら自動で開示される。*",
          ].join("\n"),
        ),
    ],
    components: [],
  }).catch(() => undefined);

  // 全員終了 → 精算
  const allDone = [...s.players.values()].every((pp) => pp.discardDone);
  if (allDone) {
    await settleGame(interaction.client, s, services);
  } else {
    // 配布パネル更新
    await editMessage(interaction.client, s, { embeds: [buildDealtPanel(s)], components: [dealtRow(s.id)] });
  }
}

// ─── 精算 ────────────────────────────────────────
async function settleGame(client: import("discord.js").Client, s: Session, services: Services): Promise<void> {
  if (s.phase !== "dealt") return;
  setPhase(s, "settled");
  const entries = [...s.players.entries()].map(([uid, p]) => ({
    userId: uid,
    hand: p.finalHand ?? p.hand,
    ev: p.ev ?? evaluate5(p.finalHand ?? p.hand),
  }));
  entries.sort((a, b) => compareEval(b.ev, a.ev));
  const top = entries[0]!.ev;
  const winners = entries.filter((e) => compareEval(e.ev, top) === 0);
  const losers = entries.filter((e) => !winners.includes(e));

  // 精算: 勝者複数なら比例配分（同額なので均等割）、単独ならサシと同じ settlePvp
  if (winners.length === 1 && losers.length === 1) {
    const w = winners[0]!;
    const { houseCut } = settlePvp(services, [w.userId], s.bet * entries.length);
    await postResult(client, s, entries, winners, houseCut);
    sessions.delete(s.id);
    return;
  }
  const { totalHouseCut } = settleProportional(
    services,
    winners.map((w) => ({ userId: w.userId, bet: s.bet })),
    losers.map((l) => ({ userId: l.userId, bet: s.bet })),
  );
  await postResult(client, s, entries, winners, totalHouseCut);
  sessions.delete(s.id);
}

async function postResult(
  client: import("discord.js").Client,
  s: Session,
  entries: Array<{ userId: string; hand: Card[]; ev: HandEval }>,
  winners: Array<{ userId: string; ev: HandEval }>,
  houseCut: number,
): Promise<void> {
  const totalPot = s.bet * entries.length;
  const isJp = winners[0]!.ev.category >= 10;
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · ポーカー" })
    .setColor(isJp ? C_JACKPOT : C_WIN)
    .setTitle(
      isJp
        ? `💎  ${winners[0]!.ev.label}！  ·  Pot ${fmtEther(totalPot).replace(" ◈", "◈")}`
        : winners.length === 1
          ? `🏆  <@${winners[0]!.userId}> の勝利  ·  Pot ${fmtEther(totalPot).replace(" ◈", "◈")}`
          : `🤝  ${winners.length}人で同役  ·  Pot ${fmtEther(totalPot).replace(" ◈", "◈")}`,
    );
  const lines = entries.map((e) => {
    const won = winners.includes(e);
    const mark = won ? "🏆" : "・";
    return `${mark}  <@${e.userId}>  ${handStr(e.hand)}  ·  **${e.ev.label}**`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({
    text:
      winners.length === 1
        ? `場代 ${fmtEther(houseCut).replace(" ◈", "◈")} → JPプール  ·  勝者総取り`
        : `場代 ${fmtEther(houseCut).replace(" ◈", "◈")} → JPプール  ·  ${winners.length}人で均等分配`,
  });
  const mentions = winners.map((w) => w.userId);
  await editMessage(client, s, {
    content: mentions.map((m) => `<@${m}>`).join(" "),
    embeds: [embed],
    components: [],
    allowedMentions: { users: mentions },
  });
}

async function forceSettle(client: import("discord.js").Client, id: string, services: Services): Promise<void> {
  const s = sessions.get(id);
  if (!s || s.phase !== "dealt") return;
  // 未確定は「オール・ステイ」として確定
  for (const p of s.players.values()) {
    if (!p.discardDone) {
      p.finalHand = p.hand;
      p.ev = evaluate5(p.hand);
      p.discardDone = true;
    }
  }
  await editMessage(client, s, {
    embeds: [
      new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ポーカー" })
        .setColor(C_LOSE)
        .setTitle("🃏  時間切れ  ·  自動精算")
        .setDescription("交換猶予（3分）を超過。未交換分はオール・ステイで確定。"),
    ],
    components: [],
  });
  await settleGame(client, s, services);
}

// ─── ユーティリティ ────────────────────────────
async function editMessage(client: import("discord.js").Client, s: Session, payload: import("discord.js").MessageEditOptions): Promise<void> {
  if (!s.messageId) return;
  try {
    const ch = await client.channels.fetch(s.channelId).catch(() => null);
    if (!ch || !("messages" in ch)) return;
    const msg = await ch.messages.fetch(s.messageId).catch(() => null);
    if (msg) await msg.edit(payload).catch(() => undefined);
  } catch {
    /* ignore */
  }
}
