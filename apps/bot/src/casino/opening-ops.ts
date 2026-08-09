import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Client,
} from "discord.js";
import {
  CASINO_OPENING_SETTING_KEYS,
  FORMAL_OPENING_VERSION,
  LEGACY_OPENING_VERSION,
  OpeningAlreadyAppliedError,
  OpeningApplyBlockedError,
  OpeningApplyManualReviewError,
  OpeningApplyRolledBackError,
  OpeningApplyStaleplanError,
  OpeningExecutionConflictError,
  OpeningExecutionStore,
  ProductionOpeningBackupAdapter,
  readCasinoOpeningConfig,
  writeCasinoOpeningConfig,
  type CasinoOpeningConfig,
  type OpeningApplyResult,
  type OpeningBlocker,
  type OpeningExternalAdapter,
  type OpeningExternalDisableLegacyRequest,
  type OpeningExternalDisableLegacyResult,
  type OpeningPreflightResult,
} from "@meigokujo/core";
import { ChannelType, RESTJSONErrorCodes } from "discord.js";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

const OPS_PREFIX = "mgmt:casino:opening";
const CONFIRM_WORD = "FORMAL-OPENING";

export function isOpeningOpsCustomId(customId: string): boolean {
  return customId.startsWith(`${OPS_PREFIX}:`);
}

