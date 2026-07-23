import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { HOUSE_HOLDER, JACKPOT_HOLDER, escrowHolderFor } from "@meigokujo/core";
import type { Services } from "../services.js";
import { fmtEther } from "../format.js";
import { C_LOSE, C_MAMMON, C_WIN } from "./ui.js";

/**
 * 「今この対戦の資金がどこにあるか」を返す。
 * - session あり: escrow:session:<id>（新方式・胴元と分離）
 * - session なし: house（旧方式・呼び出し側が旧経路でも動くように残す）
 * ここを唯一の分岐点にすることで、勝負系のあらゆる精算/返金が同じ場所から動く。
 */
function stakeHolder(session?: string): string {
  return session ? escrowHolderFor(session) : HOUSE_HOLDER;
}

/** 1v1 PvP ゲームが受け取る interaction（/勝負 直叩き or 再戦ボタン経由） */
export type PvpInteraction = ChatInputCommandInteraction | ButtonInteraction;

/**
 * PvP ゲームの共通経済ルール。
 * - エスクロー: 両者のエテルを内部的に確保（実際は既に取ってきた bet を保持するだけ）
 * - 場代: pot（賭け合計）の 3% を胴元の JP プールへ（マモンの取り分）
 * - 勝敗確定後、pot × (1 - 場代率) を勝者へ、負けは既に徴収済み
 * - 総量保存（一時的に house に置くことでカウンタの矛盾を防ぐ）
 */
const HOUSE_CUT = 0.03;

/**
 * PvP 招待の共通embed。
 * ゲーム名・アイコン・ルール要旨を渡すと author line + description + rule field を統一形で返す。
 */
export function buildPvpInvite(opts: {
  game: string;
  icon: string;
  challengerId: string;
  opponentId: string;
  bet: number;
  ruleLines: string[];
  color?: number;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(opts.color ?? C_MAMMON)
    .setTitle(`${opts.icon}  <${opts.challengerId}> の挑戦`)
    .setDescription(
      [
        `<@${opts.challengerId}> が <@${opts.opponentId}> に **${opts.game}** を挑んだ。`,
        "",
        `**賭け金**: ${fmtEther(opts.bet)}（両者から徴収）`,
        `**受ける** で対戦開始（60秒無応答は不成立）`,
      ].join("\n"),
    )
    .addFields({
      name: "▸ 遊び方",
      value: opts.ruleLines.map((l) => `　${l}`).join("\n"),
      inline: false,
    })
    .setFooter({ text: "勝者総取り · 場代3% → JPプール" });
}

/** PvP 不成立時の共通embed */
export function buildPvpAbort(game: string, icon: string, reason: string): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${game}` })
    .setColor(C_LOSE)
    .setTitle(`${icon}  不成立`)
    .setDescription(reason);
}

/** PvP 勝敗確定時の共通embed */
export function buildPvpResult(opts: {
  game: string;
  icon: string;
  winnerId: string | null;
  loserId?: string | null;
  bet: number;
  payout: number;
  houseCut: number;
  extra?: string;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · ${opts.game}` })
    .setColor(opts.winnerId ? C_WIN : 0x78716c)
    .setTitle(opts.winnerId ? `${opts.icon}  勝者 <@${opts.winnerId}>` : `${opts.icon}  引き分け`)
    .setFooter({ text: `場代 ${fmtEther(opts.houseCut).replace(" ◈", "◈")} → JPプール` });

  const lines: string[] = [];
  if (opts.winnerId) {
    lines.push(`${opts.icon} **勝ち**  <@${opts.winnerId}>  +${fmtEther(opts.payout - opts.bet).replace(" ◈", "◈")}`);
    if (opts.loserId) lines.push(`　**負け**  <@${opts.loserId}>  −${fmtEther(opts.bet).replace(" ◈", "◈")}`);
  } else {
    lines.push("両者に返金。");
  }
  if (opts.extra) lines.push("", opts.extra);
  embed.setDescription(lines.join("\n"));
  return embed;
}

/**
 * 両者から bet を徴収して house 一時保管。全員から取れなかったら false（取った分は戻す）。
 * session を渡すとエスクロー台帳に記録され、再起動時に自動返金される（推奨）。
 */
export function collectStakes(services: Services, userIds: string[], bet: number, session?: string, game = "pvp"): boolean {
  const insufficient = userIds.find((u) => services.ether.balanceOf(u) < bet);
  if (insufficient) return false;
  if (session) {
    const collected: string[] = [];
    for (const u of userIds) {
      if (!services.escrow.hold(session, u, bet, game)) {
        for (const c of collected) services.escrow.refundOne(session, c);
        return false;
      }
      collected.push(u);
    }
    return true;
  }
  for (const u of userIds) services.ether.transfer(u, HOUSE_HOLDER, bet);
  return true;
}

/** 参加者に返金（勝負不成立時など）。session があれば台帳の預かり額で返して記録も消す */
export function refundAll(services: Services, userIds: string[], bet: number, session?: string): void {
  if (session) {
    for (const u of userIds) services.escrow.refundOne(session, u);
    return;
  }
  for (const u of userIds) services.ether.transfer(HOUSE_HOLDER, u, bet);
}

