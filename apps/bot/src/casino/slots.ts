import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import {
  SLOT_SYMBOLS as SYMBOLS,
  TRIPLE_PAYOUTS,
  DOUBLE_PAYOUTS,
  SLOTS_JP_CONTRIBUTION as JP_CONTRIBUTION,
  SLOTS_JP_WIN_SHARE as JP_WIN_SHARE,
  SLOTS_SCATTER_TRIGGER_COUNT as SCATTER_TRIGGER_COUNT,
  slotsSpinReel as spinReel,
  slotsEvaluate as evaluate,
  SLOT_MAX_PAYOUT_MULT,
  slotsJackpotCutFor as jackpotCutFor,
  type PendingFreeSpinRow,
  type SlotSymbol,
} from "@meigokujo/core";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";
import {
  MIN_BET,
  acquireSeat,
  releaseHouseLiability,
  releaseSeat,
  reserveFreeSpinLiability,
  reserveSlotsLiability,
  sleep,
  validateBet,
  withExplicitHouseReservation,
} from "./common.js";
import { C_MAMMON, reelText } from "./ui.js";
import { broadcastBigWin } from "./bigwin.js";
import { buildSoloResult } from "./solo-result.js";
import {
  casinoPlayContext,
  reconcileSlotsGameFinishBestEffort,
  recordCasinoGameStartBestEffort,
  type CasinoPlayContext,
} from "./metrics.js";
import { recordCasinoCompletionBestEffort, recordCasinoParticipationBestEffort } from "./participation-history.js";

/**
 * 🎰 スロット。casino-bot 準拠。数値モデルは core/casino/slots-model へ委譲。
 * - 3リール、シンボルは冥獄城テーマ
 * - リール1→2→3 と順に止まる演出（サイクル絵柄でぐるぐる感）
 * - 1+2 リールが同じ絵柄で止まったら「あと一つで…」ニアミス煽り
 * - JP は純😈³のみ。積立=賭金1%、当選でプール半分獲得
 * - 魂片✨3つでフリースピン1回（自動再スピン・賭金不要）
 * - 結果画面に「最低/前回/最大」の3ボタン + 📖配当表ボタン
 *
 * RTP 計算・回帰テストは packages/core/tests/casino-slots-rtp.test.ts を見る。
 */

/** テーブルリミット判定用の最大払戻倍率。配当表（core）から導く（写さない・PR4） */
const MAX_MULTIPLIER = SLOT_MAX_PAYOUT_MULT;

const CYCLE = ["🦇", "👻", "🔥", "⚔️", "👑", "😈", "🌙", "✨"] as const;
const cycleAt = (n: number) => CYCLE[n % CYCLE.length]!;

const isScatter = (s: SlotSymbol) => s.kind === "scatter";

export function paytableEmbed(): EmbedBuilder {
  const tripleLines = Object.entries(TRIPLE_PAYOUTS)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      const label = name === "マモン" ? `${sym.emoji} ${name} (純3つでJP)` : `${sym.emoji} ${name}`;
      return `　${label}: **${mul}倍**`;
    })
    .join("\n");
  const doubleLines = Object.entries(DOUBLE_PAYOUTS)
    .map(([name, mul]) => {
      const sym = SYMBOLS.find((s) => s.name === name)!;
      return `　${sym.emoji} ${name}: **${mul}倍**`;
    })
    .join("\n");
  return new EmbedBuilder()
    .setTitle("📖 スロット — 配当表")
    .setColor(C_MAMMON)
    .setDescription(
      [
        "**🎯 3つ揃い** (3リール同じ絵柄)",
        tripleLines,
        "",
        "**🎯 2つ揃い** (2リール同じ絵柄・ワイルド代用不可)",
        doubleLines,
        "",
        "**🌙 月（ワイルド）**",
        "　他の絵柄を補って3つ揃いを成立させる（マモン純3はJP扱いだがワイルド代用は通常配当）",
        "",
        "**✨ 魂片（スキャッター）**",
        `　位置不問で${SCATTER_TRIGGER_COUNT}つ出現 → **賭金不要でもう1回スピン**`,
        "",
        "**🏆 ジャックポット**",
        `　純3つの 😈 マモン で発動`,
        `　 → 通常配当 + JPプールの **${JP_WIN_SHARE * 100}%** を獲得`,
        `　 (プールは賭金の ${JP_CONTRIBUTION * 100}% を毎回積立)`,
        "",
        "**⚖️ 福の重み**",
        "　チップ残高が多いほど勝ち利益から累進積立（0/5/10/20/30%）。半分は JP・半分は救済プールへ",
        "**🔥 連鎖**",
        "　2連勝目から倍率が乗る（最大 ×2.0）。連敗でリセット",
      ].join("\n"),
    );
}

