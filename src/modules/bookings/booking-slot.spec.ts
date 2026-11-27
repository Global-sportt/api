import { generateSlots } from '../spaces/slot-generator';
import {
  findAlternativeSlots,
  findRequestedSlot,
  rangesOverlap,
  slotOverlapsBookings,
} from './booking-slot';

const DATE = '2026-06-15'; // Monday
const TIMEZONE = 'America/Bogota';

function generatedSlots() {
  return generateSlots({
    space: { id: 'space-1', slotMinutes: 60, bufferMinutes: 0 },
    timezone: TIMEZONE,
    date: DATE,
    currency: 'COP',
    operatingHours: [
      { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 14 * 60 },
    ],
    exception: null,
    priceRules: [
      {
        id: 'peak',
        dayOfWeek: 1,
        startsAtMinutes: 10 * 60,
        endsAtMinutes: 11 * 60,
        amountMinor: 18_000n,
        currency: 'COP',
        priority: 10,
      },
    ],
  });
}

describe('booking slot validation', () => {
  it('accepts only the exact generated slot and takes its server-side price', () => {
    const slots = generatedSlots();
    const slot = findRequestedSlot(
      slots,
      '2026-06-15T15:00:00.000Z', // 10:00 Bogota
      '2026-06-15T16:00:00.000Z',
    );

    expect(slot).toEqual({
      startsAt: '2026-06-15T15:00:00.000Z',
      endsAt: '2026-06-15T16:00:00.000Z',
      priceMinor: '18000',
      currency: 'COP',
      available: true,
    });
  });

  it('rejects a start outside the generated grid', () => {
    expect(
      findRequestedSlot(
        generatedSlots(),
        '2026-06-15T15:30:00.000Z',
        '2026-06-15T16:30:00.000Z',
      ),
    ).toBeNull();
  });

  it('rejects a duration that is not the space slot duration', () => {
    expect(
      findRequestedSlot(
        generatedSlots(),
        '2026-06-15T15:00:00.000Z',
        '2026-06-15T17:00:00.000Z',
      ),
    ).toBeNull();
  });

  it('uses half-open ranges: adjacent slots do not overlap', () => {
    expect(
      rangesOverlap(
        '2026-06-15T15:00:00.000Z',
        '2026-06-15T16:00:00.000Z',
        '2026-06-15T16:00:00.000Z',
        '2026-06-15T17:00:00.000Z',
      ),
    ).toBe(false);

    expect(
      rangesOverlap(
        '2026-06-15T15:00:00.000Z',
        '2026-06-15T16:00:00.000Z',
        '2026-06-15T15:30:00.000Z',
        '2026-06-15T16:30:00.000Z',
      ),
    ).toBe(true);
  });

  it('excludes booked alternatives and returns at most three nearest slots', () => {
    const slots = generatedSlots();
    const occupied = [
      {
        startsAt: new Date('2026-06-15T16:00:00.000Z'),
        endsAt: new Date('2026-06-15T17:00:00.000Z'),
      },
    ];

    const alternatives = findAlternativeSlots(
      slots,
      occupied,
      '2026-06-15T15:00:00.000Z',
    );

    expect(alternatives).toHaveLength(3);
    expect(alternatives.map((slot) => slot.startsAt)).toEqual([
      '2026-06-15T14:00:00.000Z',
      '2026-06-15T17:00:00.000Z',
      '2026-06-15T18:00:00.000Z',
    ]);
    expect(alternatives.every((slot) => slot.priceMinor === '0')).toBe(true);
  });

  it('detects a slot overlapping a booked range', () => {
    expect(
      slotOverlapsBookings(
        {
          startsAt: '2026-06-15T15:00:00.000Z',
          endsAt: '2026-06-15T16:00:00.000Z',
        },
        [
          {
            startsAt: new Date('2026-06-15T15:30:00.000Z'),
            endsAt: new Date('2026-06-15T16:30:00.000Z'),
          },
        ],
      ),
    ).toBe(true);
  });
});
