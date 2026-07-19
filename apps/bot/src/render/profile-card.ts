import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

/**
 * 魂の記録カード（/プロフィール の画像）。
 *
 * 絵文字はcanvasで環境依存に豆腐化する（VPSにカラー絵文字フォント無し）ため、
 * カード上は一切使わずタイポグラフィ＋ベクター装飾で組む。世界観的にもその方が締まる。
 * フォントはOSごとに実体が違うのでフォールバック列で吸収する:
 *   開発(Win) = Yu Gothic / Yu Mincho, 本番(Linux) = Noto Sans/Serif CJK JP。
 */
const SANS = `"Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif`;
const SERIF = `"Noto Serif CJK JP", "Yu Mincho", "Hiragino Mincho ProN", serif`;

const WIDTH = 1000;
const PAD = 56;

export interface ProfileCardData {
  displayName: string;
  avatarUrl: string;
  rank: string;
  balanceText: string; // 例: "12,300 Ld"
  daysInCastle: number;
  vcHours: number;
  daysSeen: number;
  titles: Array<{ name: string; desc: string }>;
  // ランク（発言・浮上）— 未指定なら描画スキップ
  ranks?: {
    totalLevel: number;
    text: { level: number; inLevel: number; toNext: number; title: string };
    voice: { level: number; inLevel: number; toNext: number; title: string };
  };
  // 特別プロフィール（魔王など）— 指定時は最上部に専用バナーを描く（§11-§13）
  specialRole?: { name: string; desc: string; style: string };
}

/** 特別役職の装飾スタイルごとの配色 */
const SPECIAL_STYLE_COLORS: Record<string, { bg1: string; bg2: string; border: string; accent: string; sub: string }> = {
  maou: { bg1: "#2c0512", bg2: "#08020a", border: "#f0b429", accent: "#f0b429", sub: "#e05a7d" },
  crimson: { bg1: "#2a0512", bg2: "#12060a", border: "#e05a7d", accent: "#e05a7d", sub: "#f0b429" },
  gold: { bg1: "#2a2205", bg2: "#100c02", border: "#f0b429", accent: "#ffe9a8", sub: "#f0b429" },
  plain: { bg1: "#1c1030", bg2: "#0a0518", border: "#a855f7", accent: "#a855f7", sub: "#8a7fa6" },
};

/** 階級ごとの帯色（バッジ） */
const RANK_COLOR: Record<string, string> = {
  入城案内待ち: "#6b7280",
  亡霊: "#7c8fb0",
  魔人: "#a855f7",
  魔族: "#f0b429",
  迷霊: "#4b5563",
  去りし魂: "#3f3f46",
  記録なし: "#52525b",
};

