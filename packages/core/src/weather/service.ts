import { Settings } from "../settings/service.js";

/**
 * 冥界の天気（世界構想マップ「毎朝の天気発表がカジノオッズに影響／毎日のログイン理由」）。
 * 毎朝ランダムに決まり、その日のカジノ配当倍率を左右する。全員共通・公表制なので
 * 操作されない。チップは移動するだけなので配当倍率が変わってもインフレはしない
 * （良天気の日は胴元が多く払う＝賭博場の負担。通貨総量は不変）。
 */
export interface WeatherDef {
  key: string;
  emoji: string;
  label: string;
  /** カジノ配当倍率（>1=プレイヤー有利, <1=胴元有利） */
  mult: number;
  weight: number;
  note: string;
}

export const WEATHER_TYPES: WeatherDef[] = [
  { key: "clear", emoji: "☀️", label: "快晴", mult: 1.1, weight: 10, note: "配当 1.1倍。冥府も気前がいい。" },
  { key: "fair", emoji: "🌤", label: "晴れ", mult: 1.0, weight: 25, note: "平常運転。" },
  { key: "cloudy", emoji: "☁️", label: "曇り", mult: 1.0, weight: 25, note: "平常運転。" },
  { key: "fog", emoji: "🌫", label: "霧", mult: 0.95, weight: 20, note: "配当やや渋め。視界不良。" },
  { key: "storm", emoji: "⛈", label: "嵐", mult: 0.9, weight: 15, note: "配当渋め。荒れ模様、無理は禁物。" },
  { key: "eclipse", emoji: "🌑", label: "月食", mult: 1.25, weight: 5, note: "配当 1.25倍。月食の夜、賭場の扉が大きく開く。" },
];

const DEFAULT: WeatherDef = WEATHER_TYPES.find((w) => w.key === "fair")!;
const byKey = new Map(WEATHER_TYPES.map((w) => [w.key, w]));

const pad = (n: number) => String(n).padStart(2, "0");
/** JST の YYYY-MM-DD */
export function jstDateStr(d = new Date()): string {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`;
}

export class Weather {
  constructor(private readonly settings: Settings) {}

  forDate(dateStr: string): WeatherDef {
    const key = this.settings.getString(`weather:${dateStr}`);
    return (key && byKey.get(key)) || DEFAULT;
  }
  today(): WeatherDef {
    return this.forDate(jstDateStr());
  }
  /** 今日のカジノ配当倍率 */
  payoutMult(): number {
    return this.today().mult;
  }

  /**
   * その日の天気を確定する（未確定なら重み付き抽選して保存）。冪等。
   * 新規に決まったら isNew=true を返す（発表はその時だけ）。
   */
  roll(dateStr: string, actor: string, rng: () => number = Math.random): { def: WeatherDef; isNew: boolean } {
    const existing = this.settings.getString(`weather:${dateStr}`);
    if (existing && byKey.has(existing)) return { def: byKey.get(existing)!, isNew: false };
    const total = WEATHER_TYPES.reduce((s, w) => s + w.weight, 0);
    let r = Math.floor(rng() * total);
    let picked = DEFAULT;
    for (const w of WEATHER_TYPES) {
      if (r < w.weight) {
        picked = w;
        break;
      }
      r -= w.weight;
    }
    this.settings.set(`weather:${dateStr}`, picked.key, actor);
    return { def: picked, isNew: true };
  }
}
