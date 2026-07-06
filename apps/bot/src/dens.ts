import { ChannelType, type Client, type VoiceChannel, type VoiceState } from "discord.js";
import type { Services } from "./services.js";

/**
 * 冥獣の巣（評価VC）。トリガーVCに入ると複製VCを建てて中へ移す。
 * - 巣穴大: 全員・報酬対象
 * - 巣穴中/小: 魔剣士・審のみ・報酬対象
 * - 応接室: 魔剣士・審のみ・2人まで・報酬対象外（ツーショ評価）
 * 複製VC（報酬対象のもの）は生成時に vc_whitelist_den へ自動登録するので、動的に生まれた
 * 巣穴でも VC浮上報酬(Land)が付く。空になったら自動撤収、報酬登録は2日後に掃除。
 */
interface DenSpec {
  settingKey: string; // トリガーVCの設定キー
  name: string; // 複製VCの名前
  evaluatorOnly: boolean; // 魔剣士/審のみ
  reward: boolean; // 報酬対象にするか
  userLimit?: number; // 定員
}
const DENS: Record<string, DenSpec> = {
  large: { settingKey: "vc:den_large", name: "巣穴大", evaluatorOnly: false, reward: true },
  medium: { settingKey: "vc:den_medium", name: "巣穴中", evaluatorOnly: true, reward: true },
  small: { settingKey: "vc:den_small", name: "巣穴小", evaluatorOnly: true, reward: true },
  reception: { settingKey: "vc:den_reception", name: "応接室", evaluatorOnly: true, reward: false, userLimit: 2 },
};

const DEN_GRACE_S = 120; // 生成直後・一瞬の無人での誤削除を避ける猶予
const DEN_WHITELIST_KEEP_S = 2 * 86_400; // 前日分の報酬計算まで報酬対象に残す

function triggerKind(services: Services, channelId: string): keyof typeof DENS | null {
  for (const [kind, spec] of Object.entries(DENS)) {
    if (channelId === services.settings.getString(spec.settingKey)) return kind;
  }
  return null;
}

function isEvaluator(state: VoiceState, services: Services): boolean {
  const sword = services.settings.getString("role:swordsman");
  const shin = services.settings.getString("role:shin");
  const roles = state.member?.roles.cache;
  return !!((sword && roles?.has(sword)) || (shin && roles?.has(shin)));
}

/** トリガーVCへの入室を検知して複製VCを建てる */
export async function handleDenVoice(oldState: VoiceState, newState: VoiceState, services: Services): Promise<void> {
  const member = newState.member;
  if (!member || member.user.bot) return;
  const joined = newState.channelId;
  if (!joined || joined === oldState.channelId) return;

  const kind = triggerKind(services, joined);
  if (!kind) return;
  const spec = DENS[kind]!;

  if (spec.evaluatorOnly && !isEvaluator(newState, services)) {
    await member.voice.disconnect().catch(() => undefined);
    await member.send(`「${spec.name}」は魔剣士・審のみが建てられます。巣穴大からどうぞ。`).catch(() => undefined);
    return;
  }

  const guild = newState.guild;
  const catId = services.settings.getString("category:eval_den");
  const parent = catId ? await guild.channels.fetch(catId).catch(() => null) : null;
  // 定員は親元（トリガー）VCの人数制限を反映（未設定なら spec の既定＝応接室2人など）
  const trigger = newState.channel;
  const userLimit = trigger?.userLimit || spec.userLimit;
  const clone = await guild.channels
    .create({
      name: spec.name,
      type: ChannelType.GuildVoice,
      parent: parent?.type === ChannelType.GuildCategory ? parent.id : undefined,
      userLimit,
    })
    .catch((e) => {
      console.error("[den] 複製VC作成失敗:", e);
      return null;
    });
  if (!clone) return;

  // 権限をカテゴリに同期（作成直後は上書きが空でカテゴリ設定が効かないため）
  if (clone.parentId) await clone.lockPermissions().catch((e) => console.error("[den] 権限同期失敗:", e));

  await member.voice.setChannel(clone as VoiceChannel).catch(() => undefined);
  registerDen(services, clone.id, kind, spec.reward);
}

function registerDen(services: Services, channelId: string, kind: string, reward: boolean): void {
  services.db
    .prepare("INSERT INTO den_vcs (channel_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO NOTHING")
    .run(channelId, kind, Math.floor(Date.now() / 1000));
  if (reward) {
    const list = services.settings.getJson<string[]>("vc_whitelist_den", []);
    if (!list.includes(channelId)) services.settings.set("vc_whitelist_den", [...list, channelId], "system:den");
  }
}

/** 空の複製VCを削除し、古い報酬対象登録を掃除する（刻時盤から毎分呼ぶ） */
export async function scanDens(client: Client, services: Services): Promise<void> {
  const rows = services.db.prepare("SELECT channel_id, created_at FROM den_vcs").all() as Array<{ channel_id: string; created_at: number }>;
  if (rows.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const denWl = new Set(services.settings.getJson<string[]>("vc_whitelist_den", []));
  let wlChanged = false;

  for (const row of rows) {
    const ch = (await client.channels.fetch(row.channel_id).catch(() => null)) as VoiceChannel | null;
    const humans = ch ? ch.members.filter((m) => !m.user.bot).size : 0;

    if (ch && humans === 0 && now - row.created_at > DEN_GRACE_S) {
      await ch.delete("冥獣の巣: 無人のため撤収").catch((e) => console.error(`[den] 撤収失敗 ${row.channel_id}:`, e));
    }
    // 報酬対象からの掃除は前日分の計算後（2日）に。VC自体が消えていても登録は残して報酬を保証
    if (now - row.created_at > DEN_WHITELIST_KEEP_S) {
      services.db.prepare("DELETE FROM den_vcs WHERE channel_id = ?").run(row.channel_id);
      if (denWl.delete(row.channel_id)) wlChanged = true;
    }
  }
  if (wlChanged) services.settings.set("vc_whitelist_den", [...denWl], "system:den");
}