export async function renderProfileCard(data: ProfileCardData): Promise<Buffer> {
  // 称号数に応じて高さを伸ばす + ランク描画があれば追加 + 特別役職バナーがあれば追加
  const titleRows = Math.max(data.titles.length, 1);
  const specialH = data.specialRole ? 156 : 0;
  const rankBlockH = data.ranks ? 220 : 0;
  const boxY = 236 + specialH; // ステータス4枠の上端
  const rankTop = boxY + 104; // ランクセクションの上端
  const titlesBlockTop = rankTop + rankBlockH;
  const rowH = 52;
  const height = titlesBlockTop + 44 + titleRows * rowH + 40;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, height);

  // ── ヘッダ: アバター + 名前 + 階級バッジ ──
  const avSize = 168;
  const avX = PAD;
  const avY = PAD;
  await drawAvatar(ctx, data.avatarUrl, avX, avY, avSize, data.displayName);

  const textX = avX + avSize + 40;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f5e9d0";
  ctx.font = `600 52px ${SERIF}`;
  ctx.fillText(fit(ctx, data.displayName, WIDTH - textX - PAD), textX, avY + 66);

  // 階級バッジ。特別役職があるときは「主要役職＝特別役職」を大きく、階級は兼任として添える（§13）
  if (data.specialRole) {
    const sc = SPECIAL_STYLE_COLORS[data.specialRole.style] ?? SPECIAL_STYLE_COLORS.plain!;
    drawBadge(ctx, textX, avY + 92, data.specialRole.name, sc.accent);
    ctx.fillStyle = "#8a7fa6";
    ctx.font = `400 22px ${SANS}`;
    ctx.fillText(`兼任 / 階級：${data.rank}`, textX, avY + 158);
  } else {
    const rankBadgeColor = RANK_COLOR[data.rank] ?? "#a855f7";
    drawBadge(ctx, textX, avY + 92, data.rank, rankBadgeColor);
    ctx.fillStyle = "#8a7fa6";
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText("冥獄城 魂の記録カード", textX, avY + 168);
  }

  // ── 特別役職バナー（魔王など）──
  if (data.specialRole) {
    drawSpecialBanner(ctx, PAD, 232, WIDTH - PAD * 2, specialH - 20, data.specialRole);
  }

  // ── ステータス4枠 ──
  const stats: Array<[string, string]> = [
    ["所持", data.balanceText],
    ["在城", data.daysInCastle > 0 ? `${data.daysInCastle}日` : "—"],
    ["累計浮上", data.vcHours > 0 ? `${data.vcHours}時間` : "—"],
    ["出現日数", data.daysSeen > 0 ? `${data.daysSeen}日` : "—"],
  ];
  const gap = 18;
  const boxW = (WIDTH - PAD * 2 - gap * (stats.length - 1)) / stats.length;
  const boxH = 84;
  stats.forEach(([label, value], i) => {
    const x = PAD + i * (boxW + gap);
    roundRect(ctx, x, boxY, boxW, boxH, 14);
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    ctx.fill();
    ctx.strokeStyle = "rgba(240,180,41,0.18)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#8a7fa6";
    ctx.font = `400 22px ${SANS}`;
    ctx.fillText(label, x + 18, boxY + 34);

    ctx.fillStyle = "#f5e9d0";
    fitFont(ctx, value, boxW - 36, 30, 20, (px) => `600 ${px}px ${SANS}`);
    ctx.fillText(value, x + 18, boxY + 68);
  });

  // ── ランクセクション（総合Lv + 発言/浮上のゲージ + 称号）──
  if (data.ranks) {
    const secX = PAD;
    ctx.fillStyle = "#f0b429";
    ctx.font = `600 30px ${SERIF}`;
    ctx.fillText("ランク", secX, rankTop + 8);
    ctx.strokeStyle = "rgba(240,180,41,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(secX, rankTop + 24);
    ctx.lineTo(WIDTH - PAD, rankTop + 24);
    ctx.stroke();

    // 総合レベル（右寄せの大きな数字）
    ctx.fillStyle = "#8a7fa6";
    ctx.font = `400 22px ${SANS}`;
    const totalLabel = "総合Lv";
    ctx.textAlign = "right";
    ctx.fillText(totalLabel, WIDTH - PAD, rankTop + 8);
    ctx.fillStyle = "#f5e9d0";
    ctx.font = `700 44px ${SERIF}`;
    ctx.fillText(String(data.ranks.totalLevel), WIDTH - PAD, rankTop + 54);
    ctx.textAlign = "left";

    // 発言ゲージ
    const g1Y = rankTop + 60;
    drawRankRow(ctx, secX, g1Y, "発言", data.ranks.text);
    // 浮上ゲージ
    const g2Y = rankTop + 140;
    drawRankRow(ctx, secX, g2Y, "浮上", data.ranks.voice);
  }

  // ── 称号セクション ──
  const secX = PAD;
  ctx.fillStyle = "#f0b429";
  ctx.font = `600 30px ${SERIF}`;
  ctx.fillText("刻まれし称号", secX, titlesBlockTop + 8);
  // 見出し下の細線
  ctx.strokeStyle = "rgba(240,180,41,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(secX, titlesBlockTop + 24);
  ctx.lineTo(WIDTH - PAD, titlesBlockTop + 24);
  ctx.stroke();

  const listTop = titlesBlockTop + 44;
  if (data.titles.length === 0) {
    ctx.fillStyle = "#6b6480";
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText("まだ称号を持たぬ魂。城で生きた証が、いずれここに刻まれる。", secX + 4, listTop + 40);
  } else {
    data.titles.forEach((t, i) => {
      const y = listTop + i * rowH + 34;
      // ダイヤ型のブレット
      drawDiamond(ctx, secX + 10, y - 9, 7, bulletColor(i));
      ctx.fillStyle = "#ede4d3";
      ctx.font = `600 28px ${SANS}`;
      const nameW = ctx.measureText(t.name).width;
      ctx.fillText(t.name, secX + 32, y);
      ctx.fillStyle = "#8a7fa6";
      ctx.font = `400 24px ${SANS}`;
      ctx.fillText(fit(ctx, `— ${t.desc}`, WIDTH - PAD - (secX + 32 + nameW + 14)), secX + 32 + nameW + 14, y);
    });
  }

  return canvas.toBuffer("image/png");
}

