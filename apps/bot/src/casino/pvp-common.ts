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
import { DailyRiskError, JACKPOT_HOLDER } from "@meigokujo/core";
import type { Services } from "../services.js";
import { fmtEther } from "../format.js";
import { acquireTransientParticipation, releaseTransientParticipation } from "./participation.js";
import { C_LOSE, C_MAMMON, C_WIN } from "./ui.js";

/** 1v1 PvP ゲームが受け取る interaction（/勝負 直叩き or 再戦ボタン経由） */
export type PvpInteraction = ChatInputCommandInteraction | ButtonInteraction;

/**
 * `/勝負` の対人卓のリスク枠の名前（PR23）。
 *
 * 常設順位卓（`RankedTables`）とは別のシステムだが、**現役のマモン賭博入口**なので
 * 正本 §15 の安全上限（同時参加1卓・所持50%・日次純損失上限）を同じ `DailyRisk` へ通す。
 * ここで変えるのは参加可否と上限だけで、場代の行き先・配当・勝敗判定・RTP は一切触らない。
 */
export function pvpRiskScope(session: string): string {
  return `pvp:${session}`;
}

/**
 * 徴収の結果。
 *
 * `false` を返すだけだと「なぜ弾かれたか」を客に言えないので、PR23 で理由付きにした。
 * `risk` は正本 §15 の安全上限（同時参加・所持50%・日次純損失上限）に当たった場合で、
 * この時点で資金は1 Ld も動いていない。
 */
export type CollectStakesResult =
  | { ok: true }
  | { ok: false; reason: "broke" }
  | { ok: false; reason: "risk"; userId: string; detail: string };

/** 徴収失敗をそのまま客に見せる文面にする */
export function stakeFailureText(result: CollectStakesResult): string {
  if (result.ok) return "";
  if (result.reason === "risk") return `<@${result.userId}> は勝負を始められない。${result.detail}`;
  return "どちらかのLand残高が足りない。";
}

/** PR23 の安全上限に弾かれた（資金は1 Ld も動いていない）。`collectStakes` の内部シグナル */
class PvpRiskRejectedError extends Error {
  constructor(
    readonly userId: string,
    readonly detail: string,
  ) {
    super(`ERR_PVP_RISK: ${userId}`);
    this.name = "PvpRiskRejectedError";
  }
}

/**
 * PvP ゲームの共通経済ルール。
 * - エスクロー: 両者のLandを内部的に確保（実際は既に取ってきた bet を保持するだけ）
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
    .setFooter({ text: `場代 ${fmtEther(opts.houseCut).replace(" Ld", "Ld")} → JPプール` });

  const lines: string[] = [];
  if (opts.winnerId) {
    lines.push(`${opts.icon} **勝ち**  <@${opts.winnerId}>  +${fmtEther(opts.payout - opts.bet).replace(" Ld", "Ld")}`);
    if (opts.loserId) lines.push(`　**負け**  <@${opts.loserId}>  −${fmtEther(opts.bet).replace(" Ld", "Ld")}`);
  } else {
    lines.push("両者に返金。");
  }
  if (opts.extra) lines.push("", opts.extra);
  embed.setDescription(lines.join("\n"));
  return embed;
}

/**
 * 参加者から bet を徴収してエスクローへ預ける。全員から取れなかったら false（取った分は戻る）。
 *
 * ## PR23: 資金を動かす前に安全上限を通す
 *
 * 徴収の**前**に、参加者ごとに
 *
 * 1. 一時参加の排他（順位卓 live / ソロ席 / 他の対人卓 / ルーレット卓）
 * 2. 所持Landの50%（= 通常Land + 自由チップ。エスクローは含めない）
 * 3. 当日の残り許容損失
 *
 * を確認して露出を確保する。この対人卓での参加者の最大損失は**預ける賭け金そのもの**
 * （既存の徴収額から一意に決まる。ゲームごとの倍率表は作らない）。多人数丁半の
 * 増し賭けのように同じ卓で積み増す徴収は `add` で合算して判定する。
 *
 * 誰か1人でも通らなければ、**誰の資金も動かさず**に false を返す（§12）。
 */
