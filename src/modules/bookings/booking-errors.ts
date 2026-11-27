import { AppError } from '../../common/errors/app-error';

// SQLSTATE: two-digit class + three alphanumeric characters (e.g. 23P01).
// This deliberately does not match Prisma's `P2002` style codes.
const SQLSTATE_PATTERN = /^[0-9]{2}[0-9A-Z]{3}$/;
const MAX_CAUSE_DEPTH = 6;

/**
 * Extracts a PostgreSQL SQLSTATE from Prisma native errors, raw-query errors
 * (`P2010` carries the SQLSTATE in `meta.code`) and driver adapter wrappers.
 * The traversal is defensive because Prisma's error envelope differs between
 * versions and query kinds.
 */
export function pgSqlState(error: unknown): string | undefined {
  const visited = new WeakSet<object>();

  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth < 0 || value === null || typeof value !== 'object') {
      return undefined;
    }
    if (visited.has(value)) return undefined;
    visited.add(value);

    const record = value as Record<string, unknown>;
    const candidates = [
      record.code,
      record.sqlState,
      isRecord(record.meta) ? record.meta.code : undefined,
      isRecord(record.meta) ? record.meta.sqlState : undefined,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && SQLSTATE_PATTERN.test(candidate)) {
        return candidate;
      }
    }

    for (const key of [
      'cause',
      'original',
      'meta',
      'driverAdapterError',
      'error',
    ]) {
      const nested = visit(record[key], depth - 1);
      if (nested) return nested;
    }

    return undefined;
  };

  return visit(error, MAX_CAUSE_DEPTH);
}

/** PostgreSQL exclusion_violation, raised by `bookings_no_overlap`. */
export function isExclusionViolation(error: unknown): boolean {
  return pgSqlState(error) === '23P01';
}

/** PostgreSQL unique_violation, used for the idempotency and public code keys. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    pgSqlState(error) === '23505' ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002')
  );
}

/** PostgreSQL foreign_key_violation, used by the composite space FK. */
export function isForeignKeyViolation(error: unknown): boolean {
  const state = pgSqlState(error);
  return (
    state === '23503' ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2003')
  );
}

export function slotTakenError(
  spaceId: string,
  alternatives: ReadonlyArray<{
    startsAt: string;
    endsAt: string;
    priceMinor: string;
    currency: string;
  }>,
): AppError {
  return new AppError(
    409,
    'SLOT_TAKEN',
    'La franja ya no está disponible.',
    { spaceId, alternatives },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
