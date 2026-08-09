import type { ReservationScope } from "./reservations.js";

export const RANKED_FEE_RESERVATION_SCOPE: ReservationScope = "persistent_table_fee_refund";
export const rankedFeeReservationKey = (tableId: string): string => `ranked:fee-refund:${tableId}`;
