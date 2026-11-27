import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  EstablishmentStatus,
  Prisma,
  SpaceStatus,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { isValidDateOnly } from '../../common/time/zoned-time';
import { PrismaService } from '../../prisma/prisma.service';
import {
  slotOverlapsBookings,
  type BookingRange,
} from '../bookings/booking-slot';
import { SlotsService } from './slots.service';
import type {
  GeneratedSlot,
  SlotScheduleException,
} from './slot-generator.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The local date can be up to ±14 h from UTC midnight, so a ±1/2-day window
 * around the UTC date safely contains every booking that could overlap any
 * generated slot. The exact overlap is checked in memory per slot.
 */
function availabilityWindow(date: string): { start: Date; end: Date } {
  const base = new Date(`${date}T00:00:00.000Z`);
  return {
    start: new Date(base.getTime() - DAY_MS),
    end: new Date(base.getTime() + 2 * DAY_MS),
  };
}

/**
 * Booked/held slots are excluded for the public and tenant availability
 * endpoints. Pending holds count until `expires_at`; after that they are
 * ignored even if the 60 s expiry job has not run yet (Q7).
 */
function blockingBookingsWhere(window: {
  start: Date;
  end: Date;
}): Prisma.BookingWhereInput {
  return {
    startsAt: { gte: window.start, lt: window.end },
    endsAt: { gt: window.start },
    OR: [
      {
        status: {
          in: [BookingStatus.confirmed, BookingStatus.checked_in],
        },
      },
      {
        status: BookingStatus.pending_payment,
        expiresAt: { gt: new Date() },
      },
    ],
  };
}

function toBookingRanges(
  bookings: ReadonlyArray<{ startsAt: Date; endsAt: Date }> | undefined,
): BookingRange[] {
  return (bookings ?? []).map((booking) => ({
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
  }));
}

export interface OperatingHourResponse {
  dayOfWeek: number;
  opensAtMinutes: number;
  closesAtMinutes: number;
}

export interface SpaceListItem {
  id: string;
  name: string;
  slug: string;
  sport: string | null;
  slotMinutes: number;
  bufferMinutes: number;
  status: SpaceStatus;
  createdAt: string;
  updatedAt: string;
  operatingHours: OperatingHourResponse[];
}

export interface TenantAvailabilityResponse {
  date: string;
  timezone: string;
  currency: string;
  spaceId: string;
  slots: GeneratedSlot[];
}

export interface PublicAvailabilitySpace {
  id: string;
  name: string;
  slug: string;
  sport: string | null;
  slotMinutes: number;
  bufferMinutes: number;
  slots: GeneratedSlot[];
}

/**
 * Flat convenience view of the public slots, so a consumer that only needs a
 * single timeline does not have to merge `spaces[].slots`.
 */
export interface PublicAvailabilitySlot extends GeneratedSlot {
  spaceId: string;
  spaceSlug: string;
}

export interface PublicAvailabilityResponse {
  date: string;
  timezone: string;
  currency: string;
  spaces: PublicAvailabilitySpace[];
  slots: PublicAvailabilitySlot[];
}

