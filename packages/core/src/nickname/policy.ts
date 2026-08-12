/**
 * サーバーニックネームの規則（判定だけ・DBを見ない部分）。
 *
 * **入城パネルと商館の改名が、必ずこの1本を通る。** 片方だけ規則が緩いと、
 * 払えばルールを迂回できる状態になる。実際に規則を当てる順序は
 * `Nicknames.claim()` が持つ（形式 → 禁止語 → 同名）。
 */

/**
 * 城独自の文字数上限は設けない。ここにあるのは **Discord の技術上限**で、
 * 超えると API 側が弾く。増減させたくなったら、それは城の規則の変更なので
 * 先に運営の合意が要る。
 */
export const NICKNAME_MAX_LENGTH = 32;

/**
 * 規則の版。禁止語が増えたときに「いつの規則で通ったか」を残すために使う。
 * **遡って強制はしない**が、後から見直せるようにしておく。
 */
export const NICKNAME_POLICY_VERSION = "2026-08-12";

/**
 * 使ってよい文字。**ホワイトリストで決める。**
 *
 * 禁止記号を列挙する方式にすると Unicode の記号は膨大で必ず漏れる。
 * 「文字（`\p{L}`）と数字（`\p{N}`）だけ」と決めれば、通る文字が一意に定まる。
 * 長音符 `ー` は Unicode 上 `Lm`（修飾文字）なので `\p{L}` に含まれる。
 * 空白・中黒・句読点・記号・絵文字は、どれもこの2種に入らないので落ちる。
 */
const ALLOWED = /^[\p{L}\p{N}]+$/u;

export type NicknameRejection =
  | { code: "empty" }
  | { code: "too_long"; length: number }
  | { code: "illegal_chars"; chars: string[] }
  | { code: "denylisted"; pattern: string };

/**
 * 入力を正規化する。**NFKC を先に当てる。**
 *
 * 全角の `ａｌｉｃｅ` と半角の `alice`、半角カナと全角カナを別の名前として
 * 取り分けられないようにするため。正規化した結果を実際に設定する名前とし、
 * 確認画面にもその形で出す（入力と違う形が黙って登録される、を作らない）。
 */
export function normalizeNickname(input: string): string {
  return input.normalize("NFKC").trim();
}

/**
 * 同名判定に使う鍵。正規化したうえで大小同一視する。
 *
 * 見た目が似ているだけの別文字（`ロ` と `口` など）までは寄せない。
 * そこまで踏み込むと、正当な名前が取れない方の害が大きい。
 */
export function nicknameKey(input: string): string {
  return normalizeNickname(input).toLowerCase();
}

/** 文字数は**コードポイント**で数える（`.length` だと一部の漢字が2文字に見える） */
export function nicknameLength(normalized: string): number {
  return [...normalized].length;
}

/**
 * 形（長さ・使用文字）だけを見る。禁止語と同名は DB を見る側で判定する。
 */
export function checkNicknameShape(
  input: string,
): { ok: true; nickname: string; key: string } | { ok: false; rejection: NicknameRejection } {
  const nickname = normalizeNickname(input);
  if (nickname === "") return { ok: false, rejection: { code: "empty" } };
  const length = nicknameLength(nickname);
  if (length > NICKNAME_MAX_LENGTH) return { ok: false, rejection: { code: "too_long", length } };
  if (!ALLOWED.test(nickname)) {
    const chars = [...new Set([...nickname].filter((c) => !ALLOWED.test(c)))];
    return { ok: false, rejection: { code: "illegal_chars", chars } };
  }
  return { ok: true, nickname, key: nicknameKey(nickname) };
}

/** 利用者へ出す文言。**何が駄目かと、どう直すかまで書く。** */
export function describeRejection(rejection: NicknameRejection): string {
  switch (rejection.code) {
    case "empty":
      return "名前を入れてください。";
    case "too_long":
      return `名前は ${NICKNAME_MAX_LENGTH} 文字までです（いまは ${rejection.length} 文字）。`;
    case "illegal_chars":
      return [
        `使えない文字が含まれています: ${rejection.chars.join(" ")}`,
        "使えるのは **漢字・ひらがな・カタカナ・英字・数字・長音符（ー）** だけです。",
        "記号・空白・絵文字は使えません。",
      ].join("\n");
    case "denylisted":
      return "この名前は使えません。別の名前をお願いします。";
  }
}