/**
 * リール表示。
 * 以前は `╔═════╦═════╗` の枠に絵文字を流し込んでいたが、等幅フォントでも
 * 絵文字の送り幅は罫線1セルの2倍にならず、上下の枠が左右にちぎれていた。
 * 枠を捨てて `##` 見出しに置く。見出しは絵文字を大きく描画するので、
 * 枠が無くてもリールとして十分に成立する（ui.ts の reelText を参照）。
 */
const face = (a: string, b: string, c: string) => reelText([a, b, c]);

function buildSpinEmbed(
  services: Services,
  bet: number,
  isFreeSpin: boolean,
  label: string,
  slots: [string, string, string],
): EmbedBuilder {
  const jp = services.casino.jackpotPool();
  const jpHigh = jp >= 100_000;
  return new EmbedBuilder()
    .setAuthor({ name: `マモンの賭場 · スロット${isFreeSpin ? " · フリースピン" : ""}` })
    .setColor(jpHigh ? 0xf0b429 : C_MAMMON)
    .setTitle(`🎰  ${label}`)
    .setDescription(face(slots[0], slots[1], slots[2]))
    .setFooter({
      text: [
        isFreeSpin ? "ベット: 無料" : `ベット ${fmtEther(bet).replace(" Ld", "Ld")}`,
        `JP ${fmtEther(jp).replace(" Ld", "Ld")}${jpHigh ? " 🔥" : ""}`,
      ].join(" · "),
    });
}

export async function playSlots(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  betRaw: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  const uid = interaction.user.id;
  if (!acquireSeat(uid)) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "まだ前の勝負が終わっていない。", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  try {
    // 取得済み権利は新規ベットの下限・残高・予約可否に従属させない。
    await settleLeftoverFreeSpins(interaction, services, uid);
    const check = await validateBet(interaction as ChatInputCommandInteraction, services, betRaw, "スロット");
    if (!check.ok) return;
    await runPaidSpin(interaction, services, check.bet, context);
  } finally {
    releaseSeat(uid);
  }
}

/** 有料スピン1回 → 演出。獲得した無料スピンは演出の中で続けて回る */
async function runPaidSpin(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  context?: Partial<CasinoPlayContext>,
): Promise<void> {
  // **先に1セットぶん（有料 + フリースピン1回）の債務を予約**してから回す（PR5・正本 §11.2）。
  // 予約鍵は精算グループ鍵と別。精算グループ鍵にすると有料スピンの精算で解放され、
  // 続くフリースピンが裸になる
  await withExplicitHouseReservation(
    interaction,
    services,
    "スロット",
    (uid) => reserveSlotsLiability(services, uid, bet, interaction.id),
    async (reservationKey) => {
      const playContext = casinoPlayContext(context);
      recordCasinoGameStartBestEffort(services, {
        userId: interaction.user.id,
        game: "スロット",
        operationId: interaction.id,
        wager: bet,
        source: playContext.source,
      });
      const record = spinPaid(services, interaction.user.id, bet, interaction.id);
      // spinPaid()はrunGroup内で抽選・賭け・配当・JP積立を単一atomic transactionで
      // 行う正本——ここへ到達した時点で初めて「実際のpaid spinが成立した」と言える
      // （PR #163レビュー§2）。spinPaid()が投げたらwriterへ到達しない。
      recordCasinoParticipationBestEffort(services, {
        participationKey: `solo:slots:${interaction.id}`,
        activityKey: "slots",
        participantUserIds: [interaction.user.id],
      });
      // spinPaid()自体が単一atomic transactionでの正常精算——soloでは
      // commitmentとcompletionが同じ境界（PR F2b）。
      recordCasinoCompletionBestEffort(services, {
        participationKey: `solo:slots:${interaction.id}`,
        activityKey: "slots",
        participantUserIds: [interaction.user.id],
      });
      reconcileSlotsGameFinishBestEffort(services, interaction.user.id, interaction.id);
      let immediateFree: SpinRecord | undefined;
      if (record.pendingFreeSpin) {
        try {
          immediateFree = resolveFreeSpin(services, record.pendingFreeSpin, reservationKey);
          reconcileSlotsGameFinishBestEffort(services, interaction.user.id, interaction.id);
        } catch {
          immediateFree = undefined;
        }
      }
      await renderSpin(interaction, services, bet, record, false, reservationKey, playContext, undefined, immediateFree);
    },
  );
}

