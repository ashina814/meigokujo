/**
 * 称号の判定材料にしてはいけないデータ源。
 *
 * 称号はプロフィールという公開面に出る。したがって「その機能を使った事実」や
 * 「誰と関係があるか」が称号から逆算できてはいけない機能がある。
 *
 * ここに挙げた機能は、条件から完全に除外する。「装備しなければ見えない」
 * 「運営しか見られない」といった運用前提での回避はしない（自動装備・将来の公開
 * プロフィール・装備UIのいずれかが前提を崩すため、構造で防ぐ）。
 *
 * - confession / toto : トートの耳。完全匿名のタレコミ。利用事実の露出が設計違反。
 * - ticket            : 相談・出戻り等の受付窓口。利用事実は本人の私事。
 * - mitsugetsu        : 蜜月。匿名の募集・マッチング。成立は人間関係の開示になる。
 * - oborozuki         : 朧月。招待の授受が特定の相手との関係を示唆する。
 * - recruit           : 蜜月の募集・応募レコード（mitsugetsu の実体）。
 *
 * この一覧は tests/titles.test.ts が全ルールの判定式を走査して機械的に検証する。
 * 新しい秘匿機能を作ったら、まずここに足すこと。
 */
export const SENSITIVE_SOURCES = [
  "confession",
  "toto",
  "ticket",
  "mitsugetsu",
  "oborozuki",
  "recruit",
] as const;

/** 部屋の種別のうち、称号の材料にしてよいもの（蜜月・朧月は秘匿対象なので含めない） */
export const PUBLIC_ROOM_KINDS = ["normal", "game"] as const;

export type PublicRoomKind = (typeof PUBLIC_ROOM_KINDS)[number];

/** 判定式の文字列に秘匿データ源への参照が含まれていないか */
export function findSensitiveReference(source: string): string | null {
  const lowered = source.toLowerCase();
  for (const word of SENSITIVE_SOURCES) {
    if (lowered.includes(word)) return word;
  }
  return null;
}
