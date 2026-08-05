import type { Settings } from "../settings/service.js";
import { checkedAddAll, UnsafeAmountArithmeticError } from "./opening-canonical.js";

/**
 * 正式開業設定（PR12）。
 *
 * `settings` KVS（既存の `Settings` クラス）へ直接キーを置く。`SETTING_DEFAULTS` へは
 * 加えない — デフォルト値を持たせた瞬間、「未設定」と「デフォルト値そのもの」が
 * 区別できなくなり、CLAUDE.md §2 の「未設定判定に0を使わない」要件を満たせなくなる。
 * 未設定は「settings 行そのものが無い」（`getString()` が `undefined` を返す）ことで表す。
 *
 * 本番値はこのファイルにも `packages/core` の他のどこにもハードコードしない。
 * 運営が `Settings.set()` で明示的に置くまで、`readCasinoOpeningConfig()` は
 * `{ ok:false, configured:false }` を返し続ける。
 */

export const CASINO_OPENING_SETTING_KEYS = {
  capital: "casino_opening_capital",
  house: "casino_opening_house",
  jackpot: "casino_opening_jackpot",
  relief: "casino_opening_relief",
  minWorkingCapital: "casino_min_working_capital",
  remitRateBps: "casino_remit_rate_bps",
  configured: "casino_opening_configured",
} as const;

export interface CasinoOpeningConfig {
  readonly configured: true;
  readonly openingCapital: number;
  readonly openingHouse: number;
  readonly openingJackpot: number;
  readonly openingRelief: number;
  readonly minWorkingCapital: number;
  readonly remitRateBps: number;
}

export type CasinoOpeningConfigResult =
  | { ok: true; config: CasinoOpeningConfig }
  | { ok: false; configured: false; reason: "not_configured" }
  | { ok: false; configured: true; reason: "invalid"; errors: readonly string[] };

/**
 * 整数値の厳格な読み取り（CLAUDE.md §2）。
 *
 * `settings.getString()` は生の文字列（`Settings.set()` が `String(value)` で保存したもの）
 * をそのまま返す。ここでは **整数の正規表記(`-?[0-9]+`)と完全一致する場合だけ**受理する。
 * 前後空白・小数・指数表記・`NaN`・`Infinity`・16進表記はすべて拒否する
 * （`Number()` の曖昧変換や `parseInt` の部分一致を使わない）。
 */
function readStrictInteger(settings: Settings, key: string, errors: string[]): number | null {
  const raw = settings.getString(key);
  if (raw === undefined) {
    errors.push(`${key}: 未設定（settings行なし）`);
    return null;
  }
  if (!/^-?[0-9]+$/.test(raw)) {
    errors.push(`${key}: 整数リテラルではない値 ${JSON.stringify(raw)}`);
    return null;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    errors.push(`${key}: safe integer範囲外 ${JSON.stringify(raw)}`);
    return null;
  }
  return n;
}

/**
 * 開業設定を読み取り、厳格に検証する。SELECT相当の読み取りのみで、書き込みは一切しない。
 *
 * - `casino_opening_configured` が settings に無い、または文字列 `"true"` と完全一致しない
 *   場合は未設定として扱う（`0`・`"1"`・`"false"`・空文字はすべて未設定＝ configured:false）。
 * - 未設定なら他のキーを読まずに `not_configured` を返す（部分的な読み取りをしない）。
 * - configured=true なのに個別キーが欠落・不正な場合は `invalid` とし、全エラーを集める
 *   （最初の1件で打ち切らない — preflightが全不備を一度に報告できるように）。
 */
