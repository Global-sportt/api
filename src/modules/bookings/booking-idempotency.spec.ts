import { PaymentMethod } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import {
  BOOKING_REQUEST_HASH_VERSION,
  canonicalBookingRequest,
  computeBookingRequestHash,
  normalizeIdempotencyKey,
} from './booking-idempotency';

const identity = {
  establishmentId: '11111111-1111-4111-8111-111111111111',
  spaceId: '22222222-2222-4222-8222-222222222222',
  playerId: '33333333-3333-4333-8333-333333333333',
  startsAt: '2026-06-15T15:00:00.000Z',
  endsAt: '2026-06-15T16:00:00.000Z',
  paymentMethod: PaymentMethod.cash,
};

describe('booking idempotency hash', () => {
  it('serializes fixed, sorted keys and UTC ISO instants', () => {
    const canonical = canonicalBookingRequest({
      ...identity,
      startsAt: '2026-06-15T10:00:00-05:00',
      endsAt: '2026-06-15T11:00:00-05:00',
    });

    expect(canonical).toBe(
      `{"endsAt":"2026-06-15T16:00:00.000Z",` +
        `"establishmentId":"${identity.establishmentId}",` +
        `"paymentMethod":"cash",` +
        `"playerId":"${identity.playerId}",` +
        `"spaceId":"${identity.spaceId}",` +
        `"startsAt":"2026-06-15T15:00:00.000Z",` +
        `"version":${BOOKING_REQUEST_HASH_VERSION}}`,
    );
    expect(BOOKING_REQUEST_HASH_VERSION).toBe(2);
  });

  it('produces the same SHA-256 for equivalent instants and a different one when a field changes', () => {
    const fromStrings = computeBookingRequestHash(identity);

    const fromDates = computeBookingRequestHash({
      ...identity,
      startsAt: new Date('2026-06-15T10:00:00-05:00'),
      endsAt: new Date('2026-06-15T11:00:00-05:00'),
    });

    expect(fromStrings).toMatch(/^[0-9a-f]{64}$/);
    expect(fromDates).toBe(fromStrings);
    expect(
      computeBookingRequestHash({
        ...identity,
        spaceId: identity.spaceId.toUpperCase(),
      }),
    ).toBe(fromStrings);
    expect(
      computeBookingRequestHash({ ...identity, playerId: '44444444-4444-4444-8444-444444444444' }),
    ).not.toBe(fromStrings);
    expect(
      computeBookingRequestHash({ ...identity, startsAt: '2026-06-15T16:00:00.000Z' }),
    ).not.toBe(fromStrings);
    // The payment method is part of the identity: same slot, different method
    // must never replay the stored booking.
    expect(
      computeBookingRequestHash({
        ...identity,
        paymentMethod: PaymentMethod.transfer,
      }),
    ).not.toBe(fromStrings);
  });

  it('trims keys, treats blank as absent and rejects an excessive length', () => {
    expect(normalizeIdempotencyKey('  key-1  ')).toBe('key-1');
    expect(normalizeIdempotencyKey('   ')).toBeNull();
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey(['first', 'second'])).toBe('first');

    const error = (() => {
      try {
        normalizeIdempotencyKey('x'.repeat(201));
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).getStatus()).toBe(400);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
  });
});
