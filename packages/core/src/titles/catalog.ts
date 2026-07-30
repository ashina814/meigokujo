import type { TitleRule } from "./helper.js";

/**
 * 称号カタログ。
 *
 * ■ 設計方針（ランクとの差別化）
 *   ランク（rank_text / rank_voice）は「どれだけ積んだか」を連続的に測る。個人の孤立した
 *   数字しか持てないため、誰といたか・何時だったか・何が起きたかは原理的に扱えない。
 *   称号はそこを取る。すなわち「事件・関係・瞬間・組み合わせ」を測る。
 *   → VCの累計時間と発言数の段位は作らない（ランクの領分なので二重になる）。
 *
 * ■ 秘匿対象
 *   トートの耳・チケット・蜜月・朧月は判定材料にしない。理由と一覧は titles/privacy.ts。
 *   「装備しなければ見えない」では守れない（自動装備・将来の公開プロフィールがあるため）
 *   ので、条件から完全に外す方針を取っている。tests/titles.test.ts が機械的に検証する。
 *
 * ■ 説明文と判定式は一致させる
 *   desc は未獲得の一覧にも出る＝獲得条件の公示になる。実装とずれたら desc の側ではなく
 *   どちらが正しいかを決めてから直すこと。tests が両者の対応をいくつか固定している。
 *
 * ■ 名前について
 *   name は全て仮。世界観の核なので命名は別途差し替える。key は永続IDなので変更しない
 *   （key を変えると付与済みレコードとの対応が切れる）。
 */

const HOUR = 3600;

/** 段位を1行で定義するためのヘルパ。tier は 1 起点 */
function dan(
  keyBase: string,
  name: string,
  emoji: string,
  unit: string,
  thresholds: number[],
  read: (h: Parameters<TitleRule["check"]>[0]) => number,
): TitleRule[] {
  const numerals = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ"];
  return thresholds.map((threshold, i) => ({
    key: `${keyBase}_${i + 1}`,
    category: "dan" as const,
    name: `${name} ${numerals[i]}`,
    emoji,
    desc: `${unit}${threshold.toLocaleString("ja-JP")}`,
    check: (h) => read(h) >= threshold,
  }));
}

/** ── 縁・同席（ランクには原理的に作れない領域） ───────────────────── */
const KIZUNA: TitleRule[] = [
  { key: "co_first", category: "kizuna", name: "初めての同席", emoji: "👥", desc: "誰かと同じVCに居合わせた", check: (h) => h.companions.uniqueCount >= 1 },
  { key: "co_10", category: "kizuna", name: "顔見知り", emoji: "🫂", desc: "10人と同席した", check: (h) => h.companions.uniqueCount >= 10 },
  { key: "co_30", category: "kizuna", name: "城の顔役", emoji: "🎭", desc: "30人と同席した", check: (h) => h.companions.uniqueCount >= 30 },
  { key: "co_50", category: "kizuna", name: "万人の知己", emoji: "🌐", desc: "50人と同席した", check: (h) => h.companions.uniqueCount >= 50 },
  { key: "co_total_100h", category: "kizuna", name: "交わる魂", emoji: "🔗", desc: "延べ同席時間が100時間を超えた", check: (h) => h.companions.totalSeconds >= 100 * HOUR },
  { key: "co_total_500h", category: "kizuna", name: "群れの中心", emoji: "🕸", desc: "延べ同席時間が500時間を超えた", check: (h) => h.companions.totalSeconds >= 500 * HOUR },
  { key: "co_total_1500h", category: "kizuna", name: "城の結節点", emoji: "💠", desc: "延べ同席時間が1500時間を超えた", check: (h) => h.companions.totalSeconds >= 1500 * HOUR },
  { key: "buddy_10h", category: "kizuna", name: "馴染み", emoji: "🤝", desc: "誰か一人と10時間 同席した", check: (h) => h.bestCompanionHours() >= 10 },
  { key: "buddy_50h", category: "kizuna", name: "相棒", emoji: "♊", desc: "誰か一人と50時間 同席した", check: (h) => h.bestCompanionHours() >= 50 },
  { key: "buddy_200h", category: "kizuna", name: "無二の相棒", emoji: "🫱", desc: "誰か一人と200時間 同席した", check: (h) => h.bestCompanionHours() >= 200 },
  { key: "buddy_500h", category: "kizuna", name: "影の如く", emoji: "🌗", desc: "誰か一人と500時間 同席した", secret: true, check: (h) => h.bestCompanionHours() >= 500 },
  { key: "lineage_1", category: "kizuna", name: "血脈を残した者", emoji: "🩸", desc: "自分が招いた者が、さらに人を招いた", check: (h) => h.invitesGrand() >= 1 },
  { key: "lineage_5", category: "kizuna", name: "系譜の祖", emoji: "🌳", desc: "自分の招いた者が、5人を城へ導いた", check: (h) => h.invitesGrand() >= 5 },
];

