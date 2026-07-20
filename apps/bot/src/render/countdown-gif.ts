import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import * as gifencNs from "gifenc";

/**
 * 72時間耐久・最終24時間のカウントダウン描画。
 *
 * 秒が動いて見えるように「60フレーム=60秒ぶんのGIF」を作り、Bot側は1分ごとに差し替える。
 * 表示回数ではなく必ず endMs と実時刻の差から各フレームを計算するので、再起動や遅延があっても
 * 残り時間はずれない（フレームiの残り = endMs - (startMs + i*1000)）。
 *
 * 絵文字はVPSにカラー絵文字フォントが無く豆腐化するため使わず、タイポグラフィとベクターで組む。
 */
// gifenc は CJS 実体。ESMからの取り込み方が環境で揺れるため default / namespace の両対応にする
const g = ((gifencNs as unknown as { default?: typeof gifencNs }).default ?? gifencNs) as typeof gifencNs;

const SANS = `"Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif`;
const SERIF = `"Noto Serif CJK JP", "Yu Mincho", "Hiragino Mincho ProN", serif`;

const W = 640;
const H = 232;

export type Phase = "normal" | "ten" | "one" | "done";

/** 残り秒 → HH:MM:SS（負は 00:00:00） */
export function formatRemain(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(ss)}`;
}

/** フェーズごとの配色。最終盤ほど深紅へ寄せる（派手な点滅はしない） */
function palette(phase: Phase): { bg1: string; bg2: string; accent: string; sub: string; bar: string } {
  if (phase === "done") return { bg1: "#241004", bg2: "#0a0502", accent: "#f0b429", sub: "#e8d7a8", bar: "#f0b429" };
  if (phase === "one") return { bg1: "#2c0510", bg2: "#0a0206", accent: "#ff5a6e", sub: "#ffc9d0", bar: "#ff5a6e" };
  if (phase === "ten") return { bg1: "#2a0a16", bg2: "#0a0308", accent: "#ff8a5c", sub: "#ffd9c4", bar: "#ff8a5c" };
  return { bg1: "#1c1030", bg2: "#080414", accent: "#f0b429", sub: "#b9a9d6", bar: "#a855f7" };
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
 * 1フレーム描画。
 * @param progress 最終24時間の経過割合(0..1)
 */
function drawFrame(ctx: SKRSContext2D, remainSec: number, phase: Phase, progress: number): void {
  const c = palette(phase);

  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, c.bg1);
  bg.addColorStop(1, c.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 外枠（二重）
  ctx.strokeStyle = hexA(c.accent, 0.55);
  ctx.lineWidth = 2;
  roundRect(ctx, 8, 8, W - 16, H - 16, 14);
  ctx.stroke();
  ctx.strokeStyle = hexA(c.accent, 0.18);
  ctx.lineWidth = 1;
  roundRect(ctx, 15, 15, W - 30, H - 30, 10);
  ctx.stroke();

  ctx.textBaseline = "alphabetic";

  if (phase === "done") {
    // 完走表示
    ctx.textAlign = "center";
    ctx.fillStyle = c.sub;
    ctx.font = `600 22px ${SANS}`;
    ctx.fillText("七十二時間 耐久 完走", W / 2, 60);
    ctx.fillStyle = c.accent;
    ctx.font = `700 92px ${SERIF}`;
    ctx.fillText("72:00:00", W / 2, 148);
    ctx.fillStyle = c.sub;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText("C O M P L E T E", W / 2, 190);
    ctx.textAlign = "left";
    return;
  }

  // 見出し
  ctx.textAlign = "center";
  ctx.fillStyle = c.sub;
  ctx.font = `600 21px ${SANS}`;
  const heading = phase === "one" ? "最後の一分" : phase === "ten" ? "まもなく完走" : "72時間到達まで";
  ctx.fillText(heading, W / 2, 52);

  // 残り時間（主役）
  const t = formatRemain(remainSec);
  ctx.fillStyle = c.accent;
  const size = phase === "normal" ? 96 : 108;
  ctx.font = `700 ${size}px ${SERIF}`;
  ctx.fillText(t, W / 2, phase === "normal" ? 146 : 152);

  // 進捗バー（最終24時間の消化度）
  const barW = W - 120;
  const barX = 60;
  const barY = 178;
  const barH = 10;
  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fill();
  const fw = Math.max(0, Math.min(barW, Math.round(barW * progress)));
  if (fw > 0) {
    roundRect(ctx, barX, barY, fw, barH, barH / 2);
    const bg2 = ctx.createLinearGradient(barX, barY, barX + fw, barY);
    bg2.addColorStop(0, hexA(c.bar, 0.75));
    bg2.addColorStop(1, c.accent);
    ctx.fillStyle = bg2;
    ctx.fill();
  }
  ctx.strokeStyle = hexA(c.accent, 0.25);
  ctx.lineWidth = 1;
  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.stroke();

  // 脚注
  ctx.fillStyle = hexA(c.sub, 0.85);
  ctx.font = `400 17px ${SANS}`;
  ctx.fillText("魔剣士から冥獄城全体へ — バトンは巡る", W / 2, 210);
  ctx.textAlign = "left";
}

function hexA(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const gg = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${gg},${b},${a})`;
}

/**
 * 60秒ぶんのカウントダウンGIFを作る。
 * @param startMs このGIFの先頭フレームが表す実時刻
 * @param endMs   イベント終了時刻
 * @param finalStartMs 最終24時間の開始時刻（進捗バー用）
 * @param frames  フレーム数（既定60=1分）
 */
export function renderCountdownGif(opts: {
  startMs: number;
  endMs: number;
  finalStartMs: number;
  phase: Phase;
  frames?: number;
}): Buffer {
  const frames = opts.frames ?? 60;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const enc = g.GIFEncoder();

  // 配色は固定なので、先頭フレームからパレットを1度だけ作って全フレームで使い回す（高速化）
  let pal: number[][] | null = null;
  const total = Math.max(1, opts.endMs - opts.finalStartMs);

  for (let i = 0; i < frames; i++) {
    const atMs = opts.startMs + i * 1000;
    const remainSec = (opts.endMs - atMs) / 1000;
    const progress = Math.max(0, Math.min(1, (atMs - opts.finalStartMs) / total));
    drawFrame(ctx, remainSec, opts.phase, progress);
    const data = ctx.getImageData(0, 0, W, H).data;
    if (!pal) pal = g.quantize(data, 128);
    const indexed = g.applyPalette(data, pal);
    enc.writeFrame(indexed, W, H, { palette: pal, delay: 1000 });
  }
  enc.finish();
  return Buffer.from(enc.bytes());
}

/** 完走表示（静止画PNG）。終了後はアニメを止める */
export function renderCompletePng(): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  drawFrame(ctx, 0, "done", 1);
  return canvas.toBuffer("image/png");
}

/** 1フレームをPNGで返す（プレビュー・目視確認用） */
export function renderFramePng(remainSec: number, phase: Phase, progress = 0.5): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  drawFrame(ctx, remainSec, phase, progress);
  return canvas.toBuffer("image/png");
}
