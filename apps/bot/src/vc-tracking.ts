import type { VoiceState } from "discord.js";
import type { Services } from "./services.js";

/**
 * VC計測（計測は全VC・支給はホワイトリストのみ、の計測側）。
 * 入退室・チャンネル移動・ミュート/デフン変化のたびにセグメントを切り替える。
 */
export function trackVoiceState(oldState: VoiceState, newState: VoiceState, services: Services): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;
  const userId = member.id;

  const before = oldState.channelId;
  const after = newState.channelId;
  const muteChanged =
    oldState.selfMute !== newState.selfMute || oldState.selfDeaf !== newState.selfDeaf;

  if (!after) {
    // 退出
    if (before) services.vc.close(userId);
    return;
  }
  if (before !== after || muteChanged) {
    // 入室・移動・状態変化 → セグメント切替（open が既存を閉じる）
    services.vc.open(userId, after, newState.selfMute ?? false, newState.selfDeaf ?? false);
  }
}
