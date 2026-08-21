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
 *
 * rarityのidentityはtitleKey単位であって、scopeKey単位ではない。
 * titleそのものは月/eventごとに複数scopeで繰り返しawardされ得るが（例: 毎月の
 * monthly title）、「このtitleを持っているか」というrarityの意味では同一titleを
 * 何度再獲得しても1人としてしか数えない——ownership（=titleKeyを最初に獲得した
 * こと）が単位であり、award行（=titleKeyごとのscope別レコード）ではない。
 * `TitleV2Store.award()` はscope単位で複数行を作り得るが、それをそのまま
 * rarityのidentityへ流用すると、月ごとに繰り返し取得できるtitleの所持者数が
 * scopeの数だけ水増しされてしまう。
 */

/** 現在の所持者数（titleKey単位のownership数）から動的に算出する、永続化しないスナップショット。 */
export interface TitleCurrentRaritySnapshot {
  readonly titleKey: `v2.${string}`;
  readonly currentHolderCount: number;
  readonly computedAt: number;
}

/**
 * award時点でBotが確定した順位。以後不変（awardの再評価では書き換えない）。
 *
 * このtitleKeyを**最初に**獲得したタイミングでのみ作る——月/eventで同じtitleKeyを
 * 別scopeで再award（再獲得）しても、acquisitionSequenceは増やさない・snapshotを
 * 作り直さない。
 */
export interface TitleAcquisitionRaritySnapshot {
  readonly titleKey: `v2.${string}`;
  readonly userId: string;
  /** Botがtitleの最初のownershipを確定した処理順（1始まり）。真の達成順の証明ではない。 */
  readonly acquisitionSequence: number;
  readonly holderCountAtAcquisition: number;
  readonly acquiredAt: number;
  /** 最初にこのtitleKeyを獲得したscopeKey。証跡として保持するだけで、rarityのidentityではない。 */
  readonly firstScopeKey: string;
}
