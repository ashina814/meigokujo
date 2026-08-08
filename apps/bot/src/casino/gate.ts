import { MessageFlags, type Interaction, type RepliableInteraction } from "discord.js";
import type { Services } from "../services.js";
import { isFormallyOpen, openingNotice } from "./opening.js";

/**
 * 賭場の入口ガード（大型UPD PR2）。
 *
 * 賭場が停止しているあいだ、**チップを動かしうる操作をひとつも通さない**。
 * 検算が落ちている状態で資金を動かすと、壊れた帳簿の上に取引を積むことになるので、
 * 「分からないときは動かさない」を入口で徹底する。
 *
 * 停止中でも通すもの: 遊びの説明・番付・通行証などの**読むだけ**の導線と、運営卓（/管理）。
 * PR #94のイベントLand板はチップ賭場とは別経済なので、`/板 イベント立てる` と
 * `itaevt:` コンポーネントも通す。停止理由は利用者にそのまま見せる。
 */

/** チップが動きうるスラッシュコマンド（`/板` はサブコマンド単位で下で判定する） */
const GUARDED_COMMANDS = new Set([
  "遊ぶ",
  "勝負",
  "福分け",
  "賭場商店",
  "株",
  "競馬",
  "vip",
  "流れ星",
]);

/** 正式開業前でも通す `/板` サブコマンド。未知の追加サブコマンドはfail-closedで止める。 */
const UNGUARDED_ITA_SUBCOMMANDS = new Set(["イベント立てる", "一覧"]);

/**
 * チップが動きうるコンポーネント（ボタン・選択・モーダル）の customId 接頭辞。
 * `apps/bot/src/casino/*.ts` と賭場系コマンドの `setCustomId` を全部拾ってある。
 * イベントLand板の `itaevt:` は意図的に含めない。
 */
const GUARDED_PREFIXES = [
  "ether:", // 両替（預入・返還）
  "bakuten:", // 賭場商店
  "stocks:", // 株
  "vip:", // VIP加入
  "ita:", // 通常チップ板
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
  "casino:amount:", // `/賭場` ホームの金額入力・確認（押すと賭けボタンへ進む）
  "casino:play:", // 胴元の余力不足から復帰する「押せる金額」ボタン（PR5）
  "casino:exit:", // 結果画面の退場（自由チップをLandへ返還）
  "casino:daily:", // `/賭場` ホームの福分け受け取りボタン（既存Daily処理へ接続）
];

/** その操作が賭場のチップを動かしうるか */
export function isCasinoInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "板") {
      const subcommand = interaction.options.getSubcommand(false);
      return !subcommand || !UNGUARDED_ITA_SUBCOMMANDS.has(subcommand);
    }
    return GUARDED_COMMANDS.has(interaction.commandName);
  }
  if ("customId" in interaction && typeof interaction.customId === "string") {
    const id = interaction.customId;
    return GUARDED_PREFIXES.some((p) => id.startsWith(p));
  }
  return false;
}

/**
 * 賭場が閉まっていれば理由を返して true（＝呼び出し側は処理を中止する）。
 * 開いていれば false。
 *
 * 稼働状態が `open` でも、正式開業初期化（PR12）が終わっていなければ資金は動かせない
 * （PR8監査・項目8）。core 側の `ERR_CASINO_OPENING_NOT_COMPLETE` を握って generic な
 * 失敗にするのではなく、**押す前に**なぜ今できないかをここで返す。停止中の理由文の方が
 * 利用者に近いので、稼働状態の判定を先に置く。
 */
export async function denyIfCasinoClosed(interaction: Interaction, services: Services): Promise<boolean> {
  if (!isCasinoInteraction(interaction)) return false;
  const deny = services.casinoStatus.denyMessage() ?? (isFormallyOpen(services) ? null : openingNotice(services));
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
