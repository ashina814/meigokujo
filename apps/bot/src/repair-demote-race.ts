/**
 * 一時的な修復スクリプト。
 * 迷霊落ち・魔人昇格のロールrace（fix/demote-role-race）で
 *   1) souls.status が 'meirei' / 'majin' から 'waiting' に上書きされた
 *   2) queue_wait ロールが誤って付与された
 * のデータを検出して修復する。
 *
 * 使い方（VPS上・稼働中のBotとは別プロセス）:
 *   sudo -u kabu /home/kabu/.nvm/versions/node/v22.23.1/bin/node --import tsx \
 *     apps/bot/src/repair-demote-race.ts --dry-run
 *   sudo -u kabu /home/kabu/.nvm/versions/node/v22.23.1/bin/node --import tsx \
 *     apps/bot/src/repair-demote-race.ts --apply
 *
 * 修復完了後に削除する。
 */
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { buildServices } from "./services.js";

const APPLY = process.argv.includes("--apply");

interface Victim {
  userId: string;
  intended: "meirei" | "majin";
  demoteAt: number;
  resetAt: number;
}

async function main(): Promise<void> {
  const services = buildServices();
  const db = services.db;

  // race の被害者を検出（demotion or promotion → ghost_reset が 15秒以内）
  const rows = db
    .prepare(
      `SELECT DISTINCT e1.target_id AS user_id, e1.type AS kind, e1.created_at AS demote_at, e2.created_at AS reset_at
       FROM events e1
       JOIN events e2
         ON e2.target_id = e1.target_id
        AND e2.type = 'ghost_reset'
        AND e2.created_at BETWEEN e1.created_at AND e1.created_at + 15
       WHERE e1.type IN ('demotion','promotion')
       ORDER BY e1.created_at`,
    )
    .all() as Array<{ user_id: string; kind: string; demote_at: number; reset_at: number }>;

  const victims: Victim[] = rows.map((r) => ({
    userId: r.user_id,
    intended: r.kind === "demotion" ? "meirei" : "majin",
    demoteAt: r.demote_at,
    resetAt: r.reset_at,
  }));

  console.log(`race 被害候補: ${victims.length}件`);
  const needFixDb = victims.filter((v) => {
    const soul = services.entry.getSoul(v.userId);
    return soul && soul.status === "waiting"; // 現在も waiting のままなら修復対象
  });
  console.log(`  現在も waiting のまま = 要修復: ${needFixDb.length}件`);

  if (needFixDb.length > 0) {
    console.log("── DB 修復対象 ──");
    for (const v of needFixDb) {
      console.log(
        `  ${v.userId} : ${new Date(v.demoteAt * 1000).toISOString()} demote → ${v.intended} に復元`,
      );
    }
  }

  if (APPLY && needFixDb.length > 0) {
    const upd = db.prepare("UPDATE souls SET status=?, updated_at=? WHERE user_id=? AND status='waiting'");
    const ts = Math.floor(Date.now() / 1000);
    const tx = db.transaction(() => {
      for (const v of needFixDb) upd.run(v.intended, ts, v.userId);
    });
    tx();
    console.log(`✅ DB 修復完了: ${needFixDb.length}件の souls.status を復元`);
  } else if (needFixDb.length > 0) {
    console.log("（--apply 未指定のため DB は変更しません）");
  }

  // Discord のロール掃除
  const guildId = services.settings.getString("guild:main");
  const waitRoleId = services.settings.getString("role:queue_wait");
  if (!guildId || !waitRoleId) {
    console.log("guild:main または role:queue_wait 未設定のため Discord 側の掃除は skip");
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  await client.login(config.token);
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.error(`ギルド ${guildId} を取得できません`);
    await client.destroy();
    return;
  }

  const wrongRoleUsers: string[] = [];
  for (const v of victims) {
    const member = await guild.members.fetch(v.userId).catch(() => null);
    if (!member) continue;
    if (member.roles.cache.has(waitRoleId)) {
      wrongRoleUsers.push(v.userId);
      console.log(
        `  ${v.userId} : ${member.user.tag} に queue_wait 付与残留（要削除、正しい階級=${v.intended}）`,
      );
    }
  }

  console.log(`\n── queue_wait 削除対象: ${wrongRoleUsers.length}名 ──`);
  if (APPLY && wrongRoleUsers.length > 0) {
    let removed = 0;
    for (const uid of wrongRoleUsers) {
      const member = await guild.members.fetch(uid).catch(() => null);
      if (!member) continue;
      const ok = await member.roles
        .remove(waitRoleId, "repair: demote-role-race で誤付与された queue_wait を剥がす")
        .then(() => true)
        .catch((e) => {
          console.error(`  [失敗] ${uid}:`, e?.message ?? e);
          return false;
        });
      if (ok) {
        removed++;
        console.log(`  [OK] ${uid} から queue_wait を剥がしました`);
      }
    }
    console.log(`✅ Discord 側修復完了: ${removed}/${wrongRoleUsers.length}名`);
  } else if (wrongRoleUsers.length > 0) {
    console.log("（--apply 未指定のため Discord は変更しません）");
  }

  await client.destroy();
  services.db.close();
}

main().catch((e) => {
  console.error("修復に失敗:", e);
  process.exit(1);
});
