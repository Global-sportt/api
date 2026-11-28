import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { isValidDateOnly, parseDateOnly } from '../../common/time/zoned-time';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MAX_EXCEPTION_RANGE_DAYS,
  MAX_OPERATING_HOURS,
  type ReplaceOperatingHoursDto,
  type ScheduleExceptionsQueryDto,
  type UpsertScheduleExceptionDto,
} from './dto/schedule.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

export interface OperatingHourResponse {
  dayOfWeek: number;
  opensAtMinutes: number;
  closesAtMinutes: number;
}

export interface OperatingHoursResponse {
  hours: OperatingHourResponse[];
}

export interface ScheduleExceptionResponse {
  date: string;
  isClosed: boolean;
  opensAtMinutes: number | null;
  closesAtMinutes: number | null;
  reason: string | null;
}

export interface ScheduleExceptionsResponse {
  exceptions: ScheduleExceptionResponse[];
}

export interface OperatingHourRange {
  opensAtMinutes: number;
  closesAtMinutes: number;
}

export interface OperatingHourInput extends OperatingHourRange {
  dayOfWeek: number;
}

/**
 * One rejected input of the weekly grid. `constraints` mirrors the codes used
 * by the global ValidationPipe (`range`, `duplicate`, `overlap`) and `ranges`
 * carries the conflicting windows so a client can highlight them.
 */
export interface OperatingHourConflict {
  field: string;
  dayOfWeek: number;
  constraints: string[];
  message: string;
  ranges: OperatingHourRange[];
}

/**
 * Pure validation of the weekly grid. Returns every conflict instead of
 * failing on the first one so the client can fix the whole request at once.
 *
 * - A window must end after it starts.
 * - Two windows of the same day cannot share the opening minute (duplicate).
 * - Two windows of the same day cannot overlap; touching windows
 *   (09:00-12:00 and 12:00-18:00) are valid.
 */
export function findOperatingHourConflicts(
  hours: readonly OperatingHourInput[],
): OperatingHourConflict[] {
  const conflicts: OperatingHourConflict[] = [];
  // A pair is evaluated once (i < j) and identical messages are collapsed, so
  // three equal windows do not produce three copies of the same conflict.
  const seenMessages = new Set<string>();
  const pushConflict = (conflict: OperatingHourConflict): void => {
    if (seenMessages.has(conflict.message)) return;
    seenMessages.add(conflict.message);
    conflicts.push(conflict);
  };

  for (let index = 0; index < hours.length; index += 1) {
    const hour = hours[index];
    if (hour.closesAtMinutes <= hour.opensAtMinutes) {
      pushConflict({
        field: `hours[${index}]`,
        dayOfWeek: hour.dayOfWeek,
        constraints: ['range'],
        message: `El ${dayName(hour.dayOfWeek)}: la franja ${formatRange(hour)} debe terminar después de iniciar.`,
        ranges: [toRange(hour)],
      });
    }
  }

  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    const dayHours = hours
      .map((hour, index) => ({ hour, index }))
      .filter(
        ({ hour }) =>
          hour.dayOfWeek === dayOfWeek &&
          hour.closesAtMinutes > hour.opensAtMinutes,
      )
      .sort(
        (left, right) =>
          left.hour.opensAtMinutes - right.hour.opensAtMinutes ||
          left.hour.closesAtMinutes - right.hour.closesAtMinutes,
      );

    // Every pair of the same day is checked, not only adjacent windows: a wide
    // window can overlap two smaller ones that do not touch each other.
    for (let leftIndex = 0; leftIndex < dayHours.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < dayHours.length;
        rightIndex += 1
      ) {
        const left = dayHours[leftIndex];
        const right = dayHours[rightIndex];

        if (right.hour.opensAtMinutes === left.hour.opensAtMinutes) {
          pushConflict({
            field: `hours[${right.index}]`,
            dayOfWeek,
            constraints: ['duplicate'],
            message: `El ${dayName(dayOfWeek)}: la franja ${formatRange(right.hour)} está duplicada (${formatRange(left.hour)}).`,
            ranges: [toRange(left.hour), toRange(right.hour)],
          });
          continue;
        }

        if (right.hour.opensAtMinutes < left.hour.closesAtMinutes) {
          pushConflict({
            field: `hours[${right.index}]`,
            dayOfWeek,
            constraints: ['overlap'],
            message: `El ${dayName(dayOfWeek)}: las franjas ${formatRange(left.hour)} y ${formatRange(right.hour)} se cruzan.`,
            ranges: [toRange(left.hour), toRange(right.hour)],
          });
        }
      }
    }
  }

  return conflicts;
}

