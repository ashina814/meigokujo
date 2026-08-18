import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Message, type TextBasedChannel } from "discord.js";
import { randomUUID } from "node:crypto";
import { fmtLd } from "../format.js";
import { createChallenge, getOpenChallengeForChallenger, type PvpChallenge } from "./pvp-challenge.js";
import { pvpGame, type PvpGameKey } from "./pvp-games.js";
import { preparePvpNotify } from "./pvp-notify-throttle.js";
import { C_MAMMON } from "./ui.js";

export const PVP_ACCEPT = "casino:home:pvpopen-accept";
export const PVP_CANCEL = "casino:home:pvpopen-cancel";

export type PvpRecruitmentNotification = "sent" | "cooldown" | "unconfigured";

export type PvpChallengePostResult = {
  card: Message;
  notification: PvpRecruitmentNotification;
};

const activeRecruitmentPosts = new Set<string>();

export class PvpChallengePostInProgressError extends Error {
  constructor() {
    super("recruitment post already in progress");
    this.name = "PvpChallengePostInProgressError";
  }
}

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
 * **同じ募集者の投稿処理は1件だけ**にして、同時クリックでロール通知や公開カードが
 * 二重に飛ぶことを防ぐ。さらにロック取得後に open challenge を再確認することで、
 * 呼び出し側の事前確認後に別の募集が成立した stale race でも、Discord へカードや
 * ロール通知を送る前に止める。
 *
 * ID を先に customId へ入れ、`send()` 成功後は次の await を挟まずに通知枠確定 →
 * `createChallenge()` まで進める。
 *
 * 通知枠は Discord への送信が成功した時点でのみ消費する。送信自体が失敗した場合は
 * 3回枠を減らさない。一方、送信後に challenge 登録が失敗した場合は、実際に ping は
 * 届いているため通知1回として扱う。
 */
export async function postChallenge(input: {
  channel: TextBasedChannel & { send: (payload: never) => Promise<Message> };
  challengerId: string;
  game: PvpGameKey;
  bet: number;
  mentionRoleIds?: string[];
  onExpire: (challenge: PvpChallenge, card: Message) => void | Promise<void>;
}): Promise<PvpChallengePostResult> {
  if (activeRecruitmentPosts.has(input.challengerId)) {
    throw new PvpChallengePostInProgressError();
  }
  activeRecruitmentPosts.add(input.challengerId);

  try {
    // 呼び出し側の pvpAvailability() 後には await があるため、その間に同じ利用者の
    // 別募集が成立し得る。投稿ロックを取った「この瞬間」を正本にして再確認し、
    // 無効になるカードや role ping を Discord へ一度でも出してから閉じる race を防ぐ。
    if (getOpenChallengeForChallenger(input.challengerId)) {
      throw new Error(`Challenger already has an open challenge: ${input.challengerId}`);
    }

    const id = randomUUID();
    const notify = preparePvpNotify(input.challengerId, input.mentionRoleIds ?? []);
    const payload = challengeCard({ id, challengerId: input.challengerId, game: input.game, bet: input.bet });
    const card = await input.channel.send(
      {
        ...payload,
        ...(notify.roleIds.length > 0
          ? {
              content: notify.roleIds.map((roleId) => `<@&${roleId}>`).join(" "),
              allowedMentions: { roles: notify.roleIds },
            }
          : {}),
      } as never,
    );

    // ここまで来たら通知は実際に Discord へ送られたので、3回枠を確定する。
    notify.commit();

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
    return { card, notification: notify.status };
  } finally {
    activeRecruitmentPosts.delete(input.challengerId);
  }
}

/** テスト間で投稿中ロックを持ち越さないための明示リセット。 */
export function resetPvpChallengePostLocksForTesting(): void {
  activeRecruitmentPosts.clear();
}
