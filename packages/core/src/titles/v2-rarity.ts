/**
 * rarity契約の最低限の型（§13）。DB persistence・計算本体は後続PR。
 * ここでは後続実装が誤解しないよう、意味だけを型とdocで固定する。
 *
 * - current rarity: 現在の所持者状況から動的に変化する。永続化しない
 *   （「今何人持っているか」を問い合わせ時点で数えるだけの値）。
 * - acquisition-time rarity: award時点でsnapshotし、以後不変。
 * - VC derived source等、非orderableなsourceに依存するtitleが存在するため、
 *   「真のN人目」を断定できない。acquisitionSequenceは「Botがownershipを確定した
 *   処理順」（刻印順）であって、実際に条件を満たした時系列順の証明ではない
 *   ——非orderableなsourceに依存するruleはearnedAtがnullになる（v2-evaluator.ts
 *   のorderable契約）ため、そもそも「本当の達成時刻順」を再構成する材料が無い。
 */

/** 現在の所持者数から動的に算出する、永続化しないスナップショット。 */
export interface TitleCurrentRaritySnapshot {
  readonly titleKey: `v2.${string}`;
  readonly scopeKey: string;
  readonly currentHolderCount: number;
  readonly computedAt: number;
}

/** award時点でBotが確定した順位。以後不変（awardの再評価では書き換えない）。 */
export interface TitleAcquisitionRaritySnapshot {
  readonly titleKey: `v2.${string}`;
  readonly scopeKey: string;
  readonly userId: string;
  /** Botがawardを確定した処理順（1始まり）。真の達成順の証明ではない。 */
  readonly acquisitionSequence: number;
  readonly holderCountAtAcquisition: number;
  readonly acquiredAt: number;
}
