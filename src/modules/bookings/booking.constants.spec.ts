import {
  DEFAULT_BOOKING_HOLD_MINUTES,
  bookingHoldExpiresAt,
  bookingHoldMinutes,
} from './booking.constants';

describe('booking hold policy', () => {
  it('defaults to 15 minutes and accepts BOOKING_HOLD_MINUTES', () => {
    expect(bookingHoldMinutes({})).toBe(DEFAULT_BOOKING_HOLD_MINUTES);
    expect(bookingHoldMinutes({ BOOKING_HOLD_MINUTES: '20' })).toBe(20);
    expect(bookingHoldMinutes({ BOOKING_HOLD_MINUTES: '0' })).toBe(15);
    expect(bookingHoldMinutes({ BOOKING_HOLD_MINUTES: 'nope' })).toBe(15);
  });

  it('computes expires_at from now plus the configured TTL', () => {
    const now = new Date('2026-11-27T12:00:00.000Z');
    expect(
      bookingHoldExpiresAt(now, { BOOKING_HOLD_MINUTES: '15' }).toISOString(),
    ).toBe('2026-11-27T12:15:00.000Z');
  });
});
