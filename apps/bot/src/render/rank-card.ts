import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

/**
 * ランクカード（/ランキング 自分のランク）。
 * プロフィールカードと同じ流儀（絵文字を使わずタイポ+ベクター、フォールバック列でCJK吸収）。
 */
const SANS = `"Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif`;
const SERIF = `"Noto Serif CJK JP", "Yu Mincho", "Hiragino Mincho ProN", serif`;

const WIDTH = 900;
const HEIGHT = 480;
const PAD = 48;

export interface RankCardData {
  displayName: string;
  avatarUrl: string;
  serverName?: string;
  serverIconUrl?: string | null;
  totalLevel: number;
  text: { level: number; title: string; inLevel: number; toNext: number; messages: number; position: number; population: number };
  voice: { level: number; title: string; inLevel: number; toNext: number; minutes: number; position: number; population: number };
  invite: { count: number; position: number | null; population: number };
  bump: { count: number; position: number | null; population: number };
}

export async function renderRankCard(data: RankCardData): Promise<Buffer> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);

  // ── 右上: サーバー情報 ──
  if (data.serverName || data.serverIconUrl) {
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";
    ctx.fillStyle = "#8a7fa6";
    ctx.font = `500 20px ${SANS}`;
    ctx.fillText(data.serverName ?? "冥獄城", WIDTH - PAD, PAD + 20);
    ctx.textAlign = "left";
  }

  // ── ヘッダ: アバター + 名前 + 総合Lv ──
  const avSize = 152;
  const avX = PAD;
  const avY = PAD;
  await drawAvatar(ctx, data.avatarUrl, avX, avY, avSize, data.displayName);

  const textX = avX + avSize + 32;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f5e9d0";
  ctx.font = `600 44px ${SERIF}`;
  ctx.fillText(fit(ctx, data.displayName, WIDTH - textX - PAD - 200), textX, avY + 54);

  // 総合レベルバッジ（右端）
  ctx.textAlign = "right";
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText("総合Lv", WIDTH - PAD, avY + 78);
  ctx.fillStyle = "#f0b429";
  ctx.font = `700 56px ${SERIF}`;
  ctx.fillText(String(data.totalLevel), WIDTH - PAD, avY + 132);
  ctx.textAlign = "left";

  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText("冥獄城 ランクカード", textX, avY + 88);

  // ── ゲージ2本 ──
  const barTop = 220;
  drawGaugeRow(ctx, PAD, barTop, "発言", data.text.level, data.text.title, data.text.inLevel, data.text.toNext, data.text.position, data.text.population, `${data.text.messages}発言`);
  drawGaugeRow(ctx, PAD, barTop + 90, "浮上", data.voice.level, data.voice.title, data.voice.inLevel, data.voice.toNext, data.voice.position, data.voice.population, `${data.voice.minutes}分`);

  // ── 招待 / Bump（下段 2枠）──
  const boxY = 400;
  const boxH = 60;
  const gap = 20;
  const boxW = (WIDTH - PAD * 2 - gap) / 2;
  drawStatBox(ctx, PAD, boxY, boxW, boxH, "招待", data.invite.count, data.invite.count > 0 ? `${data.invite.position}位` : "実績なし", data.invite.population);
  drawStatBox(ctx, PAD + boxW + gap, boxY, boxW, boxH, "Bump", data.bump.count, data.bump.count > 0 ? `${data.bump.position}位` : "実績なし", data.bump.population);

  return canvas.toBuffer("image/png");
}

function drawGaugeRow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  label: string,
  level: number,
  title: string,
  inLevel: number,
  toNext: number,
  position: number,
  population: number,
  detail: string,
): void {
  ctx.textBaseline = "alphabetic";
  // ラベル + Lv + 称号
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText(label, x, y);
  ctx.fillStyle = "#f5e9d0";
  ctx.font = `700 30px ${SERIF}`;
  const lvText = `Lv.${level}`;
  ctx.fillText(lvText, x + 68, y + 2);
  const lvW = ctx.measureText(lvText).width;
  ctx.fillStyle = "#f0b429";
  ctx.font = `600 24px ${SANS}`;
  ctx.fillText(title, x + 68 + lvW + 16, y);

  // 右端: 順位 + XP
  ctx.textAlign = "right";
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 18px ${SANS}`;
  ctx.fillText(`${position}/${population}位 ・ ${detail}`, WIDTH - PAD, y - 10);
  ctx.fillStyle = "#ede4d3";
  ctx.font = `500 20px ${SANS}`;
  ctx.fillText(`${inLevel} / ${toNext} XP`, WIDTH - PAD, y + 12);
  ctx.textAlign = "left";

  // ゲージ
  const barY = y + 22;
  const barW = WIDTH - PAD * 2;
  const barH = 14;
  roundRect(ctx, x, barY, barW, barH, barH / 2);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();
  const fillW = Math.max(0, Math.min(barW, Math.round(barW * (inLevel / Math.max(1, toNext)))));
  if (fillW > 0) {
    roundRect(ctx, x, barY, fillW, barH, barH / 2);
    const g = ctx.createLinearGradient(x, barY, x + fillW, barY);
    g.addColorStop(0, "#a855f7");
    g.addColorStop(1, "#f0b429");
    ctx.fillStyle = g;
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(240,180,41,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, barY, barW, barH, barH / 2);
  ctx.stroke();
}

function drawStatBox(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: number,
  rankText: string,
  population: number,
): void {
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  ctx.fill();
  ctx.strokeStyle = "rgba(240,180,41,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 18px ${SANS}`;
  ctx.fillText(label, x + 16, y + 26);
  ctx.fillStyle = "#f5e9d0";
  ctx.font = `700 24px ${SERIF}`;
  ctx.fillText(String(value), x + 16, y + 50);

  ctx.textAlign = "right";
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `400 16px ${SANS}`;
  ctx.fillText(value > 0 ? `${rankText} / ${population}人中` : "—", x + w - 16, y + 30);
  ctx.fillStyle = "#ede4d3";
  ctx.font = `500 18px ${SANS}`;
  ctx.fillText(value > 0 ? rankText : "—", x + w - 16, y + 52);
  ctx.textAlign = "left";
}

// ---- helpers ----

function drawBackground(ctx: SKRSContext2D): void {
  const g = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  g.addColorStop(0, "#1c1030");
  g.addColorStop(0.55, "#120a22");
  g.addColorStop(1, "#0a0518");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = "rgba(240,180,41,0.35)";
  ctx.lineWidth = 2;
  roundRect(ctx, 10, 10, WIDTH - 20, HEIGHT - 20, 20);
  ctx.stroke();
  ctx.strokeStyle = "rgba(240,180,41,0.12)";
  ctx.lineWidth = 1;
  roundRect(ctx, 18, 18, WIDTH - 36, HEIGHT - 36, 16);
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

  // 金色のリング
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(240,180,41,0.65)";
  ctx.lineWidth = 3;
  ctx.stroke();
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

function fit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}