/**
 * その利用者に残っている保留中の無料スピンを、新しいスピンの前に片付ける（PR3）。
 *
 * 起動時の一括再開（`resumePendingFreeSpins`）で拾えなかったぶん
 * （賭場が停止していた・胴元が細っていた）を、遊びに来たタイミングで回収する。
 * 払えなければ黙って諦める（権利は pending のまま残る）。
 */
export async function settleLeftoverFreeSpins(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  uid: string,
): Promise<void> {
  for (const row of services.freeSpins.listPending(uid)) {
    // いま始めようとしている操作で獲得したものは対象外（まだ存在しない）
    if (row.operationId === interaction.id) continue;
    try {
      const free = resumeFreeSpin(services, row);
      reconcileSlotsGameFinishBestEffort(services, row.userId, row.operationId);
      const message = {
          content: `✨ 前回持ち越していた**無料スピン**を回した（配当 ${fmtEther(free.payout + free.jpWon)}）。`,
          flags: MessageFlags.Ephemeral,
        } as const;
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(message);
        else await interaction.reply(message);
      } catch {
        // 通知失敗は精算済みの権利をpendingへ戻さず、二重払いの契機にもならない。
      }
    } catch {
      return; // まだ払えない。権利は残る
    }
  }
}

/**
 * 1スピンぶんの確定結果。**すべて `result_json` に保存できる形**にしてある。
 * 同じスピンをもう一度実行しても、表示（リール・役・フリースピン獲得）と
 * 資金結果（配当・JP・お守り）が保存済みの値からそのまま再生される。
 */
export interface SpinRecord {
  /** リールの絵柄名（SLOT_SYMBOLS から引き直す） */
  reels: [string, string, string];
  kind: import("@meigokujo/core").SlotSpinKind;
  matched: string | null;
  freeSpin: boolean;
  /** お守り適用前の払戻 */
  rawPayout: number;
  /** お守り適用後の払戻（実際に動いた額） */
  payout: number;
  amuletNote: string | null;
  settled: import("@meigokujo/core").SoloRoundResult | null;
  jpWon: number;
  /**
   * 有料スピンで獲得した無料スピンの保留記録（PR3）。
   *
   * **有料スピンの確定と同じトランザクションで DB に残す。** ここで永続化しないと、
   * 「有料スピンは settled、演出の途中で Bot が落ちる → 無料スピン権が消える」が起きる。
   */
  pendingFreeSpin: PendingFreeSpinRow | null;
}

/**
 * 無料スピンの配当を払えなかった（PR3）。
 *
 * **保留記録を settled にせず、グループごと巻き戻す。** 「配当0で完了扱い」にすると
 * 権利が消えるので、払えないなら何もせず pending のまま残し、
 * 胴元の資金が戻ったときに同じ出目で払えるようにする。
 */
export class FreeSpinUnpayableError extends Error {
  constructor(
    readonly wanted: number,
    readonly capacity: number,
  ) {
    super(`ERR_FREE_SPIN_UNPAYABLE: 必要 ${wanted} / 余力 ${capacity}`);
    this.name = "FreeSpinUnpayableError";
  }
}

const symbolByName = (name: string): SlotSymbol => SYMBOLS.find((s) => s.name === name) ?? SYMBOLS[0]!;

/** 保存済みの絵柄名からリールを復元する（再開しても出目が変わらない） */
const reelsFromNames = (names: readonly [string, string, string]): [SlotSymbol, SlotSymbol, SlotSymbol] => [
  symbolByName(names[0]),
  symbolByName(names[1]),
  symbolByName(names[2]),
];

