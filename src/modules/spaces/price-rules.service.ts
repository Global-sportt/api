import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MAX_PRICE_RULES,
  PRICE_RULE_CURRENCY_PATTERN,
  type PriceRuleDto,
  type ReplacePriceRulesDto,
} from './dto/price-rules.dto';

const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

export interface PriceRuleResponse {
  id: string;
  dayOfWeek: number | null;
  startsAtMinutes: number;
  endsAtMinutes: number;
  /** Minor units serialized as a decimal string (BigInt-safe JSON). */
  amountMinor: string;
  currency: string;
  priority: number;
}

export interface PriceRulesResponse {
  rules: PriceRuleResponse[];
}

/**
 * One rejected pair of the price grid. `constraints` mirrors the codes used by
 * the global ValidationPipe (`range`, `ambiguousOverlap`, `matchesCurrency`)
 * and `ranges` carries the conflicting windows so a client can highlight them.
 */
export interface PriceRuleConflict {
  field: string;
  constraints: string[];
  message: string;
  dayOfWeek: number | null;
  priority: number;
  ranges: Array<{ startsAtMinutes: number; endsAtMinutes: number }>;
  indexes: number[];
}

interface PriceRuleRange {
  startsAtMinutes: number;
  endsAtMinutes: number;
}

/**
 * Pure validation of the price grid cross-field rules.
 *
 * - A range must end after it starts.
 * - Two rules with the same priority cannot overlap when their days can
 *   coincide: equal day, or either of them with `dayOfWeek = null` (a wildcard
 *   that applies every day). Touching ranges (09:00-12:00 and 12:00-14:00) are
 *   valid and rules with different priorities may overlap because precedence
 *   is unambiguous.
 */
export function findPriceRuleConflicts(
  rules: readonly PriceRuleDto[],
): PriceRuleConflict[] {
  const conflicts: PriceRuleConflict[] = [];
  // A pair is evaluated once (i < j) and identical messages are collapsed.
  const seenMessages = new Set<string>();
  const pushConflict = (conflict: PriceRuleConflict): void => {
    if (seenMessages.has(conflict.message)) return;
    seenMessages.add(conflict.message);
    conflicts.push(conflict);
  };

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.endsAtMinutes <= rule.startsAtMinutes) {
      pushConflict({
        field: `rules[${index}]`,
        constraints: ['range'],
        message: `La regla ${index + 1} (${formatRange(rule)}) debe terminar después de iniciar.`,
        dayOfWeek: rule.dayOfWeek ?? null,
        priority: rule.priority ?? 0,
        ranges: [toRange(rule)],
        indexes: [index],
      });
    }
  }

  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < rules.length;
      rightIndex += 1
    ) {
      const left = rules[leftIndex];
      const right = rules[rightIndex];

      if ((left.priority ?? 0) !== (right.priority ?? 0)) continue;
      if (!rangesIntersect(left, right)) continue;
      if (!daysIntersect(left.dayOfWeek, right.dayOfWeek)) continue;

      pushConflict({
        field: `rules[${rightIndex}]`,
        constraints: ['ambiguousOverlap'],
        message: `Las reglas ${leftIndex + 1} (${describeRule(left)}) y ${rightIndex + 1} (${describeRule(right)}) se cruzan con la misma prioridad y día.`,
        dayOfWeek: right.dayOfWeek ?? left.dayOfWeek ?? null,
        priority: left.priority ?? 0,
        ranges: [toRange(left), toRange(right)],
        indexes: [leftIndex, rightIndex],
      });
    }
  }

  return conflicts;
}

export function assertValidPriceRules(
  rules: readonly PriceRuleDto[],
  establishmentCurrency: string,
): void {
  if (rules.length > MAX_PRICE_RULES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `La grilla admite como máximo ${MAX_PRICE_RULES} reglas de precio por cancha.`,
      [{ field: 'rules', constraints: ['maxSize'] }],
    );
  }

  const conflicts = findPriceRuleConflicts(rules);
  if (conflicts.length > 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `La grilla de precios tiene conflictos: ${conflicts
        .map((conflict) => conflict.message)
        .join(' ')}`,
      conflicts,
    );
  }

  const currencyIssues = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => {
      const currency = rule.currency ?? establishmentCurrency;
      return (
        !PRICE_RULE_CURRENCY_PATTERN.test(currency) ||
        currency.toUpperCase() !== establishmentCurrency.toUpperCase()
      );
    });

  if (currencyIssues.length > 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `La moneda de las reglas debe coincidir con la del establecimiento (${establishmentCurrency}).`,
      currencyIssues.map(({ rule, index }) => ({
        field: `rules[${index}].currency`,
        constraints: [
          PRICE_RULE_CURRENCY_PATTERN.test(rule.currency ?? establishmentCurrency)
            ? 'matchesCurrency'
            : 'matches',
        ],
      })),
    );
  }
}

