import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  EstablishmentStatus,
  Prisma,
  UserStatus,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import {
  getZonedDateTimeParts,
  parseDateOnly,
  wallClockToUtc,
} from '../../common/time/zoned-time';
import { PrismaService } from '../../prisma/prisma.service';
import type { DashboardQueryDto } from './dto/dashboard-query.dto';

/**
 * Platform dashboard.
 *
 * Date boundaries are local calendar dates in `America/Bogota`, independent of
 * the server timezone. A period `[from, to]` covers `[from 00:00, to+1 00:00)`
 * local time, so both bounds are inclusive and the end is exclusive as a UTC
 * instant. `today` uses the same half-open range for the current local day.
 *
 * Metric definitions:
 * - `bookings.period`: every booking whose `startsAt` falls in the period.
 * - `bookings.today`: every booking whose `startsAt` falls in the current
 *   local day (not filtered by the requested period).
 * - `bookings.revenueMinor`: sum of `totalMinor` in the period for statuses
 *   confirmed, checked_in, completed and no_show.
 * - `topEstablishments`: at most five establishments with bookings in the
 *   period, ordered by booking count (desc), revenue (desc), name and id.
 * - `recentBookings`: at most ten bookings by `createdAt` desc, regardless of
 *   the period, with establishment, space and player display name.
 *
 * `users.total` excludes soft-deleted accounts (`deleted`), so it always
 * equals `active + suspended`.
 */

export const DASHBOARD_TIMEZONE = 'America/Bogota';
export const DASHBOARD_DEFAULT_PERIOD_DAYS = 30;
export const DASHBOARD_MAX_PERIOD_DAYS = 366;
export const DASHBOARD_TOP_ESTABLISHMENTS_LIMIT = 5;
export const DASHBOARD_RECENT_BOOKINGS_LIMIT = 10;

/**
 * Settlement currency of the platform. Establishments are provisioned with
 * COP (`Establishment.currency` default), so the aggregated revenue is
 * expressed in this currency. A multi-currency deployment would need a
 * per-currency breakdown before this aggregate can be used as-is.
 */
export const DASHBOARD_CURRENCY = 'COP';

export const REVENUE_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.confirmed,
  BookingStatus.checked_in,
  BookingStatus.completed,
  BookingStatus.no_show,
];

const BOOKING_STATUSES = Object.values(BookingStatus) as BookingStatus[];

const recentBookingSelect = {
  id: true,
  publicCode: true,
  status: true,
  startsAt: true,
  createdAt: true,
  totalMinor: true,
  currency: true,
  establishment: { select: { id: true, name: true } },
  space: { select: { id: true, name: true } },
  player: {
    select: {
      id: true,
      profile: { select: { displayName: true } },
    },
  },
} satisfies Prisma.BookingSelect;

type RecentBookingRow = Prisma.BookingGetPayload<{
  select: typeof recentBookingSelect;
}>;

export interface DashboardPeriod {
  from: string;
  to: string;
  timezone: string;
}

/** Period plus the UTC instants the queries use. */
export interface ResolvedDashboardPeriod extends DashboardPeriod {
  /** Inclusive instant of `from` 00:00 local. */
  fromInstant: Date;
  /** Exclusive instant of the day after `to`, 00:00 local. */
  toInstant: Date;
  /** Local calendar date of "today" for the reference clock. */
  today: string;
  todayStart: Date;
  todayEnd: Date;
}

export interface DashboardEstablishmentCounts {
  total: number;
  active: number;
  suspended: number;
  pending: number;
}

export interface DashboardUserCounts {
  total: number;
  active: number;
  suspended: number;
}

export interface DashboardBookingMetrics {
  period: number;
  today: number;
  byStatus: Record<BookingStatus, number>;
  revenueMinor: string;
  currency: string;
}

export interface DashboardTopEstablishment {
  id: string;
  name: string;
  bookings: number;
  revenueMinor: string;
}

export interface DashboardRecentBooking {
  id: string;
  publicCode: string;
  status: BookingStatus;
  startsAt: string;
  createdAt: string;
  totalMinor: string;
  currency: string;
  establishment: { id: string; name: string };
  space: { id: string; name: string };
  player: { id: string; displayName: string | null };
}

export interface PlatformDashboardResponse {
  period: DashboardPeriod;
  establishments: DashboardEstablishmentCounts;
  users: DashboardUserCounts;
  bookings: DashboardBookingMetrics;
  topEstablishments: DashboardTopEstablishment[];
  recentBookings: DashboardRecentBooking[];
}