/** 称号ブレットの色を順番で少し振る（単調さ回避の装飾） */
function bulletColor(i: number): string {
  const palette = ["#f0b429", "#a855f7", "#7c8fb0", "#e05a7d", "#5eead4"];
  return palette[i % palette.length] ?? "#f0b429";
}

function drawBackground(ctx: SKRSContext2D, height: number): void {
  const g = ctx.createLinearGradient(0, 0, WIDTH, height);
  g.addColorStop(0, "#1c1030");
  g.addColorStop(0.55, "#120a22");
  g.addColorStop(1, "#0a0518");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, height);

  // 外枠（薄い金）
  ctx.strokeStyle = "rgba(240,180,41,0.35)";
  ctx.lineWidth = 2;
  roundRect(ctx, 10, 10, WIDTH - 20, height - 20, 20);
  ctx.stroke();
  // 内枠（更に薄く）
  ctx.strokeStyle = "rgba(240,180,41,0.12)";
  ctx.lineWidth = 1;
  roundRect(ctx, 18, 18, WIDTH - 36, height - 36, 16);
  ctx.stroke();
}

async function drawAvatar(
  ctx: SKRSContext2D,
  url: string,
  x: number,
  y: number,
  size: number,
  name: string,
): Promise<void> {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    ctx.drawImage(img, x, y, size, size);
  } catch {
    // 取得失敗時は頭文字プレースホルダ
    ctx.fillStyle = "#2a1c44";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#f5e9d0";
    ctx.font = `600 ${Math.floor(size * 0.5)}px ${SERIF}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((name[0] ?? "?").toUpperCase(), cx, cy + 4);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();

  // リング
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(240,180,41,0.5)";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawRankRow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  label: string,
  data: { level: number; inLevel: number; toNext: number; title: string },
): void {
  // ラベル + Lv + 称号（1行目）
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 24px ${SANS}`;
  ctx.fillText(label, x, y);
  ctx.fillStyle = "#f5e9d0";
  ctx.font = `700 30px ${SERIF}`;
  const lvText = `Lv.${data.level}`;
  ctx.fillText(lvText, x + 70, y + 2);
  const lvW = ctx.measureText(lvText).width;
  ctx.fillStyle = "#f0b429";
  ctx.font = `600 24px ${SANS}`;
  ctx.fillText(data.title, x + 70 + lvW + 18, y);

  // XP テキスト（右端）
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 20px ${SANS}`;
  const xpText = `${data.inLevel} / ${data.toNext} XP`;
  ctx.textAlign = "right";
  ctx.fillText(xpText, WIDTH - PAD, y);
  ctx.textAlign = "left";

  // ゲージ（2行目）
  const barX = x;
  const barY = y + 14;
  const barW = WIDTH - PAD * 2;
  const barH = 14;
  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();
  const fillW = Math.max(0, Math.min(barW, Math.round(barW * (data.inLevel / Math.max(1, data.toNext)))));
  if (fillW > 0) {
    roundRect(ctx, barX, barY, fillW, barH, barH / 2);
    const g = ctx.createLinearGradient(barX, barY, barX + fillW, barY);
    g.addColorStop(0, "#a855f7");
    g.addColorStop(1, "#f0b429");
    ctx.fillStyle = g;
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(240,180,41,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.stroke();
}

/** 特別役職バナー（魔王など）。王冠＋見出し＋説明を専用枠で描く（§11-§12） */
function drawSpecialBanner(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  special: { name: string; desc: string; style: string },
): void {
  const sc = SPECIAL_STYLE_COLORS[special.style] ?? SPECIAL_STYLE_COLORS.plain!;

  // 重厚な枠（黒×深紅グラデ＋二重の金枠）
  roundRect(ctx, x, y, w, h, 16);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, sc.bg1);
  g.addColorStop(1, sc.bg2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = hexToRgba(sc.border, 0.85);
  ctx.lineWidth = 2.5;
  roundRect(ctx, x, y, w, h, 16);
  ctx.stroke();
  ctx.strokeStyle = hexToRgba(sc.border, 0.3);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 7, y + 7, w - 14, h - 14, 12);
  ctx.stroke();

  // 王冠（左）
  const crownCx = x + 62;
  const crownCy = y + h / 2;
  drawCrown(ctx, crownCx, crownCy, 40, sc.accent);

  // 見出し（名前）
  const textX = x + 120;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = sc.accent;
  ctx.font = `700 46px ${SERIF}`;
  const nameY = y + 56;
  ctx.fillText(fit(ctx, special.name, w - (textX - x) - 28), textX, nameY);

  // 肩書ライン
  ctx.fillStyle = hexToRgba(sc.sub, 0.95);
  ctx.font = `600 20px ${SANS}`;
  ctx.fillText("― 冥獄城の特別役職 ―", textX, nameY + 26);

  // 説明文（最大2行に折り返し）
  if (special.desc) {
    ctx.fillStyle = "#d9cfe6";
    ctx.font = `400 22px ${SANS}`;
    const maxW = w - (textX - x) - 28;
    const lines = wrapText(ctx, special.desc.replace(/\n/g, " "), maxW, 2);
    lines.forEach((ln, i) => ctx.fillText(ln, textX, nameY + 58 + i * 28));
  }
}

/** 王冠のベクター描画（絵文字非依存） */
function drawCrown(ctx: SKRSContext2D, cx: number, cy: number, size: number, color: string): void {
  const w = size;
  const h = size * 0.72;
  const left = cx - w / 2;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left, bottom); // 左下
  ctx.lineTo(left, top + h * 0.35); // 左の谷から上へ
  ctx.lineTo(left + w * 0.25, top + h * 0.62); // 左山の谷
  ctx.lineTo(cx, top); // 中央の頂点
  ctx.lineTo(left + w * 0.75, top + h * 0.62); // 右山の谷
  ctx.lineTo(left + w, top + h * 0.35); // 右の頂点
  ctx.lineTo(left + w, bottom); // 右下
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  // 台座
  ctx.fillRect(left - 2, bottom, w + 4, h * 0.2);
  // 宝珠（3つ）
  ctx.fillStyle = hexToRgba("#ffffff", 0.85);
  for (const fx of [0.18, 0.5, 0.82]) {
    ctx.beginPath();
    ctx.arc(left + w * fx, top + h * 0.28, size * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** テキストを幅に合わせて最大 maxLines 行へ折り返す（超過は末尾を…に詰める） */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const chars = [...text];
  const lines: string[] = [];
  let cur = "";
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxWidth) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines - 1) break;
    } else {
      cur += ch;
    }
  }
  const rest = chars.slice([...lines.join("")].length).join("");
  if (lines.length < maxLines) lines.push(fit(ctx, rest, maxWidth));
  return lines.filter((l) => l.length > 0);
}

function drawBadge(ctx: SKRSContext2D, x: number, y: number, text: string, color: string): void {
  ctx.font = `600 26px ${SANS}`;
  const tw = ctx.measureText(text).width;
  const padX = 18;
  const h = 40;
  const w = tw + padX * 2;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = hexToRgba(color, 0.18);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.6);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x + padX, y + 28);
}

function drawDiamond(ctx: SKRSContext2D, cx: number, cy: number, s: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s, cy);
  ctx.lineTo(cx, cy + s);
  ctx.lineTo(cx - s, cy);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 幅に収まるまでフォントサイズを段階的に下げる（省略より情報を残す）。
 * min まで下げても入らなければそのサイズで描く（最終手段）。ctx.font を設定して返る。
 */
function fitFont(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxPx: number,
  minPx: number,
  fontOf: (px: number) => string,
): void {
  let px = maxPx;
  for (; px >= minPx; px--) {
    ctx.font = fontOf(px);
    if (ctx.measureText(text).width <= maxWidth) return;
  }
  ctx.font = fontOf(minPx);
}

/** 幅に収まるよう末尾を … に詰める */
function fit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

function hexToRgba(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
