import { EmbedBuilder } from "discord.js";
import { fmtEther, fmtLd } from "../format.js";

/**
 * マモンの賭場 デザインシステム。
 * 色・絵文字・フォーマッタ・罫線・共通embed パターンをここに集約する。
 * 目的:
 * - 全ゲームで視覚言語が揃う
 * - 勝敗の温度差が一目で分かる
 * - 数字の見せ方が統一される
 * - 情報の階層が明快
 */

// ─────────────────────────────────────────────────────────
// カラーパレット
// ─────────────────────────────────────────────────────────
/** マモンの金 — 中立/受付/情報 */
export const C_MAMMON = 0xc9a227;
/** 深い金 — VIP/ジャックポット */
export const C_JACKPOT = 0xf0b429;
/** 勝ちの緑 — 勝利/成立/success */
export const C_WIN = 0x22c55e;
/** 大勝ちの緑 — 高倍率/連勝ボーナス */
export const C_BIGWIN = 0x16a34a;
/** 負けの臙脂 — 敗北/失格 */
export const C_LOSE = 0x991b1b;
/** 燃え尽きた黒赤 — バースト/クラッシュ/最大負け */
export const C_BURST = 0x450a0a;
/** 引き分けの灰茶 — プッシュ/中立 */
export const C_PUSH = 0x78716c;
/** 静かな夜 — 案内/バランス表示 */
export const C_NIGHT = 0x1e1b4b;

// ─────────────────────────────────────────────────────────
// 絵文字（一貫して使うキー絵文字）
// ─────────────────────────────────────────────────────────
export const E = {
  // 通貨
  ether: "◈",
  land: "Ld",
  // 状態
  win: "🟢",
  lose: "🔴",
  push: "⚪",
  // アクション
  bet: "🎯",
  cashOut: "💰",
  fold: "🏳",
  call: "👉",
  check: "✋",
  hit: "🃏",
  stand: "✋",
  double: "⚡",
  // 表現
  jp: "💎",
  fire: "🔥",
  streak: "🔥",
  sparkle: "✨",
  crown: "👑",
  demon: "😈",
  moon: "🌙",
  // 統計
  up: "▲",
  down: "▼",
  flat: "─",
  chart: "📊",
  history: "📜",
  paytable: "📖",
  home: "🏛",
  retry: "🎰",
  quit: "🚪",
} as const;

// ─────────────────────────────────────────────────────────
// フォーマッタ
// ─────────────────────────────────────────────────────────