@Injectable()
export class PriceRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async getPriceRules(
    establishmentId: string,
    spaceId: string,
  ): Promise<PriceRulesResponse> {
    await this.requireEstablishment(establishmentId);
    await this.requireSpace(establishmentId, spaceId);

    const rules = await this.prisma.priceRule.findMany({ where: { spaceId } });

    return { rules: rules.map(toPriceRuleResponse).sort(comparePriceRules) };
  }

  /**
   * Replaces the whole price grid inside one transaction. The previous rows
   * are removed even when the new grid is empty, so a PUT always leaves the
   * space with exactly the submitted rules. Existing bookings keep the
   * `totalMinor` they were created with; this operation never touches them.
   */
  async replacePriceRules(
    establishmentId: string,
    spaceId: string,
    dto: ReplacePriceRulesDto,
  ): Promise<PriceRulesResponse> {
    const establishment = await this.requireEstablishment(establishmentId);
    await this.requireSpace(establishmentId, spaceId);

    const rules = dto.rules ?? [];
    assertValidPriceRules(rules, establishment.currency);

    const data = rules.map((rule) => ({
      spaceId,
      dayOfWeek: rule.dayOfWeek ?? null,
      startsAtMinutes: rule.startsAtMinutes,
      endsAtMinutes: rule.endsAtMinutes,
      amountMinor: BigInt(rule.amountMinor),
      currency: (rule.currency ?? establishment.currency).toUpperCase(),
      priority: rule.priority ?? 0,
    }));

    await this.prisma.$transaction(async (tx) => {
      await tx.priceRule.deleteMany({ where: { spaceId } });
      if (data.length > 0) {
        await tx.priceRule.createMany({ data });
      }
    });

    return this.getPriceRules(establishmentId, spaceId);
  }

  private async requireEstablishment(
    establishmentId: string,
  ): Promise<{ id: string; currency: string }> {
    const establishment = await this.prisma.establishment.findUnique({
      where: { id: establishmentId },
      select: { id: true, currency: true },
    });

    if (!establishment) {
      throw new AppError(
        404,
        'ESTABLISHMENT_NOT_FOUND',
        'El establecimiento no existe.',
      );
    }

    return establishment;
  }

  private async requireSpace(
    establishmentId: string,
    spaceId: string,
  ): Promise<{ id: string }> {
    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, establishmentId },
      select: { id: true },
    });

    if (!space) {
      throw new AppError(
        404,
        'SPACE_NOT_FOUND',
        'La cancha no existe en este establecimiento.',
      );
    }

    return space;
  }
}

function rangesIntersect(left: PriceRuleRange, right: PriceRuleRange): boolean {
  return (
    left.startsAtMinutes < right.endsAtMinutes &&
    right.startsAtMinutes < left.endsAtMinutes
  );
}

function daysIntersect(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  return left == null || right == null || left === right;
}

function toRange(range: PriceRuleRange): PriceRuleRange {
  return {
    startsAtMinutes: range.startsAtMinutes,
    endsAtMinutes: range.endsAtMinutes,
  };
}

function describeRule(rule: PriceRuleDto): string {
  return `${rule.dayOfWeek == null ? 'todos los días' : dayName(rule.dayOfWeek)} ${formatRange(rule)} · prioridad ${rule.priority ?? 0}`;
}

function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? `día ${dayOfWeek}`;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatRange(range: PriceRuleRange): string {
  return `${formatMinutes(range.startsAtMinutes)}-${formatMinutes(range.endsAtMinutes)}`;
}

function toPriceRuleResponse(rule: {
  id: string;
  dayOfWeek: number | null;
  startsAtMinutes: number;
  endsAtMinutes: number;
  amountMinor: bigint;
  currency: string;
  priority: number;
}): PriceRuleResponse {
  return {
    id: rule.id,
    dayOfWeek: rule.dayOfWeek,
    startsAtMinutes: rule.startsAtMinutes,
    endsAtMinutes: rule.endsAtMinutes,
    amountMinor: rule.amountMinor.toString(),
    currency: rule.currency,
    priority: rule.priority,
  };
}

/**
 * Same precedence used by the slot generator: higher priority first, then the
 * earlier start, then the earlier end, then the day-specific rule.
 */
function comparePriceRules(
  left: PriceRuleResponse,
  right: PriceRuleResponse,
): number {
  if (left.priority !== right.priority) return right.priority - left.priority;

  if (left.startsAtMinutes !== right.startsAtMinutes) {
    return left.startsAtMinutes - right.startsAtMinutes;
  }
  if (left.endsAtMinutes !== right.endsAtMinutes) {
    return left.endsAtMinutes - right.endsAtMinutes;
  }

  const leftSpecific = left.dayOfWeek != null ? 1 : 0;
  const rightSpecific = right.dayOfWeek != null ? 1 : 0;
  if (leftSpecific !== rightSpecific) return rightSpecific - leftSpecific;

  return left.id.localeCompare(right.id);
}
