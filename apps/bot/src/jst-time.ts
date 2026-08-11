export interface JstNowParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  period: string;
  dateStr: string;
}

export function jstNow(date = new Date()): JstNowParts {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    year,
    month,
    day,
    hour: get("hour") % 24,
    minute: get("minute"),
    period: `${year}-${String(month).padStart(2, "0")}`,
    dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function jstDayOfWeek(date = new Date()): number {
  return new Date(`${jstNow(date).dateStr}T00:00:00Z`).getUTCDay();
}
