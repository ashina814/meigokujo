import { EmbedBuilder, type Client } from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import { C_BIGWIN, C_JACKPOT, E, fmtBigDelta } from "./ui.js";

/**
 * 大勝ち速報 — JP当選・高倍率勝ちを channel:bigwin へ流す（casino-bot 準拠）。
 * 発火: JP当選 / 払戻÷賭け ≥ 15倍 かつ 純益 ≥ 5万◈ / 純益 ≥ 100万◈。
 * 未設定なら静かに何もしない。失敗は握り潰す。
 */
const RATIO = 15;
const RATIO_MIN_NET = 50_000;
const ABS_NET = 1_000_000;

export function broadcastBigWin(
  client: Client,
  services: Services,
  o: { userId: string; game: string; bet: number; payout: number; isJackpot?: boolean },
): void {
  try {
    const chId = services.settings.getString("channel:bigwin");
    if (!chId) return;
    const net = o.payout - o.bet;
    const ratio = o.bet > 0 ? o.payout / o.bet : 0;
    if (!(o.isJackpot || (ratio >= RATIO && net >= RATIO_MIN_NET) || net >= ABS_NET)) return;
    void (async () => {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch?.isTextBased() || !("send" in ch)) return;
      const isJp = !!o.isJackpot;
      const embed = new EmbedBuilder()
        .setAuthor({ name: `マモンの賭場 · ${o.game}` })
        .setColor(isJp ? C_JACKPOT : C_BIGWIN)
        .setTitle(`${isJp ? `${E.jp}  JACKPOT!` : `${E.fire}  大勝ち  ×${ratio.toFixed(1)}`}  ${fmtBigDelta(net)}`)
        .setDescription(
          isJp
            ? `<@${o.userId}> がジャックポットを射止めた。マモンが押し黙る。`
            : `<@${o.userId}> が賭け ${fmtEther(o.bet).replace(" ◈", "◈")} を **${fmtEther(o.payout).replace(" ◈", "◈")}** に化けさせた。`,
        )
        .setFooter({ text: isJp ? `${E.demon} マモンより苦渋の献上` : `${E.streak} 賭場の話題を独占` });
      await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
    })();
  } catch {
    /* 速報は本流を止めない */
  }
}
