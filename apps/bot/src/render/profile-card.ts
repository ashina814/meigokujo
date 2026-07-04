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
}

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
  // 称号数に応じて高さを伸ばす
  const titleRows = Math.max(data.titles.length, 1);
  const titlesBlockTop = 340;
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

  // 階級バッジ
  const rankBadgeColor = RANK_COLOR[data.rank] ?? "#a855f7";
  drawBadge(ctx, textX, avY + 92, data.rank, rankBadgeColor);

  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText("冥獄城 魂の記録カード", textX, avY + 168);

  // ── ステータス4枠 ──
  const stats: Array<[string, string]> = [
    ["所持", data.balanceText],
    ["在城", data.daysInCastle > 0 ? `${data.daysInCastle}日` : "—"],
    ["累計浮上", data.vcHours > 0 ? `${data.vcHours}時間` : "—"],
    ["出現日数", data.daysSeen > 0 ? `${data.daysSeen}日` : "—"],
  ];
  const gap = 18;
  const boxW = (WIDTH - PAD * 2 - gap * (stats.length - 1)) / stats.length;
  const boxY = 236;
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
