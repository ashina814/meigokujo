import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import {
  DailyRiskError,
  ROULETTE_PAYOUTS as CORE_ROULETTE_PAYOUTS,
  rouletteSpin,
  rouletteTableLiability,
  type RouletteBet,
} from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, sleep } from "./common.js";
import { acquireTransientParticipation, releaseTransientParticipation } from "./participation.js";
import { recordCasinoCompletionBestEffort, recordCasinoParticipationBestEffort } from "./participation-history.js";
import { C_LOSE, C_MAMMON, C_WIN, E, fmtBigDelta } from "./ui.js";

/**
 * 🎡 ルーレット（チャンネル共有セッション）。casino-bot 準拠。
 * - 誰かが /遊ぶ ルーレット で卓を開く → 30秒の受付 → 0〜36 抽選 → 一括精算
 * - 賭け先: 赤/黒/奇数/偶数/大/小 = 2倍、零(0) = 36倍
 * - 1人1口（張り直しは上書き）。徴収は張った時点でエスクロー（再起動時は自動返金）
 * - **卓全体の債務は `HouseReservations` へ予約する**（PR5 マージ直前レビュー対応）。
 *   複数チャンネルの卓が同じ `available()` を見て過剰受注しないよう、張る・張り直す
 *   都度 `rouletteTableLiability()` で卓全体の増分債務を計算し直し、`resize()` で
 *   原子的に増減させる。精算（`settleRoulette`）が全員成功した後で一度だけ解放する。
 */
const LOBBY_SEC = 30;

/** 卓全体の予約に使う固定の名義。個々の参加者ではなく卓そのものの予約なので共通値にする */
const RESERVATION_OWNER = "system:roulette";

function reservationKeyFor(session: string): string {
  return `roulette:reserve:${session}`;
}

/** ルーレットの掛け方 → 債務モデルの賭け種別（"零" だけ single、それ以外は even） */
function toLiabilityBetType(type: BetType): RouletteBet["type"] {
  return type === "green" ? "single" : "even";
}

function tableLiabilityOf(bets: Iterable<SessionBet>): number {
  const rouletteBets: RouletteBet[] = [...bets].map((b) => ({ type: toLiabilityBetType(b.type), amount: b.amount }));
  return rouletteTableLiability(rouletteBets);
}

/** 卓の予約取得に失敗した（余力不足）。資金は1 Ld も動いていない */
class RouletteCapacityError extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(`ERR_ROULETTE_CAPACITY: 必要 ${needed} に対して余力 ${available}`);
    this.name = "RouletteCapacityError";
  }
}

/** エスクローへの預託に失敗した（残高不足）。予約はこの直前の状態へ巻き戻す */
class RouletteEscrowShortfall extends Error {
  constructor() {
    super("ERR_ROULETTE_ESCROW_SHORTFALL");
    this.name = "RouletteEscrowShortfall";
  }
}

/** PR23 の安全上限に弾かれた（同時参加・所持50%・日次純損失上限）。資金は動いていない */
class RouletteRiskRejected extends Error {
  constructor(readonly detail: string) {
    super("ERR_ROULETTE_RISK");
    this.name = "RouletteRiskRejected";
  }
}

export type AcceptRouletteBetResult =
  | { ok: true }
  | { ok: false; reason: "capacity"; available: number }
  | { ok: false; reason: "broke" }
  | { ok: false; reason: "conflict" }
  | { ok: false; reason: "risk"; detail: string };

/**
 * ルーレット卓のリスク枠の名前（PR23）。卓そのものが単位なので、参加者ごとの
 * 露出は `(scopeKey, userId)` で1行になる。張り直しは `replace` で差し替える。
 */
export function rouletteRiskScope(session: string): string {
  return `roulette:${session}`;
}

/** 外側グループ（`roulette:bet:*`）の要求指紋。replay 時に今回の引数と突き合わせる */
interface RouletteBetFingerprint {
  session: string;
  userId: string;
  type: BetType;
  amount: number;
}