/** ── 時と刻（累計ではなく「いつ」「どれだけ続いたか」） ─────────────── */
const TOKI: TitleRule[] = [
  { key: "streak_3", category: "toki", name: "三日続く灯", emoji: "🕯", desc: "3日続けて浮上した", check: (h) => h.vc.maxStreakDays >= 3 },
  { key: "streak_7", category: "toki", name: "七夜の常連", emoji: "🌒", desc: "7日続けて浮上した", check: (h) => h.vc.maxStreakDays >= 7 },
  { key: "streak_30", category: "toki", name: "絶えぬ魂", emoji: "🔥", desc: "30日続けて浮上した", check: (h) => h.vc.maxStreakDays >= 30 },
  { key: "streak_100", category: "toki", name: "不滅の灯", emoji: "⭐", desc: "100日続けて浮上した", secret: true, check: (h) => h.vc.maxStreakDays >= 100 },
  { key: "night_1", category: "toki", name: "丑三つの徒", emoji: "🌙", desc: "深夜2時〜4時台に浮上していた", check: (h) => h.vc.deepNightDays >= 1 },
  { key: "night_30", category: "toki", name: "夜を統べる者", emoji: "🦉", desc: "30日 深夜2時〜4時台に浮上していた", check: (h) => h.vc.deepNightDays >= 30 },
  { key: "night_100", category: "toki", name: "常闇の住人", emoji: "🌑", desc: "100日 深夜2時〜4時台に浮上していた", check: (h) => h.vc.deepNightDays >= 100 },
  { key: "dawn_1", category: "toki", name: "夜明けを見た魂", emoji: "🌅", desc: "朝5時〜6時台に浮上していた", check: (h) => h.vc.dawnDays >= 1 },
  { key: "dawn_10", category: "toki", name: "朝日の常連", emoji: "☀️", desc: "10日 朝5時〜6時台に浮上していた", check: (h) => h.vc.dawnDays >= 10 },
  { key: "dawn_50", category: "toki", name: "陽を厭わぬ亡霊", emoji: "🔆", desc: "50日 朝5時〜6時台に浮上していた", secret: true, check: (h) => h.vc.dawnDays >= 50 },
  { key: "cross_1", category: "toki", name: "日を跨ぐ者", emoji: "🕛", desc: "日付をまたいで浮上し続けた", check: (h) => h.vc.crossMidnightSessions >= 1 },
  { key: "cross_30", category: "toki", name: "境を知らぬ魂", emoji: "♾", desc: "30回 日付をまたいで浮上し続けた", check: (h) => h.vc.crossMidnightSessions >= 30 },
  { key: "marathon_8h", category: "toki", name: "不退転", emoji: "⛓", desc: "一度に8時間 浮上し続けた", check: (h) => h.vc.longestSessionSeconds >= 8 * HOUR },
  { key: "marathon_16h", category: "toki", name: "帰らずの魂", emoji: "🕳", desc: "一度に16時間 浮上し続けた", secret: true, check: (h) => h.vc.longestSessionSeconds >= 16 * HOUR },
];