/** 符号付きエテル表示（+123◈ / -456◈ / ±0◈） */
export function fmtSignedEther(n: number): string {
  if (n === 0) return "±0 ◈";
  const sign = n > 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toLocaleString("ja-JP")} ◈`;
}

/** 差分（デルタ）を色付き ansi 風テキストで大きく見せる */
export function fmtBigDelta(n: number): string {
  if (n === 0) return `**±0 ${E.ether}**`;
  const sign = n > 0 ? "**+" : "**−";
  return `${sign}${Math.abs(n).toLocaleString("ja-JP")} ${E.ether}**`;
}

/** 倍率表示（1.05x なら `×1.05`、大きい場合は太字） */
export function fmtMult(m: number): string {
  const s = `×${m.toFixed(2)}`;
  return m >= 2 ? `**${s}**` : s;
}

/** 残高（所持）表示。エテルと Land を1行で */
export function fmtWallet(ether: number, land: number): string {
  return `${E.ether} ${fmtEther(ether)} ／ ${fmtLd(land)}`;
}

/** 進捗バー（ASCII）。value/max を width 文字幅で描画。使用例: 連続日数・XP */
export function bar(value: number, max: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / Math.max(1, max)) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

// ─────────────────────────────────────────────────────────
// 罫線・区切り
// ─────────────────────────────────────────────────────────
/** 太い区切り */
export const HR = "━".repeat(28);
/** 細い区切り */
export const HR_THIN = "─".repeat(28);
/** ドット区切り */
export const HR_DOT = "・".repeat(14);

/** セクション見出し（下線付き） */
export function heading(icon: string, label: string): string {
  return `**${icon}  ${label}**\n${HR_THIN}`;
}

// ─────────────────────────────────────────────────────────
// カード表示（トランプ）
// ─────────────────────────────────────────────────────────

/** スートを装飾（♥♦は赤、♠♣は白）— コードブロックでは装飾はしないが、名称にできる */
export function suitColor(suit: string): "red" | "black" {
  return suit === "♥" || suit === "♦" ? "red" : "black";
}

const RANK_MAP: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
export function cardLabel(rank: number, suit: string): string {
  const r = RANK_MAP[rank] ?? String(rank);
  return `${suit}${r}`;
}

/**
 * 手札を箱で表示（コードブロック風・等幅）。
 * 例: `┃ ♠A ┃ ♥K ┃ ♦Q ┃`
 */
export function boxCards(labels: string[]): string {
  if (labels.length === 0) return "";
  return `┃ ${labels.map((l) => l.padStart(3, " ").padEnd(3, " ")).join(" ┃ ")} ┃`;
}

/** 隠しカード（裏面）を混ぜて表示 */
export function boxCardsMasked(labels: string[], hideAfter = 1): string {
  const shown = labels.map((l, i) => (i < hideAfter ? l : "🂠"));
  return boxCards(shown);
}

// ─────────────────────────────────────────────────────────
// サイコロ（賽・チンチロ用）
// ─────────────────────────────────────────────────────────
export const DIE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

/**
 * 二賽・三賽を「壺の中で並ぶ」表現で。等幅の箱で並べる。
 * 例（三賽）: `┃ ⚀ │ ⚂ │ ⚄ ┃`
 */
export function boxDice(dice: readonly number[]): string {
  const faces = dice.map((d) => DIE_FACES[d] ?? "?");
  return `┃ ${faces.join(" │ ")} ┃`;
}

// ─────────────────────────────────────────────────────────
// 共通 embed パターン
// ─────────────────────────────────────────────────────────

export interface SectionSpec {
  icon: string;
  label: string;
  value: string;
  inline?: boolean;
}

/**
 * 標準的な結果 embed を作る。勝敗で色・見出し記号が自動で変わる。
 * setFields でセクション化する形。
 */
export function buildResultEmbed(opts: {
  game: string;
  net: number;
  bet?: number;
  balance: number;
  sections: SectionSpec[];
  footer?: string;
  isJackpot?: boolean;
}): EmbedBuilder {
  const won = opts.net > 0;
  const push = opts.net === 0;
  const color = opts.isJackpot ? C_JACKPOT : won ? (Math.abs(opts.net) >= (opts.bet ?? 0) * 5 ? C_BIGWIN : C_WIN) : push ? C_PUSH : C_LOSE;
  const resultTag = opts.isJackpot
    ? `${E.jp} JACKPOT!`
    : won
      ? `${E.win} 勝ち`
      : push
        ? `${E.push} プッシュ`
        : `${E.lose} 負け`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(color)
    .setTitle(`${resultTag}  ${fmtBigDelta(opts.net)}`)
    .setFooter({
      text:
        opts.footer ??
        `${E.ether} 所持 ${fmtEther(opts.balance).replace(" ◈", "◈")}${opts.bet ? ` · 賭け ${fmtEther(opts.bet).replace(" ◈", "◈")}` : ""}`,
    });

  for (const s of opts.sections) {
    embed.addFields({ name: `${s.icon} ${s.label}`, value: s.value, inline: s.inline ?? false });
  }
  return embed;
}

/**
 * 進行中（アニメ中）の embed 骨格。author + title + description + footer。
 */
export function buildProgressEmbed(opts: {
  game: string;
  title: string;
  body: string;
  bet?: number;
  balance?: number;
  color?: number;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(opts.color ?? C_MAMMON)
    .setTitle(opts.title)
    .setDescription(opts.body)
    .setFooter({
      text: [opts.bet ? `賭け ${fmtEther(opts.bet)}` : null, opts.balance !== undefined ? `所持 ${fmtEther(opts.balance)}` : null]
        .filter(Boolean)
        .join(" · "),
    });
}

/**
 * 受付中（ロビー）の embed 骨格。締切カウントダウン込み。
 */
export function buildLobbyEmbed(opts: {
  game: string;
  title: string;
  body: string;
  secondsLeft: number;
  totalBet?: number;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(C_MAMMON)
    .setTitle(opts.title)
    .setDescription(opts.body)
    .setFooter({
      text: [`締切まで ${opts.secondsLeft}秒`, opts.totalBet !== undefined ? `総額 ${fmtEther(opts.totalBet)}` : null]
        .filter(Boolean)
        .join(" · "),
    });
  return embed;
}
