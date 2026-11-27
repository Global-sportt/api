/**
 * Domain types for slot generation.
 *
 * These types intentionally do not import Prisma so the generator stays a pure
 * function and can be reused by the future booking availability filter (T6).
 */

export interface SlotSpaceConfig {
  id?: string;
  slotMinutes: number;
  bufferMinutes: number;
}

export interface SlotOperatingHour {
  dayOfWeek: number;
  opensAtMinutes: number;
  closesAtMinutes: number;
}

export interface SlotScheduleException {
  date: string;
  isClosed: boolean;
  opensAtMinutes?: number | null;
  closesAtMinutes?: number | null;
  reason?: string | null;
}

export interface SlotPriceRule {
  id?: string;
  dayOfWeek?: number | null;
  startsAtMinutes: number;
  endsAtMinutes: number;
  amountMinor: bigint;
  currency: string;
  priority: number;
}

export interface SlotGeneratorInput {
  space: SlotSpaceConfig;
  timezone: string;
  /** Local calendar date in the establishment timezone, YYYY-MM-DD. */
  date: string;
  currency: string;
  operatingHours: readonly SlotOperatingHour[];
  exception?: SlotScheduleException | null;
  priceRules: readonly SlotPriceRule[];
}

export interface GeneratedSlot {
  startsAt: string;
  endsAt: string;
  /** Minor units serialized as a decimal string (BigInt-safe JSON). */
  priceMinor: string;
  currency: string;
  available: true;
}

export interface SlotAvailabilityContext {
  spaceId?: string;
}

/**
 * Extension point for T6: receives every generated slot and returns false to
 * omit it (for example, a booked slot). Keeping this out of the generator
 * avoids a booking dependency in T5.
 */
export type SlotAvailabilityFilter = (
  slot: GeneratedSlot,
  context: SlotAvailabilityContext,
) => boolean;

export interface GenerateSlotsOptions {
  isAvailable?: SlotAvailabilityFilter;
}