/** ── 賭場（「量」ではなく「起きた出来事」） ──────────────────────── */
const BAKUCHI: TitleRule[] = [
  { key: "jackpot_1", category: "bakuchi", name: "一攫千金", emoji: "💎", desc: "ジャックポットを射止めた", check: (h) => h.asActor("casino_jackpot") >= 1 },
  { key: "jackpot_5", category: "bakuchi", name: "天に愛された魂", emoji: "🌠", desc: "ジャックポットを5度 射止めた", secret: true, check: (h) => h.asActor("casino_jackpot") >= 5 },
  { key: "winstreak_5", category: "bakuchi", name: "波に乗る者", emoji: "🌊", desc: "5連勝した", check: (h) => h.casinoStat("best_win_streak") >= 5 },
  { key: "winstreak_10", category: "bakuchi", name: "連勝の覇者", emoji: "⚡", desc: "10連勝した", check: (h) => h.casinoStat("best_win_streak") >= 10 },
  { key: "winstreak_20", category: "bakuchi", name: "神懸かり", emoji: "✨", desc: "20連勝した", secret: true, check: (h) => h.casinoStat("best_win_streak") >= 20 },
  { key: "bigwin_100k", category: "bakuchi", name: "大勝ち", emoji: "💰", desc: "一度の勝負で10万エテルを掴んだ", check: (h) => h.casinoStat("biggest_win") >= 100_000 },
  { key: "bigwin_500k", category: "bakuchi", name: "大博打", emoji: "🔥", desc: "一度の勝負で50万エテルを掴んだ", check: (h) => h.casinoStat("biggest_win") >= 500_000 },
  { key: "bigwin_2m", category: "bakuchi", name: "賭場を揺らした魂", emoji: "🌋", desc: "一度の勝負で200万エテルを掴んだ", secret: true, check: (h) => h.casinoStat("biggest_win") >= 2_000_000 },
  // 戦績に種目が記録されるのは casino.settle を通る遊技だけ（現在8種）。
  // 差し・各種デュエル・競馬は escrow.settle 経由で casino_game を残さないため数えられない。
  // 閾値を実在種目数より上げると永久に解除されない称号になる（tests/titles-sources.test.ts が検証）。
  { key: "games_half", category: "bakuchi", name: "遊び人", emoji: "🎲", desc: "賭場の遊技を4種類 遊んだ", check: (h) => h.distinctCasinoGames() >= 4 },
  { key: "games_all", category: "bakuchi", name: "賭場を知る者", emoji: "🃏", desc: "賭場の遊技を8種類 遊んだ", check: (h) => h.distinctCasinoGames() >= 8 },
  { key: "market_first", category: "bakuchi", name: "扇動者", emoji: "📋", desc: "板を立てた", check: (h) => h.asActor("market_create") >= 1 },
  { key: "market_10", category: "bakuchi", name: "世論の主", emoji: "📰", desc: "板を10回 立てた", check: (h) => h.asActor("market_create") >= 10 },
  { key: "market_bet_20", category: "bakuchi", name: "読み手", emoji: "🔮", desc: "板に20回 賭けた", check: (h) => h.asActor("market_bet") >= 20 },
  { key: "stocks_first", category: "bakuchi", name: "相場師", emoji: "📈", desc: "株を買った", check: (h) => h.asActor("stock_buy") >= 1 },
  { key: "stocks_50", category: "bakuchi", name: "冥獄の投機家", emoji: "📊", desc: "株の売買を50回 行った", check: (h) => h.asActor("stock_buy") + h.asActor("stock_sell") >= 50 },
  { key: "vip_first", category: "bakuchi", name: "貴賓", emoji: "🎩", desc: "VIPの座に就いた", check: (h) => h.asActor("casino_vip_join") >= 1 },
  { key: "keiba_first", category: "bakuchi", name: "馬を見る目", emoji: "🐎", desc: "競馬に賭けた", check: (h) => h.raceBets() >= 1 },
  { key: "keiba_50", category: "bakuchi", name: "競馬狂い", emoji: "🏇", desc: "競馬に50回 賭けた", check: (h) => h.raceBets() >= 50 },
  { key: "taku_first", category: "bakuchi", name: "卓を建てる者", emoji: "🀄", desc: "賭場に卓を建てた", check: (h) => h.asActor("takutate_create") >= 1 },
];

