import { AppError } from '../../common/errors/app-error';
import {
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  pgSqlState,
  slotTakenError,
} from './booking-errors';

describe('booking conflict mapping', () => {
  it('extracts SQLSTATE from a raw pg error', () => {
    expect(pgSqlState({ code: '23P01' })).toBe('23P01');
  });

  it('extracts SQLSTATE from Prisma P2010 meta.code', () => {
    const error = {
      code: 'P2010',
      meta: { code: '23505', message: 'duplicate key value' },
    };
    expect(pgSqlState(error)).toBe('23505');
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('walks nested causes defensively', () => {
    const error = {
      code: 'P2010',
      cause: {
        driverAdapterError: {
          cause: { code: '23503', message: 'foreign key' },
        },
      },
    };
    expect(pgSqlState(error)).toBe('23503');
    expect(isForeignKeyViolation(error)).toBe(true);
  });

  it('classifies exclusion, unique and other errors', () => {
    expect(isExclusionViolation({ meta: { code: '23P01' } })).toBe(true);
    expect(isExclusionViolation({ meta: { code: '23505' } })).toBe(false);
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23P01' } })).toBe(false);
    expect(isForeignKeyViolation({ code: 'P2003' })).toBe(true);
    expect(pgSqlState(new Error('offline'))).toBeUndefined();
  });

  it('builds the 409 SLOT_TAKEN problem with alternatives', () => {
    const error = slotTakenError('space-1', [
      {
        startsAt: '2026-06-15T16:00:00.000Z',
        endsAt: '2026-06-15T17:00:00.000Z',
        priceMinor: '18000',
        currency: 'COP',
      },
    ]);

    expect(error).toBeInstanceOf(AppError);
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe('SLOT_TAKEN');
    expect(error.details).toEqual({
      spaceId: 'space-1',
      alternatives: [
        {
          startsAt: '2026-06-15T16:00:00.000Z',
          endsAt: '2026-06-15T17:00:00.000Z',
          priceMinor: '18000',
          currency: 'COP',
        },
      ],
    });
  });
});