export function collectStakes(
  services: Services,
  userIds: string[],
  bet: number,
  operationId: string,
  session: string,
  game = "pvp",
): CollectStakesResult {
  const scope = pvpRiskScope(session);
  const acquired: string[] = [];
  const authorized: string[] = [];
  try {
    for (const u of userIds) {
      if (!acquireTransientParticipation(services, u, "pvp", scope, { reentrant: true })) {
        throw new PvpRiskRejectedError(u, "ほかの卓に着いている。そちらを終わらせてからだ。");
      }
      acquired.push(u);
    }
    for (const u of userIds) {
      try {
        services.dailyRisk.authorizeExposure({
          userId: u,
          scopeKey: scope,
          operationId: `${operationId}:${u}`,
          game,
          maxPlayerLoss: bet,
          mode: "add",
        });
      } catch (e) {
        throw new PvpRiskRejectedError(u, pvpRiskDetail(services, u, e));
      }
      authorized.push(u);
    }
  } catch (e) {
    rollbackPvpAuthorization(services, scope, operationId, acquired, authorized);
    if (e instanceof PvpRiskRejectedError) return { ok: false, reason: "risk", userId: e.userId, detail: e.detail };
    throw e;
  }
  // 事前の残高確認も含めて **全員ぶんで1グループ**。
  // 途中で足りない人がいれば、先に取った人の分もグループごと巻き戻る
  let ok: boolean;
  try {
    ok = services.escrow.holdAll(session, userIds, bet, game, operationId);
  } catch (e) {
    rollbackPvpAuthorization(services, scope, operationId, acquired, authorized);
    throw e;
  }
  // 資金が1 Ld も動かなかった（全員ぶん巻き戻った）ので、露出と席も同じ状態へ戻す
  if (!ok) {
    rollbackPvpAuthorization(services, scope, operationId, acquired, authorized);
    return { ok: false, reason: "broke" };
  }
  return { ok: true };
}

/**
 * 徴収が成立しなかったときの巻き戻し。
 *
 * 資金は `escrow.holdAll` が全員ぶん原子的に扱うので、ここへ来た時点で
 * **この呼び出しで動いた資金は無い**。露出は「この呼び出しで足したぶんだけ」を
 * 取り消す（`revokeExposure`）。同じ卓に先行して成立した露出——多人数丁半の
 * 1回目の賭けなど——は預り金の裏付けがあるので、その額のまま残る。
 * 席は露出が完全に消えた人だけ解く（§10）。
 */
function rollbackPvpAuthorization(services: Services, scope: string, operationId: string, acquired: string[], authorized: string[]): void {
  for (const u of authorized) {
    try {
      services.dailyRisk.revokeExposure({ scopeKey: scope, userId: u, operationId: `${operationId}:${u}` });
    } catch {
      // 露出が残るぶんには安全側（次の賭博が断られるだけ）。ここで握り潰す
    }
  }
  for (const u of acquired) {
    if (hasLivePvpExposure(services, scope, u)) continue;
    releaseTransientParticipation(u, "pvp", scope);
  }
}

/** `pvp:<session>` から session を戻す（露出の名前空間と台帳の鍵を1箇所で対応づける） */
function scopeSessionOf(scope: string): string {
  return scope.startsWith("pvp:") ? scope.slice(4) : scope;
}

/** その卓に、この利用者の預り金が既に載っているか */
function hasEscrowStake(services: Services, scope: string, userId: string): boolean {
  try {
    return services.escrow.list(scopeSessionOf(scope)).some((row) => row.user_id === userId);
  } catch {
    return true;
  }
}

/** 露出が残っているか。判定できなければ fail-closed で「残っている」扱い */
function hasLivePvpExposure(services: Services, scope: string, userId: string): boolean {
  try {
    return services.dailyRisk.exposureOf(scope, userId) !== null;
  } catch {
    return true;
  }
}

/** PR23 拒否理由の文面 */
function pvpRiskDetail(services: Services, userId: string, error: unknown): string {
  if (error instanceof DailyRiskError && error.code === "ERR_DAILY_RISK_DAY_ROLLOVER") {
    return "日付が変わった。この卓への追加はもう受けられない。";
  }
  if (error instanceof DailyRiskError && error.code === "ERR_DAILY_RISK_LIMIT") {
    try {
      const day = services.dailyRisk.dayFor(userId);
      return day.remainingLossBudget > 0
        ? `所持額に対して賭けが大きすぎる。残り許容損失は ${fmtEther(day.remainingLossBudget)}。`
        : `今日はここまでだ。日次損失上限 ${fmtEther(day.lossCap)} に達している。`;
    } catch {
      return "賭場の利用制限を確認できないため、いまは勝負できない。";
    }
  }
  return "賭場の利用制限を確認できないため、いまは勝負できない。";
}

/**
 * 参加者に返金（勝負不成立時など）。台帳の預かり額で返して記録も消す。
 * **全員ぶんで1グループ**なので、途中で落ちれば誰にも返らない（＝同じ鍵で再試行できる）。
 *
 * PR23: 返金は純損益0なので当日枠は動かさない。資金が戻ってから露出と席を解く。
 */
