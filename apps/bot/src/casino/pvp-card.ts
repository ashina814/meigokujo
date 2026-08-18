import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Message, type TextBasedChannel } from "discord.js";
import { randomUUID } from "node:crypto";
import { fmtLd } from "../format.js";
import { createChallenge, type PvpChallenge } from "./pvp-challenge.js";
import { pvpGame, type PvpGameKey } from "./pvp-games.js";
import { takePvpNotifyRoleIds } from "./pvp-notify-throttle.js";
import { C_MAMMON } from "./ui.js";

export const PVP_ACCEPT = "casino:home:pvpopen-accept";
export const PVP_CANCEL = "casino:home:pvpopen-cancel";

export type PvpRecruitmentNotification = "sent" | "cooldown" | "unconfigured";

export type PvpChallengePostResult = {
  card: Message;
  notification: PvpRecruitmentNotification;
};

/** 公開募集カード。**この時点では資金を1 Ld も動かさない** */
export function challengeCard(input: { id: string; challengerId: string; game: PvpGameKey; bet: number }) {
  const g = pvpGame(input.game);
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 対戦相手募集中" })
    .setColor(C_MAMMON)
    .setTitle(`${g?.emoji ?? "⚔"}  ${g?.label ?? input.game}`)
    .setDescription(
      [
        `挑戦者: <@${input.challengerId}>`,
        `賭け金: **${fmtLd(input.bet)}**`,
        "",
        "誰でも参加できます。**最初に「受ける」を押した1人**と勝負します。",
        "-# 受けた時点で双方から賭け金を預かります。募集中は何も動きません。",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PVP_ACCEPT}:${input.id}`).setLabel("受ける").setEmoji("⚔").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PVP_CANCEL}:${input.id}`).setLabel("取り消す").setEmoji("✖").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** 終端表示。**ボタンは必ず外す**（押せる見た目のまま残さない） */
export function closedCard(text: string) {
  return {
    content: "",
    embeds: [new EmbedBuilder().setAuthor({ name: "マモンの賭場" }).setColor(C_MAMMON).setDescription(text)],
    components: [],
  };
}

export async function closeChallengeCard(card: Message, text: string): Promise<void> {
  await card.edit(closedCard(text));
}

/**
 * 募集を1件立てる。
 *
 * **ID を先に作って customId へ入れ、`send()` 成功の直後に、次の await を挟まずに
 * `createChallenge()` する。** 逆順やあいだに await があると
 * 「送信に失敗したのに3分タイマーだけ生きている」ゴミや、
 * 「カードは出たが押しても gone」という窓ができる。
 */
export async function postChallenge(input: {
  channel: TextBasedChannel & { send: (payload: never) => Promise<Message> };
  challengerId: string;
  game: PvpGameKey;
  bet: number;
  mentionRoleIds?: string[];
  onExpire: (challenge: PvpChallenge, card: Message) => void | Promise<void>;
}): Promise<PvpChallengePostResult> {
  const id = randomUUID();
  const configuredNotify = (input.mentionRoleIds ?? []).some(Boolean);
  // 募集そのものは止めず、通知だけを募集者単位で 3回 → 5分CD にする。
  // ここで同期的に枠を消費することで、同時投稿でも3回制限をすり抜けない。
  const mentionRoleIds = takePvpNotifyRoleIds(input.challengerId, input.mentionRoleIds ?? []);
  const notification: PvpRecruitmentNotification =
    mentionRoleIds.length > 0 ? "sent" : configuredNotify ? "cooldown" : "unconfigured";
  const payload = challengeCard({ id, challengerId: input.challengerId, game: input.game, bet: input.bet });
  const card = await input.channel.send(
    {
      ...payload,
      ...(mentionRoleIds.length > 0
        ? {
            content: mentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" "),
            allowedMentions: { roles: mentionRoleIds },
          }
        : {}),
    } as never,
  );
  try {
    createChallenge({
      id,
      challengerId: input.challengerId,
      game: input.game,
      bet: input.bet,
      channelId: card.channelId,
      onExpire: (challenge) => input.onExpire(challenge, card),
    });
  } catch (e) {
    // 登録できなかったのにカードだけ公開されている状態を残さない
    console.error("[pvp] 募集の登録に失敗:", e);
    await closeChallengeCard(card, "募集を開始できませんでした。").catch(() => undefined);
    throw e;
  }
  return { card, notification };
}
