export type StrictWagerParse =
  | { ok: true; amount: number }
  | { ok: false; reason: "empty" | "format" | "unsafe" };

export function parseStrictPositiveInteger(raw: string): StrictWagerParse {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (!/^[1-9]\d*$/.test(text)) return { ok: false, reason: "format" };
  const amount = Number(text);
  if (!Number.isSafeInteger(amount)) return { ok: false, reason: "unsafe" };
  return { ok: true, amount };
}
