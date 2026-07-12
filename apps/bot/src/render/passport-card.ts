import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { fmtEther, fmtLd } from "../format.js";

/**
 * マモンの賭場の通行証カード。
 * 既存の rank-card / profile-card と対になる意匠:
 * - profile-card は紫→黒の gradient + 金縁（冥獄城の"住人"）
 * - passport-card は 金→深緑の gradient + 焦茶縁（マモンの"賭場"）
 * 幅・高さは profile-card と同じ 900×460 に合わせる。
 */
const SANS = `"Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif`;
const SERIF = `"Noto Serif CJK JP", "Yu Mincho", "Hiragino Mincho ProN", serif`;

const WIDTH = 900;
const HEIGHT = 460;
const PAD = 48;

export interface PassportCardData {
  displayName: string;
  avatarUrl: string;
  serverName?: string;
  serverIconUrl?: string | null;
  etherBalance: number;
  landBalance: number;
  stats: {
    games: number;
    wins: number;
    losses: number;
    winRate: number; // 0..1
    biggestWin: number;
    totalEarned: number;
    totalWagered: number;
    currentWinStreak: number;
    bestWinStreak: number;
  };
}

export async function renderPassportCard(data: PassportCardData): Promise<Buffer> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);

  // ── 右上: サーバー名 ──
  if (data.serverName) {
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";
    ctx.fillStyle = "#c9a227";
    ctx.font = `500 20px ${SANS}`;
    ctx.fillText(data.serverName, WIDTH - PAD, PAD + 20);
    ctx.textAlign = "left";
  }

  // ── ヘッダ: アバター + 名前 ──
  const avSize = 152;
  const avX = PAD;
  const avY = PAD;
  await drawAvatar(ctx, data.avatarUrl, avX, avY, avSize, data.displayName);

  const textX = avX + avSize + 32;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f0e0a3";
  ctx.font = `700 44px ${SERIF}`;
  ctx.fillText(fit(ctx, data.displayName, WIDTH - textX - PAD - 200), textX, avY + 54);

  ctx.fillStyle = "#8a7a4d";
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText("マモンの賭場 通行証", textX, avY + 88);

  // 中央右: 残高
  ctx.textAlign = "right";
  ctx.fillStyle = "#8a7a4d";
  ctx.font = `400 18px ${SANS}`;
  ctx.fillText("所持", WIDTH - PAD, avY + 114);
  ctx.fillStyle = "#f0b429";
  ctx.font = `700 34px ${SERIF}`;
  ctx.fillText(fmtEther(data.etherBalance), WIDTH - PAD, avY + 152);
  ctx.textAlign = "left";

  // ── ゲーム統計 ──
  const boxTop = 220;
  const boxH = 96;
  const gap = 18;
  const boxW = (WIDTH - PAD * 2 - gap * 3) / 4;
  drawStatBox(ctx, PAD + (boxW + gap) * 0, boxTop, boxW, boxH, "総ゲーム数", String(data.stats.games), `勝ち ${data.stats.wins} / 負け ${data.stats.losses}`);
  const winRatePct = data.stats.games > 0 ? (data.stats.winRate * 100).toFixed(1) + "%" : "—";
  drawStatBox(ctx, PAD + (boxW + gap) * 1, boxTop, boxW, boxH, "勝率", winRatePct, data.stats.games < 10 ? "10戦以上で判定" : "");
  drawStatBox(ctx, PAD + (boxW + gap) * 2, boxTop, boxW, boxH, "最大勝ち", fmtEther(data.stats.biggestWin), "1ゲームの純益");
  drawStatBox(ctx, PAD + (boxW + gap) * 3, boxTop, boxW, boxH, "連勝", `${data.stats.currentWinStreak} / ${data.stats.bestWinStreak}`, "現在 / 最長");

  // ── 下段: 総獲得・総ベット・Land ──
  const bottomY = 350;
  ctx.fillStyle = "#c9a227";
  ctx.font = `700 24px ${SERIF}`;
  ctx.fillText("賭場の記録", PAD, bottomY);

  ctx.strokeStyle = "rgba(201,162,39,0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, bottomY + 12);
  ctx.lineTo(WIDTH - PAD, bottomY + 12);
  ctx.stroke();

  const rowY = bottomY + 50;
  ctx.fillStyle = "#8a7a4d";
  ctx.font = `400 18px ${SANS}`;
  ctx.fillText("総獲得", PAD, rowY);
  ctx.fillText("総ベット", PAD + 280, rowY);
  ctx.fillText("Land 残高", PAD + 560, rowY);

  ctx.fillStyle = "#ede4d3";
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText(fmtEther(data.stats.totalEarned), PAD, rowY + 28);
  ctx.fillText(fmtEther(data.stats.totalWagered), PAD + 280, rowY + 28);
  ctx.fillText(fmtLd(data.landBalance), PAD + 560, rowY + 28);

  return canvas.toBuffer("image/png");
}

// ---- helpers ----

function drawBackground(ctx: SKRSContext2D): void {
  // マモン=強欲の金を強めに出す。金→深緑→黒の gradient
  const g = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  g.addColorStop(0, "#3a2a08");
  g.addColorStop(0.5, "#1a1408");
  g.addColorStop(1, "#0d0904");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 焦茶の二重縁
  ctx.strokeStyle = "rgba(201,162,39,0.55)";
  ctx.lineWidth = 2;
  roundRect(ctx, 10, 10, WIDTH - 20, HEIGHT - 20, 20);
  ctx.stroke();
  ctx.strokeStyle = "rgba(201,162,39,0.18)";
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
    ctx.fillStyle = "#2a1c08";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#f0e0a3";
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
  ctx.strokeStyle = "rgba(240,180,41,0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawStatBox(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  sub: string,
): void {
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  ctx.fill();
  ctx.strokeStyle = "rgba(201,162,39,0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#8a7a4d";
  ctx.font = `400 16px ${SANS}`;
  ctx.fillText(label, x + 12, y + 24);

  ctx.fillStyle = "#f5ead4";
  ctx.font = `700 24px ${SERIF}`;
  ctx.fillText(fit(ctx, value, w - 24), x + 12, y + 54);

  if (sub) {
    ctx.fillStyle = "#8a7a4d";
    ctx.font = `400 14px ${SANS}`;
    ctx.fillText(fit(ctx, sub, w - 24), x + 12, y + 80);
  }
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
