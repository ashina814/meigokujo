import { MessageFlags, type Interaction } from "discord.js";

/**
 * マモンの株式市場の停止（大型UPD PR6・正本 §1.3 / §19 PR6）。
 *
 * 停止する理由は「胴元が無予約・無上限の債務を負っているから」。
 * 価格は AR(1)（前回のトレンドが 0.6 で持続する）ので、プレイヤーはトレンドに乗れる。
 * 対して胴元のエッジは売却手数料 1% だけで、保有中の含み益への引当も無い。
 * PR5 の債務予約は「1ゲーム = 1回の最悪ケース」を押さえる仕組みで、
 * 建玉を持ち続けるあいだ膨らむ株の債務は表現できない。
 *
 * **建玉には一切触れない。** 強制売却も価格更新も止める（正本 §1.3
 * 「試験データであることを確認できた建玉は初期化する」= PR12 の正式開業初期化の仕事）。
 * ここで清算すると、正式資産だった場合に補償の基準（時価）を自分で壊すことになる。
 */
export const STOCKS_PAUSED = true;

export const STOCKS_PAUSE_REASON = [
  "📈 **マモンの株式市場は停止している。**",
  "",
  "胴元が引き当てを持てない賭けだったからだ。値動きは前の流れを引きずるので、",
  "乗れば勝ち続けられる。それに対して賭場の取り分は売却手数料の1%しかない。",
  "",
  "**持っている株はそのままだ。** 勝手に売り払ったりはしない。",
  "扱いが決まるまで凍結し、決まったら本人に知らせる。",
].join("\n");

/** 停止理由を利用者へ返す（コマンド・ボタン・選択のどれでも同じ文面） */
export async function replyStocksPaused(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;
  await interaction.reply({ content: STOCKS_PAUSE_REASON, flags: MessageFlags.Ephemeral });
}
