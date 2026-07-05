import { ChannelType, type Client, type VoiceChannel, type VoiceState } from "discord.js";
import type { Services } from "./services.js";

/**
 * 冥獣の巣（評価VC）。トリガーVCに入ると複製VCを建てて中へ移す。
 * 巣穴大は全員、巣穴中/小は魔剣士・審のみ（ボット検出でゲート）。
 * 複製VCは生成時に報酬対象(vc_whitelist_den)へ自動登録するので、動的に生まれた巣穴でも
 * VC浮上報酬(Land)が付く。空になったら自動削除、報酬対象の掃除は2日後に行う。
 */
const KIND_LABEL = { large: "大", medium: "中", small: "小" } as const;
type DenKind = keyof typeof KIND_LABEL;
const DEN_GRACE_S = 120; // 生成直後・一瞬の無人での誤削除を避ける猶予
const DEN_WHITELIST_KEEP_S = 2 * 86_400; // 前日分の報酬計算まで報酬対象に残す

function triggerKind(services: Services, channelId: string): DenKind | null {
  if (channelId === services.settings.getString("vc:den_large")) return "large";
  if (channelId === services.settings.getString("vc:den_medium")) return "medium";
  if (channelId === services.settings.getString("vc:den_small")) return "small";
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

  // 巣穴中/小は魔剣士・審のみ
  if (kind !== "large" && !isEvaluator(newState, services)) {
    await member.voice.disconnect().catch(() => undefined);
    await member.send(`「巣穴${KIND_LABEL[kind]}」は魔剣士・審のみが建てられます。巣穴大からどうぞ。`).catch(() => undefined);
    return;
  }

  const guild = newState.guild;
  const catId = services.settings.getString("category:eval_den");
  const parent = catId ? await guild.channels.fetch(catId).catch(() => null) : null;
  const clone = await guild.channels
    .create({
      name: `巣穴${KIND_LABEL[kind]}`,
      type: ChannelType.GuildVoice,
      parent: parent?.type === ChannelType.GuildCategory ? parent.id : undefined,
    })
    .catch((e) => {
      console.error("[den] 複製VC作成失敗:", e);
      return null;
    });
  if (!clone) return;

  await member.voice.setChannel(clone as VoiceChannel).catch(() => undefined);
  registerDen(services, clone.id, kind);
}

function registerDen(services: Services, channelId: string, kind: DenKind): void {
  services.db
    .prepare("INSERT INTO den_vcs (channel_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO NOTHING")
    .run(channelId, kind, Math.floor(Date.now() / 1000));
  const list = services.settings.getJson<string[]>("vc_whitelist_den", []);
  if (!list.includes(channelId)) services.settings.set("vc_whitelist_den", [...list, channelId], "system:den");
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
      await ch.delete("冥獣の巣: 無人のため撤収").catch(() => undefined);
    }
    // 報酬対象からの掃除は前日分の計算後（2日）に。VC自体が消えていても登録は残して報酬を保証
    if (now - row.created_at > DEN_WHITELIST_KEEP_S) {
      services.db.prepare("DELETE FROM den_vcs WHERE channel_id = ?").run(row.channel_id);
      if (denWl.delete(row.channel_id)) wlChanged = true;
    }
  }
  if (wlChanged) services.settings.set("vc_whitelist_den", [...denWl], "system:den");
}
