import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppLogger } from '../../common/logging/app-logger.service';
import {
  getZonedDateTimeParts,
  isValidDateOnly,
  wallClockToUtc,
} from '../../common/time/zoned-time';
import { PrismaService } from '../../prisma/prisma.service';
import { isUniqueViolation } from './booking-errors';
import type { ListDayClosesQueryDto } from './dto/day-close.dto';

/** Rango máximo que un listado de cierres puede abarcar, en días inclusivos. */
export const DAY_CLOSE_MAX_RANGE_DAYS = 92;

/**
 * Estados que entran en la foto del cierre. `no_show` suma al total y al
 * conteo de reservas (es una reserva que consumió la franja); `cancelled`,
 * `expired` y `pending_payment` quedan fuera.
 */
const INCLUDED_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.confirmed,
  BookingStatus.checked_in,
  BookingStatus.completed,
  BookingStatus.no_show,
];

const INCLUDED_STATUS_SET = new Set<BookingStatus>(INCLUDED_BOOKING_STATUSES);

export interface DayBookingSnapshotRow {
  spaceId: string;
  status: BookingStatus;
  totalMinor: bigint;
}

export interface DaySpaceSnapshot {
  spaceId: string;
  bookingsCount: number;
  noShowCount: number;
  totalMinor: bigint;
}

export interface DaySnapshot {
  bookingsCount: number;
  noShowCount: number;
  cancelledCount: number;
  totalMinor: bigint;
  spaces: DaySpaceSnapshot[];
}

export interface DayCloseSpaceTotalResponse {
  spaceId: string;
  bookingsCount: number;
  noShowCount: number;
  totalMinor: string;
}

export interface DayCloseResponse {
  id: string;
  establishmentId: string;
  date: string;
  closedAt: string;
  closedByUserId: string;
  reopenedAt: string | null;
  reopenedByUserId: string | null;
  bookingsCount: number;
  noShowCount: number;
  cancelledCount: number;
  totalMinor: string;
  currency: string;
  spaceTotals: DayCloseSpaceTotalResponse[];
}

export interface CloseDayResult {
  dayClose: DayCloseResponse;
  /** False when the snapshot of a reopened day was recalculated. */
  created: boolean;
}

type DayCloseWithTotals = Prisma.DayCloseGetPayload<{
  include: { spaceTotals: true };
}>;

/**
 * Calcula la foto diaria a partir de las reservas cuyo `startsAt` cae en el
 * día local. La regla de inclusión vive aquí (y no en SQL) para que sea
 * verificable de forma aislada: canceladas, expiradas y holds no suman.
 */
