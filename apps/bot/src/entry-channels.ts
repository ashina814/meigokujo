import type { Services } from "./services.js";

/**
 * 入城導線で使うチャンネルは2種類ある。
 *
 * - `channel:entry_guide` … **利用者に見せる案内の場所**
 *   （入城案内パネル・参加時DMの案内先・DMが届かなかったときの掲示先）
 * - `channel:entry_ops`  … **運用が流れる場所**
 *   （説明会の30分前/5分前のお知らせ・「時間外・個別希望」の非公開スレッド）
 *
 * 元は1つの設定で兼ねていたが、案内の掲示先を変えると説明会のお知らせや
 * 時間外希望のスレッドまで一緒に移ってしまう。**見せる場所と、運用が動く場所は
 * 別の判断で決めたい**ので、キーを分けた。
 */
export const ENTRY_OPS_KEY = "channel:entry_ops";
export const ENTRY_GUIDE_KEY = "channel:entry_guide";

/**
 * 運用側のチャンネル。**未設定なら従来どおり案内側へ落とす。**
 *
 * 分離を入れただけで投稿先が変わると、deploy しただけで説明会のお知らせが
 * 別のチャンネルへ飛ぶ。運営が `channel:entry_ops` を入れた時点で移る。
 */
export function entryOpsChannelId(services: Pick<Services, "settings">): string | undefined {
  return services.settings.getString(ENTRY_OPS_KEY) ?? services.settings.getString(ENTRY_GUIDE_KEY);
}

/** 案内側のチャンネル（パネル・DMの案内先） */
export function entryGuideChannelId(services: Pick<Services, "settings">): string | undefined {
  return services.settings.getString(ENTRY_GUIDE_KEY);
}