/** ── 銭（金額ではなく「誰に・どう動かしたか」） ─────────────────── */
const KANE: TitleRule[] = [
  { key: "tip_targets_5", category: "kane", name: "気前のいい魂", emoji: "🎁", desc: "5人に投げ銭した", check: (h) => h.distinctTipTargets() >= 5 },
  { key: "tip_targets_20", category: "kane", name: "施しの人", emoji: "🌹", desc: "20人に投げ銭した", check: (h) => h.distinctTipTargets() >= 20 },
  { key: "tip_targets_50", category: "kane", name: "冥獄の恵み", emoji: "👐", desc: "50人に投げ銭した", secret: true, check: (h) => h.distinctTipTargets() >= 50 },
  { key: "tip_sum_100k", category: "kane", name: "散財家", emoji: "💸", desc: "投げ銭の総額が10万Ldを超えた", check: (h) => h.txOutSum("tip") >= 100_000 },
  { key: "tip_sum_1m", category: "kane", name: "浪費の美学", emoji: "🥂", desc: "投げ銭の総額が100万Ldを超えた", check: (h) => h.txOutSum("tip") >= 1_000_000 },
  { key: "tip_received_1", category: "kane", name: "報われた魂", emoji: "💌", desc: "投げ銭を受け取った", check: (h) => h.txInCount("tip") >= 1 },
  { key: "tip_received_50", category: "kane", name: "人望", emoji: "🏵", desc: "投げ銭を50回 受け取った", check: (h) => h.txInCount("tip") >= 50 },
  { key: "burnt_offering", category: "kane", name: "冥獄への供物", emoji: "🔥", desc: "冥獄ボットへ投げ銭してLandを焼却した", check: (h) => h.txOutCount("tip_burn") >= 1 },
  { key: "ether_buy_first", category: "kane", name: "両替所の客", emoji: "🔄", desc: "エテルに両替した", check: (h) => h.asActor("ether_buy") >= 1 },
  { key: "ether_sell_first", category: "kane", name: "引き際を知る者", emoji: "🚪", desc: "エテルをLandへ戻した", check: (h) => h.asActor("ether_sell") >= 1 },
  { key: "salary_first", category: "kane", name: "俸禄を食む者", emoji: "📜", desc: "給与を受け取った", check: (h) => h.txInCount("salary") >= 1 },
  { key: "taxpayer", category: "kane", name: "冥府税を納めた者", emoji: "🧾", desc: "冥府税を納めた", check: (h) => h.txOutCount("tax") >= 1 },
  { key: "pensioner", category: "kane", name: "魂の年金", emoji: "🕊", desc: "魂の年金を受け取った", check: (h) => h.txInCount("pension") >= 1 },
  { key: "dept_first", category: "kane", name: "部署の一員", emoji: "🏛", desc: "部署の金庫に入金、または部署から受け取った", check: (h) => h.txOutCount("dept_in") + h.txInCount("dept_out") >= 1 },
  { key: "shop_first", category: "kane", name: "商館の客", emoji: "🛍", desc: "公式ショップで買い物をした", check: (h) => h.shopPurchases() >= 1 },
  { key: "vc_reward_50", category: "kane", name: "浮上の報い", emoji: "🌟", desc: "浮上報酬を50回 受け取った", check: (h) => h.txInCount("vc_reward") >= 50 },
];

/** ── 城の営み（立場・役割・営為） ──────────────────────────── */
const SHIRO: TitleRule[] = [
  { key: "newborn", category: "shiro", name: "生まれし魂", emoji: "🕯", desc: "冥獄城に亡霊として迎えられた", check: (h) => h.asTarget("ghosted") >= 1 },
  { key: "risen", category: "shiro", name: "魔人への道", emoji: "⚔️", desc: "審判を越えて昇格した", check: (h) => h.asTarget("promotion") >= 1 },
  { key: "risen_twice", category: "shiro", name: "二度の審判", emoji: "🗡", desc: "二度 昇格した", check: (h) => h.asTarget("promotion") >= 2 },
  { key: "marks_5", category: "shiro", name: "印を集めし者", emoji: "🔖", desc: "昇格の印を5つ 集めた", check: (h) => h.marks("promotion") >= 5 },
  { key: "judge_1", category: "shiro", name: "審判者", emoji: "⚖️", desc: "誰かを評価した", check: (h) => h.evalsGiven() >= 1 },
  { key: "judge_impartial", category: "shiro", name: "是々非々", emoji: "🧭", desc: "昇格・据置・降格の全ての結論を下した", check: (h) => h.evalsGiven("promotion") >= 1 && h.evalsGiven("none") >= 1 && h.evalsGiven("demotion") >= 1 },
  { key: "room_normal", category: "shiro", name: "宿を取る者", emoji: "🛏", desc: "宿を開いた", check: (h) => h.roomsOpened("normal") >= 1 },
  { key: "room_game", category: "shiro", name: "遊戯の主", emoji: "🎮", desc: "ゲーム部屋を開いた", check: (h) => h.roomsOpened("game") >= 1 },
  { key: "room_both", category: "shiro", name: "宿と遊戯の主", emoji: "🗝", desc: "宿とゲーム部屋の両方を開いた", check: (h) => h.roomsOpened("normal") >= 1 && h.roomsOpened("game") >= 1 },
  { key: "recruiter_1", category: "shiro", name: "勧誘者", emoji: "📣", desc: "1人を城へ導いた", check: (h) => h.invitesDirect() >= 1 },
  { key: "recruiter_5", category: "shiro", name: "冥獄の伝道師", emoji: "🔥", desc: "5人を城へ導いた", check: (h) => h.invitesDirect() >= 5 },
  { key: "recruiter_20", category: "shiro", name: "門を開く者", emoji: "🚩", desc: "20人を城へ導いた", secret: true, check: (h) => h.invitesDirect() >= 20 },
  { key: "bless_30", category: "shiro", name: "福の申し子", emoji: "🍀", desc: "マモンの福分けを30回 受けた", check: (h) => h.asActor("casino_daily") >= 30 },
  { key: "bless_365", category: "shiro", name: "日々を欠かさぬ魂", emoji: "🎴", desc: "マモンの福分けを365回 受けた", secret: true, check: (h) => h.asActor("casino_daily") >= 365 },
];

