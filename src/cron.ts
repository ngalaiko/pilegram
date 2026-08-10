const MINUTE = 60 * 1000;

export function nextCronRun(cron: string, timeZone: string, from = new Date()): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have 5 fields: minute hour day-of-month month day-of-week");
  const fields = {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 7).map((n) => (n === 7 ? 0 : n)),
  };

  // One formatter, reused across the whole scan — constructing a DateTimeFormat
  // per minute (up to ~525k times) is the dominant cost and blocks the loop.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });

  let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  // Search up to 366 days minute-by-minute. Simple, deterministic, good enough for a tiny task list.
  const end = t + 366 * 24 * 60 * MINUTE;
  for (; t <= end; t += MINUTE) {
    const z = zonedParts(fmt, new Date(t));
    if (!fields.minute.includes(z.minute)) continue;
    if (!fields.hour.includes(z.hour)) continue;
    if (!fields.month.includes(z.month)) continue;
    if (!matchesDay(fields.dayOfMonth, fields.dayOfWeek, z.day, z.weekday, parts[2]!, parts[4]!)) continue;
    return t;
  }
  throw new Error("cron does not produce a run in the next year");
}

function matchesDay(dom: number[], dow: number[], day: number, weekday: number, rawDom: string, rawDow: string): boolean {
  const domAny = rawDom === "*";
  const dowAny = rawDow === "*";
  const domMatch = dom.includes(day);
  const dowMatch = dow.includes(weekday);
  if (domAny && dowAny) return true;
  if (domAny) return dowMatch;
  if (dowAny) return domMatch;
  // Vixie cron semantics: when both are restricted, either may match.
  return domMatch || dowMatch;
}

function parseField(raw: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`);
    const bounds = range === "*" ? [min, max] : range!.split("-").map(Number);
    const start = bounds.length === 1 ? bounds[0]! : bounds[0]!;
    const end = bounds.length === 1 ? bounds[0]! : bounds[1]!;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`invalid cron field: ${part}`);
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function zonedParts(fmt: Intl.DateTimeFormat, date: Date) {
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday") ?? "");
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday,
  };
}
