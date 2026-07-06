import type Database from "better-sqlite3";
import { Chips } from "../chips/service.js";
import { EventLog } from "../events/service.js";
import { HOUSE, cardLabel, type Card } from "../casino/service.js";

/**
 * 対人ポーカー（5カードドロー・テーブル制）。プレイヤー同士でポットを奪い合う。
 * 参加費(アンティ)を pot:poker:<id> に集め、ショーダウンで最強手が総取り（同点は分割）。
 * 胴元は少額のテラ銭(rake)だけ取る。チップは移動するだけ＝総量保存・非インフレ。
 */
export const POKER_RAKE_BPS = 500; // テラ銭5%

export type PokerErrorCode = "ERR_BAD_ANTE" | "ERR_NO_TABLE" | "ERR_NOT_HOST" | "ERR_ALREADY_JOINED" | "ERR_FULL" | "ERR_BAD_PHASE" | "ERR_TOO_FEW";

export class PokerError extends Error {
  constructor(readonly code: PokerErrorCode, readonly meta: Record<string, unknown> = {}) {
    super(code);
    this.name = "PokerError";
  }
}

// ---- 役判定（5枚）----
const HAND_NAMES = ["ハイカード", "ワンペア", "ツーペア", "スリーカード", "ストレート", "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ"];

export interface HandRank {
  category: number; // 0..8（大きいほど強い）
  tiebreak: number[]; // 同カテゴリ内の比較用（先頭優先）
  name: string;
}

/** 5枚の手を評価する */
export function evaluateHand(cards: Card[]): HandRank {
  const ranks = cards.map((c) => (c.rank === 1 ? 14 : c.rank)).sort((a, b) => b - a); // A=14
  const flush = cards.every((c) => c.suit === cards[0]!.suit);
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0]! - uniq[4]! === 4) straightHigh = uniq[0]!;
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // A-2-3-4-5
  }
  const cnt = new Map<number, number>();
  for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // 枚数降順→ランク降順
  const counts = groups.map((g) => g[1]);
  const byCount = groups.map((g) => g[0]);
  const mk = (category: number, tiebreak: number[]): HandRank => ({ category, tiebreak, name: HAND_NAMES[category]! });

  if (straightHigh && flush) return mk(8, [straightHigh]);
  if (counts[0] === 4) return mk(7, byCount);
  if (counts[0] === 3 && counts[1] === 2) return mk(6, byCount);
  if (flush) return mk(5, ranks);
  if (straightHigh) return mk(4, [straightHigh]);
  if (counts[0] === 3) return mk(3, byCount);
  if (counts[0] === 2 && counts[1] === 2) return mk(2, byCount);
  if (counts[0] === 2) return mk(1, byCount);
  return mk(0, ranks);
}

/** a が b より強ければ >0、弱ければ <0、同点なら 0 */
export function compareHands(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const d = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---- テーブル ----
const SUITS = ["♠", "♥", "♦", "♣"];
function freshDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ rank: r, suit: s });
  return d;
}

type Phase = "open" | "draw" | "done";
interface Seat {
  userId: string;
  cards: Card[];
  ready: boolean;
}
export interface PokerTable {
  id: string;
  hostId: string;
  ante: number;
  phase: Phase;
  seats: Seat[];
  deck: Card[];
  potHolder: string;
  channelId?: string;
  messageId?: string;
}

export interface ShowdownResult {
  winners: string[];
  perWinner: number;
  rake: number;
  pot: number;
  hands: Array<{ userId: string; cards: string[]; hand: string; folded: boolean }>;
}

const MAX_SEATS = 6;

export class Poker {
  private readonly tables = new Map<string, PokerTable>();

  constructor(
    private readonly db: Database.Database,
    private readonly chips: Chips,
    private readonly events: EventLog,
    private readonly rng: () => number = Math.random,
  ) {
    void this.db;
  }

  get(id: string): PokerTable | undefined {
    return this.tables.get(id);
  }
  private require(id: string): PokerTable {
    const t = this.tables.get(id);
    if (!t) throw new PokerError("ERR_NO_TABLE", { id });
    return t;
  }
  seatOf(t: PokerTable, userId: string): Seat | undefined {
    return t.seats.find((s) => s.userId === userId);
  }

  /** テーブルを作成し、ホストが着席（アンティ徴収） */
  create(hostId: string, ante: number): PokerTable {
    if (!Number.isInteger(ante) || ante <= 0) throw new PokerError("ERR_BAD_ANTE", { ante });
    const id = `${Date.now().toString(36)}${Math.floor(this.rng() * 1e6).toString(36)}`;
    const t: PokerTable = { id, hostId, ante, phase: "open", seats: [], deck: [], potHolder: `pot:poker:${id}` };
    this.tables.set(id, t);
    this.ante(t, hostId);
    this.events.log("poker_table", { actor: hostId, payload: { id, ante } });
    return t;
  }

