import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const BRANCH = "agent/toto-voice-received-close";

function replaceOnce(text: string, oldValue: string, newValue: string, label: string): string {
  const first = text.indexOf(oldValue);
  const last = text.lastIndexOf(oldValue);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match`);
  }
  return text.replace(oldValue, newValue);
}

function run(command: string): void {
  execSync(command, { stdio: "inherit", env: process.env });
}

if (process.env.GITHUB_ACTIONS !== "true") {
  console.log("Toto patch runner: GitHub Actions外のため何もしません。");
  process.exit(0);
}

run(`git fetch origin main ${BRANCH}`);
run(`git checkout -B ${BRANCH} origin/${BRANCH}`);

const corePath = "packages/core/src/confession/service.ts";
let core = readFileSync(corePath, "utf8");
core = replaceOnce(
  core,
  '/** クローズ理由（Phase 2 §4）。info_only は旧「対応先=記録のみ」を移行した終了理由 */',
  '/** クローズ理由（Phase 2 §4）。voice_received は返信不要案件向けの受領確認終了 */',
  "core close reason comment",
);
core = replaceOnce(
  core,
  '  | "info_only"\n  | "no_action"',
  '  | "info_only"\n  | "voice_received"\n  | "no_action"',
  "core CloseReason union",
);
writeFileSync(corePath, core, "utf8");

const botPath = "apps/bot/src/commands/confession.ts";
let bot = readFileSync(botPath, "utf8");
bot = replaceOnce(
  bot,
  '  info_only: "情報提供として記録した",\n  no_action: "対応不要と判断した",',
  '  info_only: "情報提供として記録した",\n  voice_received: "あなたの声は届きました",\n  no_action: "対応不要と判断した",',
  "CLOSE_META voice_received",
);
bot = replaceOnce(
  bot,
  '        "運営から返信がある場合は、トートがあなたの DM へ匿名で届けます。",',
  '        "冥教会から返信がある場合は、トートがあなたの DM へ匿名で届けます。",',
  "panel reply copy",
);
bot = replaceOnce(
  bot,
  '.setPlaceholder("② 運営からの返信を希望する？")',
  '.setPlaceholder("② 冥教会からの返信を希望する？")',
  "reply wish placeholder",
);
bot = replaceOnce(
  bot,
  `  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(\`mimi:emg:\${id}\`).setLabel("緊急共有").setEmoji("🚨").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(\`mimi:close:\${id}\`).setLabel("クローズ").setEmoji("🔒").setStyle(ButtonStyle.Danger),
  );`,
  `  const row2Buttons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(\`mimi:emg:\${id}\`).setLabel("緊急共有").setEmoji("🚨").setStyle(ButtonStyle.Danger),
  ];
  if (row.reply_wish === "no") {
    row2Buttons.push(
      new ButtonBuilder()
        .setCustomId(\`mimi:voice_received:\${id}\`)
        .setLabel("あなたの声は届きました")
        .setEmoji("🕯️")
        .setStyle(ButtonStyle.Success),
    );
  }
  row2Buttons.push(
    new ButtonBuilder().setCustomId(\`mimi:close:\${id}\`).setLabel("クローズ").setEmoji("🔒").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...row2Buttons);`,
  "reply-wish management button",
);
bot = replaceOnce(
  bot,
  `    case "close":
      await opGuarded(() => interaction.reply({ ...closeSelectMsg(id), flags: MessageFlags.Ephemeral }));
      return;
    case "reopen":`,
  `    case "close":
      await opGuarded(() => interaction.reply({ ...closeSelectMsg(id), flags: MessageFlags.Ephemeral }));
      return;
    case "voice_received":
      await opGuarded(() => closeAsVoiceReceived(interaction, services, id));
      return;
    case "reopen":`,
  "voice_received button handler",
);
bot = replaceOnce(
  bot,
  '      content: "🕯 あなたの声は、トートの耳に届いた。運営から返信があれば、この DM にそっと届く。",',
  '      content: "🕯 あなたの声は、トートの耳に届いた。冥教会から返信があれば、この DM にそっと届く。",',
  "submission acknowledgement copy",
);
bot = replaceOnce(
  bot,
  '.setAuthor({ name: `👂 トートの耳 #${row.id} — 運営より` })',
  '.setAuthor({ name: `👂 トートの耳 #${row.id} — 冥教会より` })',
  "relay author copy",
);

const helper = `
/** 返信不要の案件へ、受領を伝えて静かに閉じる専用クローズ */
async function closeAsVoiceReceived(
  interaction: ButtonInteraction,
  services: Services,
  id: number,
): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.reply({ content: "この件が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.reply_wish !== "no") {
    await interaction.reply({
      content: "「あなたの声は届きました」は、返信不要を選んだ案件でのみ利用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const retentionDays =
    row.court_status === "sent"
      ? services.settings.getNumber("confession_court_retention_days")
      : services.settings.getNumber("confession_body_retention_days");
  services.confessions.close(id, interaction.user.id, "voice_received", retentionDays);

  const openEmg = services.confessions.openEmergencyFor(id);
  if (openEmg) services.confessions.closeEmergency(openEmg.id, interaction.user.id);

  const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
  await user
    ?.send(
      [
        "# 🕯️ トートの耳",
        "",
        "あなたの声は、たしかに届きました。",
        "",
        "返信は不要とのことでしたので、この件はここでそっと閉じます。",
        "",
        "伝えてくれて、ありがとう。",
      ].join("\\n"),
    )
    .catch(() => undefined);

  await threadLog(interaction.client, services, id, \`🕯️ <@\${interaction.user.id}> が「あなたの声は届きました」でクローズしました。\`);
  await refreshPanel(interaction.client, services, id);
  await interaction.editReply({ content: "🕯️ 投稿者へ「あなたの声は届きました」と伝えてクローズしました。" });

  const thread = row.thread_id ? await interaction.client.channels.fetch(row.thread_id).catch(() => null) : null;
  if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
}

`;
bot = replaceOnce(
  bot,
  "/** 再オープン（§17 再オープン）。誤クローズや相談再開に使う */",
  `${helper}/** 再オープン（§17 再オープン）。誤クローズや相談再開に使う */`,
  "voice_received close helper",
);
writeFileSync(botPath, bot, "utf8");

writeFileSync(
  "packages/core/tests/confession-voice-received.test.ts",
  `import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Confessions } from "../src/confession/service.js";

describe("トートの耳・受領確認クローズ", () => {
  it("voice_received を正式な終了理由として保存できる", () => {
    const db = openDb(":memory:");
    const confessions = new Confessions(db, new EventLog(db));
    const row = confessions.create("poster", {
      type: "iken",
      replyWish: "no",
      body: "返信は不要ですが、伝えておきたいことです。",
    });

    const closed = confessions.close(row.id, "staff", "voice_received", 7);

    expect(closed?.status).toBe("closed");
    expect(closed?.close_reason).toBe("voice_received");
    expect(closed?.closed_by).toBe("staff");
    expect(closed?.body_purge_at).not.toBeNull();
    db.close();
  });
});
`,
  "utf8",
);

writeFileSync(
  "apps/bot/tests/confession-voice-received.test.ts",
  `import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/commands/confession.ts");
const source = readFileSync(sourcePath, "utf8");

describe("トートの耳・返信不要案件の表示と専用クローズ", () => {
  it("返信元の利用者向け表記を冥教会へ統一する", () => {
    expect(source).toContain('setPlaceholder("② 冥教会からの返信を希望する？")');
    expect(source).not.toContain('setPlaceholder("② 運営からの返信を希望する？")');
    expect(source).toContain("冥教会から返信がある場合は");
    expect(source).toContain("冥教会から返信があれば");
    expect(source).toContain("— 冥教会より");
  });

  it("返信不要案件だけに受領確認クローズを用意する", () => {
    expect(source).toContain('row.reply_wish === "no"');
    expect(source).toContain("mimi:voice_received:\${id}");
    expect(source).toContain('services.confessions.close(id, interaction.user.id, "voice_received", retentionDays)');
    expect(source).toContain("あなたの声は、たしかに届きました。");
    expect(source).toContain("返信は不要とのことでしたので、この件はここでそっと閉じます。");
  });
});
`,
  "utf8",
);

run("git fetch origin main");
run("git checkout origin/main -- .github/workflows/ci.yml apps/bot/package.json");
if (existsSync(".github/workflows/apply-toto-voice-received.yml")) {
  rmSync(".github/workflows/apply-toto-voice-received.yml");
}
rmSync("apps/bot/tests/apply-toto-patch.ts");

run('git config user.name "github-actions[bot]"');
run('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
run("git add -A");
run('git commit -m "Improve Toto no-reply closure"');
run(`git push origin HEAD:${BRANCH}`);

// child_process importが未使用扱いにならないよう、実行環境の存在確認にも使う
execFileSync("git", ["status", "--short"], { stdio: "inherit" });
