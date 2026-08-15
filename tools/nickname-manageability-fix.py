from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} matches, found {count}")
    p.write_text(text.replace(old, new))


# 1) Discord.js の manageability + ManageNicknames を課金前判定の正本にする。
replace_exact(
    "apps/bot/src/shop-delivery.ts",
    'import type { Guild, GuildMember, Role } from "discord.js";\n',
    'import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";\n',
)

replace_exact(
    "apps/bot/src/shop-delivery.ts",
    '''export function nicknameBlockReason(\n  guild: Pick<Guild, "ownerId"> & { members: { me: GuildMember | null } },\n  member: Pick<GuildMember, "id"> & { roles: { highest: { position: number } } },\n): { reason: string; message: string } | null {\n  if (guild.ownerId === member.id) {\n    return {\n      reason: "target_is_owner",\n      message: "サーバー所有者のニックネームはBotから変更できません。お手数ですがご自身で変更してください。",\n    };\n  }\n  const me = guild.members.me;\n  if (!me) return { reason: "bot_member_unavailable", message: "Bot自身の情報が取れないため変更できません。" };\n  if (me.roles.highest.position <= member.roles.highest.position) {\n    return {\n      reason: "role_hierarchy",\n      message: "あなたのロールがBotより上位のため、Botからは変更できません。運営にご相談ください。",\n    };\n  }\n  return null;\n}\n''',
    '''export function nicknameBlockReason(\n  guild: Pick<Guild, "ownerId"> & { members: { me: GuildMember | null } },\n  member: Pick<GuildMember, "id" | "manageable">,\n): { reason: string; message: string } | null {\n  if (guild.ownerId === member.id) {\n    return {\n      reason: "target_is_owner",\n      message: "サーバー所有者のニックネームはBotから変更できません。お手数ですがご自身で変更してください。",\n    };\n  }\n  const me = guild.members.me;\n  if (!me) return { reason: "bot_member_unavailable", message: "Bot自身の情報が取れないため変更できません。" };\n  if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) {\n    return {\n      reason: "missing_manage_nicknames",\n      message: "Botに「ニックネームの管理」権限がないため、現在は名前を変更できません。運営にご相談ください。",\n    };\n  }\n  // Discord.js が owner / bot自身 / ロール順序まで含めて算出する manageability を正本にする。\n  // 独自の position 数値比較を重ねると、ライブラリ側の判定と二重管理になる。\n  if (!member.manageable) {\n    return {\n      reason: "role_hierarchy",\n      message: "Discord上のロール階層によりBotから管理できないため、名前を変更できません。運営にご相談ください。",\n    };\n  }\n  return null;\n}\n''',
)

# 2) setNickname の実API失敗を、既存の収束/返金挙動を変えず追跡可能にする。
replace_exact(
    "apps/bot/src/shop-delivery.ts",
    '''      const setError = await member\n        .setNickname(wanted, "公式ショップ: 名前変更")\n        .then(() => null)\n        .catch((e: Error) => e.message || "unknown");\n''',
    '''      const setError = await member\n        .setNickname(wanted, "公式ショップ: 名前変更")\n        .then(() => null)\n        .catch((e: unknown) => {\n          const message = e instanceof Error ? e.message || "unknown" : String(e);\n          const code =\n            typeof e === "object" && e !== null && "code" in e\n              ? String((e as { code?: unknown }).code ?? "") || null\n              : null;\n          const me = guild.members.me;\n          try {\n            services.events.log("shop_nickname_set_failed", {\n              actor,\n              target: userId,\n              payload: {\n                purchaseId: purchase.id,\n                error: message,\n                code,\n                memberManageable: member.manageable,\n                botHasManageNicknames: me?.permissions.has(PermissionFlagsBits.ManageNicknames) ?? false,\n                botHighestRoleId: me?.roles.highest.id ?? null,\n                botHighestRolePosition: me?.roles.highest.position ?? null,\n                memberHighestRoleId: member.roles.highest.id,\n                memberHighestRolePosition: member.roles.highest.position,\n              },\n            });\n          } catch {\n            // 診断ログの失敗で既存の返金・収束経路を壊さない。\n          }\n          return message;\n        });\n''',
)