/**
 * 有料スピン1回ぶんの資金処理（抽選・お守り・賭け・配当・JP積立・JP当選）を
 * **ひとつの業務グループ**で行う。分かれていると、精算だけ通ってJP当選が落ちる／
 * お守りだけ消える中途半端な状態が残る。
 *
 * フリースピンを獲得した場合は、**同じグループの中で**次の無料スピンの出目まで振って
 * 保留（`casino_pending_free_spins`）として残す。ここまでが1トランザクションなので、
 * 「有料スピンが確定したのに無料スピン権だけ無い」状態は作れない。
 */
export function spinPaid(services: Services, uid: string, bet: number, interactionId: string): SpinRecord {
  const rng = services.rng;
  const groupKey = `slots:spin:${uid}:${interactionId}:paid`;
  return services.chips.runGroup(
    { groupKey, kind: "solo_game", actorId: uid },
    (): SpinRecord => {
      const reelsRaw: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
      const spin = evaluate(reelsRaw, bet);
      // 積立額は core の単一定義から取る（債務モデルが予約するのと同じ関数・PR4）
      const jpCut = jackpotCutFor(bet);

      const settledInGroup = services.casino.settleSolo(uid, "スロット", bet, spin.payout, {
        operationId: `${interactionId}:paid`,
        jackpotCut: jpCut,
        // 有料スピンの精算鍵は `<interactionId>:paid`（フリースピンと分けるため）だが、
        // 日次リスクの開始枠は `validateBet()` が interaction.id で取っている。
        // どちらの鍵を使うかを明示しないと、枠が見つからず fail-closed で落ちる（PR23）
        risk: { kind: "solo", startOperationId: interactionId },
      });
      const payout = settledInGroup.payout - settledInGroup.chainBonus + settledInGroup.fukuTax;

      // JP はフリースピンでも当選する（原作準拠）
      const jpWon =
        spin.kind === "jackpot" ? services.casino.seizeJackpot(uid, "slots", `${interactionId}:paid`, JP_WIN_SHARE) : 0;

      // 無料スピン権の永続化。**出目もここで確定させる**（再開で出目が変わらないように）
      let pendingFreeSpin: PendingFreeSpinRow | null = null;
      if (spin.freeSpin) {
        const freeReels: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
        const freeSpin = evaluate(freeReels, bet);
        const freeAmulet = services.casino.consumeAmulets(uid, bet, freeSpin.payout);
        const jackpotClaim = freeSpin.kind === "jackpot" ? Math.floor(services.casino.jackpotPool() * JP_WIN_SHARE) : 0;
        pendingFreeSpin = services.freeSpins.grant({
          userId: uid,
          operationId: interactionId,
          spinNo: 1,
          bet,
          sourceGroup: groupKey,
          reels: [freeReels[0].name, freeReels[1].name, freeReels[2].name],
          rawPayout: freeSpin.payout,
          amuletEffect: {
            kind: freeAmulet.payout > freeSpin.payout ? "win_bonus" : freeAmulet.payout !== freeSpin.payout ? "loss_protection" : "none",
            amount: Math.abs(freeAmulet.payout - freeSpin.payout),
          },
          amuletNote: freeAmulet.note,
          payout: freeAmulet.payout,
          jackpotWon: freeSpin.kind === "jackpot",
          jackpotClaim,
          totalClaim: freeAmulet.payout + jackpotClaim,
        });
        if (jackpotClaim > 0) {
          services.chips.transfer("jackpot", services.freeSpins.jackpotClaimHolder(pendingFreeSpin), jackpotClaim, {
            reason: "フリースピンJP請求の予約",
            game: "スロット",
          });
        }
      }

      return {
        reels: [reelsRaw[0].name, reelsRaw[1].name, reelsRaw[2].name],
        kind: spin.kind,
        matched: spin.matched ?? null,
        freeSpin: spin.freeSpin,
        rawPayout: spin.payout,
        payout,
        amuletNote: settledInGroup.amuletNote ?? null,
        settled: settledInGroup,
        jpWon,
        pendingFreeSpin,
      };
    },
  );
}

/**
 * 保留中の無料スピンを1件精算する（PR3）。
 *
 * 出目は保存済みなので**何度呼んでも同じ結果**になり、資金グループ鍵も行の identity から
 * 決まるので**払い出しは一度きり**になる。賭場が停止中なら資金グループが作れず例外になり、
 * 保留記録はそのまま残る（権利を失わない）。
 *
 * @param reservationKey この無料スピンを含む**生きている予約**の鍵（PR5）。
 *   渡すとその予約額を支払保証として使える（自分で確保した枠に弾かれない）。
 *   渡さない場合は「予約を引いた残り」だけで判定する。
 */
