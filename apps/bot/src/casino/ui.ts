import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
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
  // PR13: 利用者向け通貨はLandだけ。内部チップを示す記号は画面へ出さない。
  ether: "Ld",
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

/** 符号付きLand表示（+123Ld / -456Ld / ±0Ld） */
export function fmtSignedEther(n: number): string {
  if (n === 0) return "±0 Ld";
  const sign = n > 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toLocaleString("ja-JP")} Ld`;
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

/** 残高（所持）表示。自由チップはLand価値として合算表示する。 */
export function fmtWallet(ether: number, land: number): string {
  return `所持 ${fmtLd(ether + land)}`;
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
// 描画の大原則（ここを破ると Discord 実機で崩れる）
// ─────────────────────────────────────────────────────────
/**
 * 1. **コードブロックの中に絵文字・CJK・稀少記号を入れない。**
 *    等幅フォントでも絵文字の送り幅は1セルにならず、枠線が必ずちぎれる。
 *    コードブロックに入れてよいのは ASCII と罫線素片と `●` だけ。
 * 2. **2次元の桁揃えが要るものだけコードブロックに入れる。**（＝賽の目・盤面）
 *    1行で済むもの（手札・リール）は通常テキストに置く。そのほうが絵文字が活きる。
 * 3. **複数行の桁揃えが要るが絵文字も使いたい場合は inline field を使う。**
 *    Discord が列を作ってくれるので、こちらで空白を数えなくていい。
 * 4. 見出しは Discord の `##` / `###` / `-#` を使う。embed description でも効く。
 *
 * かつて `⚀⚁⚂⚃⚄⚅`(U+2680〜) を使っていたが、Discord の等幅フォントスタックに
 * グリフが無くフォールバックで潰れていた（賽が□に見えていた原因）。使用禁止。
 */

// ─────────────────────────────────────────────────────────
// 見出し（Discord markdown）
// ─────────────────────────────────────────────────────────
/** 大見出し。絵文字を大きく見せたいとき（スロットのリール等）にも使う */
export const h2 = (s: string): string => `## ${s}`;
/** 中見出し。手札・盤面の主役 */
export const h3 = (s: string): string => `### ${s}`;
/** 小文字の補足。所持・内訳など「読めればいい」情報 */
export const sub = (s: string): string => `-# ${s}`;

// ─────────────────────────────────────────────────────────
// 賽（さい）— コードブロック内専用・ASCII と ● のみ
// ─────────────────────────────────────────────────────────

/** 賽の目のピップ配置（3×3グリッドを5文字幅で表現） */
const PIPS: Readonly<Record<number, readonly [string, string, string]>> = {
  1: ["     ", "  ●  ", "     "],
  2: ["●    ", "     ", "    ●"],
  3: ["●    ", "  ●  ", "    ●"],
  4: ["●   ●", "     ", "●   ●"],
  5: ["●   ●", "  ●  ", "●   ●"],
  6: ["●   ●", "●   ●", "●   ●"],
};
const PIPS_UNKNOWN: readonly [string, string, string] = ["  ?  ", "  ?  ", "  ?  "];

const DIE_TOP = "┌─────┐";
const DIE_BOTTOM = "└─────┘";

/**
 * 賽を横並びに描く。**戻り値はコードブロックの中身のみ**（```は呼び出し側で付ける）。
 * 5行 × (7*n + 間隔) の等幅アート。絵文字を一切含まないので実機で崩れない。
 *
 * ```
 * ┌─────┐ ┌─────┐
 * │●   ●│ │●    │
 * │     │ │  ●  │
 * │●   ●│ │    ●│
 * └─────┘ └─────┘
 * ```
 */
export function diceArt(dice: readonly number[]): string {
  if (dice.length === 0) return "";
  const faces = dice.map((d) => PIPS[d] ?? PIPS_UNKNOWN);
  const gap = " ";
  return [
    dice.map(() => DIE_TOP).join(gap),
    ...[0, 1, 2].map((row) => faces.map((f) => `│${f[row]}│`).join(gap)),
    dice.map(() => DIE_BOTTOM).join(gap),
  ].join("\n");
}

/** 賽アートをコードブロックで包んだ完成形 */
export function diceBlock(dice: readonly number[]): string {
  return ["```", diceArt(dice), "```"].join("\n");
}

/**
 * まだ伏せられている賽。相手の手を隠すときに使う。
 * 出目アートと同じ寸法なので、開示時にレイアウトが跳ねない。
 */
