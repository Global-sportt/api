import { Inject, Injectable } from '@nestjs/common';
import {
  BookingStatus,
  Prisma,
  SpaceStatus,
  UserStatus,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { queryPlanToPrisma } from '@cerbos/orm-prisma';
import {
  AUTHORIZATION_SERVICE,
  AUTHZ_PERMISSION_RESOLVER,
  type AuthorizationService,
  type PermissionResolver,
} from '../../common/authz/authorization.types';
import { AppError } from '../../common/errors/app-error';
import { AppLogger } from '../../common/logging/app-logger.service';
import {
  getZonedDateTimeParts,
  wallClockToUtc,
} from '../../common/time/zoned-time';
import { PrismaService } from '../../prisma/prisma.service';
import type { GeneratedSlot } from '../spaces/slot-generator.types';
import { SlotsService } from '../spaces/slots.service';
import {
  computeBookingRequestHash,
  normalizeIdempotencyKey,
} from './booking-idempotency';
import {
  assertBookingTransition,
  replayErrorForBooking,
} from './booking-state';
import {
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  slotTakenError,
} from './booking-errors';
import {
  findAlternativeSlots,
  findRequestedSlot,
  type BookingAlternative,
  type BookingRange,
} from './booking-slot';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { CreateTenantBookingDto } from './dto/create-tenant-booking.dto';
import type { ListBookingsQueryDto } from './dto/list-bookings-query.dto';

const bookingSelect = {
  id: true,
  publicCode: true,
  establishmentId: true,
  spaceId: true,
  playerId: true,
  createdByUserId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  totalMinor: true,
  currency: true,
  idempotencyKey: true,
  requestHash: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BookingSelect;

type BookingRow = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;
type PlanResourcesResponseShape = Parameters<
  typeof queryPlanToPrisma
>[0]['queryPlan'];

const MAX_IDEMPOTENCY_INSERT_ATTEMPTS = 3;

export interface BookingResponse {
  id: string;
  publicCode: string;
  establishmentId: string;
  spaceId: string;
  playerId: string;
  createdByUserId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  totalMinor: string;
  currency: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingActionResult {
  booking: BookingResponse;
  /** True when the result is the current state of a previous request. */
  replay: boolean;
}

interface ResolvedSlot {
  spaceId: string;
  establishmentId: string;
  startsAtIso: string;
  endsAtIso: string;
  startsAt: Date;
  endsAt: Date;
  totalMinor: bigint;
  currency: string;
  timezone: string;
  localDate: string;
  allSlots: GeneratedSlot[];
}

interface InsertBookingInput {
  actorId: string;
  playerId: string;
  establishmentId: string;
  spaceId: string;
  startsAt: Date;
  endsAt: Date;
  totalMinor: bigint;
  currency: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  resolved: ResolvedSlot;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: SlotsService,
    @Inject(AUTHZ_PERMISSION_RESOLVER)
    private readonly permissions: PermissionResolver,
    @Inject(AUTHORIZATION_SERVICE)
    private readonly authorization: AuthorizationService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * `POST /bookings`: a player books for themself. The controller always
   * passes the authenticated principal as actor; `playerId` is never read
   * from the body (Q16).
   */
  async createForPlayer(
    actorId: string,
    dto: CreateBookingDto,
    idempotencyHeader?: string | string[],
  ): Promise<BookingActionResult> {
    const times = normalizeRequestTimes(dto.startsAt, dto.endsAt);
    const idempotencyKey = normalizeIdempotencyKey(idempotencyHeader);

    const space = await this.findSpaceForOwnBooking(dto.spaceId);
    const requestHash = idempotencyKey
      ? computeBookingRequestHash({
          establishmentId: space.establishmentId,
          spaceId: dto.spaceId,
          playerId: actorId,
          startsAt: times.startsAtIso,
          endsAt: times.endsAtIso,
        })
      : null;

    if (idempotencyKey) {
      const existing = await this.findIdempotentBooking(
        actorId,
        idempotencyKey,
      );
      if (existing) return this.replayOrThrow(existing, requestHash);
    }

    const resolved = await this.resolveBookableSlot({
      spaceId: dto.spaceId,
      startsAtIso: times.startsAtIso,
      endsAtIso: times.endsAtIso,
    });

    return this.insertBooking({
      actorId,
      playerId: actorId,
      establishmentId: resolved.establishmentId,
      spaceId: resolved.spaceId,
      startsAt: resolved.startsAt,
      endsAt: resolved.endsAt,
      totalMinor: resolved.totalMinor,
      currency: resolved.currency,
      idempotencyKey,
      requestHash,
      resolved,
    });
  }

  /**
   * `POST /establishments/:id/bookings`: staff/owner books on behalf of an
   * active player. The establishment comes exclusively from the path.
   */
  async createForTenant(
    actorId: string,
    establishmentId: string,
    dto: CreateTenantBookingDto,
    idempotencyHeader?: string | string[],
  ): Promise<BookingActionResult> {
    const times = normalizeRequestTimes(dto.startsAt, dto.endsAt);
    const idempotencyKey = normalizeIdempotencyKey(idempotencyHeader);

    const space = await this.findSpaceForTenantBooking(
      dto.spaceId,
      establishmentId,
    );
    const requestHash = idempotencyKey
      ? computeBookingRequestHash({
          establishmentId,
          spaceId: space.id,
          playerId: dto.playerId,
          startsAt: times.startsAtIso,
          endsAt: times.endsAtIso,
        })
      : null;

    if (idempotencyKey) {
      const existing = await this.findIdempotentBooking(
        actorId,
        idempotencyKey,
      );
      if (existing) return this.replayOrThrow(existing, requestHash);
    }

    await this.assertActivePlayer(dto.playerId);

    const resolved = await this.resolveBookableSlot({
      spaceId: dto.spaceId,
      establishmentId,
      startsAtIso: times.startsAtIso,
      endsAtIso: times.endsAtIso,
    });

    return this.insertBooking({
      actorId,
      playerId: dto.playerId,
      establishmentId,
      spaceId: resolved.spaceId,
      startsAt: resolved.startsAt,
      endsAt: resolved.endsAt,
      totalMinor: resolved.totalMinor,
      currency: resolved.currency,
      idempotencyKey,
      requestHash,
      resolved,
    });
  }

  /**
   * Own list: the Cerbos plan is always ANDed with `playerId = principal.id`,
   * even when the plan is ALWAYS_ALLOWED (platform-admin). This is the Q16
   * invariant; the filter is applied in SQL, not after loading rows.
   */
  async listMine(
    actorId: string,
    query: ListBookingsQueryDto,
  ): Promise<BookingResponse[]> {
    const planFilter = await this.planFilter(actorId, null);
    if (planFilter === null) return [];

    const rows = await this.prisma.booking.findMany({
      where: {
        AND: [
          planFilter,
          { playerId: actorId },
          ...(query.playerId ? [{ playerId: query.playerId }] : []),
          ...(query.status ? [{ status: query.status }] : []),
          ...(query.spaceId ? [{ spaceId: query.spaceId }] : []),
        ],
      },
      select: bookingSelect,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toBookingResponse);
  }

  /** Own detail. A booking from another player is indistinguishable from 404. */
  async getMine(actorId: string, bookingId: string): Promise<BookingResponse> {
    const row = await this.prisma.booking.findFirst({
      where: { id: bookingId, playerId: actorId },
      select: bookingSelect,
    });

    if (!row) throw bookingNotFound();
    return toBookingResponse(row);
  }

  /** Own cancellation: ownership, status and the starts-at window are enforced. */
  async cancelMine(
    actorId: string,
    bookingId: string,
  ): Promise<BookingResponse> {
    const row = await this.prisma.booking.findFirst({
      where: { id: bookingId, playerId: actorId },
      select: bookingSelect,
    });

    if (!row) throw bookingNotFound();
    assertCancellableByPlayer(row);

    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.booking.updateMany({
        where: {
          id: row.id,
          playerId: actorId,
          status: {
            in: [BookingStatus.pending_payment, BookingStatus.confirmed],
          },
        },
        data: { status: BookingStatus.cancelled },
      });

      if (changed.count === 0) {
        throw new AppError(
          409,
          'INVALID_STATE',
          'La reserva cambió de estado; no se puede cancelar.',
        );
      }

      return tx.booking.findUniqueOrThrow({
        where: { id: row.id },
        select: bookingSelect,
      });
    });

    this.audit('booking.cancelled', {
      actorId,
      bookingId: updated.id,
      establishmentId: updated.establishmentId,
      spaceId: updated.spaceId,
      status: updated.status,
    });

    return toBookingResponse(updated);
  }

  /**
   * Tenant list. The path establishment is ANDed with the Cerbos plan filter;
   * a staff/owner of another tenant never reaches this method (TenantGuard),
   * and platform-admin's ALWAYS_ALLOWED is still narrowed to the path.
   */
  async listTenant(
    actorId: string,
    establishmentId: string,
    query: ListBookingsQueryDto,
  ): Promise<BookingResponse[]> {
    const planFilter = await this.planFilter(actorId, establishmentId);
    if (planFilter === null) return [];

    const rows = await this.prisma.booking.findMany({
      where: {
        AND: [
          planFilter,
          { establishmentId },
          ...(query.playerId ? [{ playerId: query.playerId }] : []),
          ...(query.status ? [{ status: query.status }] : []),
          ...(query.spaceId ? [{ spaceId: query.spaceId }] : []),
        ],
      },
      select: bookingSelect,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toBookingResponse);
  }

  /**
   * Staff/owner status update. Only the documented graph is allowed, and a
   * suspended-in-time pending hold cannot be confirmed (BOOKING_EXPIRED).
   */
  async updateStatus(
    actorId: string,
    establishmentId: string,
    bookingId: string,
    targetStatus: BookingStatus,
  ): Promise<BookingResponse> {
    const row = await this.prisma.booking.findFirst({
      where: { id: bookingId, establishmentId },
      select: bookingSelect,
    });

    if (!row) throw bookingNotFound();

    assertBookingTransition(row.status, targetStatus);

    if (
      row.status === BookingStatus.pending_payment &&
      targetStatus === BookingStatus.confirmed &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(
        409,
        'BOOKING_EXPIRED',
        'La reserva expiró y no se puede confirmar.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.booking.updateMany({
        where: {
          id: row.id,
          establishmentId,
          status: row.status,
        },
        data: { status: targetStatus },
      });

      if (changed.count === 0) {
        throw new AppError(
          409,
          'INVALID_STATE',
          'La reserva cambió de estado; recarga e intenta de nuevo.',
        );
      }

      return tx.booking.findUniqueOrThrow({
        where: { id: row.id },
        select: bookingSelect,
      });
    });

    this.audit('booking.status_changed', {
      actorId,
      bookingId: updated.id,
      establishmentId: updated.establishmentId,
      spaceId: updated.spaceId,
      fromStatus: row.status,
      toStatus: updated.status,
    });

    return toBookingResponse(updated);
  }

  private async findSpaceForOwnBooking(
    spaceId: string,
  ): Promise<{ id: string; establishmentId: string }> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { id: true, establishmentId: true },
    });

    if (!space) throw spaceNotFound();
    return space;
  }

  private async findSpaceForTenantBooking(
    spaceId: string,
    establishmentId: string,
  ): Promise<{ id: string; establishmentId: string }> {
    const space = await this.prisma.space.findFirst({
      where: { id: spaceId, establishmentId },
      select: { id: true, establishmentId: true },
    });

    // Q6: a space from another tenant is 404, never a 201/500. The composite
    // FK is only the database backstop.
    if (!space) throw spaceNotFound();
    return space;
  }

  private async assertActivePlayer(playerId: string): Promise<void> {
    const player = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { status: true },
    });

    if (!player || player.status !== UserStatus.active) {
      throw new AppError(
        404,
        'USER_NOT_FOUND',
        'El jugador indicado no existe o no está activo.',
      );
    }
  }

  /**
   * Generates T5 slots for the local date of `startsAt` and requires the exact
   * generated slot. Price and currency come only from that slot.
   */
  private async resolveBookableSlot(params: {
    spaceId: string;
    establishmentId?: string;
    startsAtIso: string;
    endsAtIso: string;
  }): Promise<ResolvedSlot> {
    const space = await this.prisma.space.findFirst({
      where: {
        id: params.spaceId,
        ...(params.establishmentId
          ? { establishmentId: params.establishmentId }
          : {}),
      },
      select: {
        id: true,
        establishmentId: true,
        slotMinutes: true,
        bufferMinutes: true,
        status: true,
        establishment: {
          select: { timezone: true, currency: true },
        },
        operatingHours: {
          select: {
            dayOfWeek: true,
            opensAtMinutes: true,
            closesAtMinutes: true,
          },
        },
        priceRules: {
          select: {
            id: true,
            dayOfWeek: true,
            startsAtMinutes: true,
            endsAtMinutes: true,
            amountMinor: true,
            currency: true,
            priority: true,
          },
        },
      },
    });

    if (!space || space.status !== SpaceStatus.active) {
      throw spaceNotFound();
    }

    const timezone = space.establishment.timezone;
    const startsAt = new Date(params.startsAtIso);
    const localDate = toDateOnly(getZonedDateTimeParts(startsAt, timezone));

    const exception = await this.prisma.scheduleException.findFirst({
      where: {
        spaceId: space.id,
        date: new Date(`${localDate}T00:00:00.000Z`),
      },
      select: {
        isClosed: true,
        opensAtMinutes: true,
        closesAtMinutes: true,
        reason: true,
      },
    });

    const allSlots = this.slots.generate({
      space: {
        id: space.id,
        slotMinutes: space.slotMinutes,
        bufferMinutes: space.bufferMinutes,
      },
      timezone,
      date: localDate,
      currency: space.establishment.currency,
      operatingHours: space.operatingHours,
      exception: exception
        ? {
            date: localDate,
            isClosed: exception.isClosed,
            opensAtMinutes: exception.opensAtMinutes,
            closesAtMinutes: exception.closesAtMinutes,
            reason: exception.reason,
          }
        : null,
      priceRules: space.priceRules,
    });

    const slot = findRequestedSlot(
      allSlots,
      params.startsAtIso,
      params.endsAtIso,
    );

    if (!slot) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'startsAt/endsAt no corresponden a una franja disponible del horario.',
        [
          {
            field: 'startsAt',
            constraints: ['isGeneratedSlot'],
          },
        ],
      );
    }

    return {
      spaceId: space.id,
      establishmentId: space.establishmentId,
      startsAtIso: slot.startsAt,
      endsAtIso: slot.endsAt,
      startsAt: new Date(slot.startsAt),
      endsAt: new Date(slot.endsAt),
      totalMinor: BigInt(slot.priceMinor),
      currency: slot.currency,
      timezone,
      localDate,
      allSlots,
    };
  }

  /**
   * Inserts inside a transaction. PostgreSQL is the concurrency authority:
   * exclusion violation 23P01 -> SLOT_TAKEN, unique violation 23505 on the
   * idempotency key -> replay/reuse. A public-code collision is retried.
   */
  private async insertBooking(
    input: InsertBookingInput,
  ): Promise<BookingActionResult> {
    for (
      let attempt = 0;
      attempt < MAX_IDEMPOTENCY_INSERT_ATTEMPTS;
      attempt += 1
    ) {
      const id = randomUUID();
      const publicCode = generatePublicCode();

      try {
        const row = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "bookings" (
              "id",
              "public_code",
              "establishment_id",
              "space_id",
              "player_id",
              "created_by_user_id",
              "starts_at",
              "ends_at",
              "status",
              "total_minor",
              "currency",
              "idempotency_key",
              "request_hash",
              "expires_at",
              "created_at",
              "updated_at"
            )
            VALUES (
              ${id}::uuid,
              ${publicCode},
              ${input.establishmentId}::uuid,
              ${input.spaceId}::uuid,
              ${input.playerId}::uuid,
              ${input.actorId}::uuid,
              CAST(${input.startsAt} AS timestamptz),
              CAST(${input.endsAt} AS timestamptz),
              CAST(${BookingStatus.confirmed} AS "BookingStatus"),
              ${input.totalMinor},
              ${input.currency},
              CAST(${input.idempotencyKey} AS text),
              CAST(${input.requestHash} AS text),
              CAST(${null} AS timestamptz),
              NOW(),
              NOW()
            )
          `;

          return tx.booking.findUniqueOrThrow({
            where: { id },
            select: bookingSelect,
          });
        });

        this.audit('booking.created', {
          actorId: input.actorId,
          bookingId: row.id,
          establishmentId: row.establishmentId,
          spaceId: row.spaceId,
          playerId: row.playerId,
          status: row.status,
        });

        return { booking: toBookingResponse(row), replay: false };
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          // The space/establishment pair disappeared or was never valid. The
          // composite FK is the backstop, but the API keeps the 404 contract.
          throw spaceNotFound();
        }

        if (isExclusionViolation(error)) {
          // Two constraints can fire for the same concurrent request: the
          // exclusion (same slot) and the idempotency unique key. If this
          // actor already owns this key, idempotency wins and the caller gets
          // the same replay/terminal semantics as a sequential retry.
          if (input.idempotencyKey) {
            const existing = await this.findIdempotentBooking(
              input.actorId,
              input.idempotencyKey,
            );
            if (existing) {
              return this.replayOrThrow(existing, input.requestHash);
            }
          }

          const alternatives = await this.loadAlternatives(input.resolved);
          throw slotTakenError(input.spaceId, alternatives);
        }

        if (isUniqueViolation(error)) {
          if (input.idempotencyKey) {
            const existing = await this.findIdempotentBooking(
              input.actorId,
              input.idempotencyKey,
            );

            if (existing) {
              return this.replayOrThrow(existing, input.requestHash);
            }
          }

          // public_code collision: regenerate the code and retry.
          if (attempt < MAX_IDEMPOTENCY_INSERT_ATTEMPTS - 1) continue;
        }

        throw error;
      }
    }

    throw new AppError(
      500,
      'INTERNAL_ERROR',
      'No se pudo generar un código público único para la reserva.',
    );
  }

  private async findIdempotentBooking(
    actorId: string,
    idempotencyKey: string,
  ): Promise<BookingRow | null> {
    return this.prisma.booking.findFirst({
      where: {
        createdByUserId: actorId,
        idempotencyKey,
      },
      select: bookingSelect,
    });
  }

  private replayOrThrow(
    row: BookingRow,
    requestHash: string | null,
  ): BookingActionResult {
    if (!requestHash || row.requestHash !== requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'La clave de idempotencia ya se usó con otra solicitud.',
      );
    }

    const terminalError = replayErrorForBooking(row.status, row.expiresAt);
    if (terminalError) throw terminalError;

    return { booking: toBookingResponse(row), replay: true };
  }

  private async loadAlternatives(
    resolved: ResolvedSlot,
  ): Promise<BookingAlternative[]> {
    const occupied = await this.loadOccupiedRanges(
      resolved.spaceId,
      resolved.localDate,
      resolved.timezone,
    );

    return findAlternativeSlots(
      resolved.allSlots,
      occupied,
      resolved.startsAtIso,
      3,
    );
  }

  /**
   * Active bookings for the local day. A `pending_payment` hold is only
   * blocking while `expires_at > now()`, matching the availability contract
   * even if the expiry job has not run yet.
   */
  private async loadOccupiedRanges(
    spaceId: string,
    localDate: string,
    timezone: string,
  ): Promise<BookingRange[]> {
    const dayStart = wallClockToUtc(localDate, 0, timezone).instant;
    const dayEnd = wallClockToUtc(localDate, 1440, timezone).instant;
    const now = new Date();

    return this.prisma.booking.findMany({
      where: {
        spaceId,
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
        OR: [
          {
            status: {
              in: [BookingStatus.confirmed, BookingStatus.checked_in],
            },
          },
          {
            status: BookingStatus.pending_payment,
            expiresAt: { gt: now },
          },
        ],
      },
      select: { startsAt: true, endsAt: true },
    });
  }

  private async planFilter(
    actorId: string,
    establishmentId: string | null,
  ): Promise<Prisma.BookingWhereInput | null> {
    const principal = await this.permissions.resolve(
      actorId,
      establishmentId ?? undefined,
    );
    const plan = await this.authorization.plan(principal, 'booking', 'read');

    const converted = queryPlanToPrisma({
      queryPlan: planForPrismaAdapter(plan) as PlanResourcesResponseShape,
      model: 'Booking',
      datamodel: Prisma.dmmf.datamodel,
    }) as
      | { kind: 'KIND_ALWAYS_ALLOWED' }
      | { kind: 'KIND_ALWAYS_DENIED' }
      | { kind: 'KIND_CONDITIONAL'; filters: unknown };

    switch (converted.kind) {
      case 'KIND_ALWAYS_DENIED':
        return null;
      case 'KIND_ALWAYS_ALLOWED':
        return {};
      case 'KIND_CONDITIONAL':
        return converted.filters as Prisma.BookingWhereInput;
    }

    // Fail closed if the adapter ever returns an unknown plan kind.
    return null;
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

function normalizeRequestTimes(
  startsAt: string,
  endsAt: string,
): { startsAtIso: string; endsAtIso: string } {
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (!Number.isFinite(start.getTime())) {
    throw invalidInstant('startsAt');
  }
  if (!Number.isFinite(end.getTime())) {
    throw invalidInstant('endsAt');
  }

  const startsAtIso = start.toISOString();
  const endsAtIso = end.toISOString();

  if (end.getTime() <= start.getTime()) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'endsAt debe ser posterior a startsAt.',
      [{ field: 'endsAt', constraints: ['isAfterStartsAt'] }],
    );
  }

  return { startsAtIso, endsAtIso };
}

function invalidInstant(field: string): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    `${field} debe ser un instante ISO-8601 válido.`,
    [{ field, constraints: ['isIso8601'] }],
  );
}

function assertCancellableByPlayer(row: BookingRow): void {
  if (
    row.status === BookingStatus.pending_payment &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError(
      409,
      'BOOKING_EXPIRED',
      'El hold de la reserva expiró.',
    );
  }

  if (
    row.status !== BookingStatus.pending_payment &&
    row.status !== BookingStatus.confirmed
  ) {
    throw new AppError(
      409,
      'INVALID_STATE',
      'La reserva ya no se puede cancelar en su estado actual.',
    );
  }

  if (row.startsAt.getTime() <= Date.now()) {
    throw new AppError(
      409,
      'CANCELLATION_WINDOW_CLOSED',
      'La reserva ya comenzó; no se puede cancelar.',
    );
  }
}

function toBookingResponse(row: BookingRow): BookingResponse {
  return {
    id: row.id,
    publicCode: row.publicCode,
    establishmentId: row.establishmentId,
    spaceId: row.spaceId,
    playerId: row.playerId,
    createdByUserId: row.createdByUserId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    totalMinor: row.totalMinor.toString(),
    currency: row.currency,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

function generatePublicCode(): string {
  return `BK${randomBytes(10).toString('hex').toUpperCase()}`;
}

/**
 * The Cerbos HTTP API returns the protobuf JSON shape: the condition is
 * wrapped in `{ expression: ... }` and variables are `{ variable: "..." }`.
 * `@cerbos/orm-prisma` expects the SDK shape (`condition` operand plus
 * `{ name: "..." }` variables), so the boundary converts it. The SDK does the
 * same mapping internally; this project uses a native `fetch` transport.
 */
function planForPrismaAdapter(plan: unknown): unknown {
  if (!isRecord(plan)) return plan;
  if (plan.kind !== 'KIND_CONDITIONAL') return plan;

  return { ...plan, condition: toPrismaPlanOperand(plan.condition) };
}

function toPrismaPlanOperand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toPrismaPlanOperand);
  if (!isRecord(node)) return node;

  if (typeof node.variable === 'string') {
    return { name: node.variable };
  }

  if (isRecord(node.expression)) {
    return toPrismaPlanOperand(node.expression);
  }

  if (Array.isArray(node.operands)) {
    return {
      ...node,
      operands: node.operands.map(toPrismaPlanOperand),
    };
  }

  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function spaceNotFound(): AppError {
  return new AppError(
    404,
    'SPACE_NOT_FOUND',
    'La cancha no existe o no está activa.',
  );
}

function bookingNotFound(): AppError {
  return new AppError(
    404,
    'BOOKING_NOT_FOUND',
    'La reserva no existe.',
  );
}