export function resolveFreeSpin(
  services: Services,
  row: PendingFreeSpinRow,
  reservationKey?: string,
): SpinRecord {
  const capacityOf = (s: Services): number =>
    reservationKey ? s.reservations.availableIncludingOwn(reservationKey) : s.casino.availableForLiability();
  const key = services.freeSpins.payoutGroupKey(row);
  try {
    return services.chips.runGroup({ groupKey: key, kind: "solo_game", actorId: row.userId }, (): SpinRecord => {
      const reelsRaw = reelsFromNames(row.reels);
      const spin = evaluate(reelsRaw, row.bet);
      // 払う前に「これから払う」印を付ける。例外が出れば一緒に巻き戻って pending に戻る
      services.freeSpins.beginProcessing(row.id);

      // 権利内容は獲得時に確定済み。現在のお守りやJPプールは参照しない。
      const wanted = row.payout;
      const capacity = capacityOf(services);
      if (wanted > capacity) {
        // **配当0で完了扱いにはしない。** 権利を残して巻き戻す
        throw new FreeSpinUnpayableError(wanted, capacity);
      }
      if (wanted > 0) {
        services.chips.transfer("house", row.userId, wanted, { reason: "フリースピンの配当", game: "スロット" });
        // 賭けなしの払い出しなので settle を通らない。通算損益にはここで足す
      }
      if (row.jackpotClaim > 0) {
        services.chips.transfer(services.freeSpins.jackpotClaimHolder(row), row.userId, row.jackpotClaim, {
          reason: "フリースピンのジャックポット請求",
          game: "スロット",
        });
      }
      if (row.totalClaim > 0) services.casino.recordGameNet(row.userId, row.totalClaim, { countAsBiggestWin: row.jackpotWon });

      // 払い切ってからだけ settled にする
      services.freeSpins.markSettled(row.id);

      return {
        reels: [reelsRaw[0].name, reelsRaw[1].name, reelsRaw[2].name],
        kind: spin.kind,
        matched: spin.matched ?? null,
        freeSpin: spin.freeSpin,
        rawPayout: row.rawPayout,
        payout: wanted,
        amuletNote: row.amuletNote,
        settled: null,
        jpWon: row.jackpotClaim,
        pendingFreeSpin: null,
      };
    });
  } catch (e) {
    if (e instanceof FreeSpinUnpayableError) {
      // グループの外で記録する（中で events.log しても同じトランザクションなので消える）
      services.events.log("casino_house_insufficient", {
        actor: row.userId,
        payload: {
          game: "スロット",
          kind: "free_spin",
          wanted: e.wanted,
          capacity: e.capacity,
          pendingFreeSpinId: row.id,
          keptPending: true,
        },
      });
    }
    throw e;
  }
}

/**
 * 保留中の無料スピンを**予約を取り直してから**精算する（PR5）。
 *
 * 元の予約は起動時に全解放されている（正本 §8.2 S9）ので、
 * 再開時は「払う直前に必要額を予約 → 払う → 解放」で安全に取り直す。
 * 予約が取れなければ `HouseCapacityError` になり、権利は pending のまま残る。
 */
export function resumeFreeSpin(services: Services, row: PendingFreeSpinRow): SpinRecord {
  const reserved = reserveFreeSpinLiability(services, row);
  try {
    return resolveFreeSpin(services, row, reserved.key);
  } finally {
    releaseHouseLiability(services, reserved.key);
  }
}

/**
 * 起動時に、前回のプロセスで払い切れなかった無料スピンを精算する（PR3）。
 *
 * 出目は保存済みなので、再起動をまたいでも表示・配当は同じ。
 * 1件の失敗（胴元不足・賭場停止など）で他を止めず、**失敗した権利は pending のまま残す**。
 */
