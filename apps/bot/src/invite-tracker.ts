import type { Client, Guild, Invite } from "discord.js";
import { Events } from "discord.js";

/**
 * 招待リンクの使用回数キャッシュ。
 * メンバー参加時に「どの招待コードが使われたか」を検出し、そのコード作成者を招待者とみなす。
 *
 * 動作原理:
 *  - Bot 起動時に全招待の uses をキャッシュ
 *  - inviteCreate/inviteDelete で追随
 *  - GuildMemberAdd 時に再度 fetch → uses が増えたコードが使われた招待
 *  - 検出できない場合（Vanity URL 経由・キャッシュずれ）は null を返す
 */
export interface InviteDetection {
  code: string;
  url: string;
  uses: number;
  channelId: string | null;
  inviterId: string | null;
}

export class InviteTracker {
  private uses = new Map<string, number>(); // code -> uses
  private inviterOf = new Map<string, string>(); // code -> inviter user id
  private channelOf = new Map<string, string>(); // code -> channel id

  constructor(private readonly client: Client) {}

  wire(): void {
    this.client.on(Events.InviteCreate, (invite) => this.rememberInvite(invite));
    this.client.on(Events.InviteDelete, (invite) => {
      this.uses.delete(invite.code);
      this.inviterOf.delete(invite.code);
      this.channelOf.delete(invite.code);
    });
  }

  async initGuild(guild: Guild): Promise<void> {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return;
    for (const inv of invites.values()) this.rememberInvite(inv);
  }

  private rememberInvite(inv: Invite): void {
    this.uses.set(inv.code, inv.uses ?? 0);
    if (inv.inviter?.id) this.inviterOf.set(inv.code, inv.inviter.id);
    if (inv.channel?.id) this.channelOf.set(inv.code, inv.channel.id);
  }

  /** 参加後に呼ぶ: 使われた招待コードの詳細を返す（不明なら null） */
  async detectInvite(guild: Guild): Promise<InviteDetection | null> {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return null;
    let matched: InviteDetection | null = null;
    for (const inv of invites.values()) {
      const before = this.uses.get(inv.code) ?? 0;
      const now = inv.uses ?? 0;
      if (now > before && matched === null) {
        matched = {
          code: inv.code,
          url: `https://discord.gg/${inv.code}`,
          uses: now,
          channelId: inv.channel?.id ?? this.channelOf.get(inv.code) ?? null,
          inviterId: inv.inviter?.id ?? this.inviterOf.get(inv.code) ?? null,
        };
      }
      // キャッシュを更新
      this.uses.set(inv.code, now);
      if (inv.inviter?.id) this.inviterOf.set(inv.code, inv.inviter.id);
      if (inv.channel?.id) this.channelOf.set(inv.code, inv.channel.id);
    }
    return matched;
  }

  /** 後方互換: inviter ID だけ返す旧API */
  async detectInviter(guild: Guild): Promise<string | null> {
    const d = await this.detectInvite(guild);
    return d?.inviterId ?? null;
  }
}
