import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

/**
 * 称号昇格カード。iris-economy-bot の rank-up card を参考にした横長PNG。
 * 意匠は冥獄城の rank-card / profile-card に合わせて purple gradient + gold border。
 */
const SANS = `"Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif`;
const SERIF = `"Noto Serif CJK JP", "Yu Mincho", "Hiragino Mincho ProN", serif`;

const WIDTH = 900;
const HEIGHT = 260;

export interface RankUpCardData {
  displayName: string;
  avatarUrl: string;
  serverName?: string;
  serverIconUrl?: string | null;
  kind: "text" | "voice";
  oldTier: string;
  newTier: string;
  level: number;
}

export async function renderRankUpCard(data: RankUpCardData): Promise<Buffer> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);

  const avSize = 132;
  const avX = 42;
  const avY = (HEIGHT - avSize) / 2;
  await drawAvatar(ctx, data.avatarUrl, avX, avY, avSize, data.displayName);

  const textX = avX + avSize + 32;
  ctx.textBaseline = "alphabetic";

  // 右上: サーバー
  if (data.serverIconUrl) {
    await drawAvatar(ctx, data.serverIconUrl, WIDTH - 68, 32, 46, data.serverName ?? "I");
  }
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `500 20px ${SANS}`;
  ctx.fillText(fit(ctx, data.serverName ?? "冥獄城", 460), textX, 52);

  // 名前
  ctx.fillStyle = "#f5e9d0";
  ctx.font = `700 36px ${SERIF}`;
  ctx.fillText(fit(ctx, data.displayName, 500), textX, 96);

  // 種別ピル（発言称号 昇格 / 浮上称号 昇格）
  const badge = data.kind === "text" ? "発言称号 昇格" : "浮上称号 昇格";
  darkPill(ctx, textX, 108, badge);

  // 新称号（一番目立たせる）
  ctx.fillStyle = "#f0b429";
  ctx.font = `700 42px ${SERIF}`;
  ctx.fillText(fit(ctx, data.newTier, 640), textX, 188);

  // 遷移サブライン
  ctx.fillStyle = "#8a7fa6";
  ctx.font = `500 20px ${SANS}`;
  ctx.fillText(
    fit(ctx, `Lv.${data.level} 到達 ・ ${data.oldTier} → ${data.newTier}`, 640),
    textX,
    220,
  );

  return canvas.toBuffer("image/png");
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
  roundRect(ctx, 10, 10, WIDTH - 20, HEIGHT - 20, 18);
  ctx.stroke();
  ctx.strokeStyle = "rgba(240,180,41,0.12)";
  ctx.lineWidth = 1;
  roundRect(ctx, 18, 18, WIDTH - 36, HEIGHT - 36, 14);
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

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(240,180,41,0.65)";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function darkPill(ctx: SKRSContext2D, x: number, y: number, label: string): void {
  ctx.font = `600 16px ${SANS}`;
  const padX = 12;
  const padY = 6;
  const textW = ctx.measureText(label).width;
  const w = textW + padX * 2;
  const h = 26;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = "rgba(51,40,69,0.9)";
  ctx.fill();
  ctx.strokeStyle = "rgba(240,180,41,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#f0b429";
  ctx.fillText(label, x + padX, y + h - padY - 2);
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
