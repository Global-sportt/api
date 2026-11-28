import { AppError } from '../../common/errors/app-error';
import type { PriceRuleDto } from './dto/price-rules.dto';
import {
  assertValidPriceRules,
  findPriceRuleConflicts,
} from './price-rules.service';

function rule(overrides: Partial<PriceRuleDto> = {}): PriceRuleDto {
  return {
    dayOfWeek: 1,
    startsAtMinutes: 9 * 60,
    endsAtMinutes: 12 * 60,
    amountMinor: 10_000,
    currency: 'COP',
    priority: 0,
    ...overrides,
  };
}

describe('findPriceRuleConflicts', () => {
  it('acepta reglas disjuntas, contiguas, de distinta prioridad o de distinto día', () => {
    const rules: PriceRuleDto[] = [
      rule({ startsAtMinutes: 9 * 60, endsAtMinutes: 12 * 60 }),
      // Contigua: comparte el minuto de cierre pero no se cruza.
      rule({ startsAtMinutes: 12 * 60, endsAtMinutes: 14 * 60 }),
      // Mismo día y franja, pero otra prioridad: la precedencia es clara.
      rule({ priority: 10 }),
      // Misma prioridad, otro día.
      rule({ dayOfWeek: 2 }),
      // Misma prioridad y franja, pero en otro día específico (y una regla
      // general ya no existe en esta lista).
      rule({ dayOfWeek: 3, priority: 0 }),
    ];

    expect(findPriceRuleConflicts(rules)).toEqual([]);
  });

  it('rechaza dos reglas solapadas con la misma prioridad y día', () => {
    const conflicts = findPriceRuleConflicts([
      rule({ startsAtMinutes: 9 * 60, endsAtMinutes: 12 * 60 }),
      rule({ startsAtMinutes: 11 * 60, endsAtMinutes: 14 * 60 }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual(
      expect.objectContaining({
        field: 'rules[1]',
        constraints: ['ambiguousOverlap'],
        dayOfWeek: 1,
        priority: 0,
        indexes: [0, 1],
        ranges: [
          { startsAtMinutes: 9 * 60, endsAtMinutes: 12 * 60 },
          { startsAtMinutes: 11 * 60, endsAtMinutes: 14 * 60 },
        ],
      }),
    );
    expect(conflicts[0].message).toContain('09:00-12:00');
    expect(conflicts[0].message).toContain('11:00-14:00');
  });

  it('trata dayOfWeek nulo como comodín en el cruce ambiguo', () => {
    const conflicts = findPriceRuleConflicts([
      rule({ dayOfWeek: null }),
      rule({ dayOfWeek: 1 }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].constraints).toEqual(['ambiguousOverlap']);
    expect(conflicts[0].message).toContain('todos los días');
  });

  it('rechaza una franja invertida', () => {
    const conflicts = findPriceRuleConflicts([
      rule({ startsAtMinutes: 15 * 60, endsAtMinutes: 14 * 60 }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual(
      expect.objectContaining({
        field: 'rules[0]',
        constraints: ['range'],
      }),
    );
  });
});

describe('assertValidPriceRules', () => {
  it('acepta una grilla válida y la moneda omitida del establecimiento', () => {
    expect(() =>
      assertValidPriceRules(
        [
          rule({ currency: undefined }),
          rule({ dayOfWeek: 2, currency: 'cop' }),
        ],
        'COP',
      ),
    ).not.toThrow();
  });

  it('rechaza una moneda distinta a la del establecimiento con detalle', () => {
    try {
      assertValidPriceRules([rule({ currency: 'USD' })], 'COP');
      throw new Error('Se esperaba un VALIDATION_ERROR');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.getStatus()).toBe(400);
      expect(appError.code).toBe('VALIDATION_ERROR');
      expect(appError.details).toEqual([
        { field: 'rules[0].currency', constraints: ['matchesCurrency'] },
      ]);
    }
  });

  it('rechaza más de 100 reglas', () => {
    const rules = Array.from({ length: 101 }, (_, index) => ({
      ...rule(),
      startsAtMinutes: index,
      endsAtMinutes: index + 1,
    }));

    expect(() => assertValidPriceRules(rules, 'COP')).toThrow(AppError);
  });
});
