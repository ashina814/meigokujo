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
export class InviteTracker {
  private uses = new Map<string, number>(); // code -> uses
  private inviterOf = new Map<string, string>(); // code -> inviter user id

  constructor(private readonly client: Client) {}

  wire(): void {
    this.client.on(Events.InviteCreate, (invite) => this.rememberInvite(invite));
    this.client.on(Events.InviteDelete, (invite) => {
      this.uses.delete(invite.code);
      this.inviterOf.delete(invite.code);
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
  }

  /** 参加後に呼ぶ: 使われた招待コードを特定し、招待者IDを返す（不明なら null） */
  async detectInviter(guild: Guild): Promise<string | null> {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return null;
    let matched: string | null = null;
    for (const inv of invites.values()) {
      const before = this.uses.get(inv.code) ?? 0;
      const now = inv.uses ?? 0;
      if (now > before && matched === null) matched = this.inviterOf.get(inv.code) ?? inv.inviter?.id ?? null;
      // キャッシュを更新
      this.uses.set(inv.code, now);
      if (inv.inviter?.id) this.inviterOf.set(inv.code, inv.inviter.id);
    }
    return matched;
  }
}
