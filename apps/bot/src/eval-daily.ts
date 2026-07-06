import { EmbedBuilder, type AnyThreadChannel, type Client } from "discord.js";
import { fmtLd } from "./format.js";
import type { Services } from "./services.js";

/**
 * 亡霊各人の評価スレッドに「実績サマリ」を毎日更新する。
 * 直近14日の浮上時間・出現日数、招待による評価期限延長、通算残高を反映。
 * 既存の更新メッセージがあれば edit、無ければ新規投稿してIDを保存する。
 */
export async function refreshEvalStats(client: Client, services: Services): Promise<void> {
  const ghosts = services.entry.listSouls("ghost");
  for (const soul of ghosts) {
    const threadId = services.evaluation.threadFor(soul.user_id);
    if (!threadId) continue;
    const thread = (await client.channels.fetch(threadId).catch(() => null)) as AnyThreadChannel | null;
    if (!thread?.isThread()) continue;
    if (thread.archived) await thread.setArchived(false).catch(() => undefined);

    const presence = services.vc.presence(soul.user_id, 14);
    const hours = Math.floor(presence.totalSeconds / 3600);
    const mins = Math.floor((presence.totalSeconds % 3600) / 60);
    const balance = services.ledger.balanceOf(`user:${soul.user_id}`);
    const deadlineLine = soul.eval_deadline_at ? `<t:${soul.eval_deadline_at}:D>（<t:${soul.eval_deadline_at}:R>）` : "未設定";
    const extLine =
      soul.eval_extension_days > 0
        ? `**+${soul.eval_extension_days}日**（累積、招待による延長込み）`
        : "延長なし";

    const embed = new EmbedBuilder()
      .setTitle("📊 実績サマリ（毎日更新）")
      .setColor(0x6b21a8)
      .setDescription(
        [
          `**浮上実績（直近14日・評価対象VC）**: ${hours}時間${mins}分 / 出現${presence.daysSeen}日`,
          `**評価期限**: ${deadlineLine}`,
          `**評価期限の延長**: ${extLine}`,
          `**通算残高**: ${fmtLd(balance)}`,
        ].join("\n"),
      )
      .setFooter({ text: `更新: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}` });

    const existingMsgId = services.settings.getString(`eval_stat_msg:${soul.user_id}`);
    if (existingMsgId) {
      const msg = await thread.messages.fetch(existingMsgId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed] }).catch(() => undefined);
        continue;
      }
    }
    const sent = await thread.send({ embeds: [embed] }).catch(() => null);
    if (sent) services.settings.set(`eval_stat_msg:${soul.user_id}`, sent.id, "system:eval-daily");
  }
}