export function openingOpsRows(services: Services): ActionRowBuilder<ButtonBuilder>[] {
  const phase = services.chipTx.openingPhase();
  const execution = currentOpeningExecution(services);
  const terminalFormal = phase === "formal" || currentOpeningVersion(services) === FORMAL_OPENING_VERSION;
  const settingsDisabled = settingsEditBlockedReason(services) !== null;
  const executeDisabled = terminalFormal;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${OPS_PREFIX}:capital`)
        .setLabel("Opening Capital")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(settingsDisabled),
      new ButtonBuilder()
        .setCustomId(`${OPS_PREFIX}:ops`)
        .setLabel("Ops Settings")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(settingsDisabled),
      new ButtonBuilder()
        .setCustomId(`${OPS_PREFIX}:preflight`)
        .setLabel("Preflight")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(executeDisabled),
      ...(execution && execution.status !== "completed"
        ? [
            new ButtonBuilder()
              .setCustomId(`${OPS_PREFIX}:resume`)
              .setLabel("Resume Opening")
              .setStyle(ButtonStyle.Danger),
          ]
        : []),
    ),
  ];
}

export function openingOpsField(services: Services): { name: string; value: string; inline: false } {
  const cfg = readCasinoOpeningConfig(services.settings);
  const execution = currentOpeningExecution(services);
  const phase = services.chipTx.openingPhase();
  const status = services.casinoStatus.current().status;
  const configLine = cfg.ok
    ? `configured / capital ${fmtLd(cfg.config.openingCapital)} / house ${fmtLd(cfg.config.openingHouse)} / JP ${fmtLd(cfg.config.openingJackpot)} / relief ${fmtLd(cfg.config.openingRelief)} / min ${fmtLd(cfg.config.minWorkingCapital)} / remit ${cfg.config.remitRateBps}bps`
    : cfg.configured
      ? `invalid: ${cfg.errors.join("; ").slice(0, 700)}`
      : "not configured";
  const execLine = execution
    ? `${execution.id} / ${execution.status} / owner ${execution.actorId} / fundsApplied=${execution.fundsApplied}`
    : "none";
  return {
    name: "Formal Opening Prep",
    value: [`phase=${phase} / status=${status}`, `config: ${configLine}`, `execution: ${execLine}`].join("\n").slice(0, 1024),
    inline: false,
  };
}

export async function handleOpeningOpsButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const [, , , action, arg] = interaction.customId.split(":");
  if (action === "capital") {
    if (!ensureOwner(interaction)) return;
    const reason = settingsEditBlockedReason(services);
    if (reason) return void (await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral }));
    return void (await interaction.showModal(openingCapitalModal()));
  }
  if (action === "ops") {
    if (!ensureOwner(interaction)) return;
    const reason = settingsEditBlockedReason(services);
    if (reason) return void (await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral }));
    return void (await interaction.showModal(openingOpsModal()));
  }
  if (action === "preflight") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const plan = services.openingPlanner.dryRun();
    await interaction.editReply(renderPreflight(plan, interaction.user.id));
    return;
  }
  if (action === "confirm" && arg) {
    if (!ensureOwner(interaction)) return;
    const plan = services.openingPlanner.dryRun();
    if (plan.planHash !== arg || !isApplyEligiblePreflight(plan)) {
      return void (await interaction.reply({
        content: "Preflight is stale or blocked. Run preflight again before executing formal opening.",
        flags: MessageFlags.Ephemeral,
      }));
    }
    return void (await interaction.showModal(openingApplyModal(plan.planHash)));
  }
  if (action === "resume") {
    if (!ensureOwner(interaction)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await runOpeningApply(interaction, services, null));
  }
}

export async function handleOpeningOpsModal(interaction: ModalSubmitInteraction, services: Services): Promise<void> {
  const [, , , action, arg] = interaction.customId.split(":");
  if (!ensureOwner(interaction)) return;

  if (action === "capital") {
    const reason = settingsEditBlockedReason(services);
    if (reason) return void (await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral }));
    const parsed = parseOpeningIntegers(interaction, ["openingCapital", "openingHouse", "openingJackpot", "openingRelief"]);
    if (!parsed.ok) return void (await interaction.reply({ content: parsed.message, flags: MessageFlags.Ephemeral }));
    const values = parsed.values as Pick<CasinoOpeningConfig, "openingCapital" | "openingHouse" | "openingJackpot" | "openingRelief">;
    const validation = validateOpeningCapital(values);
    if (!validation.ok) return void (await interaction.reply({ content: validation.message, flags: MessageFlags.Ephemeral }));
    services.settings.delete(CASINO_OPENING_SETTING_KEYS.configured, `user:${interaction.user.id}`);
    services.settings.set(CASINO_OPENING_SETTING_KEYS.capital, values.openingCapital, `user:${interaction.user.id}`);
    services.settings.set(CASINO_OPENING_SETTING_KEYS.house, values.openingHouse, `user:${interaction.user.id}`);
    services.settings.set(CASINO_OPENING_SETTING_KEYS.jackpot, values.openingJackpot, `user:${interaction.user.id}`);
    services.settings.set(CASINO_OPENING_SETTING_KEYS.relief, values.openingRelief, `user:${interaction.user.id}`);
    await interaction.reply({
      content: "Opening capital settings saved as partial input. Configure operational settings to validate and mark configured=true.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "ops") {
    const reason = settingsEditBlockedReason(services);
    if (reason) return void (await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral }));
    const parsed = parseOpeningIntegers(interaction, ["minWorkingCapital", "remitRateBps"]);
    if (!parsed.ok) return void (await interaction.reply({ content: parsed.message, flags: MessageFlags.Ephemeral }));
    const capital = readPartialOpeningCapital(services);
    if (!capital.ok) return void (await interaction.reply({ content: capital.message, flags: MessageFlags.Ephemeral }));
    const ops = parsed.values as Pick<CasinoOpeningConfig, "minWorkingCapital" | "remitRateBps">;
    const candidate: OpeningConfigWrite = { ...capital.values, ...ops };
    const validation = validateOpeningConfig(candidate);
    if (!validation.ok) return void (await interaction.reply({ content: validation.message, flags: MessageFlags.Ephemeral }));
    services.settings.delete(CASINO_OPENING_SETTING_KEYS.configured, `user:${interaction.user.id}`);
    writeCasinoOpeningConfig(services.settings, candidate, `user:${interaction.user.id}`);
    const reread = readCasinoOpeningConfig(services.settings);
    if (!reread.ok) {
      services.settings.delete(CASINO_OPENING_SETTING_KEYS.configured, `user:${interaction.user.id}`);
      return void (await interaction.reply({ content: "Opening settings failed read-back validation; configured flag was not kept.", flags: MessageFlags.Ephemeral }));
    }
    await interaction.reply({ content: "Opening settings validated and configured=true was written last.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "apply" && arg) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const confirm = interaction.fields.getTextInputValue("confirm").trim();
    if (confirm !== `${CONFIRM_WORD} ${arg.slice(0, 8)}`) {
      await interaction.editReply("Confirmation text did not match the current plan hash prefix. Nothing was executed.");
      return;
    }
    await interaction.editReply(await runOpeningApply(interaction, services, arg));
  }
}

function openingCapitalModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${OPS_PREFIX}:capital`)
    .setTitle("Formal Opening Capital")
    .addComponents(
      textInput("openingCapital", "opening capital", true),
      textInput("openingHouse", "house amount", true),
      textInput("openingJackpot", "jackpot amount", true),
      textInput("openingRelief", "relief amount", true),
    );
}

function openingOpsModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${OPS_PREFIX}:ops`)
    .setTitle("Formal Opening Ops")
    .addComponents(textInput("minWorkingCapital", "minimum working capital", true), textInput("remitRateBps", "remit rate bps", true));
}

export function isApplyEligiblePreflight(plan: OpeningPreflightResult): boolean {
  if (plan.blockers.length === 0) return true;
  return (
    plan.blockers.length === 1 &&
    plan.blockers[0]?.code === "status_not_opening_reset" &&
    plan.snapshot.casinoStatus === "open"
  );
}

function openingApplyModal(planHash: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${OPS_PREFIX}:apply:${planHash}`)
    .setTitle("Execute Formal Opening")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("confirm")
          .setLabel(`type: ${CONFIRM_WORD} ${planHash.slice(0, 8)}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40),
      ),
    );
}

function textInput(id: string, label: string, required: boolean): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(16),
  );
}

function renderPreflight(plan: OpeningPreflightResult, actorId: string) {
  const embed = new EmbedBuilder()
    .setTitle("Formal Opening Preflight")
    .setColor(isApplyEligiblePreflight(plan) ? 0x166534 : 0x991b1b)
    .setDescription(
      [
        `planHash: \`${plan.planHash}\``,
        `phase/version: ${plan.snapshot.currentOpeningVersion}`,
        `casino status: ${plan.snapshot.casinoStatus}`,
        `opening source: ${fmtLd(plan.snapshot.openingSourceLand)} / old reserve ${fmtLd(plan.snapshot.oldReserveLand)} / department ${fmtLd(plan.snapshot.departmentLandBefore)}`,
        `blockers: ${plan.blockers.length}`,
        `protected findings: ${plan.protectedFindings.length}`,
        `compensation: ${plan.compensation.requiredLand === null ? "unknown" : fmtLd(plan.compensation.requiredLand)} / unknown ${plan.compensation.unknownCount}`,
        `unknown casino tables: ${plan.unknownTables.length ? plan.unknownTables.join(", ") : "none"}`,
        `legacy ledger: ${plan.legacyLedgerAudit.ok ? "ok" : "NG"}`,
        `tables: ${plan.tableAudits.filter((t) => t.exists).length}/${plan.tableAudits.length} exist`,
      ].join("\n"),
    )
    .addFields(
      { name: "Opening Config", value: configSummary(plan.snapshot.configuration), inline: false },
      { name: "Blockers", value: blockerSummary(plan.blockers), inline: false },
      { name: "Protected", value: plan.protectedFindings.slice(0, 10).map((f) => `${f.assetType}:${f.userId}:${f.sourceTable}`).join("\n") || "none", inline: false },
    );
  const components =
    isApplyEligiblePreflight(plan) && actorId === openingOwnerId()
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${OPS_PREFIX}:confirm:${plan.planHash}`)
              .setLabel("Confirm Opening Apply")
              .setStyle(ButtonStyle.Danger),
          ),
        ]
      : [];
  return { embeds: [embed], components };
}

async function runOpeningApply(interaction: ModalSubmitInteraction | ButtonInteraction, services: Services, expectedPlanHash: string | null): Promise<string> {
  const actorId = interaction.user.id;
  if (expectedPlanHash) {
    const fresh = services.openingPlanner.dryRun();
    if (fresh.planHash !== expectedPlanHash) return "Plan hash changed after confirmation. Nothing was executed.";
    if (!isApplyEligiblePreflight(fresh)) return `Preflight is now blocked. Nothing was executed.\n${blockerSummary(fresh.blockers)}`;
  }
  try {
    const result = await services.openingReset.apply({
      actorId,
      backup: new ProductionOpeningBackupAdapter(openingBackupDir()),
      external: new DiscordTrackedTempVcOpeningExternalAdapter(interaction.client, services),
    });
    return applyResultSummary(result);
  } catch (error) {
    return openingApplyErrorMessage(error);
  }
}

function applyResultSummary(result: OpeningApplyResult): string {
  return [
    "Formal opening apply finished.",
    `executionId: ${result.executionId}`,
    `planHash: ${result.planHash}`,
    `status: ${result.status}`,
    `openingVersion: ${result.openingVersion}`,
    `oldSettlementLandTxId: ${result.oldSettlementLandTxId ?? "none"}`,
    `newInvestmentLandTxId: ${result.newInvestmentLandTxId}`,
    `postflight: ${result.postflight.ok ? "OK" : "NG"}`,
    `casinoReopened: ${result.casinoReopened}`,
    `backup: persistent / verified / plan ${result.manifest.planHash}`,
    `external R3: ${result.externalOperationId}`,
    `notifier: ${result.notifierStatus}`,
  ].join("\n");
}

function openingApplyErrorMessage(error: unknown): string {
  if (error instanceof OpeningApplyBlockedError) return `OpeningApplyBlockedError\n${blockerSummary(error.blockers)}`;
  if (error instanceof OpeningApplyStaleplanError) return `OpeningApplyStaleplanError: ${error.stage} / ${error.executionId}`;
  if (error instanceof OpeningApplyManualReviewError) return `OpeningApplyManualReviewError: ${error.reason} / fundsApplied=${error.fundsApplied}`;
  if (error instanceof OpeningApplyRolledBackError) return `OpeningApplyRolledBackError: ${error.executionId}`;
  if (error instanceof OpeningAlreadyAppliedError) return `OpeningAlreadyAppliedError: ${error.executionId}`;
  if (error instanceof OpeningExecutionConflictError) return `OpeningExecutionConflictError: ${error.reason} / ${error.executionId}`;
  return `Formal opening apply failed closed: ${error instanceof Error ? error.message : String(error)}`;
}

function ensureOwner(interaction: ButtonInteraction | ModalSubmitInteraction): boolean {
  if (interaction.user.id === openingOwnerId()) return true;
  void interaction.reply({ content: "Formal opening operations require the configured OWNER_ID.", flags: MessageFlags.Ephemeral });
  return false;
}

function openingOwnerId(): string {
  return process.env.OWNER_ID ?? "";
}

function openingBackupDir(): string {
  return process.env.CASINO_OPENING_BACKUP_DIR ?? "";
}

function settingsEditBlockedReason(services: Services): string | null {
  if (services.chipTx.openingPhase() !== "pre_reset") return "Opening settings can be edited only before formal opening.";
  if (currentOpeningVersion(services) !== LEGACY_OPENING_VERSION) return "Opening settings can be edited only on legacy_pre_reset.";
  const execution = currentOpeningExecution(services);
  if (execution) return `Opening execution already exists (${execution.id}/${execution.status}); editing is prohibited.`;
  return null;
}

function currentOpeningExecution(services: Services) {
  if (!services.db?.prepare) return null;
  const store = new OpeningExecutionStore(services.db);
  const applied = store.findAppliedNotCompleted();
  if (applied) return applied;
  const rows = services.db
    .prepare("SELECT id FROM casino_opening_executions WHERE status != 'completed' ORDER BY started_at DESC LIMIT 1")
    .all() as Array<{ id: string }>;
  return rows[0] ? store.get(rows[0].id) ?? null : null;
}

function currentOpeningVersion(services: Services): string | undefined {
  return typeof services.chipTx.currentVersion === "function" ? services.chipTx.currentVersion() : undefined;
}

type OpeningInputKey =
  | "openingCapital"
  | "openingHouse"
  | "openingJackpot"
  | "openingRelief"
  | "minWorkingCapital"
  | "remitRateBps";

type OpeningConfigWrite = Omit<CasinoOpeningConfig, "configured">;

function parseOpeningIntegers(
  interaction: ModalSubmitInteraction,
  keys: OpeningInputKey[],
): { ok: true; values: Partial<Record<OpeningInputKey, number>> } | { ok: false; message: string } {
  const values: Partial<Record<OpeningInputKey, number>> = {};
  for (const key of keys) {
    const raw = interaction.fields.getTextInputValue(key).trim();
    if (!/^-?[0-9]+$/.test(raw)) return { ok: false, message: `${key} must be a plain safe integer literal.` };
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return { ok: false, message: `${key} is outside safe integer range.` };
    values[key] = n;
  }
  return { ok: true, values };
}

function readPartialOpeningCapital(services: Services) {
  const fake = {
    fields: {
      getTextInputValue: (key: string) => {
        const map: Record<string, string> = {
          openingCapital: services.settings.getString(CASINO_OPENING_SETTING_KEYS.capital) ?? "",
          openingHouse: services.settings.getString(CASINO_OPENING_SETTING_KEYS.house) ?? "",
          openingJackpot: services.settings.getString(CASINO_OPENING_SETTING_KEYS.jackpot) ?? "",
          openingRelief: services.settings.getString(CASINO_OPENING_SETTING_KEYS.relief) ?? "",
        };
        return map[key] ?? "";
      },
    },
  } as ModalSubmitInteraction;
  const parsed = parseOpeningIntegers(fake, ["openingCapital", "openingHouse", "openingJackpot", "openingRelief"]);
  if (!parsed.ok) return { ok: false as const, message: "Capital settings are incomplete or invalid. Save opening capital first." };
  return { ok: true as const, values: parsed.values as Pick<CasinoOpeningConfig, "openingCapital" | "openingHouse" | "openingJackpot" | "openingRelief"> };
}

function validateOpeningConfig(config: Partial<OpeningConfigWrite>): { ok: true } | { ok: false; message: string } {
  const c = config as OpeningConfigWrite;
  const capital = validateOpeningCapital(c);
  if (!capital.ok) return capital;
  if (!(c.minWorkingCapital >= 0)) return { ok: false, message: "minWorkingCapital must be >= 0." };
  if (!(c.remitRateBps >= 0 && c.remitRateBps <= 10_000)) return { ok: false, message: "remitRateBps must be 0..10000." };
  return { ok: true };
}

function validateOpeningCapital(config: Partial<OpeningConfigWrite>): { ok: true } | { ok: false; message: string } {
  const c = config as OpeningConfigWrite;
  if (!(c.openingCapital > 0)) return { ok: false, message: "openingCapital must be > 0." };
  if (!(c.openingHouse > 0)) return { ok: false, message: "openingHouse must be > 0." };
  if (!(c.openingJackpot >= 0)) return { ok: false, message: "openingJackpot must be >= 0." };
  if (!(c.openingRelief >= 0)) return { ok: false, message: "openingRelief must be >= 0." };
  const total = c.openingHouse + c.openingJackpot + c.openingRelief;
  if (!Number.isSafeInteger(total)) return { ok: false, message: "house + jackpot + relief is outside safe integer range." };
  if (total !== c.openingCapital) return { ok: false, message: "house + jackpot + relief must equal opening capital." };
  return { ok: true };
}

function configSummary(c: CasinoOpeningConfig): string {
  return [
    `capital ${fmtLd(c.openingCapital)}`,
    `house ${fmtLd(c.openingHouse)}`,
    `jackpot ${fmtLd(c.openingJackpot)}`,
    `relief ${fmtLd(c.openingRelief)}`,
    `minWorkingCapital ${fmtLd(c.minWorkingCapital)}`,
    `remitRateBps ${c.remitRateBps}`,
  ].join("\n");
}

function blockerSummary(blockers: readonly OpeningBlocker[]): string {
  if (blockers.length === 0) return "none";
  return blockers.slice(0, 12).map((b) => `${b.code}: ${b.message}`.slice(0, 180)).join("\n");
}

function isUnknownChannelError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === RESTJSONErrorCodes.UnknownChannel
  );
}

export class DiscordTrackedTempVcOpeningExternalAdapter implements OpeningExternalAdapter {
  constructor(
    private readonly client: Client,
    private readonly services: Services,
  ) {}

  async disableLegacyCasino(request: OpeningExternalDisableLegacyRequest): Promise<OpeningExternalDisableLegacyResult> {
    const rows = this.services.takutate.list();
    const disabled: string[] = [];
    for (const row of rows) {
      let channel;
      try {
        channel = await this.client.channels.fetch(row.channel_id, { force: true });
      } catch (error) {
        if (isUnknownChannelError(error)) {
          disabled.push(row.channel_id);
          continue;
        }
        throw error;
      }
      if (channel === null) {
        throw new Error(`tracked temp VC fetch returned null without Unknown Channel error: ${row.channel_id}`);
      }
      if (channel.type !== ChannelType.GuildVoice || channel.guildId !== row.guild_id) {
        throw new Error(`tracked temp VC target mismatch: ${row.channel_id}`);
      }
      try {
        await channel.delete(`formal opening ${request.idempotencyKey}`);
      } catch (error) {
        if (!isUnknownChannelError(error)) throw error;
      }
      disabled.push(row.channel_id);
    }
    return {
      idempotencyKey: request.idempotencyKey,
      disabledChannelIds: disabled,
      completedAt: Math.floor(Date.now() / 1000),
    };
  }
}
