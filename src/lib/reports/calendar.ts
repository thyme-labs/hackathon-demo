// Prague business-day calendar without external dependencies.
// Used for ČNB validFor rules (rates declared ~14:30 on working days) and for
// the SWIFT / SEPA settlement baselines (cut-offs, D+1, business days only).

export const PRAGUE_TZ = 'Europe/Prague';

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PRAGUE_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return d;
}

/** Wall-clock parts of an instant in Prague. */
export function pragueParts(value: string | number | Date): LocalParts {
  const parts = partsFormatter.formatToParts(toDate(value));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Instant corresponding to a Prague wall-clock time (handles DST by two-pass correction). */
export function fromPragueLocal(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const p = pragueParts(guess);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    guess += want - got;
  }
  return new Date(guess);
}

export function isoDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** YYYY-MM-DD of an instant in Prague. */
export function pragueIsoDate(value: string | number | Date): string {
  const p = pragueParts(value);
  return isoDate(p.year, p.month, p.day);
}

export function parseIsoDate(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Gregorian Easter Sunday (Meeus/Jones/Butcher). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function shiftIsoDate(date: string, days: number): string {
  const { year, month, day } = parseIsoDate(date);
  const t = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const d = new Date(t);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

const holidayCache = new Map<number, Set<string>>();

/** Czech public holidays (zákon 245/2000 Sb.) for a year, as YYYY-MM-DD. */
export function czechHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
  const set = new Set(fixed.map((md) => `${year}-${md}`));
  const easter = easterSunday(year);
  const easterIso = isoDate(year, easter.month, easter.day);
  set.add(shiftIsoDate(easterIso, -2)); // Good Friday (since 2016)
  set.add(shiftIsoDate(easterIso, 1)); // Easter Monday
  holidayCache.set(year, set);
  return set;
}

export function isCzechHoliday(date: string): boolean {
  const { year } = parseIsoDate(date);
  return czechHolidays(year).has(date);
}

export function isWeekend(date: string): boolean {
  const { year, month, day } = parseIsoDate(date);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return wd === 0 || wd === 6;
}

/** Prague business day: Monday-Friday and not a Czech public holiday. */
export function isBusinessDay(date: string): boolean {
  return !isWeekend(date) && !isCzechHoliday(date);
}

export function nextBusinessDay(date: string, offset = 1): string {
  let cursor = date;
  let remaining = offset;
  while (remaining > 0) {
    cursor = shiftIsoDate(cursor, 1);
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return cursor;
}

export function previousBusinessDay(date: string): string {
  let cursor = shiftIsoDate(date, -1);
  while (!isBusinessDay(cursor)) cursor = shiftIsoDate(cursor, -1);
  return cursor;
}

/** The business day whose ČNB rate applies to `date` (same day if business day, else previous one). */
export function cnbRateDayFor(date: string): string {
  return isBusinessDay(date) ? date : previousBusinessDay(date);
}

export function parseLocalTime(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Expected HH:MM, got ${hhmm}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Instant of `hhmm` Prague time on an ISO date. */
export function atPragueTime(date: string, hhmm: string): Date {
  const { year, month, day } = parseIsoDate(date);
  const { hour, minute } = parseLocalTime(hhmm);
  return fromPragueLocal(year, month, day, hour, minute);
}

/**
 * Bank value date for a submission instant: the same Prague business day when
 * submitted before the cut-off, otherwise the next business day.
 */
export function valueDateFor(submittedAt: Date, cutoffLocal: string): string {
  const day = pragueIsoDate(submittedAt);
  if (isBusinessDay(day) && submittedAt.getTime() < atPragueTime(day, cutoffLocal).getTime()) return day;
  return nextBusinessDay(day);
}

/** Roll an instant forward to 09:00 Prague on the next business day if it falls on a non-business day. */
export function rollToBusinessDay(at: Date, openLocal = '09:00'): Date {
  const day = pragueIsoDate(at);
  if (isBusinessDay(day)) return at;
  return atPragueTime(nextBusinessDay(day), openLocal);
}

/**
 * Fractional Prague business days between two instants: for every calendar
 * day the interval touches, the business-day fraction of the overlap is added
 * (weekends and Czech holidays count 0). Negative when `to` is before `from`.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to.getTime() < from.getTime()) return -businessDaysBetween(to, from);
  let total = 0;
  let cursorDay = pragueIsoDate(from);
  const endDay = pragueIsoDate(to);
  let guard = 0;
  while (guard < 4000) {
    guard += 1;
    const dayStart = atPragueTime(cursorDay, '00:00');
    const nextDay = shiftIsoDate(cursorDay, 1);
    const dayEnd = atPragueTime(nextDay, '00:00');
    const overlapStart = Math.max(dayStart.getTime(), from.getTime());
    const overlapEnd = Math.min(dayEnd.getTime(), to.getTime());
    if (overlapEnd > overlapStart && isBusinessDay(cursorDay)) {
      total += (overlapEnd - overlapStart) / (dayEnd.getTime() - dayStart.getTime());
    }
    if (cursorDay === endDay) break;
    cursorDay = nextDay;
  }
  return total;
}

export function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * 3_600_000);
}

/** Prague wall-clock label such as "Tue 20 Oct 14:10". */
export function formatPrague(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: PRAGUE_TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(toDate(value));
}

/** True when the ČNB fixing for `date` should already be declared (business day and past 14:30 Prague, or a past day). */
export function cnbDeclaredFor(date: string, now: Date, declaredLocal = '14:30'): boolean {
  const today = pragueIsoDate(now);
  if (date < today) return true;
  if (date > today) return false;
  if (!isBusinessDay(date)) return true;
  return now.getTime() >= atPragueTime(date, declaredLocal).getTime();
}
