/**
 * The recurrence rules a migration schedule needs: a five-field cron expression, or a plain
 * interval for the common "every 15 minutes" case.
 *
 * Hand-rolled because the semantics have to be exact and auditable — a schedule that silently
 * fires at the wrong hour across a DST boundary is worse than no schedule — and because the whole
 * of the syntax we accept fits here: minute, hour, day-of-month, month, day-of-week, with `*`,
 * lists, ranges and steps. No seconds field (a migration is not a per-second operation), no `L`,
 * `W`, `#` or `?`.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when day-of-month and day-of-week are both restricted, which cron treats as OR. */
  bothDayFieldsRestricted: boolean;
}

const RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  daysOfMonth: [1, 31],
  months: [1, 12],
  daysOfWeek: [0, 6],
} as const;

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Shorthands people expect to work, expanded before parsing. */
const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

export class CronError extends Error {}

export function parseCron(expression: string): CronFields {
  const normalized = expression.trim().toLowerCase();
  const expanded = ALIASES[normalized] ?? normalized;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `A cron expression has five fields (minute hour day-of-month month day-of-week); got ${parts.length}`,
    );
  }
  const [minute, hour, dom, month, dow] = parts;
  const fields: CronFields = {
    minutes: parseField(minute, 'minutes'),
    hours: parseField(hour, 'hours'),
    daysOfMonth: parseField(dom, 'daysOfMonth'),
    months: parseField(month, 'months', MONTH_NAMES, 1),
    daysOfWeek: parseField(dow, 'daysOfWeek', DAY_NAMES, 0),
    bothDayFieldsRestricted: !isWildcard(dom) && !isWildcard(dow),
  };
  return fields;
}

const isWildcard = (field: string) => field === '*' || field === '?';