@Injectable()
export class SpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: SlotsService,
  ) {}

  async listSpaces(establishmentId: string): Promise<SpaceListItem[]> {
    await this.requireEstablishment(establishmentId);

    const spaces = await this.prisma.space.findMany({
      where: { establishmentId },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
      },
    });

    return spaces.map((space) => ({
      id: space.id,
      name: space.name,
      slug: space.slug,
      sport: space.sport,
      slotMinutes: space.slotMinutes,
      bufferMinutes: space.bufferMinutes,
      status: space.status,
      createdAt: space.createdAt.toISOString(),
      updatedAt: space.updatedAt.toISOString(),
      operatingHours: space.operatingHours.map((hour) => ({
        dayOfWeek: hour.dayOfWeek,
        opensAtMinutes: hour.opensAtMinutes,
        closesAtMinutes: hour.closesAtMinutes,
      })),
    }));
  }

  async getAvailability(
    establishmentId: string,
    spaceId: string,
    date: string,
  ): Promise<TenantAvailabilityResponse> {
    this.assertDate(date);

    const establishment = await this.requireEstablishment(establishmentId);
    const scheduleExceptionDate = toDateOnlyDate(date);
    const bookingWindow = availabilityWindow(date);

    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, establishmentId },
      include: {
        operatingHours: true,
        priceRules: true,
        exceptions: { where: { date: scheduleExceptionDate } },
        bookings: {
          where: blockingBookingsWhere(bookingWindow),
          select: { startsAt: true, endsAt: true },
        },
      },
    });

    if (!space) {
      throw new AppError(
        404,
        'SPACE_NOT_FOUND',
        'La cancha no existe en este establecimiento.',
      );
    }

    const booked = toBookingRanges(space.bookings);
    const slots = this.slots.generate(
      {
        space: {
          id: space.id,
          slotMinutes: space.slotMinutes,
          bufferMinutes: space.bufferMinutes,
        },
        timezone: establishment.timezone,
        date,
        currency: establishment.currency,
        operatingHours: space.operatingHours,
        exception: toSlotException(space.exceptions[0]),
        priceRules: space.priceRules,
      },
      {
        isAvailable: (slot) => !slotOverlapsBookings(slot, booked),
      },
    );

    return {
      date,
      timezone: establishment.timezone,
      currency: establishment.currency,
      spaceId: space.id,
      slots,
    };
  }

  async getPublicAvailability(
    slug: string,
    date: string,
    spaceId?: string,
  ): Promise<PublicAvailabilityResponse> {
    this.assertDate(date);
    const scheduleExceptionDate = toDateOnlyDate(date);
    const bookingWindow = availabilityWindow(date);

    const establishment = await this.prisma.establishment.findUnique({
      where: { slug },
      select: {
        id: true,
        timezone: true,
        currency: true,
        status: true,
        spaces: {
          where: {
            status: SpaceStatus.active,
            ...(spaceId ? { id: spaceId } : {}),
          },
          orderBy: { name: 'asc' },
          include: {
            operatingHours: true,
            priceRules: true,
            bookings: {
              where: blockingBookingsWhere(bookingWindow),
              select: { startsAt: true, endsAt: true },
            },
          },
        },
      },
    });

    // A slug from another tenant or an inactive establishment is deliberately
    // indistinguishable from a missing one (RT-02 / NEG-02).
    if (!establishment || establishment.status !== EstablishmentStatus.active) {
      throw new AppError(
        404,
        'ESTABLISHMENT_NOT_FOUND',
        'El establecimiento no existe o no está disponible.',
      );
    }

    if (spaceId && establishment.spaces.length === 0) {
      throw new AppError(
        404,
        'SPACE_NOT_FOUND',
        'La cancha no existe en este establecimiento.',
      );
    }

    const exceptions = await this.prisma.scheduleException.findMany({
      where: {
        date: scheduleExceptionDate,
        spaceId: { in: establishment.spaces.map((space) => space.id) },
      },
    });
    const exceptionsBySpace = new Map<string, SlotScheduleException>();
    for (const exception of exceptions) {
      exceptionsBySpace.set(exception.spaceId, toSlotException(exception)!);
    }

    const spaces = establishment.spaces.map((space) => {
      const booked = toBookingRanges(space.bookings);

      return {
        id: space.id,
        name: space.name,
        slug: space.slug,
        sport: space.sport,
        slotMinutes: space.slotMinutes,
        bufferMinutes: space.bufferMinutes,
        slots: this.slots.generate(
          {
            space: {
              id: space.id,
              slotMinutes: space.slotMinutes,
              bufferMinutes: space.bufferMinutes,
            },
            timezone: establishment.timezone,
            date,
            currency: establishment.currency,
            operatingHours: space.operatingHours,
            exception: exceptionsBySpace.get(space.id) ?? null,
            priceRules: space.priceRules,
          },
          {
            isAvailable: (slot) => !slotOverlapsBookings(slot, booked),
          },
        ),
      };
    });

    return {
      date,
      timezone: establishment.timezone,
      currency: establishment.currency,
      spaces,
      slots: spaces
        .flatMap((space) =>
          space.slots.map((slot) => ({
            ...slot,
            spaceId: space.id,
            spaceSlug: space.slug,
          })),
        )
        .sort(
          (left, right) =>
            left.startsAt.localeCompare(right.startsAt) ||
            left.spaceId.localeCompare(right.spaceId),
        ),
    };
  }

  private assertDate(date: string): void {
    if (!isValidDateOnly(date)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'date debe ser una fecha válida en formato YYYY-MM-DD.',
        [{ field: 'date', constraints: ['isCalendarDate'] }],
      );
    }
  }

  private async requireEstablishment(
    establishmentId: string,
  ): Promise<{ id: string; timezone: string; currency: string }> {
    const establishment = await this.prisma.establishment.findUnique({
      where: { id: establishmentId },
      select: { id: true, timezone: true, currency: true },
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
}

function toDateOnlyDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toSlotException(
  exception:
    | {
        date: Date;
        isClosed: boolean;
        opensAtMinutes: number | null;
        closesAtMinutes: number | null;
        reason: string | null;
      }
    | undefined,
): SlotScheduleException | null {
  if (!exception) return null;

  return {
    date: exception.date.toISOString().slice(0, 10),
    isClosed: exception.isClosed,
    opensAtMinutes: exception.opensAtMinutes,
    closesAtMinutes: exception.closesAtMinutes,
    reason: exception.reason,
  };
}
