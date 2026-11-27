import { BookingStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import {
  ALLOWED_BOOKING_TRANSITIONS,
  assertBookingTransition,
  canTransitionBooking,
  isTerminalBookingStatus,
  replayErrorForBooking,
} from './booking-state';

describe('booking state machine', () => {
  it('allows the documented transitions only', () => {
    expect(
      canTransitionBooking(
        BookingStatus.pending_payment,
        BookingStatus.confirmed,
      ),
    ).toBe(true);
    expect(
      canTransitionBooking(BookingStatus.confirmed, BookingStatus.checked_in),
    ).toBe(true);
    expect(
      canTransitionBooking(BookingStatus.checked_in, BookingStatus.completed),
    ).toBe(true);
    expect(
      canTransitionBooking(BookingStatus.confirmed, BookingStatus.cancelled),
    ).toBe(true);

    expect(
      canTransitionBooking(BookingStatus.pending_payment, BookingStatus.completed),
    ).toBe(false);
    expect(
      canTransitionBooking(BookingStatus.checked_in, BookingStatus.cancelled),
    ).toBe(false);
    expect(
      canTransitionBooking(BookingStatus.cancelled, BookingStatus.confirmed),
    ).toBe(false);
    expect(
      canTransitionBooking(BookingStatus.confirmed, BookingStatus.confirmed),
    ).toBe(false);
  });

  it('has no outgoing edges from terminal statuses', () => {
    for (const status of [
      BookingStatus.completed,
      BookingStatus.cancelled,
      BookingStatus.expired,
      BookingStatus.no_show,
    ]) {
      expect(isTerminalBookingStatus(status)).toBe(true);
      expect(ALLOWED_BOOKING_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('maps an invalid transition to 409 INVALID_STATE', () => {
    try {
      assertBookingTransition(
        BookingStatus.completed,
        BookingStatus.confirmed,
      );
      throw new Error('Se esperaba un AppError');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).getStatus()).toBe(409);
      expect((error as AppError).code).toBe('INVALID_STATE');
    }
  });

  it('does not replay terminal bookings', () => {
    expect(
      replayErrorForBooking(BookingStatus.expired, null)?.code,
    ).toBe('BOOKING_EXPIRED');
    expect(
      replayErrorForBooking(
        BookingStatus.pending_payment,
        new Date('2026-06-15T15:00:00.000Z'),
        new Date('2026-06-15T15:00:01.000Z'),
      )?.code,
    ).toBe('BOOKING_EXPIRED');
    expect(
      replayErrorForBooking(BookingStatus.cancelled, null)?.code,
    ).toBe('INVALID_STATE');
    expect(
      replayErrorForBooking(BookingStatus.completed, null)?.code,
    ).toBe('INVALID_STATE');
    expect(
      replayErrorForBooking(BookingStatus.no_show, null)?.code,
    ).toBe('INVALID_STATE');
    expect(
      replayErrorForBooking(
        BookingStatus.pending_payment,
        new Date('2026-06-15T16:00:00.000Z'),
        new Date('2026-06-15T15:00:00.000Z'),
      ),
    ).toBeNull();
    expect(replayErrorForBooking(BookingStatus.confirmed, null)).toBeNull();
  });
});
