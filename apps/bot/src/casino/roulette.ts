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
import { ROULETTE_PAYOUTS as CORE_ROULETTE_PAYOUTS, rouletteSpin, rouletteTableLiability, type RouletteBet } from "@meigokujo/core";
import { fmtEther } from "../format.js";
import { Mammon } from "../mammon.js";
import type { Services } from "../services.js";
import { MAX_BET, MIN_BET, sleep } from "./common.js";
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

export type AcceptRouletteBetResult =
  | { ok: true }
  | { ok: false; reason: "capacity"; available: number }
  | { ok: false; reason: "broke" };

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
  try {
    services.chips.runGroup(
      { groupKey: `roulette:bet:${session}:${userId}:${operationId}`, kind: "table_hold", actorId: userId },
      () => {
        const r = services.reservations.resize(reservationKey, wantedTotal, "ルーレット", RESERVATION_OWNER);
        if (!r.ok) throw new RouletteCapacityError(wantedTotal, r.available);
        // 張り直しは上書き: 前の張りを返してから新しい額をエスクロー
        if (wasRebet) services.escrow.refundOne(session, userId, `rebet:${operationId}`);
        if (!services.escrow.hold(session, userId, amount, "roulette", operationId)) {
          throw new RouletteEscrowShortfall();
        }
      },
    );
  } catch (e) {
    if (e instanceof RouletteCapacityError) return { ok: false, reason: "capacity", available: e.available };
    if (e instanceof RouletteEscrowShortfall) return { ok: false, reason: "broke" };
    throw e;
  }
  bets.set(userId, { userId, type, amount });
  return { ok: true };
}

/**
 * 卓を無効化する: 全員へ返金し、卓予約を**同じグループ**で解放する（PR5）。
 * 別々に行うと、返金だけ成功して予約解放が落ちた場合に予約が残り続ける。
 */
export function voidRouletteTable(services: Services, session: string): void {
  services.chips.runGroup(
    { groupKey: `roulette:void:${session}`, kind: "table_refund", actorId: "system:roulette" },
    () => {
      services.escrow.refund(session);
      services.reservations.release(reservationKeyFor(session));
    },
  );
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
  try {
    const bets = new Map<string, SessionBet>(); // userId -> bet（上書き）

    const lobbyEmbed = (secondsLeft: number) => {
      const totalPot = [...bets.values()].reduce((s, b) => s + b.amount, 0);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "マモンの賭場 · ルーレット" })
        .setColor(C_MAMMON)
        .setTitle(`🎡  受付中  ·  締切まで ${secondsLeft}秒`)
        .setDescription(
          [
            "```",
            `赤・黒・奇数・偶数・大・小  ×  2倍`,
            `🟢 零                       ×  36倍`,
            "```",
            `*「${Mammon.greeting()}」*`,
          ].join("\n"),
        )
        .setFooter({ text: `参加 ${bets.size}人 · 総額 ${fmtEther(totalPot).replace(" ◈", "◈")}` });

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
          const users = arr.map((x) => `<@${x.user}> ${fmtEther(x.amt).replace(" ◈", "◈")}`).join("・");
          embed.addFields({ name: `${LABELS[t as keyof typeof LABELS]}  ·  ${fmtEther(total).replace(" ◈", "◈")}`, value: users, inline: false });
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
              new TextInputBuilder().setCustomId("amount").setLabel(`賭けるエテル（${MIN_BET}〜${MAX_BET.toLocaleString()}）`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(9),
            ),
          );
        await btn.showModal(modal);
        const sub = await btn.awaitModalSubmit({ time: 25_000, filter: (m) => m.customId === `rl:amt:${type}:${btn.id}` }).catch(() => null);
        if (!sub) return;
        const amt = Number(sub.fields.getTextInputValue("amount").replaceAll(",", "").trim());
        if (!Number.isInteger(amt) || amt < MIN_BET || amt > MAX_BET) {
          await sub.reply({ content: `賭け額は ${MIN_BET}〜${MAX_BET.toLocaleString()} ◈ で。`, flags: MessageFlags.Ephemeral });
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
    try {
      spin = settleRoulette(services, session, [...bets.values()]);
    } catch (e) {
      console.error(`[roulette] 卓 ${session} の精算に失敗。全額返金します`, e);
      // 精算はまるごと巻き戻っているので、預り金・卓予約はそのまま残っている。
      // 返金と卓予約の解放を同じグループで行う（voidRouletteTable）
      try {
        voidRouletteTable(services, session);
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
      .setFooter({ text: `参加 ${bets.size}人 · 総額 ${fmtEther(totalPot).replace(" ◈", "◈")}` });
    await interaction.editReply({ embeds: [embed], components: [] });
  } finally {
    activeSessions.delete(channelId);
  }
}