function parseField(field: string, name: keyof typeof RANGES, names?: string[], nameBase = 0): Set<number> {
  const [min, max] = RANGES[name];
  const out = new Set<number>();
  if (isWildcard(field)) {
    for (let i = min; i <= max; i++) out.add(i);
    return out;
  }
  for (const piece of field.split(',')) {
    if (!piece) throw new CronError(`Empty entry in the ${name} field`);
    const [spec, stepText] = piece.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Invalid step "${stepText}" in ${name}`);

    let from: number;
    let to: number;
    if (isWildcard(spec)) {
      from = min;
      to = max;
    } else if (spec.includes('-')) {
      const [a, b] = spec.split('-');
      from = value(a, name, names, nameBase);
      to = value(b, name, names, nameBase);
      if (to < from) throw new CronError(`Range "${spec}" in ${name} runs backwards`);
    } else {
      from = value(spec, name, names, nameBase);
      to = stepText === undefined ? from : max;
    }
    for (let i = from; i <= to; i += step) out.add(i);
  }
  // Cron accepts 7 for Sunday, which is the same day as 0.
  if (name === 'daysOfWeek' && out.delete(7)) out.add(0);
  if (out.size === 0) throw new CronError(`The ${name} field matches nothing`);
  return out;
}

function value(
  raw: string,
  name: keyof typeof RANGES,
  names: string[] | undefined,
  nameBase: number,
): number {
  const text = raw.trim();
  if (names) {
    const index = names.indexOf(text.slice(0, 3));
    if (index >= 0) return index + nameBase;
  }
  const n = Number(text);
  const [min, max] = RANGES[name];
  // Day-of-week 7 is Sunday; it is folded into 0 once the field is built.
  const ceiling = name === 'daysOfWeek' ? 7 : max;
  if (!Number.isInteger(n) || n < min || n > ceiling) {
    throw new CronError(`"${raw}" is out of range for ${name} (${min}-${max})`);
  }
  return n;
}

/**
 * The next time a cron expression fires strictly after `after`, in the given IANA time zone.
 *
 * Time zones are handled by asking `Intl` what the wall clock reads at a candidate instant, rather
 * than by doing arithmetic on offsets. It costs a formatter call per candidate minute and is worth
 * it: "every night at 02:30 in Europe/London" then means 02:30 local across the DST change, and a
 * wall-clock time that a spring-forward skips is landed on the next minute that exists instead of
 * being silently dropped for the year.
 */
export function nextCronTime(
  expression: string,
  after: Date,
  timeZone = 'UTC',
  limitDays = 400,
): Date | null {
  const fields = parseCron(expression);
  const parts = zonedPartsFactory(timeZone);
  // Candidates advance a minute at a time from the next whole minute.
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const deadline = start.getTime() + limitDays * 86_400_000;

  for (let t = start.getTime(); t <= deadline; t += 60_000) {
    const candidate = new Date(t);
    const p = parts(candidate);
    if (!fields.months.has(p.month)) {
      // Skip to the first minute of the next day rather than crawling through a whole month.
      t = endOfDay(t, p);
      continue;
    }
    const domMatch = fields.daysOfMonth.has(p.day);
    const dowMatch = fields.daysOfWeek.has(p.weekday);
    const dayMatch = fields.bothDayFieldsRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) {
      t = endOfDay(t, p);
      continue;
    }
    if (!fields.hours.has(p.hour)) {
      t = endOfHour(t, p);
      continue;
    }
    if (fields.minutes.has(p.minute)) return candidate;
  }
  return null;
}

/** Jumps the cursor to one minute before the next local midnight, so the loop lands on it. */
const endOfDay = (t: number, p: ZonedParts) => t + (23 - p.hour) * 3_600_000 + (59 - p.minute) * 60_000;
const endOfHour = (t: number, p: ZonedParts) => t + (59 - p.minute) * 60_000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** Reusing one formatter matters: this is called once per candidate minute. */
function zonedPartsFactory(timeZone: string): (d: Date) => ZonedParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
  } catch {
    throw new CronError(`Unknown time zone "${timeZone}"`);
  }
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (d: Date) => {
    const found: Record<string, string> = {};
    for (const part of formatter.formatToParts(d)) found[part.type] = part.value;
    return {
      year: Number(found.year),
      month: Number(found.month),
      day: Number(found.day),
      hour: Number(found.hour),
      minute: Number(found.minute),
      weekday: weekdays[found.weekday] ?? 0,
    };
  };
}

/** Validates an expression and returns the reason it is unusable, or null when it is fine. */
export function cronError(expression: string, timeZone = 'UTC'): string | null {
  try {
    if (nextCronTime(expression, new Date(), timeZone) === null) {
      return 'That expression never fires within the next year';
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression';
  }
}

/** A plain-English rendering, so a saved schedule can be read back without decoding cron. */
export function describeCron(expression: string): string {
  const normalized = ALIASES[expression.trim().toLowerCase()] ?? expression.trim().toLowerCase();
  const [minute, hour, dom, month, dow] = normalized.split(/\s+/);
  if (!minute) return expression;
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${everyMinutes[1]} minutes`;
  }
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'Every minute';
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHours && dom === '*' && month === '*' && dow === '*') {
    // On the hour needs no qualifier; any other minute does.
    return minute === '0'
      ? `Every ${everyHours[1]} hours`
      : `Every ${everyHours[1]} hours at ${minute.padStart(2, '0')} past`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const at = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (dom === '*' && month === '*' && dow === '*') return `Every day at ${at}`;
    if (dom === '*' && month === '*') return `${weekdayPhrase(dow)} at ${at}`;
    if (month === '*' && dow === '*') return `Day ${dom} of every month at ${at}`;
  }
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return minute === '0' ? 'Every hour' : `Every hour at ${minute.padStart(2, '0')} past`;
  }
  return `Cron: ${normalized}`;
}

function weekdayPhrase(dow: string): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (dow === '1-5') return 'Every weekday';
  const parts = dow
    .split(',')
    .map((d) => {
      const named = DAY_NAMES.indexOf(d.slice(0, 3));
      const n = named >= 0 ? named : Number(d);
      return Number.isInteger(n) && n >= 0 && n <= 7 ? names[n === 7 ? 0 : n] : null;
    })
    .filter((n): n is string => n !== null);
  return parts.length ? `Every ${parts.join(' and ')}` : `Cron day ${dow}`;
}

/** The interval presets the UI offers, as cron, so everything downstream has one representation. */
export const SCHEDULE_PRESETS = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Every weekday at 06:00', cron: '0 6 * * 1-5' },
  { label: 'Every Sunday at 01:00', cron: '0 1 * * 0' },
] as const;
