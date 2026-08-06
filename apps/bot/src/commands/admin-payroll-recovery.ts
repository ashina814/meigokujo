import type { Services } from "../services.js";
import { runWithCapacityVipBetCapMult } from "../casino/capacity-report.js";
import * as base from "./admin-payroll-recovery-base.js";

export * from "./admin-payroll-recovery-base.js";

/**
 * `/管理` の最終ルータ境界で、現在のVIP倍率をinteraction単位のスコープへ渡す。
 * capacity report側に「最後に見たprovider」を保持せず、並行する管理操作を混線させない。
 */
function withCapacityContext<TInteraction>(
  handler: (interaction: TInteraction, services: Services) => Promise<void>,
): (interaction: TInteraction, services: Services) => Promise<void> {
  return (interaction, services) => {
    // 既存の部分mockテストにはvipが無い場合がある。実Servicesでは必ず存在する。
    const vip = (services as Partial<Services>).vip;
    if (!vip || typeof vip.betCapMult !== "function") return handler(interaction, services);
    return runWithCapacityVipBetCapMult(vip.betCapMult(), () => handler(interaction, services));
  };
}

export const handleAdminCommand = withCapacityContext(base.handleAdminCommand);
export const handleAdminButton = withCapacityContext(base.handleAdminButton);
export const handleAdminSelect = withCapacityContext(base.handleAdminSelect);
export const handleAdminModal = withCapacityContext(base.handleAdminModal);