/**
 * 勝負確定: pot から場代を差し引いて勝者に分配。
 * @param winners 勝者のユーザID配列（複数なら山分け・端数は最初の1人）
 * @param pot 総賭け合計（houseに一時的にある）
 * @returns { payout: 実際に払われた総額, houseCut: 場代 }
 */
export function settlePvp(
  services: Services,
  winners: string[],
  pot: number,
  session?: string,
): { payout: number; houseCut: number } {
  const src = stakeHolder(session);
  const houseCut = Math.floor(pot * HOUSE_CUT);
  const distributable = pot - houseCut;
  // 場代は JP へ（胴元の取り分＝プレイヤーに間接的に還元される）
  if (houseCut > 0) services.ether.transfer(src, JACKPOT_HOLDER, houseCut);

  if (winners.length === 0) {
    // 引き分け or 該当者なし → 場代だけ取って残りを分割対象がいないので国庫（実装的にはこのケースは呼ばれない）
    if (session) services.escrow.clear(session);
    return { payout: 0, houseCut };
  }
  const share = Math.floor(distributable / winners.length);
  const remainder = distributable - share * winners.length;
  for (const w of winners) services.ether.transfer(src, w, share);
  if (remainder > 0) services.ether.transfer(src, winners[0]!, remainder);
  if (session) services.escrow.clear(session);
  return { payout: distributable, houseCut };
}

/**
 * 賭け額比の按分（多人数丁半用: 勝ち側が負け側の賭けを比例分配）。
 * @param winners 勝ち側のユーザIDと bet
 * @param losers 負け側のユーザIDと bet
 */
export function settleProportional(
  services: Services,
  winners: Array<{ userId: string; bet: number }>,
  losers: Array<{ userId: string; bet: number }>,
  session?: string,
): { totalHouseCut: number } {
  const src = stakeHolder(session);
  const winnerPot = winners.reduce((s, w) => s + w.bet, 0);
  const loserPot = losers.reduce((s, l) => s + l.bet, 0);
  const houseCut = Math.floor((winnerPot + loserPot) * HOUSE_CUT);
  if (houseCut > 0) services.ether.transfer(src, JACKPOT_HOLDER, houseCut);
  const distributable = winnerPot + loserPot - houseCut;

  // 勝ち側に賭け額比で分配（元本 + 負け側からの取り分）
  let remaining = distributable;
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i]!;
    const isLast = i === winners.length - 1;
    const share = isLast ? remaining : Math.floor((distributable * w.bet) / winnerPot);
    if (share > 0) services.ether.transfer(src, w.userId, share);
    remaining -= share;
  }
  if (session) services.escrow.clear(session);
  return { totalHouseCut: houseCut };
}

/**
 * 決着後の再戦オファー。決着メッセージの下に「⚔ 再戦（同額）」ボタンを followUp で出し、
 * **両者が60秒以内に押したら** replay(btn) を呼ぶ。btn は2人目の押下 interaction で、
 * これを新しい挑戦コマンドの代わりとして各ゲームの play 関数に渡す（reply から新規に始まる）。
 * 残高チェック・エスクローは play 関数側が普通にやるので、ここでは何も徴収しない。
 */
export async function offerRematch(
  interaction: PvpInteraction,
  opts: { aId: string; bId: string; bet: number; game: string; replay: (btn: ButtonInteraction) => Promise<void> },
): Promise<void> {
  const nonce = `rem:${interaction.id}`;
  let msg: Message;
  try {
    msg = (await interaction.followUp({
      content: `⚔ 再戦するか？（同額 ${fmtEther(opts.bet)}・**両者**が押したら開始・60秒）`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(nonce).setLabel("再戦（同額）").setEmoji("⚔").setStyle(ButtonStyle.Primary),
        ),
      ],
      allowedMentions: { parse: [] },
    })) as Message;
  } catch {
    return; // followUp できない状況（期限切れ等）は静かに諦める
  }

  const pressed = new Set<string>();
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.customId === nonce && (i.user.id === opts.aId || i.user.id === opts.bId),
    time: 60_000,
  });
  collector.on("collect", (btn) => {
    void (async () => {
      if (pressed.has(btn.user.id)) {
        await btn.reply({ content: "もう押してある。相手待ちだ。", flags: MessageFlags.Ephemeral });
        return;
      }
      pressed.add(btn.user.id);
      if (pressed.size < 2) {
        await btn.reply({ content: "✅ 受け付けた。相手が押したら開戦。", flags: MessageFlags.Ephemeral });
        await msg.edit({ content: `⚔ 再戦するか？（同額 ${fmtEther(opts.bet)}・あと1人・60秒）` }).catch(() => undefined);
        return;
      }
      collector.stop("go");
      await msg.edit({ content: `⚔ **再戦成立！**（${opts.game}・${fmtEther(opts.bet)}）`, components: [] }).catch(() => undefined);
      await opts.replay(btn);
    })().catch((e) => console.error(`[rematch:${opts.game}] 再戦失敗:`, e));
  });
  collector.on("end", (_c, reason) => {
    if (reason !== "go") void msg.edit({ components: [] }).catch(() => undefined);
  });
}
