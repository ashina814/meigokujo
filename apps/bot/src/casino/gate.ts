import { MessageFlags, type Interaction, type RepliableInteraction } from "discord.js";
import type { Services } from "../services.js";

/**
 * 賭場の入口ガード（大型UPD PR2）。
 *
 * 賭場が停止しているあいだ、**チップを動かしうる操作をひとつも通さない**。
 * 検算が落ちている状態で資金を動かすと、壊れた帳簿の上に取引を積むことになるので、
 * 「分からないときは動かさない」を入口で徹底する。
 *
 * 停止中でも通すもの: 遊びの説明・番付・通行証などの**読むだけ**の導線と、運営卓（/管理）。
 * 停止理由は利用者にそのまま見せる（黙って何も起きないのが一番困る）。
 */

/** チップが動きうるスラッシュコマンド */
const GUARDED_COMMANDS = new Set([
  "遊ぶ",
  "勝負",
  "福分け",
  "賭場商店",
  "株",
  "競馬",
  "vip",
  "流れ星",
  "板",
]);

/**
 * チップが動きうるコンポーネント（ボタン・選択・モーダル）の customId 接頭辞。
 * `apps/bot/src/casino/*.ts` と賭場系コマンドの `setCustomId` を全部拾ってある。
 */
const GUARDED_PREFIXES = [
  "ether:", // 両替（預入・返還）
  "bakuten:", // 賭場商店
  "stocks:", // 株
  "vip:", // VIP加入
  "ita:", // 板
  "rl:", // ルーレット
  "slots:",
  "chinchiro:",
  "keiba:",
  "crash:",
  "chohan:",
  "chm:", // 多人数丁半
  "bj:", // ブラックジャック
  "holdem:",
  "poker:", // ソロポーカー
  "pkr:", // PvPポーカー（卓）
  "bjd:", // BJ デュエル
  "ccd:", // チンチロ デュエル
  "ind:", // インディアンポーカー
  "sashi:", // サシ勝負
  "rem:", // 再戦オファー（押すと新しい勝負が始まる＝資金が動く）
];

/** その操作が賭場のチップを動かしうるか */
export function isCasinoInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) return GUARDED_COMMANDS.has(interaction.commandName);
  if ("customId" in interaction && typeof interaction.customId === "string") {
    const id = interaction.customId;
    return GUARDED_PREFIXES.some((p) => id.startsWith(p));
  }
  return false;
}

/**
 * 賭場が閉まっていれば理由を返して true（＝呼び出し側は処理を中止する）。
 * 開いていれば false。
 */
export async function denyIfCasinoClosed(interaction: Interaction, services: Services): Promise<boolean> {
  if (!isCasinoInteraction(interaction)) return false;
  const deny = services.casinoStatus.denyMessage();
  if (!deny) return false;
  const repliable = interaction as RepliableInteraction;
  if (typeof repliable.reply !== "function") return true;
  const content = `🎰 ${deny}`;
  try {
    if (repliable.replied || repliable.deferred) {
      await repliable.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await repliable.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    /* 応答できない状況（期限切れ等）でも、処理を通さないことが目的なので握り潰す */
  }
  return true;
}
