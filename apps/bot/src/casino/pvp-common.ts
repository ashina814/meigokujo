import { randomUUID } from "node:crypto";
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
import { HOUSE_HOLDER, JACKPOT_HOLDER } from "@meigokujo/core";
import type { Services } from "../services.js";
import { fmtEther } from "../format.js";
import { C_LOSE, C_MAMMON, C_WIN } from "./ui.js";

/**
 * session を渡さない旧方式で資金が置かれる場所。
 *
 * 以前は `stakeHolder(session?)` という分岐関数だったが、呼び出しは2箇所とも
 * `stakeHolder(undefined)` で、session がある経路は先に `escrow.settle()` へ抜けていた。
 * 通らない分岐を持つと「session を渡せばここも切り替わる」と読めてしまうので、
 * 旧経路の置き場だけを名前で示す（PR3 の死んだコード整理）。
 */
const LEGACY_STAKE_HOLDER = HOUSE_HOLDER;

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
export function collectStakes(
  services: Services,
  userIds: string[],
  bet: number,
  operationId: string,
  session?: string,
  game = "pvp",
): boolean {
  // 新方式（session あり）: 事前の残高確認も含めて **全員ぶんで1グループ**。
  // 途中で足りない人がいれば、先に取った人の分もグループごと巻き戻る
  if (session) return services.escrow.holdAll(session, userIds, bet, game, operationId);

  // 旧方式（session なし・レガシー呼び出し互換）: house へ直接。こちらも1グループ
  try {
    return services.ether.runGroup(
      { groupKey: `pvp:collect:${game}:${operationId}`, kind: "table_hold", actorId: "system:pvp" },
      (): boolean => {
        // 残高確認もグループの中（徴収成功後の再試行を残高不足で false にしない）
        for (const u of userIds) {
          if (services.ether.balanceOf(u) < bet) throw new StakeShortfall();
        }
        // 通算損益はここでは動かさない（PR3）。徴収は「まだ何も確定していない」状態で、
        // 対局中なのに通算負けが増えるのは定義に合わない。記録は精算のとき一度だけ
        for (const u of userIds) services.ether.transfer(u, HOUSE_HOLDER, bet, { reason: "対人戦の賭け金", game });
        return true;
      },
    );
  } catch (e) {
    if (e instanceof StakeShortfall) return false;
    throw e;
  }
}

/** 誰かの残高が足りずに徴収を打ち切ったことを伝える内部例外（グループを巻き戻すため） */
class StakeShortfall extends Error {
  constructor() {
    super("STAKE_SHORTFALL");
    this.name = "StakeShortfall";
  }
}

/**
 * 参加者に返金（勝負不成立時など）。session があれば台帳の預かり額で返して記録も消す。
 * **全員ぶんで1グループ**なので、途中で落ちれば誰にも返らない（＝同じ鍵で再試行できる）。
 */
export function refundAll(services: Services, userIds: string[], bet: number, operationId: string, session?: string): void {
  if (session) {
    services.escrow.refundMany(session, userIds, operationId);
    return;
  }
  services.ether.runGroup({ groupKey: `pvp:refund:${operationId}`, kind: "table_refund", actorId: "system:pvp" }, () => {
    // 返金でも通算損益は動かさない（徴収時にも記録していないので差引0のまま・PR3）
    for (const u of userIds) services.ether.transfer(HOUSE_HOLDER, u, bet, { reason: "対人戦の不成立返金" });
  });
}

/**
 * 旧経路（session なし）の通算損益（PR3）。
 *
 * 「徴収時に −bet、配当時に +share」と分けて記録すると、対局中なのに通算負けが増え、
 * 不成立返金でも total_earned / total_lost が両方膨らむ。
 * **確定精算のときに、利用者ごとの純損益を一度だけ**記録する。
 * 場代は「受取が出した額を下回る」形で自然に損失側へ入る。
 *
 * 呼び出し元は必ず精算の資金グループの中なので、再試行では二度呼ばれない。
 * session ありの経路は `Escrow.settle` が帳簿から同じ計算をする。
 */