# 3) 課金前に止めた理由も永続イベントへ残す。業務ロール名は見ない。
replace_exact(
    "apps/bot/src/commands/shop-panel.ts",
    '''function nicknamePreflight(\n  interaction: ButtonInteraction | ModalSubmitInteraction,\n): { ok: true; member: GuildMember } | { ok: false; message: string } {\n  const guild = interaction.guild;\n  const member = interaction.member as GuildMember | null;\n  if (!guild || !member) return { ok: false, message: "サーバー内で実行してください。" };\n  const blocked = nicknameBlockReason(guild, member);\n  return blocked ? { ok: false, message: blocked.message } : { ok: true, member };\n}\n''',
    '''function nicknamePreflight(\n  interaction: ButtonInteraction | ModalSubmitInteraction,\n  services: Services,\n): { ok: true; member: GuildMember } | { ok: false; message: string } {\n  const guild = interaction.guild;\n  const member = interaction.member as GuildMember | null;\n  if (!guild || !member) return { ok: false, message: "サーバー内で実行してください。" };\n  const blocked = nicknameBlockReason(guild, member);\n  if (!blocked) return { ok: true, member };\n\n  const me = guild.members.me;\n  try {\n    services.events.log("shop_nickname_preflight_blocked", {\n      actor: `user:${interaction.user.id}`,\n      target: member.id,\n      payload: {\n        reason: blocked.reason,\n        guildId: guild.id,\n        memberManageable: blocked.reason === "bot_member_unavailable" ? null : member.manageable,\n        botHighestRoleId: me?.roles.highest.id ?? null,\n        botHighestRolePosition: me?.roles.highest.position ?? null,\n        memberHighestRoleId: member.roles.highest.id,\n        memberHighestRolePosition: member.roles.highest.position,\n      },\n    });\n  } catch {\n    // 診断ログの失敗で購入前ガード自体を壊さない。\n  }\n  return { ok: false, message: blocked.message };\n}\n''',
)

p = Path("apps/bot/src/commands/shop-panel.ts")
text = p.read_text()
call = "nicknamePreflight(interaction)"
count = text.count(call)
if count != 3:
    raise SystemExit(f"shop-panel.ts: expected 3 nicknamePreflight calls, found {count}")
p.write_text(text.replace(call, "nicknamePreflight(interaction, services)"))

# 4) Regression tests: permission, manageable contract, multiple lower roles, rank-at-least separation.
replace_exact(
    "apps/bot/tests/shop-nickname.test.ts",
    'import type { Services } from "../src/services.js";\n',
    'import type { Services } from "../src/services.js";\nimport { meetsRoleRequirement } from "../src/rank-requirement.js";\n',
)

replace_exact(
    "apps/bot/tests/shop-nickname.test.ts",
    ' * - **課金前に分かる不可**（サーバー所有者・Botより上位ロール）は無課金で止める\n',
    ' * - **課金前に分かる不可**（所有者・Bot権限不足・Discord manageability不可）は無課金で止める\n',
)

replace_exact(
    "apps/bot/tests/shop-nickname.test.ts",
    '''    myPosition?: number;\n    theirPosition?: number;\n    setFails?: string;\n''',
    '''    myPosition?: number;\n    theirPosition?: number;\n    /** Discord.js GuildMember.manageable の判定。未指定なら旧テスト互換でpositionから算出 */\n    manageable?: boolean;\n    /** Botが ManageNicknames を持つか。Administrator相当を含む has() の結果 */\n    botCanManageNicknames?: boolean;\n    /** 対象が持つ複数ロール。業務ロール名に依存しない回帰用 */\n    roleIds?: string[];\n    setFails?: string;\n''',
)

replace_exact(
    "apps/bot/tests/shop-nickname.test.ts",
    '''    roles: { cache: new Collection(), highest: { position: opts.theirPosition ?? 10 } },\n    setNickname: vi.fn(async (name: string) => {\n''',
    '''    roles: {\n      cache: new Collection((opts.roleIds ?? []).map((id) => [id, true])),\n      highest: { id: "target-highest", position: opts.theirPosition ?? 10 },\n    },\n    get manageable() {\n      return opts.manageable ?? (!opts.owner && (opts.myPosition ?? 100) > (opts.theirPosition ?? 10));\n    },\n    setNickname: vi.fn(async (name: string) => {\n''',
)

replace_exact(
    "apps/bot/tests/shop-nickname.test.ts",
    '''    members: {\n      me: { roles: { highest: { position: opts.myPosition ?? 100 } } },\n      fetch: vi.fn(async () => member),\n    },\n''',
    '''    members: {\n      me: {\n        id: "bot",\n        permissions: { has: vi.fn(() => opts.botCanManageNicknames ?? true) },\n        roles: { highest: { id: "bot-highest", position: opts.myPosition ?? 100 } },\n      },\n      fetch: vi.fn(async () => member),\n    },\n''',
)