export function diceHiddenArt(count: number): string {
  if (count <= 0) return "";
  const gap = " ";
  return [
    Array.from({ length: count }, () => DIE_TOP).join(gap),
    ...[0, 1, 2].map((row) =>
      Array.from({ length: count }, () => `│${row === 1 ? "  ?  " : "     "}│`).join(gap),
    ),
    Array.from({ length: count }, () => DIE_BOTTOM).join(gap),
  ].join("\n");
}

/** 出目を数字で1行に。ログ・履歴・狭い場所向け（例: `6 4` → `6・4`） */
export function diceInline(dice: readonly number[]): string {
  return dice.join("・");
}

// ─────────────────────────────────────────────────────────
// トランプ — 通常テキスト専用（コードブロックに入れない）
// ─────────────────────────────────────────────────────────
/**
 * ♥♦ は環境によって絵文字として色付き描画される。1行に並べるぶんには
 * それが「赤いスート」として利点になるが、コードブロックに入れると
 * 送り幅が狂って桁が崩れる。カードは必ず通常テキストへ。
 */

/** 手札を1行に。`♠A ♥K ♦Q` */
export function handText(labels: readonly string[]): string {
  return labels.join("  ");
}

/** 見出しサイズの手札。結果画面の主役に使う */
export function handHeadline(labels: readonly string[]): string {
  return h3(handText(labels));
}

/** 伏せ札込みの手札。`♠A 🂠 🂠` ではなく崩れない `?` を使う */
export function handTextMasked(labels: readonly string[], reveal: number): string {
  return handText(labels.map((l, i) => (i < reveal ? l : "▮")));
}

// ─────────────────────────────────────────────────────────
// リール（スロット）— 通常テキスト＋見出しで絵文字を大きく見せる
// ─────────────────────────────────────────────────────────
/**
 * かつて `╔═════╦═════╗` に絵文字を流し込んでいたが、絵文字の幅が
 * 罫線と合わず上下の枠が左右にちぎれていた。枠を捨てて `##` 見出しに置く。
 * 見出しは絵文字を大きく描画するので、枠が無くてもリールとして成立する。
 */
export function reelText(symbols: readonly string[]): string {
  return h2(symbols.join("  ┃  "));
}

// ─────────────────────────────────────────────────────────
// 金額の見せ方
// ─────────────────────────────────────────────────────────

/**
 * 結果画面の「所持」行。ここだけは太字で本文に置く。
 * 一番知りたい数字をフッターの極小灰文字に埋めない。
 */
export function balanceLine(balance: number): string {
  return `所持 **${balance.toLocaleString("ja-JP")}** Ld`;
}

/**
 * 賭場ホームへ戻る導線。**子画面はどれもこれを付ける**。
 *
 * ここ（design system 側）に置いてあるのは、`casino/` から
 * `commands/casino-home.ts` を参照すると循環参照になるため。
 * 実際の遷移は customId `casino:home:back` を賭場ホームが受ける。
 */
export function casinoHomeBackRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("casino:home:back").setLabel("賭場ホームへ戻る").setEmoji("🏛").setStyle(ButtonStyle.Secondary),
  );
}

/** 子画面の payload へ戻る導線を足す。段が上限(5)に達していれば足さない */
export function withCasinoHomeBack<T extends { components?: unknown[] }>(payload: T): T {
  const rows = (payload.components ?? []) as unknown[];
  if (rows.length >= 5) return payload;
  return { ...payload, components: [...rows, casinoHomeBackRow()] };
}

/** 賭け → 払戻 の対を1行で。収支の内訳が要るときだけ使う */
export function stakeLine(bet: number | "無料", payout: number): string {
  const betText = bet === "無料" ? "無料" : `${bet.toLocaleString("ja-JP")} Ld`;
  return `賭け ${betText}　→　払戻 ${payout.toLocaleString("ja-JP")} Ld`;
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

/*
 * 旧 boxCards / boxCardsMasked / boxDice / DIE_FACES はここにあったが削除した。
 * - `⚀⚁⚂⚃⚄⚅` は Discord の等幅フォントに無く、賽が□に潰れていた → diceArt を使う
 * - `┃ ♠A ┃` は ♥♦ の絵文字描画で桁が崩れていた → handText（通常テキスト）を使う
 * - `🂠` も同様に幅が合わない → handTextMasked の `▮` を使う
 */

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
        `${E.ether} 所持 ${fmtEther(opts.balance).replace(" Ld", "Ld")}${opts.bet ? ` · 賭け ${fmtEther(opts.bet).replace(" Ld", "Ld")}` : ""}`,
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