  private ante(t: PokerTable, userId: string): void {
    this.chips.transfer(userId, t.potHolder, t.ante); // 足りなければ ChipError
    t.seats.push({ userId, cards: [], ready: false });
  }

  join(id: string, userId: string): PokerTable {
    const t = this.require(id);
    if (t.phase !== "open") throw new PokerError("ERR_BAD_PHASE", { id });
    if (this.seatOf(t, userId)) throw new PokerError("ERR_ALREADY_JOINED");
    if (t.seats.length >= MAX_SEATS) throw new PokerError("ERR_FULL");
    this.ante(t, userId);
    return t;
  }

  private drawFrom(deck: Card[]): Card {
    return deck.splice(Math.min(deck.length - 1, Math.floor(this.rng() * deck.length)), 1)[0]!;
  }

  /** ホストが配る。open→draw。全員に5枚 */
  deal(id: string, hostId: string): PokerTable {
    const t = this.require(id);
    if (t.hostId !== hostId) throw new PokerError("ERR_NOT_HOST");
    if (t.phase !== "open") throw new PokerError("ERR_BAD_PHASE");
    if (t.seats.length < 2) throw new PokerError("ERR_TOO_FEW");
    t.deck = freshDeck();
    for (const seat of t.seats) {
      seat.cards = [this.drawFrom(t.deck), this.drawFrom(t.deck), this.drawFrom(t.deck), this.drawFrom(t.deck), this.drawFrom(t.deck)];
      seat.ready = false;
    }
    t.phase = "draw";
    return t;
  }

  /** 交換して確定。discardIndices の札を引き直す */
  swap(id: string, userId: string, discardIndices: number[]): Seat {
    const t = this.require(id);
    if (t.phase !== "draw") throw new PokerError("ERR_BAD_PHASE");
    const seat = this.seatOf(t, userId);
    if (!seat) throw new PokerError("ERR_NO_TABLE");
    const drop = new Set(discardIndices.filter((i) => i >= 0 && i < 5));
    seat.cards = seat.cards.map((c, i) => (drop.has(i) ? this.drawFrom(t.deck) : c));
    seat.ready = true;
    return seat;
  }

  allReady(t: PokerTable): boolean {
    return t.seats.every((s) => s.ready);
  }

  /** ショーダウン。最強手がポット総取り（同点は分割）、テラ銭は胴元へ */
  showdown(id: string, actor: string): ShowdownResult {
    const t = this.require(id);
    if (t.phase !== "draw") throw new PokerError("ERR_BAD_PHASE");
    const pot = this.chips.balanceOf(t.potHolder);
    const rake = Math.floor((pot * POKER_RAKE_BPS) / 10_000);
    const prizePool = pot - rake;

    const ranked = t.seats.map((s) => ({ seat: s, rank: evaluateHand(s.cards) }));
    let best = ranked[0]!.rank;
    for (const r of ranked) if (compareHands(r.rank, best) > 0) best = r.rank;
    const winners = ranked.filter((r) => compareHands(r.rank, best) === 0).map((r) => r.seat.userId);

    const perWinner = winners.length > 0 ? Math.floor(prizePool / winners.length) : 0;
    if (rake > 0) this.chips.transfer(t.potHolder, HOUSE, rake);
    for (const w of winners) this.chips.transfer(t.potHolder, w, perWinner);
    // 端数はテラ銭に上乗せ（胴元へ）
    const remainder = this.chips.balanceOf(t.potHolder);
    if (remainder > 0) this.chips.transfer(t.potHolder, HOUSE, remainder);

    t.phase = "done";
    const hands = ranked.map((r) => ({ userId: r.seat.userId, cards: r.seat.cards.map(cardLabel), hand: r.rank.name, folded: false }));
    this.events.log("poker_showdown", { actor, payload: { id, winners, perWinner, rake } });
    this.tables.delete(id);
    return { winners, perWinner, rake: rake + remainder, pot, hands };
  }

  /** 解散。全員へアンティ返金 */
  cancel(id: string, hostId: string): void {
    const t = this.require(id);
    if (t.hostId !== hostId) throw new PokerError("ERR_NOT_HOST");
    for (const s of t.seats) this.chips.transfer(t.potHolder, s.userId, t.ante);
    // 端数があれば胴元へ
    const remainder = this.chips.balanceOf(t.potHolder);
    if (remainder > 0) this.chips.transfer(t.potHolder, HOUSE, remainder);
    t.phase = "done";
    this.events.log("poker_cancel", { actor: hostId, payload: { id } });
    this.tables.delete(id);
  }

  setPanel(id: string, channelId: string, messageId: string): void {
    const t = this.tables.get(id);
    if (t) {
      t.channelId = channelId;
      t.messageId = messageId;
    }
  }
}
