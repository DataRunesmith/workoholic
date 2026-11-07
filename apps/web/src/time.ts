const STOCKHOLM_TZ = "Europe/Stockholm";

export interface StockholmClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function stockholmClock(date = new Date()): StockholmClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STOCKHOLM_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** YYYY-MM-DD in Europe/Stockholm, e.g. for file names. */
export function stockholmDateKey(iso: string): string {
  const local = stockholmClock(new Date(iso));
  return `${monthKey(local.year, local.month)}-${String(local.day).padStart(2, "0")}`;
}

export function currentMonthKey(date = new Date()): string {
  const local = stockholmClock(date);
  return monthKey(local.year, local.month);
}

export function previousMonthKey(date = new Date()): string {
  const local = stockholmClock(date);
  const previous = new Date(Date.UTC(local.year, local.month - 2, 1));
  return monthKey(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
}

/** Applications run on the 1st–14th so the month's ten are done early. */
export function isApplicationAutomationWindow(date = new Date()): boolean {
  const local = stockholmClock(date);
  return local.day >= 1 && local.day <= 14;
}

/**
 * Low-traffic autonomous fallback: one invocation per day on the 10th–13th.
 * The Cron itself runs at 09:00 UTC, which is 10:00 CET or 11:00 CEST.
 */
export function isScheduledSafetyWindow(date = new Date()): boolean {
  const local = stockholmClock(date);
  return local.day >= 10 && local.day <= 13 && local.hour >= 10 && local.hour < 20;
}