function recordPvpNet(
  services: Services,
  stakes: ReadonlyArray<{ userId: string; amount: number }> | undefined,
  received: ReadonlyMap<string, number>,
): void {
  if (!stakes || stakes.length === 0) return;
  const staked = new Map<string, number>();
  for (const s of stakes) staked.set(s.userId, (staked.get(s.userId) ?? 0) + s.amount);
  for (const [userId, stake] of staked) {
    services.casino.recordGameNet(userId, (received.get(userId) ?? 0) - stake);
  }
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
  operationId: string,
  session?: string,
  /**
   * 旧経路（session なし）で通算損益を出すための「誰がいくら出したか」（PR3）。
   * session ありなら `Escrow.settle` が帳簿から同じことをするので不要。
   */
  stakes?: ReadonlyArray<{ userId: string; amount: number }>,
): { payout: number; houseCut: number } {
  const houseCut = Math.floor(pot * HOUSE_CUT);
  const distributable = pot - houseCut;

  if (session) {
    // 新方式: 単一トランザクションで原子的に分配
    const distributions: Array<{ to: string; amount: number; reason: string }> = [];
    if (houseCut > 0) distributions.push({ to: JACKPOT_HOLDER, amount: houseCut, reason: "場代" });
    if (winners.length > 0) {
      const share = Math.floor(distributable / winners.length);
      const remainder = distributable - share * winners.length;
      for (let i = 0; i < winners.length; i++) {
        const amount = share + (i === 0 ? remainder : 0);
        if (amount > 0) distributions.push({ to: winners[i]!, amount, reason: "PvP勝者" });
      }
    } else if (distributable > 0) {
      distributions.push({ to: JACKPOT_HOLDER, amount: distributable, reason: "引き分け残余" });
    }
    services.escrow.settle(session, distributions, "system:pvp", "settlePvp");
    return { payout: winners.length > 0 ? distributable : 0, houseCut };
  }

  // 旧方式（session なし・レガシー呼び出し互換）: house から直接動かす
  const src = LEGACY_STAKE_HOLDER;
  return services.ether.runGroup(
    { groupKey: `pvp:settle:${operationId}`, kind: "table_settle", actorId: "system:pvp" },
    () => {
      if (houseCut > 0) services.ether.transfer(src, JACKPOT_HOLDER, houseCut, { reason: "場代" });
      if (winners.length === 0) {
        recordPvpNet(services, stakes, new Map());
        return { payout: 0, houseCut };
      }
      const share = Math.floor(distributable / winners.length);
      const remainder = distributable - share * winners.length;
      const received = new Map<string, number>();
      for (const w of winners) {
        services.ether.transfer(src, w, share, { reason: "対人戦の配当" });
        received.set(w, (received.get(w) ?? 0) + share);
      }
      if (remainder > 0) {
        services.ether.transfer(src, winners[0]!, remainder, { reason: "対人戦の配当（端数）" });
        received.set(winners[0]!, (received.get(winners[0]!) ?? 0) + remainder);
      }
      // 通算損益は「受取 − 出した額」を精算時に一度だけ（PR3）
      recordPvpNet(services, stakes, received);
      return { payout: distributable, houseCut };
    },
  );
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
  operationId: string,
  session?: string,
): { totalHouseCut: number } {
  const winnerPot = winners.reduce((s, w) => s + w.bet, 0);
  const loserPot = losers.reduce((s, l) => s + l.bet, 0);
  const houseCut = Math.floor((winnerPot + loserPot) * HOUSE_CUT);
  const distributable = winnerPot + loserPot - houseCut;

  if (session) {
    const distributions: Array<{ to: string; amount: number; reason: string }> = [];
    if (houseCut > 0) distributions.push({ to: JACKPOT_HOLDER, amount: houseCut, reason: "場代" });
    if (winnerPot > 0) {
      let remaining = distributable;
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i]!;
        const isLast = i === winners.length - 1;
        const share = isLast ? remaining : Math.floor((distributable * w.bet) / winnerPot);
        if (share > 0) distributions.push({ to: w.userId, amount: share, reason: "比例配当" });
        remaining -= share;
      }
    }
    services.escrow.settle(session, distributions, "system:pvp", "settleProportional");
    return { totalHouseCut: houseCut };
  }

  // 旧方式（session なし）
  const src = LEGACY_STAKE_HOLDER;
  services.ether.runGroup(
    { groupKey: `pvp:settle_proportional:${operationId}`, kind: "table_settle", actorId: "system:pvp" },
    () => {
      if (houseCut > 0) services.ether.transfer(src, JACKPOT_HOLDER, houseCut, { reason: "場代" });
      const received = new Map<string, number>();
      let remaining = distributable;
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i]!;
        const isLast = i === winners.length - 1;
        const share = isLast ? remaining : Math.floor((distributable * w.bet) / winnerPot);
        if (share > 0) {
          services.ether.transfer(src, w.userId, share, { reason: "対人戦の比例配当" });
          received.set(w.userId, (received.get(w.userId) ?? 0) + share);
        }
        remaining -= share;
      }
      // 通算損益は「受取 − 出した額」を精算時に一度だけ（PR3）
      recordPvpNet(services, [...winners, ...losers].map((p) => ({ userId: p.userId, amount: p.bet })), received);
    },
  );
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