export function assertValidOperatingHours(
  hours: readonly OperatingHourInput[],
): void {
  if (hours.length > MAX_OPERATING_HOURS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `La grilla admite como máximo ${MAX_OPERATING_HOURS} franjas por cancha.`,
      [{ field: 'hours', constraints: ['maxSize'] }],
    );
  }

  const conflicts = findOperatingHourConflicts(hours);
  if (conflicts.length > 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `La grilla de horarios tiene conflictos: ${conflicts
        .map((conflict) => conflict.message)
        .join(' ')}`,
      conflicts,
    );
  }
}

@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async getOperatingHours(
    establishmentId: string,
    spaceId: string,
  ): Promise<OperatingHoursResponse> {
    await this.requireSpace(establishmentId, spaceId);

    const hours = await this.prisma.operatingHour.findMany({
      where: { spaceId },
      orderBy: [{ dayOfWeek: 'asc' }, { opensAtMinutes: 'asc' }],
      select: {
        dayOfWeek: true,
        opensAtMinutes: true,
        closesAtMinutes: true,
      },
    });

    return { hours: hours.map(toOperatingHourResponse) };
  }

  /**
   * Replaces the whole weekly grid inside one transaction. The previous rows
   * are removed even when the new grid is empty, so a PUT always leaves the
   * space with exactly the submitted windows.
   */
  async replaceOperatingHours(
    establishmentId: string,
    spaceId: string,
    dto: ReplaceOperatingHoursDto,
  ): Promise<OperatingHoursResponse> {
    const hours = dto.hours ?? [];
    assertValidOperatingHours(hours);

    await this.requireSpace(establishmentId, spaceId);

    await this.prisma.$transaction(async (tx) => {
      await tx.operatingHour.deleteMany({ where: { spaceId } });
      if (hours.length > 0) {
        await tx.operatingHour.createMany({
          data: hours.map((hour) => ({
            spaceId,
            dayOfWeek: hour.dayOfWeek,
            opensAtMinutes: hour.opensAtMinutes,
            closesAtMinutes: hour.closesAtMinutes,
          })),
        });
      }
    });

    return this.getOperatingHours(establishmentId, spaceId);
  }

  async listExceptions(
    establishmentId: string,
    spaceId: string,
    query: ScheduleExceptionsQueryDto,
  ): Promise<ScheduleExceptionsResponse> {
    this.assertDateOnly(query.from, 'from');
    this.assertDateOnly(query.to, 'to');

    const from = toDateOnly(query.from);
    const to = toDateOnly(query.to);

    if (from.getTime() > to.getTime()) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'from no puede ser posterior a to.',
        [{ field: 'from', constraints: ['range'] }],
      );
    }

    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_EXCEPTION_RANGE_DAYS) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `El rango de fechas admite como máximo ${MAX_EXCEPTION_RANGE_DAYS} días.`,
        [{ field: 'to', constraints: ['maxRange'] }],
      );
    }

    await this.requireSpace(establishmentId, spaceId);

    const exceptions = await this.prisma.scheduleException.findMany({
      where: { spaceId, date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });

    return { exceptions: exceptions.map(toScheduleExceptionResponse) };
  }

  async upsertException(
    establishmentId: string,
    spaceId: string,
    date: string,
    dto: UpsertScheduleExceptionDto,
  ): Promise<ScheduleExceptionResponse> {
    this.assertDateOnly(date, 'date');
    const valid = this.validateExceptionInput(dto);

    await this.requireSpace(establishmentId, spaceId);

    const dateOnly = toDateOnly(date);
    const exception = await this.prisma.scheduleException.upsert({
      where: { spaceId_date: { spaceId, date: dateOnly } },
      create: {
        spaceId,
        date: dateOnly,
        isClosed: dto.isClosed,
        opensAtMinutes: valid.opensAtMinutes,
        closesAtMinutes: valid.closesAtMinutes,
        reason: valid.reason,
      },
      update: {
        isClosed: dto.isClosed,
        opensAtMinutes: valid.opensAtMinutes,
        closesAtMinutes: valid.closesAtMinutes,
        reason: valid.reason,
      },
    });

    return toScheduleExceptionResponse(exception);
  }

  async deleteException(
    establishmentId: string,
    spaceId: string,
    date: string,
  ): Promise<void> {
    this.assertDateOnly(date, 'date');
    await this.requireSpace(establishmentId, spaceId);

    const deleted = await this.prisma.scheduleException.deleteMany({
      where: { spaceId, date: toDateOnly(date) },
    });

    if (deleted.count === 0) {
      throw new AppError(
        404,
        'SCHEDULE_EXCEPTION_NOT_FOUND',
        'La excepción de horario no existe para esa fecha.',
      );
    }
  }

  private validateExceptionInput(dto: UpsertScheduleExceptionDto): {
    opensAtMinutes: number | null;
    closesAtMinutes: number | null;
    reason: string | null;
  } {
    const reason = dto.reason?.trim() ? dto.reason.trim() : null;
    const hasOpens = dto.opensAtMinutes !== undefined;
    const hasCloses = dto.closesAtMinutes !== undefined;

    if (dto.isClosed) {
      if (hasOpens || hasCloses) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Una excepción cerrada no admite horario de apertura ni cierre.',
          [
            { field: 'opensAtMinutes', constraints: ['isClosed'] },
            { field: 'closesAtMinutes', constraints: ['isClosed'] },
          ],
        );
      }

      return { opensAtMinutes: null, closesAtMinutes: null, reason };
    }

    if (!hasOpens || !hasCloses) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Una excepción abierta requiere opensAtMinutes y closesAtMinutes.',
        [
          ...(hasOpens ? [] : [{ field: 'opensAtMinutes', constraints: ['required'] }]),
          ...(hasCloses ? [] : [{ field: 'closesAtMinutes', constraints: ['required'] }]),
        ],
      );
    }

    const opensAtMinutes = dto.opensAtMinutes as number;
    const closesAtMinutes = dto.closesAtMinutes as number;

    if (closesAtMinutes <= opensAtMinutes) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `La franja de la excepción ${formatRange({ opensAtMinutes, closesAtMinutes })} debe terminar después de iniciar.`,
        [{ field: 'closesAtMinutes', constraints: ['range'] }],
      );
    }

    return { opensAtMinutes, closesAtMinutes, reason };
  }

  private assertDateOnly(value: string | undefined, field: string): void {
    if (typeof value !== 'string' || !isValidDateOnly(value)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `${field} debe ser una fecha válida en formato YYYY-MM-DD.`,
        [{ field, constraints: ['isCalendarDate'] }],
      );
    }
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

