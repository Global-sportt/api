import { generateSlots } from './slot-generator';
import type { SlotGeneratorInput } from './slot-generator.types';

const MONDAY = '2026-06-15';
const SATURDAY = '2026-06-20';

function baseInput(
  overrides: Partial<SlotGeneratorInput> = {},
): SlotGeneratorInput {
  return {
    space: { id: 'space-1', slotMinutes: 60, bufferMinutes: 0 },
    timezone: 'America/Bogota',
    date: MONDAY,
    currency: 'COP',
    operatingHours: [{ dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 }],
    exception: null,
    priceRules: [],
    ...overrides,
  };
}

describe('generateSlots', () => {
  it('genera las franjas de un día normal en UTC', () => {
    const slots = generateSlots(baseInput());

    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({
      startsAt: '2026-06-15T14:00:00.000Z',
      endsAt: '2026-06-15T15:00:00.000Z',
      priceMinor: '0',
      currency: 'COP',
      available: true,
    });
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-06-15T14:00:00.000Z',
      '2026-06-15T15:00:00.000Z',
      '2026-06-15T16:00:00.000Z',
    ]);
  });

  it('devuelve cero franjas cuando la excepción cierra el día', () => {
    const slots = generateSlots(
      baseInput({
        exception: {
          date: MONDAY,
          isClosed: true,
          opensAtMinutes: 10 * 60,
          closesAtMinutes: 11 * 60,
        },
      }),
    );

    expect(slots).toEqual([]);
  });

  it('usa el horario alterno de una excepción abierta', () => {
    const slots = generateSlots(
      baseInput({
        date: SATURDAY,
        operatingHours: [
          { dayOfWeek: 6, opensAtMinutes: 8 * 60, closesAtMinutes: 10 * 60 },
        ],
        exception: {
          date: SATURDAY,
          isClosed: false,
          opensAtMinutes: 14 * 60,
          closesAtMinutes: 16 * 60,
        },
      }),
    );

    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-06-20T19:00:00.000Z',
      '2026-06-20T20:00:00.000Z',
    ]);
  });

  it('aplica el buffer solo entre franjas consecutivas', () => {
    const slots = generateSlots(
      baseInput({
        space: { slotMinutes: 60, bufferMinutes: 15 },
        operatingHours: [
          { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 13 * 60 },
        ],
      }),
    );

    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-06-15T14:00:00.000Z',
      '2026-06-15T15:15:00.000Z',
      '2026-06-15T16:30:00.000Z',
    ]);
    expect(slots[2].endsAt).toBe('2026-06-15T17:30:00.000Z');
  });

  it('elige la regla de precio de mayor prioridad y día específico', () => {
    const slots = generateSlots(
      baseInput({
        priceRules: [
          {
            id: 'general',
            dayOfWeek: null,
            startsAtMinutes: 9 * 60,
            endsAtMinutes: 12 * 60,
            amountMinor: 10_000n,
            currency: 'COP',
            priority: 0,
          },
          {
            id: 'peak',
            dayOfWeek: 1,
            startsAtMinutes: 10 * 60,
            endsAtMinutes: 11 * 60,
            amountMinor: 18_000n,
            currency: 'COP',
            priority: 10,
          },
          {
            id: 'peak-general',
            dayOfWeek: null,
            startsAtMinutes: 10 * 60,
            endsAtMinutes: 11 * 60,
            amountMinor: 17_000n,
            currency: 'COP',
            priority: 10,
          },
        ],
      }),
    );

    expect(slots.map((slot) => slot.priceMinor)).toEqual([
      '10000',
      '18000',
      '10000',
    ]);
  });

  it('desempata por menor inicio y menor fin cuando la prioridad es igual', () => {
    const slots = generateSlots(
      baseInput({
        priceRules: [
          {
            id: 'wide',
            dayOfWeek: 1,
            startsAtMinutes: 9 * 60,
            endsAtMinutes: 12 * 60,
            amountMinor: 10_000n,
            currency: 'COP',
            priority: 5,
          },
          {
            id: 'narrow',
            dayOfWeek: 1,
            startsAtMinutes: 9 * 60,
            endsAtMinutes: 10 * 60,
            amountMinor: 12_000n,
            currency: 'COP',
            priority: 5,
          },
        ],
      }),
    );

    expect(slots.map((slot) => slot.priceMinor)).toEqual([
      '12000',
      '10000',
      '10000',
    ]);
  });

  it('desempata por la regla específica del día cuando prioridad y franja coinciden', () => {
    const slots = generateSlots(
      baseInput({
        priceRules: [
          {
            id: 'every-day',
            dayOfWeek: null,
            startsAtMinutes: 9 * 60,
            endsAtMinutes: 12 * 60,
            amountMinor: 10_000n,
            currency: 'COP',
            priority: 5,
          },
          {
            id: 'monday',
            dayOfWeek: 1,
            startsAtMinutes: 9 * 60,
            endsAtMinutes: 12 * 60,
            amountMinor: 14_000n,
            currency: 'COP',
            priority: 5,
          },
        ],
      }),
    );

    expect(slots.map((slot) => slot.priceMinor)).toEqual([
      '14000',
      '14000',
      '14000',
    ]);
  });

  it('usa la tarifa fija del espacio cuando ninguna regla cubre la franja', () => {
    const slots = generateSlots(
      baseInput({
        space: {
          id: 'space-1',
          slotMinutes: 60,
          bufferMinutes: 0,
          basePriceMinor: 120_000n,
        },
        priceRules: [
          {
            id: 'peak',
            dayOfWeek: 1,
            startsAtMinutes: 10 * 60,
            endsAtMinutes: 11 * 60,
            amountMinor: 18_000n,
            currency: 'COP',
            priority: 0,
          },
        ],
      }),
    );

    expect(slots.map((slot) => slot.priceMinor)).toEqual([
      '120000',
      '18000',
      '120000',
    ]);
  });

  it('usa 0 cuando no hay regla aplicable ni tarifa fija', () => {
    const slots = generateSlots(
      baseInput({
        space: {
          id: 'space-1',
          slotMinutes: 60,
          bufferMinutes: 0,
          basePriceMinor: null,
        },
      }),
    );

    expect(slots.map((slot) => slot.priceMinor)).toEqual(['0', '0', '0']);
  });

  it('ignora las reglas de otro día y aplica la tarifa fija', () => {
    const slots = generateSlots(
      baseInput({
        space: {
          id: 'space-1',
          slotMinutes: 60,
          bufferMinutes: 0,
          basePriceMinor: 90_000n,
        },
        priceRules: [
          {
            id: 'tuesday-only',
            dayOfWeek: 2,
            startsAtMinutes: 9 * 60,
            endsAtMinutes: 12 * 60,
            amountMinor: 20_000n,
            currency: 'COP',
            priority: 10,
          },
        ],
      }),
    );

    expect(slots.map((slot) => slot.priceMinor)).toEqual([
      '90000',
      '90000',
      '90000',
    ]);
  });

  it('no genera una franja que no cabe completa antes del cierre', () => {
    const slots = generateSlots(
      baseInput({
        operatingHours: [
          { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 9 * 60 + 50 },
        ],
      }),
    );

    expect(slots).toEqual([]);
  });

  it('convierte la hora local con la zona IANA del establecimiento', () => {
    const bogota = generateSlots(
      baseInput({
        operatingHours: [
          { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 10 * 60 },
        ],
      }),
    );
    const tokyo = generateSlots(
      baseInput({
        timezone: 'Asia/Tokyo',
        operatingHours: [
          { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 10 * 60 },
        ],
      }),
    );

    expect(bogota[0].startsAt).toBe('2026-06-15T14:00:00.000Z');
    expect(tokyo[0].startsAt).toBe('2026-06-15T00:00:00.000Z');
  });

  it('omite el inicio inexistente del cambio de hora de primavera', () => {
    const slots = generateSlots(
      baseInput({
        timezone: 'America/New_York',
        date: '2026-03-08',
        operatingHours: [
          { dayOfWeek: 0, opensAtMinutes: 0, closesAtMinutes: 6 * 60 },
        ],
      }),
    );

    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-03-08T05:00:00.000Z',
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      '2026-03-08T09:00:00.000Z',
    ]);
    // 01:00-02:00 local termina cuando el reloj salta a 03:00.
    expect(slots[1].endsAt).toBe('2026-03-08T07:00:00.000Z');
  });

  it('resuelve la hora ambigua del cambio de hora de otoño a la primera ocurrencia', () => {
    const slots = generateSlots(
      baseInput({
        timezone: 'America/New_York',
        date: '2026-11-01',
        operatingHours: [
          { dayOfWeek: 0, opensAtMinutes: 0, closesAtMinutes: 4 * 60 },
        ],
      }),
    );

    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
    // 01:00-02:00 local dura dos horas reales al repetirse la hora.
    expect(slots[1].endsAt).toBe('2026-11-01T07:00:00.000Z');
  });

  it('permite inyectar el filtro de disponibilidad de T6', () => {
    const slots = generateSlots(baseInput(), {
      isAvailable: (slot) => slot.startsAt !== '2026-06-15T15:00:00.000Z',
    });

    expect(slots).toHaveLength(2);
    expect(slots.every((slot) => slot.startsAt !== '2026-06-15T15:00:00.000Z')).toBe(
      true,
    );
  });

  it('rechaza una fecha de calendario inválida', () => {
    expect(() => generateSlots(baseInput({ date: '2026-02-30' }))).toThrow(
      /Fecha inválida/,
    );
  });
});