/** ── 極み（複数機能の組み合わせ・自己言及） ─────────────────────── */
const KIWAMI: TitleRule[] = [
  { key: "all_economy", category: "kiwami", name: "城を遊び尽くす者", emoji: "🏆", desc: "送金・投げ銭・両替・株・板・商館の全てに触れた", check: (h) => h.txOutCount("transfer") >= 1 && h.txOutCount("tip") >= 1 && h.asActor("ether_buy") >= 1 && h.asActor("stock_buy") >= 1 && h.asActor("market_bet") >= 1 && h.shopPurchases() >= 1 },
  { key: "explorer_10", category: "kiwami", name: "城を歩く者", emoji: "🧭", desc: "10種類の常設VCに浮上した（宿・卓などの一時VCは除く）", check: (h) => h.vc.distinctChannels >= 10 },
  { key: "deafened", category: "kiwami", name: "聞かぬ亡霊", emoji: "🙉", desc: "スピーカーを切ったまま累計50時間 居座った", secret: true, check: (h) => h.vc.deafenedSeconds >= 50 * HOUR },
  { key: "titles_25", category: "kiwami", name: "収集家", emoji: "📚", desc: "称号を25個 集めた", check: (h) => h.ownedTitles() >= 25 },
  { key: "titles_50", category: "kiwami", name: "冥獄の博物家", emoji: "🏛", desc: "称号を50個 集めた", check: (h) => h.ownedTitles() >= 50 },
  { key: "titles_80", category: "kiwami", name: "全てを識る魂", emoji: "👑", desc: "称号を80個 集めた", secret: true, check: (h) => h.ownedTitles() >= 80 },
];

/** ── 段位（ランクが扱っていない「量」だけを刻む） ────────────────── */
const DAN: TitleRule[] = [
  ...dan("dan_games", "賭場の徒", "🎰", "賭場で通算", [10, 50, 200, 1000, 5000], (h) => h.casinoStat("games")),
  ...dan("dan_wager", "投じる者", "🪙", "賭場に累計", [10_000, 100_000, 1_000_000, 10_000_000, 100_000_000], (h) => h.casinoStat("total_wagered")),
  ...dan("dan_bump", "城の目覚まし", "🔔", "城の宣伝を通算", [1, 10, 50, 200, 500], (h) => h.bumps()),
  ...dan("dan_days", "在城の魂", "🏰", "在城", [7, 30, 100, 200, 365, 730], (h) => h.daysInCastle()),
  ...dan("dan_tip", "投げ銭", "🌹", "投げ銭を通算", [1, 10, 50, 200], (h) => h.txOutCount("tip")),
  ...dan("dan_room", "宿の主", "🛏", "宿・ゲーム部屋を通算", [1, 5, 20, 50], (h) => h.roomsOpened()),
  ...dan("dan_eval", "評定の徒", "⚖️", "評価を通算", [1, 5, 20, 50], (h) => h.evalsGiven()),
];

export const TITLE_RULES: TitleRule[] = [...KIZUNA, ...TOKI, ...BAKUCHI, ...KANE, ...SHIRO, ...KIWAMI, ...DAN];

/** 隠し二つ名の総数（「X/N 発見」表示用） */
export const SECRET_TITLE_COUNT = TITLE_RULES.filter((r) => r.secret).length;
