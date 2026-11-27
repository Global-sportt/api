/**
 * Zoned time conversion without a date library.
 *
 * The API stores schedule times as wall-clock minutes (0 = 00:00, 1440 =
 * 24:00) in the establishment timezone. Slot instants must be real UTC
 * timestamps, so this helper converts a local calendar date + minutes through
 * `Intl.DateTimeFormat` instead of relying on the server timezone.
 *
 * DST policy:
 * - Ambiguous local times (fall back) resolve to the earlier occurrence.
 * - Non-existent local times (spring forward) resolve to the first valid local
 *   time after the gap (the `compatible` disambiguation used by Temporal).
 * - Callers can inspect `exists` to skip a slot whose start falls in a gap.
 */

export interface DateOnlyParts {
  year: number;
  month: number;
  day: number;
}

export interface ZonedDateTimeParts extends DateOnlyParts {
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedConversion {
  instant: Date;
  /** False when the requested wall clock does not exist on that local day. */
  exists: boolean;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function parseDateOnly(value: string): DateOnlyParts | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(year, month - 1, day);

  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

export function isValidDateOnly(value: string): boolean {
  return parseDateOnly(value) !== null;
}

/** 0 = Sunday ... 6 = Saturday for the local calendar date. */
export function dayOfWeekForDateOnly(value: string): number {
  const parts = requireDateOnly(value);
  return dateForUtcParts(parts.year, parts.month, parts.day, 0, 0, 0).getUTCDay();
}

export function getZonedDateTimeParts(
  instant: Date,
  timeZone: string,
): ZonedDateTimeParts {
  const fields: Record<string, number> = {};

  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type === 'year') fields.year = Number(part.value);
    else if (part.type === 'month') fields.month = Number(part.value);
    else if (part.type === 'day') fields.day = Number(part.value);
    else if (part.type === 'hour') fields.hour = Number(part.value);
    else if (part.type === 'minute') fields.minute = Number(part.value);
    else if (part.type === 'second') fields.second = Number(part.value);
  }

  const hour = fields.hour === 24 ? 0 : fields.hour;
  if (
    fields.year === undefined ||
    fields.month === undefined ||
    fields.day === undefined ||
    hour === undefined ||
    fields.minute === undefined ||
    fields.second === undefined
  ) {
    throw new RangeError(`Intl could not format ${instant.toISOString()} in ${timeZone}`);
  }

  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour,
    minute: fields.minute,
    second: fields.second,
  };
}

function requireDateOnly(value: string): DateOnlyParts {
  const parsed = parseDateOnly(value);
  if (!parsed) {
    throw new RangeError(`Fecha inválida: ${value}. Se espera YYYY-MM-DD.`);
  }
  return parsed;
}

function dateForUtcParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const date = new Date(0);
  date.setUTCHours(hour, minute, second, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function utcMilliseconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  return dateForUtcParts(year, month, day, hour, minute, second).getTime();
}

function wallMilliseconds(parts: ZonedDateTimeParts): number {
  return utcMilliseconds(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function offsetMilliseconds(instant: Date, timeZone: string): number {
  const parts = getZonedDateTimeParts(instant, timeZone);
  // Offsets have second precision; truncating avoids sub-second noise.
  const instantSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return wallMilliseconds(parts) - instantSecond;
}

/**
 * Converts a calendar date plus wall-clock minutes in `timeZone` to a UTC
 * instant. Minutes may be 1440 to mean midnight at the start of the next day
 * (used for a closing time of 24:00).
 */
export function wallClockToUtc(
  date: string,
  minutes: number,
  timeZone: string,
): ZonedConversion {
  const { year, month, day } = requireDateOnly(date);

  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new RangeError(`Minutos fuera de rango: ${minutes}.`);
  }
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Zona horaria inválida: ${timeZone}.`);
  }

  const localMilliseconds =
    utcMilliseconds(year, month, day, 0, 0, 0) + minutes * 60_000;

  // The offset depends on the instant; evaluate it once at the naive instant
  // and once at the first candidate to cover a DST boundary in either
  // direction.
  const firstOffset = offsetMilliseconds(new Date(localMilliseconds), timeZone);
  const first = new Date(localMilliseconds - firstOffset);
  const secondOffset = offsetMilliseconds(first, timeZone);
  const candidates =
    secondOffset === firstOffset
      ? [first]
      : [first, new Date(localMilliseconds - secondOffset)];

  const exact = candidates.filter(
    (candidate) =>
      wallMilliseconds(getZonedDateTimeParts(candidate, timeZone)) ===
      localMilliseconds,
  );

  if (exact.length > 0) {
    const earliest = Math.min(...exact.map((candidate) => candidate.getTime()));
    return { instant: new Date(earliest), exists: true };
  }

  // The requested wall clock does not exist (spring-forward gap). Return the
  // first candidate after the gap, which is the `compatible` behaviour.
  const afterGap = candidates
    .filter(
      (candidate) =>
        wallMilliseconds(getZonedDateTimeParts(candidate, timeZone)) >
        localMilliseconds,
    )
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    instant: afterGap[0] ?? first,
    exists: false,
  };
}
