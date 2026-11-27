export const DEFAULT_BOOKING_HOLD_MINUTES = 15;
export const BOOKINGS_EXPIRY_INTERVAL_MS = 60_000;
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replay';

/** Hold TTL in minutes (Q7: BOOKING_HOLD_MINUTES=15). */
export function bookingHoldMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number.parseInt(env.BOOKING_HOLD_MINUTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BOOKING_HOLD_MINUTES;
}

export function bookingHoldExpiresAt(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Date {
  return new Date(now.getTime() + bookingHoldMinutes(env) * 60_000);
}
