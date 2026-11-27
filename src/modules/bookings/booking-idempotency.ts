import { createHash } from 'node:crypto';
import { AppError } from '../../common/errors/app-error';

export const BOOKING_REQUEST_HASH_VERSION = 1;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface BookingRequestIdentity {
  establishmentId: string;
  spaceId: string;
  playerId: string;
  startsAt: Date | string;
  endsAt: Date | string;
}

/**
 * Canonical request identity:
 * - UTC ISO-8601 instants with milliseconds (`.000Z`).
 * - Fixed, sorted keys and an explicit schema version, so a future field
 *   addition cannot silently reuse an old hash.
 */
export function canonicalBookingRequest(input: BookingRequestIdentity): string {
  const payload = {
    version: BOOKING_REQUEST_HASH_VERSION,
    // UUIDs are case-insensitive in PostgreSQL. Normalizing here keeps the
    // same logical request hashable across clients that send uppercase UUIDs.
    establishmentId: input.establishmentId.toLowerCase(),
    spaceId: input.spaceId.toLowerCase(),
    playerId: input.playerId.toLowerCase(),
    startsAt: toUtcIso(input.startsAt),
    endsAt: toUtcIso(input.endsAt),
  };

  return JSON.stringify(payload, Object.keys(payload).sort());
}

export function computeBookingRequestHash(
  input: BookingRequestIdentity,
): string {
  return createHash('sha256')
    .update(canonicalBookingRequest(input), 'utf8')
    .digest('hex');
}

/**
 * `Idempotency-Key` is optional. An empty/blank header means "no key"; a very
 * long key is rejected instead of being truncated (truncation would alias two
 * different clients).
 */
export function normalizeIdempotencyKey(
  value?: string | string[] | null,
): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Idempotency-Key no puede superar ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres.`,
      [{ field: 'Idempotency-Key', constraints: ['maxLength'] }],
    );
  }

  return trimmed;
}

export function toUtcIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Instante inválido: ${String(value)}`);
  }
  return date.toISOString();
}