type CountRow<T extends string> = {
  status: T;
  _count: { _all: number };
};

type EstablishmentCountRow = {
  establishmentId: string;
  _count: { _all: number };
};

type EstablishmentRevenueRow = {
  establishmentId: string;
  _sum: { totalMinor: bigint | null };
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlatformDashboard(
    query: DashboardQueryDto,
    now: Date = new Date(),
  ): Promise<PlatformDashboardResponse> {
    const period = resolveDashboardPeriod(query.from, query.to, now);
    const periodWhere: Prisma.BookingWhereInput = {
      startsAt: { gte: period.fromInstant, lt: period.toInstant },
    };
    const revenueWhere: Prisma.BookingWhereInput = {
      ...periodWhere,
      status: { in: [...REVENUE_BOOKING_STATUSES] },
    };

    const [
      establishmentRows,
      userRows,
      bookingStatusRows,
      todayCount,
      revenueSum,
      topCountRows,
      topRevenueRows,
      recentRows,
    ] = await Promise.all([
      this.prisma.establishment.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.booking.groupBy({
        by: ['status'],
        where: periodWhere,
        _count: { _all: true },
      }),
      this.prisma.booking.count({
        where: {
          startsAt: { gte: period.todayStart, lt: period.todayEnd },
        },
      }),
      this.prisma.booking.aggregate({
        where: revenueWhere,
        _sum: { totalMinor: true },
      }),
      this.prisma.booking.groupBy({
        by: ['establishmentId'],
        where: periodWhere,
        _count: { _all: true },
      }),
      this.prisma.booking.groupBy({
        by: ['establishmentId'],
        where: revenueWhere,
        _sum: { totalMinor: true },
      }),
      this.prisma.booking.findMany({
        select: recentBookingSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: DASHBOARD_RECENT_BOOKINGS_LIMIT,
      }),
    ]);

    const establishmentCounts = establishmentCountsFrom(establishmentRows);
    const userCounts = userCountsFrom(userRows);

    const byStatus = {} as Record<BookingStatus, number>;
    for (const status of BOOKING_STATUSES) {
      byStatus[status] = 0;
    }
    for (const row of bookingStatusRows) {
      byStatus[row.status] = row._count._all;
    }

    const topEstablishments = await this.buildTopEstablishments(
      topCountRows,
      topRevenueRows,
    );

    return {
      period: {
        from: period.from,
        to: period.to,
        timezone: period.timezone,
      },
      establishments: establishmentCounts,
      users: userCounts,
      bookings: {
        period: bookingStatusRows.reduce(
          (total, row) => total + row._count._all,
          0,
        ),
        today: todayCount,
        byStatus,
        revenueMinor: (revenueSum._sum.totalMinor ?? 0n).toString(),
        currency: DASHBOARD_CURRENCY,
      },
      topEstablishments,
      recentBookings: recentRows.map(toRecentBooking),
    };
  }

  private async buildTopEstablishments(
    countRows: readonly EstablishmentCountRow[],
    revenueRows: readonly EstablishmentRevenueRow[],
  ): Promise<DashboardTopEstablishment[]> {
    if (countRows.length === 0) return [];

    const revenueById = new Map<string, bigint>();
    for (const row of revenueRows) {
      revenueById.set(row.establishmentId, row._sum.totalMinor ?? 0n);
    }

    const establishments = await this.prisma.establishment.findMany({
      where: { id: { in: countRows.map((row) => row.establishmentId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(
      establishments.map((establishment) => [
        establishment.id,
        establishment.name,
      ]),
    );

    return countRows
      .map((row) => ({
        id: row.establishmentId,
        name: nameById.get(row.establishmentId) ?? '',
        bookings: row._count._all,
        revenueMinor: revenueById.get(row.establishmentId) ?? 0n,
      }))
      .sort(compareTopEstablishments)
      .slice(0, DASHBOARD_TOP_ESTABLISHMENTS_LIMIT)
      .map((row) => ({
        id: row.id,
        name: row.name,
        bookings: row.bookings,
        revenueMinor: row.revenueMinor.toString(),
      }));
  }
}

/**
 * Resolves the requested period.
 *
 * Defaults: `to` is the current local date and `from` is 29 days earlier, so
 * the default window holds exactly 30 local days including today. `from <= to`
 * and a maximum of 366 days are enforced; invalid calendar dates and
 * out-of-range values surface as `400 VALIDATION_ERROR`.
 */
export function resolveDashboardPeriod(
  from?: string,
  to?: string,
  now: Date = new Date(),
): ResolvedDashboardPeriod {
  const today = toDateOnly(getZonedDateTimeParts(now, DASHBOARD_TIMEZONE));
  const toDate = to ?? today;

  if (!parseDateOnly(toDate)) {
    throw invalidPeriodField('to');
  }

  const fromDate =
    from ?? addDaysToDateOnly(toDate, -(DASHBOARD_DEFAULT_PERIOD_DAYS - 1));

  if (!parseDateOnly(fromDate)) {
    throw invalidPeriodField('from');
  }

  const fromDay = utcDayNumber(fromDate);
  const toDay = utcDayNumber(toDate);

  if (fromDay > toDay) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'from no puede ser posterior a to.',
      [{ field: 'from', constraints: ['fromBeforeTo'] }],
    );
  }

  const days = toDay - fromDay + 1;
  if (days > DASHBOARD_MAX_PERIOD_DAYS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `El periodo no puede superar ${DASHBOARD_MAX_PERIOD_DAYS} días.`,
      [{ field: 'to', constraints: ['maxPeriodDays'] }],
    );
  }

  return {
    from: fromDate,
    to: toDate,
    timezone: DASHBOARD_TIMEZONE,
    fromInstant: wallClockToUtc(fromDate, 0, DASHBOARD_TIMEZONE).instant,
    toInstant: wallClockToUtc(toDate, 1440, DASHBOARD_TIMEZONE).instant,
    today,
    todayStart: wallClockToUtc(today, 0, DASHBOARD_TIMEZONE).instant,
    todayEnd: wallClockToUtc(today, 1440, DASHBOARD_TIMEZONE).instant,
  };
}

function establishmentCountsFrom(
  rows: ReadonlyArray<CountRow<EstablishmentStatus>>,
): DashboardEstablishmentCounts {
  const counts = new Map<EstablishmentStatus, number>();
  for (const row of rows) {
    counts.set(row.status, row._count._all);
  }

  const active = counts.get(EstablishmentStatus.active) ?? 0;
  const suspended = counts.get(EstablishmentStatus.suspended) ?? 0;
  const pending = counts.get(EstablishmentStatus.pending) ?? 0;

  return { total: active + suspended + pending, active, suspended, pending };
}

function userCountsFrom(
  rows: ReadonlyArray<CountRow<UserStatus>>,
): DashboardUserCounts {
  const counts = new Map<UserStatus, number>();
  for (const row of rows) {
    counts.set(row.status, row._count._all);
  }

  const active = counts.get(UserStatus.active) ?? 0;
  const suspended = counts.get(UserStatus.suspended) ?? 0;

  // `deleted` is a soft delete; it is intentionally excluded from `total`.
  return { total: active + suspended, active, suspended };
}

function toRecentBooking(row: RecentBookingRow): DashboardRecentBooking {
  return {
    id: row.id,
    publicCode: row.publicCode,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    totalMinor: row.totalMinor.toString(),
    currency: row.currency,
    establishment: { id: row.establishment.id, name: row.establishment.name },
    space: { id: row.space.id, name: row.space.name },
    player: {
      id: row.player.id,
      displayName: row.player.profile?.displayName ?? null,
    },
  };
}

function compareTopEstablishments(
  a: { bookings: number; revenueMinor: bigint; name: string; id: string },
  b: { bookings: number; revenueMinor: bigint; name: string; id: string },
): number {
  if (a.bookings !== b.bookings) return b.bookings - a.bookings;
  if (a.revenueMinor !== b.revenueMinor) {
    return a.revenueMinor > b.revenueMinor ? -1 : 1;
  }
  return compareStrings(a.name, b.name) || compareStrings(a.id, b.id);
}

/** Code-unit comparison: deterministic across locales and hosts. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function invalidPeriodField(field: 'from' | 'to'): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    `${field} debe ser una fecha válida en formato YYYY-MM-DD.`,
    [{ field, constraints: ['isDateOnly'] }],
  );
}

function toDateOnly(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}

/** Days since 1970-01-01 for a validated `YYYY-MM-DD` local date. */
function utcDayNumber(date: string): number {
  const parts = parseDateOnly(date);
  if (!parts) {
    throw new RangeError(`Fecha inválida: ${date}.`);
  }

  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return Math.floor(probe.getTime() / 86_400_000);
}

function addDaysToDateOnly(date: string, days: number): string {
  const shifted = new Date((utcDayNumber(date) + days) * 86_400_000);
  return toDateOnly({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}