export function refundAll(services: Services, userIds: string[], bet: number, operationId: string, session: string): void {
  services.escrow.refundMany(session, userIds, operationId);
  releasePvpParticipants(services, session, userIds);
}

/**
 * 卓ごと流す（全員へ返金し、露出も一括で解く）。純損益0なので当日枠は動かさない。
 *
 * 返金と露出解放を同じトランザクションに入れるので、「返金だけ通って露出が残る」
 * （＝その人が以後どの賭博も始められない）状態を作らない。
 */
export function voidPvpTable(services: Services, session: string): void {
  const participants = pvpParticipants(services, session);
  const scope = pvpRiskScope(session);
  services.chips.runGroup({ groupKey: `pvp:void:${session}`, kind: "table_refund", actorId: "system:pvp" }, () => {
    services.escrow.refund(session);
    services.dailyRisk.releaseExposureScope(scope);
  });
  for (const u of participants) releaseTransientParticipation(u, "pvp", scope);
}

/**
 * 卓が終わった（返金・精算済み）参加者の露出と席を解く。
 * 資金の後始末が済んでいない人は手放さない（§10）。
 */
export function releasePvpParticipants(services: Services, session: string, userIds: readonly string[]): void {
  const scope = pvpRiskScope(session);
  for (const u of userIds) {
    try {
      if (hasEscrowStake(services, scope, u)) continue;
      services.dailyRisk.releaseExposure(scope, u);
    } catch {
      continue;
    }
    if (hasLivePvpExposure(services, scope, u)) continue;
    releaseTransientParticipation(u, "pvp", scope);
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
  session: string,
): { payout: number; houseCut: number } {
  const houseCut = Math.floor(pot * HOUSE_CUT);
  const distributable = pot - houseCut;

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
  settleWithRisk(services, session, operationId, distributions, "settlePvp");
  return { payout: winners.length > 0 ? distributable : 0, houseCut };
}

/**
 * エスクロー精算と日次リスクの確定を**ひとつのトランザクション**で行う（PR23 §13）。
 *
 * `Escrow.settle` は自分のグループを開くが、外側グループが動いていれば素通しするので
 * 送金・帳簿削除・リスク記録が同じトランザクションに入る。リスク記録が落ちれば
 * 送金ごと巻き戻る（＝場代も配当も動かない）。
 *
 * 記録する額は **実際の残高変動そのもの**（受取 − その卓へ出した額）。場代・JPへ抜けた分は
 * 「受取が出した額を下回る」形で自然に損失側へ入る。**場代の行き先も配当も変えない。**
 */
function settleWithRisk(
  services: Services,
  session: string,
  operationId: string,
  distributions: ReadonlyArray<{ to: string; amount: number; reason: string }>,
  reason: string,
): void {
  const scope = pvpRiskScope(session);
  // 露出（＝その卓へ出した総額）は帳簿を消す前に読む
  const participants = pvpParticipants(services, session);
  services.chips.runGroup(
    { groupKey: `pvp:risk_settle:${session}:${operationId}`, kind: "table_settle", actorId: "system:pvp" },
    () => {
      const staked = new Map<string, number>();
      for (const row of services.escrow.list(session)) staked.set(row.user_id, (staked.get(row.user_id) ?? 0) + row.amount);
      const received = new Map<string, number>();
      for (const d of distributions) if (d.amount > 0) received.set(d.to, (received.get(d.to) ?? 0) + d.amount);
      services.escrow.settle(session, [...distributions], "system:pvp", reason);
      for (const [userId, stake] of staked) {
        services.dailyRisk.settleExposure({
          scopeKey: scope,
          userId,
          operationId,
          netSigned: (received.get(userId) ?? 0) - stake,
        });
      }
    },
  );
  releasePvpParticipants(services, session, participants);
}

/** その卓に預けている参加者（精算前に読む） */
function pvpParticipants(services: Services, session: string): string[] {
  try {
    return [...new Set(services.escrow.list(session).map((row) => row.user_id))];
  } catch {
    return [];
  }
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
  session: string,
): { totalHouseCut: number } {
  const winnerPot = winners.reduce((s, w) => s + w.bet, 0);
  const loserPot = losers.reduce((s, l) => s + l.bet, 0);
  const houseCut = Math.floor((winnerPot + loserPot) * HOUSE_CUT);
  const distributable = winnerPot + loserPot - houseCut;

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
  settleWithRisk(services, session, operationId, distributions, "settleProportional");
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