owner_test = '''  it("サーバー所有者は無課金で止まり、自分で変えるよう案内する", async () => {\n    const { handleShopButton } = await shopPanelModule;\n    const ctx = setup();\n    const w = world({ owner: true });\n    const interaction = pressInteraction(ctx, `shop:nick:${ctx.item.id}`, w) as unknown as {\n      reply: ReturnType<typeof vi.fn>;\n      showModal: ReturnType<typeof vi.fn>;\n    };\n    const before = balance(ctx);\n\n    await handleShopButton(interaction as never, ctx.services);\n\n    expect(contentOf(interaction.reply)).toContain("ご自身で変更");\n    expect(interaction.showModal).not.toHaveBeenCalled();\n    expect(balance(ctx)).toBe(before);\n    ctx.db.close();\n  });\n'''
owner_plus = owner_test + '''\n  it("BotにManage Nicknames権限がなければ課金前に止める", async () => {\n    const { handleShopButton } = await shopPanelModule;\n    const ctx = setup();\n    const w = world({ botCanManageNicknames: false, manageable: true });\n    const interaction = pressInteraction(ctx, `shop:nick:${ctx.item.id}`, w) as unknown as {\n      reply: ReturnType<typeof vi.fn>;\n      showModal: ReturnType<typeof vi.fn>;\n    };\n    const before = balance(ctx);\n\n    await handleShopButton(interaction as never, ctx.services);\n\n    expect(contentOf(interaction.reply)).toContain("ニックネームの管理");\n    expect(interaction.showModal).not.toHaveBeenCalled();\n    expect(balance(ctx)).toBe(before);\n    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);\n    expect(ctx.events.listByType("shop_nickname_preflight_blocked")[0]?.payload).toContain("missing_manage_nicknames");\n    ctx.db.close();\n  });\n\n  it("Discord.js manageable=falseなら自前position値が下位でも課金前に止める", async () => {\n    const { handleShopButton } = await shopPanelModule;\n    const ctx = setup();\n    const w = world({ myPosition: 100, theirPosition: 10, manageable: false });\n    const interaction = pressInteraction(ctx, `shop:nick:${ctx.item.id}`, w) as unknown as {\n      reply: ReturnType<typeof vi.fn>;\n      showModal: ReturnType<typeof vi.fn>;\n    };\n\n    await handleShopButton(interaction as never, ctx.services);\n\n    expect(contentOf(interaction.reply)).toContain("ロール階層");\n    expect(interaction.showModal).not.toHaveBeenCalled();\n    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);\n    ctx.db.close();\n  });\n\n  it("Discord.js manageable=trueなら独自position比較で上書きしない", async () => {\n    const { handleShopButton } = await shopPanelModule;\n    const ctx = setup();\n    // contract test: manageabilityを正本にし、positionの二重判定を復活させない。\n    const w = world({ myPosition: 5, theirPosition: 50, manageable: true });\n    const interaction = pressInteraction(ctx, `shop:nick:${ctx.item.id}`, w) as unknown as {\n      reply: ReturnType<typeof vi.fn>;\n      showModal: ReturnType<typeof vi.fn>;\n    };\n\n    await handleShopButton(interaction as never, ctx.services);\n\n    expect(interaction.showModal).toHaveBeenCalledTimes(1);\n    expect(interaction.reply).not.toHaveBeenCalled();\n    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);\n    ctx.db.close();\n  });\n'''
replace_exact("apps/bot/tests/shop-nickname.test.ts", owner_test, owner_plus)

normal_anchor = '''describe("通常の流れ", () => {\n  it("入力 → 確認 → 変更する で完了する", async () => {\n'''
normal_plus = '''describe("通常の流れ", () => {\n  it("魔人 + 別業務ロールでも亡霊以上の購入資格を満たす（manageabilityとは別判定）", () => {\n    const ctx = setup();\n    ctx.settings.set("role:ghost", "role-ghost", "test");\n    ctx.settings.set("role:majin", "role-majin", "test");\n    ctx.settings.set("role:kenma", "role-kenma", "test");\n    ctx.settings.set("role:mazoku", "role-mazoku", "test");\n\n    expect(meetsRoleRequirement(ctx.settings, ["role-majin", "role-shop-manager"], "role-ghost")).toBe(true);\n    ctx.db.close();\n  });\n\n  it("Botより下位の複数ロールを持つユーザーは正常に変更できる", async () => {\n    const { handleShopButton } = await shopPanelModule;\n    const ctx = setup();\n    const w = world({\n      nickname: "まえ",\n      myPosition: 100,\n      theirPosition: 40,\n      manageable: true,\n      roleIds: ["role-majin", "role-shop-manager", "role-extra"],\n    });\n\n    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "multi-role", "あたらしい"), w), ctx.services);\n\n    expect(w.state.nickname).toBe("あたらしい");\n    expect(w.member.setNickname).toHaveBeenCalledTimes(1);\n    expect(balance(ctx)).toBe(1_000_000 - PRICE);\n    expect(ctx.shop.listUserPurchases(USER)[0]?.delivery_state).toBe("delivered");\n    ctx.db.close();\n  });\n\n  it("入力 → 確認 → 変更する で完了する", async () => {\n'''
replace_exact("apps/bot/tests/shop-nickname.test.ts", normal_anchor, normal_plus)

# Existing Missing Permissions regression should remain and now produce a diagnosable API-failure event.
missing_anchor = '''    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);\n    // 「処理失敗」には出ない（自分で収束したので人の出番が無い）\n'''
missing_plus = '''    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);\n    expect(ctx.events.listByType("shop_nickname_set_failed")).toHaveLength(1);\n    // 「処理失敗」には出ない（自分で収束したので人の出番が無い）\n'''
replace_exact("apps/bot/tests/shop-nickname.test.ts", missing_anchor, missing_plus, expected=1)

print("nickname manageability fix applied")