/**
 * 卓へのベット受付（新規・張り増し・張り直し）を1つの原子操作として行う（PR5）。
 *
 * 1. 卓全体の新しい債務を計算（張り直しなら旧ベットを除いて見積もる）
 * 2. `HouseReservations.resize()` で原子的に増減
 * 3. （張り直しなら）旧ベットのエスクローを返す
 * 4. 新しいベットぶんをエスクローへ預ける
 *
 * 2〜4 を**同じ業務グループ**にまとめてあるので、途中のどこで失敗しても
 * 予約・エスクロー・呼び出し側の `bets` マップが食い違わない
 * （成功したときだけ `bets` を書き換える。失敗時は3点とも直前の状態のまま）。
 *
 * ## 取り違え対策（PR11独立監査 #50・フォローアップ）
 *
 * `services.escrow.hold()` はこの関数の**外側グループの中から**呼ばれる nested 呼び出しで、
 * `ChipTx.runGroup` は「すでに active な外側グループがあれば新しいグループを作らず本体を
 * 素通しする」ため、hold() 自身の取り違え検出には（内側の `escrow:hold:*` キーの replay 判定
 * にはそもそも来ないので）到達しない。**さらに悪いことに**、外側グループ自体が既に settled
 * なら `runGroup` は本体（＝ hold() 呼び出しそのもの）ごと実行せず保存済みの結果を返すだけなので、
 * 同じ operationId を別の type・amount で呼び直すと、hold() は一度も呼ばれないまま
 * `bets.set(userId, { userId, type, amount })` だけが**今回の**（実際には預かっていない）
 * type・amount で実行されてしまう——エスクローの実額と `bets` マップの内容が食い違う。
 *
 * そのため、外側グループ自身の戻り値に要求指紋（session/userId/type/amount）を積み、
 * replay されたときにいまの引数と突き合わせる。不一致（＝取り違え）なら `bets` を更新せず
 * `{ ok: false, reason: "conflict" }` を返す。
 *
 * この関数は Discord のボタン collector から直接呼ばれ、呼び出し側は
 * `void (async () => {...})()` で fire-and-forget しており、プロセス全体に波及する
 * unhandled rejection を避ける必要がある。したがって conflict は例外ではなく
 * `AcceptRouletteBetResult` の一種として返し、呼び出し側が通常のエラー応答として処理する。
 *
 * ### legacy（この変更より前に確定した外側グループ）との互換
 * 以前の本体は値を返していなかった（`undefined` が保存される）。type はどこにも永続化
 * されないため、legacy の replay からは要求内容を一切復元できない。fail-closed の原則により、
 * legacy な外側グループの replay は**無条件で** conflict 扱いにする。
 */
