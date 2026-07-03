/** 表示まわりの共通フォーマッタ。世界観文言の本格辞書化（packages/theme）までの仮置き */

export function fmtLd(n: number): string {
  return `${n.toLocaleString("ja-JP")} Ld`;
}

export function mention(accountId: string): string {
  if (accountId.startsWith("user:")) return `<@${accountId.slice(5)}>`;
  if (accountId === "sys:treasury") return "🏛 国庫";
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