function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? `día ${dayOfWeek}`;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatRange(range: OperatingHourRange): string {
  return `${formatMinutes(range.opensAtMinutes)}-${formatMinutes(range.closesAtMinutes)}`;
}

function toRange(range: OperatingHourRange): OperatingHourRange {
  return {
    opensAtMinutes: range.opensAtMinutes,
    closesAtMinutes: range.closesAtMinutes,
  };
}

function toDateOnly(date: string): Date {
  const parts = parseDateOnly(date);
  if (!parts) {
    throw new RangeError(`Fecha inválida: ${date}. Se espera YYYY-MM-DD.`);
  }
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function toOperatingHourResponse(hour: OperatingHourResponse): OperatingHourResponse {
  return {
    dayOfWeek: hour.dayOfWeek,
    opensAtMinutes: hour.opensAtMinutes,
    closesAtMinutes: hour.closesAtMinutes,
  };
}

function toScheduleExceptionResponse(exception: {
  date: Date;
  isClosed: boolean;
  opensAtMinutes: number | null;
  closesAtMinutes: number | null;
  reason: string | null;
}): ScheduleExceptionResponse {
  return {
    date: exception.date.toISOString().slice(0, 10),
    isClosed: exception.isClosed,
    opensAtMinutes: exception.opensAtMinutes,
    closesAtMinutes: exception.closesAtMinutes,
    reason: exception.reason,
  };
}
