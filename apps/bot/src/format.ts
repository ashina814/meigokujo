/** 表示まわりの共通フォーマッタ。世界観文言の本格辞書化（packages/theme）までの仮置き */

export function fmtLd(n: number): string {
  return `${n.toLocaleString("ja-JP")} Ld`;
}

/** エテル（マモンの賭場の第二通貨）。◈ は通貨記号 */
export function fmtEther(n: number): string {
  return `${n.toLocaleString("ja-JP")} ◈`;
}

/**
 * 記録カードなど幅の限られた場所向けの簡約表記。
 * 冥獄城は京クラス残高が実在するので万進法の単位で畳む。
 * 例: 1,284,300 → "128.4万 Ld" / 2.8e16 → "2.8京 Ld" / 500 → "500 Ld"
 */
export function fmtLdCompact(n: number): string {
  const sign = n < 0 ? "−" : "";
  const v = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e16, "京"],
    [1e12, "兆"],
    [1e8, "億"],
    [1e4, "万"],
  ];
  for (const [base, unit] of units) {
    if (v >= base) {
      const scaled = v / base;
      // 100以上は小数を落とす（例: 128万）。それ未満は小数1桁（例: 2.8京）
      const text = scaled >= 100 ? Math.round(scaled).toLocaleString("ja-JP") : trimZero(scaled.toFixed(1));
      return `${sign}${text}${unit} Ld`;
    }
  }
  return `${sign}${v.toLocaleString("ja-JP")} Ld`;
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, "");
}

export function mention(accountId: string): string {
  if (accountId.startsWith("user:")) return `<@${accountId.slice(5)}>`;
  if (accountId === "sys:treasury") return "🏛 国庫";
  if (accountId.startsWith("sys:dept:")) return `🏦 ${accountId.slice("sys:dept:".length)}`;
  return `⚙️ ${accountId}`;
}

export const TX_LABELS: Record<string, string> = {
  transfer: "送金",
  salary: "給与",
  initial: "初期発行",
  opening: "残高移行",
  fine: "罰金",
  adjust: "調整",
  vc_reward: "浮上報酬",
  reward_bump: "bump報酬",
  reward_boost: "ブースト報酬",
  room_fee: "部屋利用",
  room_refund: "部屋返金",
  event_prize: "イベント賞金",
  event_fee: "イベント参加費",
  pension: "年金",
  tax: "冥府税",
  tip: "投げ銭",
  dept_in: "部署入金",
  dept_out: "部署払戻",
  commission: "歩合",
};

export function txLabel(type: string): string {
  return TX_LABELS[type] ?? type;
}

export interface HistTx {
  from_account: string;
  to_account: string;
  amount: number;
  type: string;
  reason: string | null;
  created_at: number;
}

/** 取引履歴の1行表示（本人視点で +/− を付ける） */
export function formatHistLine(tx: HistTx, myAccount: string): string {
  const date = new Date(tx.created_at * 1000).toLocaleDateString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
  });
  const memo = tx.reason ? `『${tx.reason}』` : "";
  if (tx.from_account === myAccount) {
    return `${date} **−${fmtLd(tx.amount)}** ${txLabel(tx.type)} → ${mention(tx.to_account)} ${memo}`;
  }
  return `${date} **＋${fmtLd(tx.amount)}** ${txLabel(tx.type)} ← ${mention(tx.from_account)} ${memo}`;
}