export function summarizeDayBookings(
  rows: readonly DayBookingSnapshotRow[],
): DaySnapshot {
  const perSpace = new Map<string, DaySpaceSnapshot>();
  let bookingsCount = 0;
  let noShowCount = 0;
  let cancelledCount = 0;
  let totalMinor = 0n;

  for (const row of rows) {
    if (row.status === BookingStatus.cancelled) {
      cancelledCount += 1;
      continue;
    }

    if (!INCLUDED_STATUS_SET.has(row.status)) continue;

    const current = perSpace.get(row.spaceId) ?? {
      spaceId: row.spaceId,
      bookingsCount: 0,
      noShowCount: 0,
      totalMinor: 0n,
    };

    current.bookingsCount += 1;
    current.totalMinor += row.totalMinor;
    if (row.status === BookingStatus.no_show) current.noShowCount += 1;
    perSpace.set(row.spaceId, current);

    bookingsCount += 1;
    totalMinor += row.totalMinor;
    if (row.status === BookingStatus.no_show) noShowCount += 1;
  }

  return {
    bookingsCount,
    noShowCount,
    cancelledCount,
    totalMinor,
    spaces: [...perSpace.values()].sort((a, b) =>
      a.spaceId.localeCompare(b.spaceId),
    ),
  };
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona horaria de la sede. */
export function formatLocalDate(instant: Date, timezone: string): string {
  const parts = getZonedDateTimeParts(instant, timezone);
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}

/**
 * Guard reutilizable del bloqueo operativo: un día con cierre vigente (no
 * reabierto) no admite crear, mover ni cancelar reservas. Lo usan las rutas de
 * reservas antes de escribir.
 */
export async function assertDayNotClosed(
  prisma: Pick<PrismaService, 'dayClose'>,
  establishmentId: string,
  localDate: string,
): Promise<void> {
  const close = await prisma.dayClose.findUnique({
    where: {
      establishmentId_date: {
        establishmentId,
        date: dateOnlyToUtc(localDate),
      },
    },
    select: { reopenedAt: true },
  });

  if (close && close.reopenedAt === null) {
    throw new AppError(
      409,
      'DAY_CLOSED',
      `El día ${localDate} está cerrado; no admite cambios en reservas.`,
    );
  }
}

/**
 * Variante por instante: resuelve el día local con la zona horaria de la sede
 * y aplica el mismo guard. Evita que cada ruta reimplemente la conversión.
 */
export async function assertDayOpenForInstant(
  prisma: Pick<PrismaService, 'dayClose'>,
  establishmentId: string,
  startsAt: Date,
  timezone: string,
): Promise<void> {
  await assertDayNotClosed(
    prisma,
    establishmentId,
    formatLocalDate(startsAt, timezone),
  );
}

@Injectable()
export class DayCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Cierra el día local de la sede y congela los totales. Un día ya cerrado
   * responde 409; si fue reabierto, se recalcula la foto sobre el mismo
   * registro (no se crea uno nuevo).
   */
  async closeDay(
    actorId: string,
    establishmentId: string,
    date: string,
  ): Promise<CloseDayResult> {
    const localDate = requireDateOnly(date, 'date');

    const establishment = await this.prisma.establishment.findUnique({
      where: { id: establishmentId },
      select: { timezone: true, currency: true },
    });

    if (!establishment) {
      throw new AppError(
        404,
        'ESTABLISHMENT_NOT_FOUND',
        'El establecimiento no existe.',
      );
    }

    const bounds = localDayBounds(localDate, establishment.timezone);
    const rows = await this.prisma.booking.findMany({
      where: {
        establishmentId,
        startsAt: { gte: bounds.start, lt: bounds.end },
      },
      select: { spaceId: true, status: true, totalMinor: true },
    });

    const snapshot = summarizeDayBookings(rows);
    const closedAt = new Date();

    let result: { row: DayCloseWithTotals; created: boolean };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.dayClose.findUnique({
          where: {
            establishmentId_date: {
              establishmentId,
              date: dateOnlyToUtc(localDate),
            },
          },
          select: { id: true, reopenedAt: true },
        });

        if (existing && existing.reopenedAt === null) {
          throw dayAlreadyClosed(localDate);
        }

        const spaceTotals = snapshot.spaces.map((space) => ({
          spaceId: space.spaceId,
          bookingsCount: space.bookingsCount,
          noShowCount: space.noShowCount,
          totalMinor: space.totalMinor,
        }));

        if (existing) {
          await tx.dayCloseSpaceTotal.deleteMany({
            where: { dayCloseId: existing.id },
          });

          const row = await tx.dayClose.update({
            where: { id: existing.id },
            data: {
              closedAt,
              closedByUserId: actorId,
              reopenedAt: null,
              reopenedByUserId: null,
              bookingsCount: snapshot.bookingsCount,
              noShowCount: snapshot.noShowCount,
              cancelledCount: snapshot.cancelledCount,
              totalMinor: snapshot.totalMinor,
              currency: establishment.currency,
              spaceTotals: { create: spaceTotals },
            },
            include: { spaceTotals: true },
          });

          return { row, created: false };
        }

        const row = await tx.dayClose.create({
          data: {
            establishmentId,
            date: dateOnlyToUtc(localDate),
            closedAt,
            closedByUserId: actorId,
            bookingsCount: snapshot.bookingsCount,
            noShowCount: snapshot.noShowCount,
            cancelledCount: snapshot.cancelledCount,
            totalMinor: snapshot.totalMinor,
            currency: establishment.currency,
            spaceTotals: { create: spaceTotals },
          },
          include: { spaceTotals: true },
        });

        return { row, created: true };
      });
    } catch (error) {
      // Dos cierres concurrentes compiten por (establishment_id, date): el
      // perdedor debe ver el mismo 409 que un reintento secuencial.
      if (isUniqueViolation(error)) throw dayAlreadyClosed(localDate);
      throw error;
    }

    this.audit('day.closed', {
      actorId,
      establishmentId,
      date: localDate,
      bookingsCount: snapshot.bookingsCount,
      noShowCount: snapshot.noShowCount,
      cancelledCount: snapshot.cancelledCount,
      totalMinor: snapshot.totalMinor.toString(),
      spaces: snapshot.spaces.length,
      reclose: !result.created,
    });

    return {
      dayClose: toDayCloseResponse(result.row),
      created: result.created,
    };
  }

  async getByDate(
    establishmentId: string,
    date: string,
  ): Promise<DayCloseResponse> {
    const localDate = requireDateOnly(date, 'date');

    const row = await this.prisma.dayClose.findUnique({
      where: {
        establishmentId_date: {
          establishmentId,
          date: dateOnlyToUtc(localDate),
        },
      },
      include: { spaceTotals: true },
    });

    if (!row) throw dayCloseNotFound();

    return toDayCloseResponse(row);
  }

  async list(
    establishmentId: string,
    query: ListDayClosesQueryDto,
  ): Promise<DayCloseResponse[]> {
    const from = requireDateOnly(query.from, 'from');
    const to = requireDateOnly(query.to, 'to');
    const fromUtc = dateOnlyToUtc(from);
    const toUtc = dateOnlyToUtc(to);

    if (toUtc.getTime() < fromUtc.getTime()) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'from debe ser anterior o igual a to.',
        [{ field: 'to', constraints: ['isAfterFrom'] }],
      );
    }

    const days =
      Math.round((toUtc.getTime() - fromUtc.getTime()) / 86_400_000) + 1;

    if (days > DAY_CLOSE_MAX_RANGE_DAYS) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `El rango máximo de consulta es de ${DAY_CLOSE_MAX_RANGE_DAYS} días.`,
        [{ field: 'to', constraints: ['maxRangeDays'] }],
      );
    }

    const rows = await this.prisma.dayClose.findMany({
      where: {
        establishmentId,
        date: { gte: fromUtc, lte: toUtc },
      },
      include: { spaceTotals: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toDayCloseResponse);
  }

  /**
   * Reapertura: solo dueño o plataforma (el permiso `establishment:update`
   * vive en Cerbos). Reabrir un día ya reabierto es 409 y no reescribe la
   * auditoría anterior.
   */
  async reopen(
    actorId: string,
    establishmentId: string,
    date: string,
  ): Promise<DayCloseResponse> {
    const localDate = requireDateOnly(date, 'date');
    const dateValue = dateOnlyToUtc(localDate);

    const existing = await this.prisma.dayClose.findUnique({
      where: {
        establishmentId_date: { establishmentId, date: dateValue },
      },
      select: {
        id: true,
        reopenedAt: true,
        bookingsCount: true,
        noShowCount: true,
        cancelledCount: true,
        totalMinor: true,
      },
    });

    if (!existing) throw dayCloseNotFound();
    if (existing.reopenedAt !== null) throw dayAlreadyReopened(localDate);

    const changed = await this.prisma.dayClose.updateMany({
      where: { id: existing.id, reopenedAt: null },
      data: { reopenedAt: new Date(), reopenedByUserId: actorId },
    });

    // Otra petición reabrió primero: el estado final es el mismo 409.
    if (changed.count === 0) throw dayAlreadyReopened(localDate);

    const row = await this.prisma.dayClose.findUniqueOrThrow({
      where: { id: existing.id },
      include: { spaceTotals: true },
    });

    this.audit('day.reopened', {
      actorId,
      establishmentId,
      date: localDate,
      bookingsCount: existing.bookingsCount,
      noShowCount: existing.noShowCount,
      cancelledCount: existing.cancelledCount,
      totalMinor: existing.totalMinor.toString(),
    });

    return toDayCloseResponse(row);
  }

  private audit(event: string, fields: Record<string, unknown>): void {
    this.logger.raw.info(
      {
        event,
        ...fields,
        decision: 'allow',
      },
      event,
    );
  }
}