export function readCasinoOpeningConfig(settings: Settings): CasinoOpeningConfigResult {
  const configuredRaw = settings.getString(CASINO_OPENING_SETTING_KEYS.configured);
  if (configuredRaw !== "true") {
    return { ok: false, configured: false, reason: "not_configured" };
  }

  const errors: string[] = [];
  const capital = readStrictInteger(settings, CASINO_OPENING_SETTING_KEYS.capital, errors);
  const house = readStrictInteger(settings, CASINO_OPENING_SETTING_KEYS.house, errors);
  const jackpot = readStrictInteger(settings, CASINO_OPENING_SETTING_KEYS.jackpot, errors);
  const relief = readStrictInteger(settings, CASINO_OPENING_SETTING_KEYS.relief, errors);
  const minWorkingCapital = readStrictInteger(settings, CASINO_OPENING_SETTING_KEYS.minWorkingCapital, errors);
  const remitRateBps = readStrictInteger(settings, CASINO_OPENING_SETTING_KEYS.remitRateBps, errors);

  if (errors.length > 0) {
    return { ok: false, configured: true, reason: "invalid", errors };
  }

  // readStrictInteger が null を返さなかったので、ここでは全部 number
  const c = capital as number;
  const h = house as number;
  const j = jackpot as number;
  const r = relief as number;
  const m = minWorkingCapital as number;
  const bps = remitRateBps as number;

  if (!(c > 0)) errors.push(`${CASINO_OPENING_SETTING_KEYS.capital}: 0より大きい必要がある（現在値 ${c}）`);
  if (!(h > 0)) errors.push(`${CASINO_OPENING_SETTING_KEYS.house}: 0より大きい必要がある（現在値 ${h}）`);
  if (!(j >= 0)) errors.push(`${CASINO_OPENING_SETTING_KEYS.jackpot}: 0以上である必要がある（現在値 ${j}）`);
  if (!(r >= 0)) errors.push(`${CASINO_OPENING_SETTING_KEYS.relief}: 0以上である必要がある（現在値 ${r}）`);
  // CLAUDE.md監査ブロッカー8: h/j/rは個々にsafe integerでも、合計がsafe integerとは限らない。
  // 生の`+`で桁あふれを黙って丸めない(checkedAddAllが例外を投げれば、それ自体を
  // 構造化エラーとしてerrorsへ積む — dry-run同様、preflight的な検証はここでも投げさせない)。
  try {
    const sum = checkedAddAll([h, j, r], "house+jackpot+relief");
    if (sum !== c) {
      errors.push(`house(${h}) + jackpot(${j}) + relief(${r}) = ${sum} は capital(${c}) と一致しない`);
    }
  } catch (e) {
    if (!(e instanceof UnsafeAmountArithmeticError)) throw e;
    errors.push(`house/jackpot/reliefの合算でsafe integerを超えた: ${e.message}`);
  }
  if (!(m >= 0)) {
    errors.push(`${CASINO_OPENING_SETTING_KEYS.minWorkingCapital}: 0以上である必要がある（現在値 ${m}）`);
  }
  if (!(bps >= 0 && bps <= 10_000)) {
    errors.push(`${CASINO_OPENING_SETTING_KEYS.remitRateBps}: 0〜10000の範囲外（現在値 ${bps}）`);
  }

  if (errors.length > 0) {
    return { ok: false, configured: true, reason: "invalid", errors };
  }

  return {
    ok: true,
    config: {
      configured: true,
      openingCapital: c,
      openingHouse: h,
      openingJackpot: j,
      openingRelief: r,
      minWorkingCapital: m,
      remitRateBps: bps,
    },
  };
}

/**
 * テスト・将来の運営ツール用の書き込みヘルパー。
 *
 * Discordコマンド・ボタン・admin-hub からは呼ばない（CLAUDE.md §17: 実行禁止経路を
 * コードでも守る）。運営が値を置く手段は本PRの範囲外で別途用意する。
 */
export function writeCasinoOpeningConfig(
  settings: Settings,
  config: {
    openingCapital: number;
    openingHouse: number;
    openingJackpot: number;
    openingRelief: number;
    minWorkingCapital: number;
    remitRateBps: number;
  },
  actor: string,
): void {
  settings.set(CASINO_OPENING_SETTING_KEYS.capital, config.openingCapital, actor);
  settings.set(CASINO_OPENING_SETTING_KEYS.house, config.openingHouse, actor);
  settings.set(CASINO_OPENING_SETTING_KEYS.jackpot, config.openingJackpot, actor);
  settings.set(CASINO_OPENING_SETTING_KEYS.relief, config.openingRelief, actor);
  settings.set(CASINO_OPENING_SETTING_KEYS.minWorkingCapital, config.minWorkingCapital, actor);
  settings.set(CASINO_OPENING_SETTING_KEYS.remitRateBps, config.remitRateBps, actor);
  // configured フラグは最後に立てる。途中で例外が起きても configured=true にならない
  // （configured だけ先に立てると、個別キーが欠けたまま「設定済み」を名乗ってしまう）。
  settings.set(CASINO_OPENING_SETTING_KEYS.configured, "true", actor);
}

/** テスト用: 未設定状態へ戻す（configured フラグだけ消せば readCasinoOpeningConfig は not_configured を返す） */
export function clearCasinoOpeningConfig(settings: Settings, actor: string): void {
  settings.delete(CASINO_OPENING_SETTING_KEYS.configured, actor);
}