export function resumePendingFreeSpins(services: Services): {
  total: number;
  settled: number;
  paid: number;
  failed: Array<{ id: number; userId: string; error: string }>;
} {
  const rows = services.freeSpins.listPending();
  let settled = 0;
  let paid = 0;
  const failed: Array<{ id: number; userId: string; error: string }> = [];
  for (const row of rows) {
    try {
      const r = resumeFreeSpin(services, row);
      reconcileSlotsGameFinishBestEffort(services, row.userId, row.operationId);
      settled++;
      paid += r.payout + r.jpWon;
    } catch (e) {
      failed.push({ id: row.id, userId: row.userId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  try {
    services.casinoMetrics?.reconcileSlotsFinishes();
  } catch (error) {
    console.error("[casino-metrics] slots startup reconcile failed", error);
  }
  if (rows.length > 0) {
    services.events.log("casino_free_spins_resumed", {
      actor: "system:startup",
      payload: { total: rows.length, settled, paid, failed: failed.length },
    });
  }
  return { total: rows.length, settled, paid, failed };
}

/**
 * 1スピンぶんの演出と結果表示。
 *
 * 資金処理は `record` の時点でもう終わっている（`spinPaid` / `resolveFreeSpin`）。
 * ここから先はアニメーションと画面だけなので、途中で落ちても資金は矛盾しない。
 * 無料スピンの権利も DB に残っているので、演出中に落ちても消えない。
 */
async function renderSpin(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: Services,
  bet: number,
  record: SpinRecord,
  isFreeSpin: boolean,
  /** この操作の予約鍵（PR5）。続けて回す無料スピンはこの予約の範囲で払う */
  reservationKey?: string,
  context?: CasinoPlayContext,
  originPaid?: SpinRecord,
  resolvedFree?: SpinRecord,
): Promise<void> {
  const uid = interaction.user.id;

  const reelsRaw: [SlotSymbol, SlotSymbol, SlotSymbol] = [
    symbolByName(record.reels[0]),
    symbolByName(record.reels[1]),
    symbolByName(record.reels[2]),
  ];
  const spin = { kind: record.kind, matched: record.matched ?? undefined, freeSpin: record.freeSpin };
  const adjustedPayout = record.payout;
  const amulet = { note: record.amuletNote ?? undefined };
  const settled = record.settled;
  const jpWon = record.jpWon;

  // ── Phase 1: スピンアニメ ──
  const initialEmbed = buildSpinEmbed(services, bet, isFreeSpin, "壺の中で運命が転がる……", ["❓", "❓", "❓"]);
  let reply: Message;
  if (interaction.replied || interaction.deferred) {
    reply = (await interaction.followUp({ embeds: [initialEmbed] })) as Message;
  } else {
    await interaction.reply({ embeds: [initialEmbed] });
    reply = (await interaction.fetchReply()) as Message;
  }

  const edit = async (embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = []) => {
    try {
      await reply.edit({ embeds: [embed], components });
    } catch {
      /* ignore */
    }
  };

  // リール1: サイクル→確定
  for (let t = 0; t < 3; t++) {
    await sleep(160);
    await edit(buildSpinEmbed(services, bet, isFreeSpin, "ぐるぐる……", [cycleAt(t * 3), cycleAt(t * 3 + 1), cycleAt(t * 3 + 2)]));
  }
  await sleep(160);
  await edit(buildSpinEmbed(services, bet, isFreeSpin, "ふむ……", [reelsRaw[0].emoji, cycleAt(99), cycleAt(98)]));

  // リール2: サイクル→確定
  for (let t = 0; t < 3; t++) {
    await sleep(160);
    await edit(buildSpinEmbed(services, bet, isFreeSpin, "おぉ……", [reelsRaw[0].emoji, cycleAt(t * 5), cycleAt(t * 5 + 1)]));
  }
  await sleep(160);

  // リール1+2 のニアミス煽り
  const isNearMiss =
    !isScatter(reelsRaw[0]) &&
    !isScatter(reelsRaw[1]) &&
    reelsRaw[0].kind === "normal" &&
    reelsRaw[1].kind === "normal" &&
    reelsRaw[0].name === reelsRaw[1].name;
  const teaseLabel = isNearMiss ? `あと一つで **${reelsRaw[0].name}** が揃う……！` : "むむ……";
  await edit(buildSpinEmbed(services, bet, isFreeSpin, teaseLabel, [reelsRaw[0].emoji, reelsRaw[1].emoji, "❓"]));
  await sleep(isNearMiss ? 1900 : 1100);

  // ── Phase 2: 結果 ──
  const payoutLabel = (() => {
    switch (spin.kind) {
      case "jackpot": return `🎉 **JACKPOT！** 純3マモン揃い`;
      case "triple": return `3つ揃い (${spin.matched})`;
      case "wild_triple": return `🌙 ワイルド3つ揃い (${spin.matched})`;
      case "double": return `2つ揃い (${spin.matched})`;
      default: return "";
    }
  })();
  const reelDisplay = face(reelsRaw[0].emoji, reelsRaw[1].emoji, reelsRaw[2].emoji);

  const won = adjustedPayout > 0;
  const totalPayout = adjustedPayout + jpWon + (settled?.chainBonus ?? 0) - (settled?.fukuTax ?? 0);
  const net = totalPayout - (isFreeSpin ? 0 : bet);
  const stats = services.casino.stats(uid);
  const winStreak = won ? stats.current_win_streak : 0;

  // 結果 embed（Fields でセクション化）
  const isJp = spin.kind === "jackpot";
  const bigWin = won && totalPayout >= bet * 5;
  const color = isJp ? 0xf0b429 : bigWin ? 0x16a34a : won ? 0x22c55e : net === 0 ? 0x78716c : 0x991b1b;

  const bonusBits: string[] = [];
  if (settled && settled.chainBonus > 0) {
    bonusBits.push(`${settled.chainLabel} 連鎖 ×${settled.chainMult.toFixed(2)}（${settled.chainStreak}連勝）  +${fmtEther(settled.chainBonus)}`);
  }
  if (settled && settled.fukuTax > 0) {
    bonusBits.push(`⚖️ 福の重み ${Math.round(settled.fukuRate * 100)}%  −${fmtEther(settled.fukuTax)}`);
  }
  if (amulet.note) bonusBits.push(`✨ ${amulet.note}`);
  if (jpWon > 0) bonusBits.push(`💎 JP獲得  +${fmtEther(jpWon)}（残 ${fmtEther(services.casino.jackpotPool())}）`);

  const resultPayload = buildSoloResult({
    services,
    userId: uid,
    game: "スロット",
    net,
    wager: isFreeSpin ? "無料" : bet,
    retryBet: bet,
    isJackpot: isJp,
    colorOverride: color,
    description: [
      reelDisplay,
      payoutLabel,
      spin.freeSpin && !isFreeSpin ? "✨ **魂片3つ！フリースピン獲得！** ✨" : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    // JP残高と連勝は「見えていれば嬉しい」程度の情報。フィールドを1枠使う価値はない
    footerExtra: [`💎 JP ${fmtEther(services.casino.jackpotPool())}`, winStreak >= 2 ? `🔥 ${winStreak}連勝` : ""]
      .filter(Boolean)
      .join(" · "),
    sections: bonusBits.length > 0 ? [{ name: "▸ 加算・控除", value: bonusBits.join("\n"), inline: false }] : [],
  });
  // 大勝ち速報
  if (won) {
    broadcastBigWin(interaction.client, services, {
      userId: uid,
      game: "スロット",
      bet: isFreeSpin ? 0 : bet,
      payout: totalPayout,
      isJackpot: spin.kind === "jackpot",
    });
  }

  // フリースピンなら結果表示後に自動で回す（原作準拠）。
  // 権利は DB に残っているので、ここで落ちても次の起動で払われる（PR3）
  if (record.pendingFreeSpin) {
    await reply.edit({ embeds: resultPayload.embeds, components: [] }).catch(() => undefined);
    await sleep(2500);
    try {
      const free = resolvedFree ?? resolveFreeSpin(services, record.pendingFreeSpin, reservationKey);
      reconcileSlotsGameFinishBestEffort(services, uid, interaction.id);
      await renderSpin(interaction, services, bet, free, true, reservationKey, context, record);
    } catch {
      // 胴元不足・賭場停止など。**権利は pending のまま残っている**
      await interaction
        .followUp({
          content: [
            "⚠️ いま無料スピンを回せなかった（胴元の資金不足か、賭場が閉じている）。",
            "**権利は残してある。** 賭場が開いたら同じ出目で自動的に払われる。",
          ].join("\n"),
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
    return;
  }

  await reply.edit({ embeds: resultPayload.embeds, components: resultPayload.components }).catch(() => undefined);
}
