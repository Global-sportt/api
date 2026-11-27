import { BookingStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';

/**
 * Tenant-managed status graph. Holds can be confirmed, cancelled or expired;
 * a confirmed booking can check in, cancel or be marked as no-show; only a
 * checked-in booking can complete. Terminal states have no outgoing edges.
 */
export const ALLOWED_BOOKING_TRANSITIONS: Record<
  BookingStatus,
  readonly BookingStatus[]
> = {
  [BookingStatus.pending_payment]: [
    BookingStatus.confirmed,
    BookingStatus.cancelled,
    BookingStatus.expired,
  ],
  [BookingStatus.confirmed]: [
    BookingStatus.checked_in,
    BookingStatus.cancelled,
    BookingStatus.no_show,
  ],
  [BookingStatus.checked_in]: [BookingStatus.completed],
  [BookingStatus.completed]: [],
  [BookingStatus.cancelled]: [],
  [BookingStatus.expired]: [],
  [BookingStatus.no_show]: [],
};

export function canTransitionBooking(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  return ALLOWED_BOOKING_TRANSITIONS[from].includes(to);
}

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return ALLOWED_BOOKING_TRANSITIONS[status].length === 0;
}

export function assertBookingTransition(
  from: BookingStatus,
  to: BookingStatus,
): void {
  if (!canTransitionBooking(from, to)) {
    throw new AppError(
      409,
      'INVALID_STATE',
      `La reserva no puede pasar de "${from}" a "${to}".`,
    );
  }
}

/**
 * Idempotent replay must return the *current* state. A booking that is already
 * terminal is not replayed: the caller gets Q3's terminal error instead.
 */
export function replayErrorForBooking(
  status: BookingStatus,
  expiresAt: Date | null,
  now: Date = new Date(),
): AppError | null {
  if (
    status === BookingStatus.expired ||
    (status === BookingStatus.pending_payment &&
      expiresAt !== null &&
      expiresAt.getTime() <= now.getTime())
  ) {
    return new AppError(
      409,
      'BOOKING_EXPIRED',
      'La reserva expiró y no puede reutilizarse.',
    );
  }

  if (
    status === BookingStatus.cancelled ||
    status === BookingStatus.completed ||
    status === BookingStatus.no_show
  ) {
    return new AppError(
      409,
      'INVALID_STATE',
      'La reserva está en un estado terminal y no puede reutilizarse.',
    );
  }

  return null;
}