function localDayBounds(
  date: string,
  timezone: string,
): { start: Date; end: Date } {
  return {
    start: wallClockToUtc(date, 0, timezone).instant,
    end: wallClockToUtc(date, 1440, timezone).instant,
  };
}

function dateOnlyToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function requireDateOnly(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidDateOnly(value)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${field} debe ser una fecha YYYY-MM-DD válida.`,
      [{ field, constraints: ['isDateOnly'] }],
    );
  }

  return value;
}

function toDayCloseResponse(row: DayCloseWithTotals): DayCloseResponse {
  return {
    id: row.id,
    establishmentId: row.establishmentId,
    date: formatDateOnly(row.date),
    closedAt: row.closedAt.toISOString(),
    closedByUserId: row.closedByUserId,
    reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
    reopenedByUserId: row.reopenedByUserId,
    bookingsCount: row.bookingsCount,
    noShowCount: row.noShowCount,
    cancelledCount: row.cancelledCount,
    totalMinor: row.totalMinor.toString(),
    currency: row.currency,
    spaceTotals: [...row.spaceTotals]
      .sort((a, b) => a.spaceId.localeCompare(b.spaceId))
      .map((total) => ({
        spaceId: total.spaceId,
        bookingsCount: total.bookingsCount,
        noShowCount: total.noShowCount,
        totalMinor: total.totalMinor.toString(),
      })),
  };
}

function dayAlreadyClosed(localDate: string): AppError {
  return new AppError(
    409,
    'DAY_ALREADY_CLOSED',
    `El día ${localDate} ya está cerrado.`,
  );
}

function dayAlreadyReopened(localDate: string): AppError {
  return new AppError(
    409,
    'DAY_ALREADY_REOPENED',
    `El día ${localDate} ya está reabierto.`,
  );
}

function dayCloseNotFound(): AppError {
  return new AppError(
    404,
    'DAY_CLOSE_NOT_FOUND',
    'No hay un cierre para esa fecha.',
  );
}