export function acceptRouletteBet(
  services: Services,
  session: string,
  bets: Map<string, SessionBet>,
  userId: string,
  type: BetType,
  amount: number,
  operationId: string,
): AcceptRouletteBetResult {
  const otherBets = [...bets.values()].filter((b) => b.userId !== userId);
  const wantedTotal = tableLiabilityOf([...otherBets, { userId, type, amount }]);
  const reservationKey = reservationKeyFor(session);
  const wasRebet = bets.has(userId);
  const requested: RouletteBetFingerprint = { session, userId, type, amount };
  const riskScope = rouletteRiskScope(session);
  // 資金へ触る前に一時参加を押さえる（ソロ席・対人卓・競馬との排他）。
  // 張り直しは同じ卓なので再取得を許す
  if (!acquireTransientParticipation(userId, "roulette", riskScope, { reentrant: true })) {
    return { ok: false, reason: "risk", detail: "ほかの卓に着いている。そちらを終わらせてからだ。" };
  }
  let stored: RouletteBetFingerprint | undefined;
  try {
    stored = services.chips.runGroup(
      { groupKey: `roulette:bet:${session}:${userId}:${operationId}`, kind: "table_hold", actorId: userId },
      (): RouletteBetFingerprint => {
        // 予約もエスクローも触る前に PR23 の安全上限を通す。ここで例外になれば
        // グループごと巻き戻るので、Land・自由チップ・エスクロー・予約・casino_tx は
        // 1行も動かない。ルーレットの最大損失は張った額そのもの（配当モデルは不変）
        try {
          services.dailyRisk.authorizeExposure({
            userId,
            scopeKey: riskScope,
            operationId,
            game: "ルーレット",
            maxPlayerLoss: amount,
            mode: "replace",
          });
        } catch (e) {
          throw new RouletteRiskRejected(riskRejectionDetail(services, userId, e));
        }
        const r = services.reservations.resize(reservationKey, wantedTotal, "ルーレット", RESERVATION_OWNER);
        if (!r.ok) throw new RouletteCapacityError(wantedTotal, r.available);
        // 張り直しは上書き: 前の張りを返してから新しい額をエスクロー
        if (wasRebet) services.escrow.refundOne(session, userId, `rebet:${operationId}`);
        if (!services.escrow.hold(session, userId, amount, "roulette", operationId)) {
          throw new RouletteEscrowShortfall();
        }
        return requested;
      },
    );
  } catch (e) {
    // 失敗はグループごと巻き戻っているので、この呼び出しでは資金も露出も増えていない。
    // ただし**露出が残っているなら手放さない**（張り直しの失敗＝元の張りが生きている、
    // 同一セッションの別操作が先に成立している、のどちらでも預り金が卓にある）。
    if (!hasLiveRouletteExposure(services, riskScope, userId)) {
      releaseTransientParticipation(userId, "roulette", riskScope);
    }
    if (e instanceof RouletteRiskRejected) return { ok: false, reason: "risk", detail: e.detail };
    if (e instanceof RouletteCapacityError) return { ok: false, reason: "capacity", available: e.available };
    if (e instanceof RouletteEscrowShortfall) return { ok: false, reason: "broke" };
    throw e;
  }
  if (
    stored === undefined || // legacy: この変更より前に確定した外側グループ（値を返していない）
    stored.session !== session ||
    stored.userId !== userId ||
    stored.type !== type ||
    stored.amount !== amount
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[roulette] bet operation conflict: session=${session} userId=${userId} operationId=${operationId} stored=${JSON.stringify(stored)} requested=${JSON.stringify(requested)}`,
    );
    return { ok: false, reason: "conflict" };
  }
  bets.set(userId, { userId, type, amount });
  // 実際にbetが受理され、escrow/risk/reservationを含む業務groupが成功した時点(§2)。
  // participationKeyはsession+userId——同じ卓での張り直し(rebet)は同じidempotency
  // identityへ収束し、raw participation行を増やさない(§5)。
  recordCasinoParticipationBestEffort(services, {
    participationKey: `roulette:${session}:${userId}`,
    activityKey: "roulette",
    participantUserIds: [userId],
  });
  return { ok: true };
}

/** PR23 拒否理由の文面。日次上限に当たった場合は残り枠まで見せる */
function riskRejectionDetail(services: Services, userId: string, error: unknown): string {
  if (error instanceof DailyRiskError && error.code === "ERR_DAILY_RISK_DAY_ROLLOVER") {
    return "日付が変わった。この卓への追加はもう受けられない。";
  }
  if (error instanceof DailyRiskError && error.code === "ERR_DAILY_RISK_LIMIT") {
    try {
      const day = services.dailyRisk.dayFor(userId);
      const remaining = day.remainingLossBudget;
      return remaining > 0
        ? `所持額に対して張りすぎだ。残り許容損失 ${fmtEther(remaining)} の範囲で張り直せ。`
        : `今日はここまでだ。日次損失上限 ${fmtEther(day.lossCap)} に達している。`;
    } catch {
      return "賭場の利用制限を確認できないため、いまは張れない。";
    }
  }
  return "賭場の利用制限を確認できないため、いまは張れない。";
}

/** その卓にまだ露出（＝預り金の裏付け）が残っているか。fail-closed で「残っている」扱い */
function hasLiveRouletteExposure(services: Services, riskScope: string, userId: string): boolean {
  try {
    return services.dailyRisk.exposureOf(riskScope, userId) !== null;
  } catch {
    return true;
  }
}

/**
 * 卓を無効化する: 全員へ返金し、卓予約を**同じグループ**で解放する（PR5）。
 * 別々に行うと、返金だけ成功して予約解放が落ちた場合に予約が残り続ける。
 *
 * PR23: 返金と同じトランザクションで露出も解く（純損益0なので当日枠は動かさない）。
 */
export function voidRouletteTable(services: Services, session: string, participants: readonly string[] = []): void {
  services.chips.runGroup(
    { groupKey: `roulette:void:${session}`, kind: "table_refund", actorId: "system:roulette" },
    () => {
      services.escrow.refund(session);
      services.dailyRisk.releaseExposureScope(rouletteRiskScope(session));
      services.reservations.release(reservationKeyFor(session));
    },
  );
  // 資金が戻ってから一時参加を解く（順序を逆にすると預り金が卓にあるのに席だけ空く）
  for (const userId of participants) releaseTransientParticipation(userId, "roulette", rouletteRiskScope(session));
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

type BetType = "red" | "black" | "green" | "odd" | "even" | "high" | "low";

const LABELS: Record<BetType, string> = {
  red: "🔴 赤",
  black: "⚫ 黒",
  green: "🟢 零",
  odd: "奇数",
  even: "偶数",
  high: "大(19-36)",
  low: "小(1-18)",
};

// 配当は core の ROULETTE_PAYOUTS（単一の真実源）から派生させる。数値変更はモデル側で行う。
const PAYOUTS: Record<BetType, number> = {
  red: CORE_ROULETTE_PAYOUTS.even,
  black: CORE_ROULETTE_PAYOUTS.even,
  green: CORE_ROULETTE_PAYOUTS.single,
  odd: CORE_ROULETTE_PAYOUTS.even,
  even: CORE_ROULETTE_PAYOUTS.even,
  high: CORE_ROULETTE_PAYOUTS.even,
  low: CORE_ROULETTE_PAYOUTS.even,
};

function hits(type: BetType, n: number): boolean {
  switch (type) {
    case "red": return RED.has(n);
    case "black": return n !== 0 && !RED.has(n);
    case "green": return n === 0;
    case "odd": return n > 0 && n % 2 === 1;
    case "even": return n > 0 && n % 2 === 0;
    case "high": return n >= 19;
    case "low": return n >= 1 && n <= 18;
  }
}

function colorOf(n: number): string {
  if (n === 0) return "🟢";
  return RED.has(n) ? "🔴" : "⚫";
}

export interface SessionBet {
  userId: string;
  type: BetType;
  amount: number;
}

/**
 * 1回転の確定結果。**すべて `result_json` に保存できる形**にしてある。
 * 同じセッションの再試行は、出目も参加者別の結果もここから再生される。
 */
export interface RouletteSpinRecord {
  /** 出目（0〜36） */
  n: number;
  results: Array<{ userId: string; type: BetType; amount: number; won: boolean; payout: number; net: number }>;
}

/**
 * 1回転ぶんの資金処理を**ひとつの最外部グループ**で行う。
 *
 * 抽選・エスクロー返還・全員分の精算（賭け徴収→配当）・戦績・エスクロー台帳の削除・
 * **卓予約の解放**まで、全部この中。以前は「先に全員へ返金 → 参加者ごとに別グループで精算」
 * だったため、途中で止まると「全員返金済み・一部だけ再精算済み」が残った。
 *
 * 個別の精算例外は握り潰さない。1人でも払えなければ回転ごと巻き戻し（**卓予約も残る**）、
 * 呼び出し側が卓ごと返金する（中途半端な卓を残さない）。
 *
 * **卓予約は参加者ごとの `settle()` では解放しない。** 1人目の精算で解放すると、
 * 残りの参加者が予約の裏付けを失う（＝他の卓に枠を奪われうる）。全員成功した後で
 * この関数の最後に一度だけ解放する（PR5 マージ直前レビュー対応）。
 *
 * `_beforeStep` はテスト専用のフック（各精算の直前に呼ばれる）。本番呼び出しは省略する。
 */
export function settleRoulette(
  services: Services,
  session: string,
  bets: readonly SessionBet[],
  _beforeStep?: (index: number, bet: SessionBet) => void,
): RouletteSpinRecord {
  return services.chips.runGroup(
    { groupKey: `${session}:settle`, kind: "table_settle", actorId: "system:roulette" },
    (): RouletteSpinRecord => {
      // 抽選もグループの中。出目を保存結果に含めるので、再試行でも同じ目・同じ分配になる
      const n = rouletteSpin(services.rng);
      // エスクロー分を一旦全員へ返してから casino.settle で正規精算する
      //（settle が賭け徴収→配当を原子的にやる。戦績・イベントログも settle 経由）
      services.escrow.refund(session);
      const results: RouletteSpinRecord["results"] = [];
      for (let i = 0; i < bets.length; i++) {
        const b = bets[i]!;
        _beforeStep?.(i, b);
        const won = hits(b.type, n);
        const payout = won ? Math.floor(b.amount * PAYOUTS[b.type]) : 0;
        const settled = services.casino.settle(b.userId, "roulette", b.amount, payout, 0, {
          chain: false,
          fuku: false,
          operationId: `${session}:${b.userId}`,
          // 実際の純損益を、**ベット受付時に決めた day_key** へ1回だけ帰属させる（PR23）。
          // 露出が無ければここで落ちて回転ごと巻き戻る（日次上限の抜け道を作らない）
          risk: { kind: "exposure", scopeKey: rouletteRiskScope(session) },
        });
        results.push({ userId: b.userId, type: b.type, amount: b.amount, won, payout, net: settled.net });
      }
      // 全員成功した後で一度だけ解放。ここまでに例外が出ればトランザクションごと
      // 巻き戻るので、予約は残ったまま（途中で払った額と解放が食い違うことはない）
      services.reservations.release(reservationKeyFor(session));
      return { n, results };
    },
  );
}

/** チャンネルごとに1卓 */
const activeSessions = new Set<string>();

export async function playRoulette(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const channelId = interaction.channelId;
  if (activeSessions.has(channelId)) {
    await interaction.reply({ content: "この卓はもう回っている。今の勝負が終わるのを待て。", flags: MessageFlags.Ephemeral });
    return;
  }
  activeSessions.add(channelId);
  const session = `roulette:${interaction.id}`;
  // finally の席解放から見えるよう try の外に置く（PR23）
  const bets = new Map<string, SessionBet>(); // userId -> bet（上書き）
  try {

    const lobbyEmbed = (secondsLeft: number) => {
      const totalPot = [...bets.values()].reduce((s, b) => s + b.amount, 0);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ルーレット" })
        .setColor(C_MAMMON)
        .setTitle(`🎡  受付中  ·  締切まで ${secondsLeft}秒`)
        .setDescription(
          [
            // 絵文字とCJKをコードブロックへ入れると桁が合わない。配当表は普通の行で書く
            "赤・黒・奇数・偶数・大・小 → **×2倍**",
            "🟢 零 → **×36倍**",
            "",
            `*「${Mammon.greeting()}」*`,
          ].join("\n"),
        )
        .setFooter({ text: `参加 ${bets.size}人 · 総額 ${fmtEther(totalPot).replace(" Ld", "Ld")}` });

      if (bets.size > 0) {
        // 賭け目ごとにまとめて表示
        const byType = new Map<string, { user: string; amt: number }[]>();
        for (const b of bets.values()) {
          if (!byType.has(b.type)) byType.set(b.type, []);
          byType.get(b.type)!.push({ user: b.userId, amt: b.amount });
        }
        const sortedTypes = [...byType.keys()].sort();
        for (const t of sortedTypes) {
          const arr = byType.get(t)!;
          const total = arr.reduce((s, x) => s + x.amt, 0);
          const users = arr.map((x) => `<@${x.user}> ${fmtEther(x.amt).replace(" Ld", "Ld")}`).join("・");
          embed.addFields({ name: `${LABELS[t as keyof typeof LABELS]}  ·  ${fmtEther(total).replace(" Ld", "Ld")}`, value: users, inline: false });
        }
      }
      return embed;
    };

    const rows = (disabled = false) => [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("rl:red").setLabel("🔴 赤").setStyle(ButtonStyle.Danger).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:black").setLabel("⚫ 黒").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:green").setLabel("🟢 零 (36倍)").setStyle(ButtonStyle.Success).setDisabled(disabled),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("rl:odd").setLabel("奇数").setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:even").setLabel("偶数").setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:high").setLabel("大 19-36").setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId("rl:low").setLabel("小 1-18").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      ),
    ];

    const msg = await interaction.reply({ embeds: [lobbyEmbed(LOBBY_SEC)], components: rows(), withResponse: true });
    const reply: Message | undefined = msg.resource?.message ?? undefined;
    if (!reply) throw new Error("reply unavailable");

    const endAt = Date.now() + LOBBY_SEC * 1000;
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.customId.startsWith("rl:"),
      time: LOBBY_SEC * 1000,
    });

    collector.on("collect", (btn: ButtonInteraction) => {
      void (async () => {
        const type = btn.customId.slice(3) as BetType;
        const modal = new ModalBuilder()
          .setCustomId(`rl:amt:${type}:${btn.id}`)
          .setTitle(`${LABELS[type]} に張る`)
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("amount").setLabel(`賭けるLand（${MIN_BET}〜${MAX_BET.toLocaleString()}）`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(9),
            ),
          );
        await btn.showModal(modal);
        const sub = await btn.awaitModalSubmit({ time: 25_000, filter: (m) => m.customId === `rl:amt:${type}:${btn.id}` }).catch(() => null);
        if (!sub) return;
        const amt = Number(sub.fields.getTextInputValue("amount").replaceAll(",", "").trim());
        if (!Number.isInteger(amt) || amt < MIN_BET || amt > MAX_BET) {
          await sub.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} Ld で。`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (collector.ended) {
          await sub.reply({ content: "締切に間に合わなかった。次の卓で。", flags: MessageFlags.Ephemeral });
          return;
        }
        // 卓全体の債務を原子的に予約してから資金を動かす（PR5）。失敗時は
        // 予約・エスクロー・bets のどれも変わらない（acceptRouletteBet が保証する）
        const accepted = acceptRouletteBet(services, session, bets, btn.user.id, type, amt, btn.id);
        if (!accepted.ok) {
          if (accepted.reason === "capacity") {
            await sub.reply({ content: Mammon.tableClosed(), flags: MessageFlags.Ephemeral });
            return;
          }
          if (accepted.reason === "conflict") {
            await sub.reply({ content: "処理に失敗した。もう一度張り直してくれ。", flags: MessageFlags.Ephemeral });
            return;
          }
          if (accepted.reason === "risk") {
            await sub.reply({ content: accepted.detail, flags: MessageFlags.Ephemeral });
            return;
          }
          await sub.reply({ content: `${Mammon.broke()}（所持 ${fmtEther(services.chips.balanceOf(btn.user.id))}）`, flags: MessageFlags.Ephemeral });
          await interaction.editReply({ embeds: [lobbyEmbed(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))] }).catch(() => undefined);
          return;
        }
        await sub.reply({ content: `✅ ${LABELS[type]} に ${fmtEther(amt)} を張った。`, flags: MessageFlags.Ephemeral });
        await interaction.editReply({ embeds: [lobbyEmbed(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))] }).catch(() => undefined);
      })();
    });

    // 残り時間の表示更新
    for (const left of [20, 10] as const) {
      const wait = endAt - left * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      if (collector.ended) break;
      await interaction.editReply({ embeds: [lobbyEmbed(left)] }).catch(() => undefined);
    }
    // 締切まで待つ
    await new Promise<void>((resolve) => collector.once("end", () => resolve()));

    if (bets.size === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setAuthor({ name: "マモンの賭場 · ルーレット" })
            .setColor(C_LOSE)
            .setTitle("🎡  流れた")
            .setDescription("誰も張らなかったので、この卓は流れた。"),
        ],
        components: [],
      });
      return;
    }

    // 抽選演出
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: "マモンの賭場 · ルーレット" })
          .setColor(C_MAMMON)
          .setTitle("🎡  締切  ·  球が回る……")
          .setDescription("*カラカラカラ……*"),
      ],
      components: [],
    });
    await sleep(1800);

    // 抽選も core モデルの rouletteSpin() を使う（37 マス構成が単一の真実源）
    // 1回転ぶんを1グループで精算。1人でも払えなければ回転ごと巻き戻る
    let spin: RouletteSpinRecord;
    const participants = [...bets.keys()];
    try {
      spin = settleRoulette(services, session, [...bets.values()]);
      // settleRoulette()は卓全体を単一atomic transactionで精算する正本——ここへ
      // 到達した時点で初めて全参加者のroundが成立したと言える。失敗時はまるごと
      // 巻き戻ってvoidRouletteTableへ落ちるため、completion 0のまま（PR F2b）。
      for (const userId of participants) {
        recordCasinoCompletionBestEffort(services, {
          participationKey: `roulette:${session}:${userId}`,
          activityKey: "roulette",
          participantUserIds: [userId],
        });
      }
    } catch (e) {
      console.error(`[roulette] 卓 ${session} の精算に失敗。全額返金します`, e);
      // 精算はまるごと巻き戻っているので、預り金・卓予約・露出はそのまま残っている。
      // 返金・露出解放・卓予約の解放を同じグループで行う（voidRouletteTable）
      try {
        voidRouletteTable(services, session, participants);
      } catch (re) {
        console.error(`[roulette] 卓 ${session} の返金にも失敗。起動時の掃除に任せます`, re);
      }
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setAuthor({ name: "マモンの賭場 · ルーレット" })
            .setColor(C_LOSE)
            .setTitle("🎡  この卓は無効")
            .setDescription("胴元の資金が足りず精算できなかった。**全員に賭け金を返した**。"),
        ],
        components: [],
      });
      return;
    }
    const n = spin.n;
    const anyWin = spin.results.some((r) => r.won);
    const lines = spin.results.map((r) =>
      r.won
        ? `${E.win}  <@${r.userId}>  ${LABELS[r.type]} 的中！  ${fmtBigDelta(r.payout - r.amount)}`
        : `${E.lose}  <@${r.userId}>  ${LABELS[r.type]} 外れ  ${fmtBigDelta(-r.amount)}`,
    );

    const totalPot = spin.results.reduce((s, r) => s + r.amount, 0);
    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · ルーレット" })
      .setColor(anyWin ? C_WIN : C_LOSE)
      .setTitle(`🎡  出目  ${colorOf(n)} **${n}**`)
      .setDescription([...lines, "", `*「${anyWin ? Mammon.win() : Mammon.lose()}」*`].join("\n"))
      .setFooter({ text: `参加 ${bets.size}人 · 総額 ${fmtEther(totalPot).replace(" Ld", "Ld")}` });
    await interaction.editReply({ embeds: [embed], components: [] });
  } finally {
    // 卓が終わったので席を空ける。ただし**露出が残っている人は手放さない**
    // （返金にも失敗して預り金が卓に残っている状態で他の賭博へ行かせない）
    releaseRouletteParticipants(services, session, [...bets.keys()]);
    activeSessions.delete(channelId);
  }
}

/** 資金の後始末が済んだ参加者だけ席を空ける（§10 のライフサイクル） */
function releaseRouletteParticipants(services: Services, session: string, userIds: readonly string[]): void {
  const riskScope = rouletteRiskScope(session);
  for (const userId of userIds) {
    if (hasLiveRouletteExposure(services, riskScope, userId)) continue;
    releaseTransientParticipation(userId, "roulette", riskScope);
  }
}
