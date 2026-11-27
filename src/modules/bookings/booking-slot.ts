import type { GeneratedSlot } from '../spaces/slot-generator.types';

export interface BookingRange {
  startsAt: Date;
  endsAt: Date;
}

export interface BookingAlternative {
  startsAt: string;
  endsAt: string;
  priceMinor: string;
  currency: string;
}

/**
 * A request is only bookable when it matches a slot produced by T5 exactly:
 * same UTC start and end, same duration, same price source. This is what makes
 * client-supplied prices impossible to trust.
 */
export function findRequestedSlot(
  slots: readonly GeneratedSlot[],
  startsAtIso: string,
  endsAtIso: string,
): GeneratedSlot | null {
  return (
    slots.find(
      (slot) =>
        slot.startsAt === startsAtIso && slot.endsAt === endsAtIso,
    ) ?? null
  );
}

/** Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) != ∅. */
export function rangesOverlap(
  aStart: Date | string,
  aEnd: Date | string,
  bStart: Date | string,
  bEnd: Date | string,
): boolean {
  const aStartMs = toMillis(aStart);
  const aEndMs = toMillis(aEnd);
  const bStartMs = toMillis(bStart);
  const bEndMs = toMillis(bEnd);

  return aStartMs < bEndMs && bStartMs < aEndMs;
}

export function slotOverlapsBookings(
  slot: Pick<GeneratedSlot, 'startsAt' | 'endsAt'>,
  bookings: readonly BookingRange[],
): boolean {
  return bookings.some((booking) =>
    rangesOverlap(slot.startsAt, slot.endsAt, booking.startsAt, booking.endsAt),
  );
}

/**
 * Up to `limit` generated slots that are not the requested one and do not
 * overlap an active booking. Closest to the requested start first, then
 * chronological order for ties.
 */
export function findAlternativeSlots(
  slots: readonly GeneratedSlot[],
  occupied: readonly BookingRange[],
  requestedStartIso: string,
  limit = 3,
): BookingAlternative[] {
  const requestedMs = Date.parse(requestedStartIso);

  return slots
    .filter(
      (slot) =>
        slot.startsAt !== requestedStartIso &&
        !slotOverlapsBookings(slot, occupied),
    )
    .sort((left, right) => {
      const leftDistance = Math.abs(Date.parse(left.startsAt) - requestedMs);
      const rightDistance = Math.abs(Date.parse(right.startsAt) - requestedMs);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.startsAt.localeCompare(right.startsAt);
    })
    .slice(0, limit)
    .map((slot) => ({
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      priceMinor: slot.priceMinor,
      currency: slot.currency,
    }));
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
