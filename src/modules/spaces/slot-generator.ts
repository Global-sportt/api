import {
  dayOfWeekForDateOnly,
  isValidTimeZone,
  parseDateOnly,
  wallClockToUtc,
} from '../../common/time/zoned-time';
import type {
  GenerateSlotsOptions,
  GeneratedSlot,
  SlotGeneratorInput,
  SlotOperatingHour,
  SlotPriceRule,
} from './slot-generator.types';

const MINUTES_PER_DAY = 1440;

interface OpeningWindow {
  opensAtMinutes: number;
  closesAtMinutes: number;
}

/**
 * Generates the bookable slots for one space and one local calendar date.
 *
 * Rules:
 * - No operating hours, a closed exception, or an invalid window => no slots.
 * - An exception with alternate hours replaces that day's regular hours.
 *   Regular days may have several non-overlapping windows; every window is
 *   walked independently.
 * - A slot must fit fully before the closing minute; slots never end after
 *   close. The buffer is added between consecutive slots, not after the last.
 * - Price rules apply only when the complete slot lies inside the rule range.
 *   The winner is the highest priority; ties prefer the lower start minute,
 *   then the lower end minute, then a day-specific rule, then the lower id.
 * - Local wall-clock times are converted to UTC with IANA rules. A start that
 *   falls in a spring-forward gap is skipped; ambiguous fall-back times use the
 *   earlier occurrence.
 */
export function generateSlots(
  input: SlotGeneratorInput,
  options: GenerateSlotsOptions = {},
): GeneratedSlot[] {
  if (!parseDateOnly(input.date)) {
    throw new RangeError(`Fecha inválida: ${input.date}. Se espera YYYY-MM-DD.`);
  }
  if (!isValidTimeZone(input.timezone)) {
    throw new RangeError(`Zona horaria inválida: ${input.timezone}.`);
  }
  if (!Number.isInteger(input.space.slotMinutes) || input.space.slotMinutes <= 0) {
    throw new RangeError('slotMinutes debe ser un entero positivo.');
  }
  if (!Number.isInteger(input.space.bufferMinutes) || input.space.bufferMinutes < 0) {
    throw new RangeError('bufferMinutes debe ser un entero no negativo.');
  }

  const dayOfWeek = dayOfWeekForDateOnly(input.date);
  const exception =
    input.exception && input.exception.date === input.date
      ? input.exception
      : null;

  if (exception?.isClosed) return [];

  const windows = resolveWindows(input.operatingHours, dayOfWeek, exception);
  if (windows.length === 0) return [];

  const slots: GeneratedSlot[] = [];
  const step = input.space.slotMinutes + input.space.bufferMinutes;
  const seenStarts = new Set<string>();

  for (const window of windows) {
    for (
      let startsAtMinutes = window.opensAtMinutes;
      startsAtMinutes + input.space.slotMinutes <= window.closesAtMinutes;
      startsAtMinutes += step
    ) {
      const endsAtMinutes = startsAtMinutes + input.space.slotMinutes;
      const start = wallClockToUtc(
        input.date,
        startsAtMinutes,
        input.timezone,
      );

      // A wall-clock start inside a DST gap does not exist. Skipping it keeps
      // the following (real) slot from being duplicated.
      if (!start.exists) continue;

      const end = wallClockToUtc(input.date, endsAtMinutes, input.timezone);
      if (end.instant.getTime() <= start.instant.getTime()) continue;

      const startsAt = start.instant.toISOString();
      if (seenStarts.has(startsAt)) continue;
      seenStarts.add(startsAt);

      const price = selectPrice(
        input.priceRules,
        dayOfWeek,
        startsAtMinutes,
        endsAtMinutes,
        input.currency,
      );
      const slot: GeneratedSlot = {
        startsAt,
        endsAt: end.instant.toISOString(),
        priceMinor: price.amountMinor.toString(),
        currency: price.currency,
        available: true,
      };

      if (options.isAvailable && !options.isAvailable(slot, { spaceId: input.space.id })) {
        continue;
      }

      slots.push(slot);
    }
  }

  // Overlapping windows are rejected at write time; sorting keeps the output
  // deterministic if legacy data ever contains more than one window per day.
  return slots.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

function resolveWindows(
  operatingHours: readonly SlotOperatingHour[],
  dayOfWeek: number,
  exception: SlotGeneratorInput['exception'],
): OpeningWindow[] {
  if (
    exception &&
    !exception.isClosed &&
    exception.opensAtMinutes != null &&
    exception.closesAtMinutes != null
  ) {
    const window = validWindow(exception.opensAtMinutes, exception.closesAtMinutes);
    return window ? [window] : [];
  }

  const windows: OpeningWindow[] = [];
  for (const hour of operatingHours) {
    if (hour.dayOfWeek !== dayOfWeek) continue;
    const window = validWindow(hour.opensAtMinutes, hour.closesAtMinutes);
    if (window) windows.push(window);
  }

  return windows.sort(
    (left, right) =>
      left.opensAtMinutes - right.opensAtMinutes ||
      left.closesAtMinutes - right.closesAtMinutes,
  );
}

function validWindow(
  opensAtMinutes: number,
  closesAtMinutes: number,
): OpeningWindow | null {
  if (
    !Number.isInteger(opensAtMinutes) ||
    !Number.isInteger(closesAtMinutes) ||
    opensAtMinutes < 0 ||
    closesAtMinutes > MINUTES_PER_DAY ||
    opensAtMinutes >= closesAtMinutes
  ) {
    return null;
  }

  return { opensAtMinutes, closesAtMinutes };
}

interface SelectedPrice {
  amountMinor: bigint;
  currency: string;
}

function selectPrice(
  rules: readonly SlotPriceRule[],
  dayOfWeek: number,
  startsAtMinutes: number,
  endsAtMinutes: number,
  fallbackCurrency: string,
): SelectedPrice {
  const applicable = rules.filter(
    (rule) =>
      (rule.dayOfWeek == null || rule.dayOfWeek === dayOfWeek) &&
      rule.startsAtMinutes <= startsAtMinutes &&
      endsAtMinutes <= rule.endsAtMinutes,
  );

  applicable.sort(comparePriceRules);

  const winner = applicable[0];
  return winner
    ? { amountMinor: winner.amountMinor, currency: winner.currency }
    : { amountMinor: 0n, currency: fallbackCurrency };
}

function comparePriceRules(left: SlotPriceRule, right: SlotPriceRule): number {
  if (left.priority !== right.priority) return right.priority - left.priority;

  if (left.startsAtMinutes !== right.startsAtMinutes) {
    return left.startsAtMinutes - right.startsAtMinutes;
  }
  if (left.endsAtMinutes !== right.endsAtMinutes) {
    return left.endsAtMinutes - right.endsAtMinutes;
  }

  const leftSpecific = left.dayOfWeek != null ? 1 : 0;
  const rightSpecific = right.dayOfWeek != null ? 1 : 0;
  if (leftSpecific !== rightSpecific) return rightSpecific - leftSpecific;

  return (left.id ?? '').localeCompare(right.id ?? '');
}
