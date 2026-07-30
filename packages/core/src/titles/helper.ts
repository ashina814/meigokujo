import type { TitleSnapshot, VcDerived } from "./snapshot.js";
import type { PublicRoomKind } from "./privacy.js";

const DAY = 86_400;
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

/** 称号の分類。命名・一覧表示・絞り込みの単位 */
export type TitleCategory =
  | "kizuna" // 同席・縁
  | "toki" // 時と刻
  | "bakuchi" // 賭場
  | "kane" // 銭
  | "shiro" // 城の営み
  | "kiwami" // 極み（コンプリート・同日達成）
  | "dan"; // 段位

export interface TitleRule {
  key: string;
  category: TitleCategory;
  name: string;
  emoji: string;
  /** 獲得条件の説明。未獲得の一覧にも出る（secret のときは伏せる）。判定式と一致させること */
  desc: string;
  check: (h: TitleHelper) => boolean;
  /** 隠し二つ名。獲得するまで名前も条件も明かさない */
  secret?: boolean;
}

/**
 * ルール判定用のアクセサ。DBには一切触らず、事前に構築した TitleSnapshot だけを読む。
 * ここに生えているメソッドが、称号ルールで使える語彙のすべて。
 *
 * 台帳系は actor_id ではなく口座の出入りで数える（理由は snapshot.ts の先頭コメント）。
 * 部屋は公開してよい種別しか触れない（理由は privacy.ts）。
 */
export class TitleHelper {
  constructor(private readonly s: TitleSnapshot) {}

  get userId(): string {
    return this.s.userId;
  }

  /** 自分が行為者として事件録に記録された回数 */
  asActor(type: string): number {
    return this.s.evActor.get(type) ?? 0;
  }

  /** 自分が対象として事件録に記録された回数 */
  asTarget(type: string): number {
    return this.s.evTarget.get(type) ?? 0;
  }

  /** 自分の口座から出た取引の件数（投げ銭・送金・入金など） */
  txOutCount(type: string): number {
    return this.s.txOut.get(type)?.count ?? 0;
  }

  /** 自分の口座から出た取引の総額 */
  txOutSum(type: string): number {
    return this.s.txOut.get(type)?.sum ?? 0;
  }

  /** 自分の口座が受け取った件数（給与・浮上報酬・部署からの出金など） */
  txInCount(type: string): number {
    return this.s.txIn.get(type)?.count ?? 0;
  }

  /** 自分の口座が受け取った総額 */
  txInSum(type: string): number {
    return this.s.txIn.get(type)?.sum ?? 0;
  }

  casinoStat(field: string): number {
    return this.s.casino[field] ?? 0;
  }

  status(): string | null {
    return this.s.soulStatus;
  }

  /** 亡霊化してからの在城日数（未亡霊化なら0） */
  daysInCastle(): number {
    if (!this.s.ghostAt) return 0;
    return Math.floor((now() - this.s.ghostAt) / DAY);
  }

  /** VC由来の指標（時間帯・連続性・最長滞在など） */
  get vc(): VcDerived {
    return this.s.vc;
  }

  totalVcSeconds(): number {
    return this.s.vc.totalSeconds;
  }

  /**
   * 同席の要約。
   * totalSeconds は「相手ごとの延べ」なので、3人以上のVCでは実時間を超える。
   * 単独時間の算出には使えない（誤用防止のためコメントを残す）。
   */
  get companions(): { uniqueCount: number; totalSeconds: number; bestSeconds: number } {
    return this.s.companions;
  }

  /** 最も長く同席した相手との時間（＝相棒の濃さ）。時間単位 */
  bestCompanionHours(): number {
    return this.s.companions.bestSeconds / HOUR;
  }

  distinctCasinoGames(): number {
    return this.s.distinctCasinoGames;
  }

  /**
   * 開いた部屋の数。種別は公開してよいものだけを受け付ける
   * （蜜月・朧月を条件に書けないよう型で塞いでいる）。
   */
  roomsOpened(kind?: PublicRoomKind): number {
    if (kind) return this.s.roomsByKind.get(kind) ?? 0;
    let total = 0;
    for (const v of this.s.roomsByKind.values()) total += v;
    return total;
  }

  /** 自分が直接招いた人数 */
  invitesDirect(): number {
    return this.s.invites.direct;
  }

  /** 自分が招いた人が、さらに招いた人数（＝血脈） */
  invitesGrand(): number {
    return this.s.invites.grand;
  }

  marks(kind: "promotion" | "demotion"): number {
    return this.s.marks[kind];
  }

  /** 自分が下した評価の件数（conclusion 省略で全件） */
  evalsGiven(conclusion?: string): number {
    if (conclusion) return this.s.evalsGiven.get(conclusion) ?? 0;
    let total = 0;
    for (const v of this.s.evalsGiven.values()) total += v;
    return total;
  }

  bumps(): number {
    return this.s.bumps;
  }

  /** 投げ銭を贈った相手のユニーク人数 */
  distinctTipTargets(): number {
    return this.s.distinctTipTargets;
  }

  shopPurchases(): number {
    return this.s.shopPurchases;
  }

  raceBets(): number {
    return this.s.raceBets;
  }

  /** 既に集めた称号の数。同一評価内での増分は次回に持ち越される */
  ownedTitles(): number {
    return this.s.ownedTitles;
  }
}
