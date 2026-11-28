import { Injectable } from '@nestjs/common';
import {
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
  Prisma,
  UserStatus,
} from '@prisma/client';
import {
  OWNER_GROUP_SLUG,
  STAFF_GROUP_SLUG,
} from '../../common/authz/permissions';
import { provisionEstablishmentGroups } from '../../common/authz/establishment-groups';
import { AppError } from '../../common/errors/app-error';
import { AppLogger } from '../../common/logging/app-logger.service';
import { isValidTimeZone } from '../../common/time/zoned-time';
import type { TenantRequestContext } from '../../common/types/express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AddMembershipDto } from './dto/add-membership.dto';
import type { CreateEstablishmentDto } from './dto/create-establishment.dto';
import {
  ESTABLISHMENT_LIFECYCLE_STATUSES,
  type EstablishmentLifecycleStatus,
} from './dto/update-establishment-status.dto';
import type { UpdateMembershipDto } from './dto/update-membership.dto';

const establishmentSelect = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  currency: true,
  status: true,
  createdAt: true,
} satisfies Prisma.EstablishmentSelect;

const membershipSelect = {
  id: true,
  userId: true,
  establishmentId: true,
  status: true,
  createdAt: true,
  user: {
    select: {
      email: true,
      profile: { select: { displayName: true } },
    },
  },
  groups: {
    select: {
      group: { select: { slug: true, name: true } },
    },
  },
} satisfies Prisma.MembershipSelect;

const membershipWithGroupsSelect = {
  id: true,
  userId: true,
  establishmentId: true,
  status: true,
  createdAt: true,
  groups: {
    select: {
      group: { select: { id: true, slug: true, name: true } },
    },
  },
} satisfies Prisma.MembershipSelect;

type EstablishmentSummary = Prisma.EstablishmentGetPayload<{
  select: typeof establishmentSelect;
}>;

type MembershipWithGroups = Prisma.MembershipGetPayload<{
  select: typeof membershipWithGroupsSelect;
}>;

type MembershipRow = Prisma.MembershipGetPayload<{
  select: typeof membershipSelect;
}>;

export interface MembershipSummary {
  id: string;
  userId: string;
  establishmentId: string;
  status: MembershipStatus;
  user?: { email: string; displayName: string | null };
  groups: Array<{ slug: string; name: string }>;
}

export interface CreatedEstablishment extends EstablishmentSummary {
  owner: {
    membershipId: string;
    userId: string;
    status: MembershipStatus;
    groups: string[];
  };
}

export interface MyEstablishment {
  id: string;
  name: string;
  slug: string;
  status: MembershipStatus;
  groups: string[];
}

@Injectable()
export class EstablishmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Creates an establishment and its first active owner atomically.
   *
   * Steps (all inside one transaction):
   * 1. owner user exists and is active;
   * 2. establishment created as `active`;
   * 3. `owner`/`staff` system groups provisioned;
   * 4. owner membership created as `active`;
   * 5. owner group assigned to that membership;
   * 6. audit structured log emitted after commit.
   */
  async create(
    actorId: string,
    dto: CreateEstablishmentDto,
  ): Promise<CreatedEstablishment> {
    const name = dto.name.trim();
    if (!name) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'El nombre del establecimiento es obligatorio.',
      );
    }

    if (dto.timezone && !isValidTimeZone(dto.timezone)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'timezone debe ser una zona IANA válida.',
        [{ field: 'timezone', constraints: ['isTimeZone'] }],
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.findUnique({
        where: { id: dto.ownerUserId },
        select: { id: true, status: true },
      });

      if (!owner || owner.status !== UserStatus.active) {
        throw new AppError(
          422,
          'OWNER_NOT_FOUND',
          'El usuario indicado como owner no existe o no está activo.',
        );
      }

      const establishment = await tx.establishment.create({
        data: {
          name,
          slug: dto.slug,
          status: EstablishmentStatus.active,
          ...(dto.timezone ? { timezone: dto.timezone } : {}),
          ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}),
        },
        select: establishmentSelect,
      });

      await provisionEstablishmentGroups(tx, establishment.id);

      const membership = await tx.membership.create({
        data: {
          userId: owner.id,
          establishmentId: establishment.id,
          status: MembershipStatus.active,
        },
        select: { id: true },
      });

      const ownerGroup = await findTenantGroup(
        tx,
        establishment.id,
        OWNER_GROUP_SLUG,
      );

      await tx.membershipGroup.create({
        data: {
          membershipId: membership.id,
          groupId: ownerGroup.id,
          establishmentId: establishment.id,
        },
      });

      return { establishment, membershipId: membership.id, ownerId: owner.id };
    });

    this.audit('establishment.created', {
      actorId,
      establishmentId: created.establishment.id,
      ownerUserId: created.ownerId,
      membershipId: created.membershipId,
    });

    return {
      ...created.establishment,
      owner: {
        membershipId: created.membershipId,
        userId: created.ownerId,
        status: MembershipStatus.active,
        groups: [OWNER_GROUP_SLUG],
      },
    };
  }

  /** Platform listing. Read permission is enforced by `AuthorizationGuard`. */
  async list(): Promise<EstablishmentSummary[]> {
    return this.prisma.establishment.findMany({
      select: establishmentSelect,
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Memberships of the authenticated user. `/me` is global context and never
   * uses `TenantGuard` or Cerbos.
   */
  async listMine(userId: string): Promise<MyEstablishment[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: {
        id: true,
        status: true,
        establishment: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        groups: {
          select: { group: { select: { slug: true } } },
        },
      },
      orderBy: { establishment: { name: 'asc' } },
    });

    return memberships.map((membership) => ({
      id: membership.establishment.id,
      name: membership.establishment.name,
      slug: membership.establishment.slug,
      status: membership.status,
      groups: membership.groups.map((assignment) => assignment.group.slug),
    }));
  }

  async getById(establishmentId: string): Promise<EstablishmentSummary> {
    const establishment = await this.prisma.establishment.findUnique({
      where: { id: establishmentId },
      select: establishmentSelect,
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

  /**
   * Platform lifecycle: `active <-> suspended`.
   *
   * The establishment row is locked while the current state is read and the
   * new one is written, so two concurrent requests cannot both observe the
   * same source state. Repeating the current state is a 200 no-op (no write
   * and no `status_changed` audit entry); every other transition, including
   * any source state other than active/suspended, is a 409 INVALID_STATE.
   * Only the `status` column changes: spaces, schedules and bookings are
   * deliberately untouched so history and availability data survive.
   */
  async changeStatus(
    actorId: string,
    establishmentId: string,
    status: EstablishmentStatus,
  ): Promise<EstablishmentSummary> {
    if (!isLifecycleStatus(status)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'status debe ser active o suspended.',
        [{ field: 'status', constraints: ['isIn'] }],
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await lockEstablishment(tx, establishmentId);

      const current = await tx.establishment.findUnique({
        where: { id: establishmentId },
        select: establishmentSelect,
      });

      if (!current) {
        throw new AppError(
          404,
          'ESTABLISHMENT_NOT_FOUND',
          'El establecimiento no existe.',
        );
      }

      if (current.status === status) {
        return { establishment: current, from: current.status, changed: false };
      }

      if (!isAllowedStatusTransition(current.status, status)) {
        throw new AppError(
          409,
          'INVALID_STATE',
          `No se puede cambiar el estado de "${current.status}" a "${status}".`,
        );
      }

      const updated = await tx.establishment.update({
        where: { id: establishmentId },
        data: { status },
        select: establishmentSelect,
      });

      return { establishment: updated, from: current.status, changed: true };
    });

    if (result.changed) {
      this.audit('establishment.status_changed', {
        actorId,
        establishmentId,
        from: result.from,
        to: status,
      });
    }

    return result.establishment;
  }

  async listMemberships(
    establishmentId: string,
  ): Promise<MembershipSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { establishmentId },
      select: membershipSelect,
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });

    return memberships.map((membership) => toMembershipSummary(membership));
  }

  /**
   * Adds or reactivates a membership with a single tenant group.
   *
   * Escalation (Q15): only platform-admin may assign `owner`; an owner may
   * assign `staff`. The same rule is enforced on PATCH through `groupSlug`.
   */
  async addMembership(
    tenant: TenantRequestContext,
    actorId: string,
    establishmentId: string,
    dto: AddMembershipDto,
  ): Promise<MembershipSummary> {
    assertCanAssignGroup(tenant, dto.groupSlug);

    const result = await this.prisma.$transaction(async (tx) => {
      await lockEstablishment(tx, establishmentId);

      const user = await tx.user.findUnique({
        where: { id: dto.userId },
        select: { id: true, status: true },
      });

      if (!user || user.status !== UserStatus.active) {
        throw new AppError(
          404,
          'USER_NOT_FOUND',
          'El usuario indicado no existe o no está activo.',
        );
      }

      const group = await findTenantGroup(
        tx,
        establishmentId,
        dto.groupSlug,
      );

      const existing = await tx.membership.findUnique({
        where: {
          userId_establishmentId: {
            userId: dto.userId,
            establishmentId,
          },
        },
        select: membershipWithGroupsSelect,
      });

      if (existing) {
        const wasActiveOwner = isActiveOwner(existing);
        const willBeOwner = dto.groupSlug === OWNER_GROUP_SLUG;

        if (wasActiveOwner && !willBeOwner) {
          await assertNotLastOwner(tx, establishmentId);
        }

        await tx.membership.update({
          where: { id: existing.id },
          data: { status: MembershipStatus.active },
        });

        await tx.membershipGroup.deleteMany({
          where: { membershipId: existing.id },
        });

        await tx.membershipGroup.create({
          data: {
            membershipId: existing.id,
            groupId: group.id,
            establishmentId,
          },
        });

        return buildMembershipSummary(
          existing.id,
          dto.userId,
          establishmentId,
          MembershipStatus.active,
          group,
        );
      }

      const membership = await tx.membership.create({
        data: {
          userId: dto.userId,
          establishmentId,
          status: MembershipStatus.active,
        },
        select: { id: true },
      });

      await tx.membershipGroup.create({
        data: {
          membershipId: membership.id,
          groupId: group.id,
          establishmentId,
        },
      });

      return buildMembershipSummary(
        membership.id,
        dto.userId,
        establishmentId,
        MembershipStatus.active,
        group,
      );
    });

    this.audit('membership.created', {
      actorId,
      establishmentId,
      membershipId: result.id,
      targetUserId: dto.userId,
      groupSlug: dto.groupSlug,
    });

    return result;
  }

  /**
   * Updates membership status and/or group.
   *
   * The last active owner cannot be removed, suspended or demoted. The check
   * and the write happen in one transaction with the establishment row locked.
   */
  async updateMembership(
    tenant: TenantRequestContext,
    actorId: string,
    establishmentId: string,
    membershipId: string,
    dto: UpdateMembershipDto,
  ): Promise<MembershipSummary> {
    if (!dto.status && !dto.groupSlug) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Debes indicar al menos un cambio de estado o de grupo.',
      );
    }

    if (dto.groupSlug) {
      assertCanAssignGroup(tenant, dto.groupSlug);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await lockEstablishment(tx, establishmentId);

      const membership = await tx.membership.findFirst({
        where: { id: membershipId, establishmentId },
        select: membershipWithGroupsSelect,
      });

      if (!membership) {
        throw membershipNotFound();
      }

      const wasActiveOwner = isActiveOwner(membership);
      const nextStatus = dto.status ?? membership.status;
      const nextIsOwner = dto.groupSlug
        ? dto.groupSlug === OWNER_GROUP_SLUG
        : membership.groups.some(
            (assignment) => assignment.group.slug === OWNER_GROUP_SLUG,
          );

      // Closing an escalation hole: an owner cannot restore owner privileges
      // by reactivating a removed/suspended owner membership. Only a
      // platform-admin may create that transition.
      if (
        !tenant.isPlatformAdmin &&
        nextStatus === MembershipStatus.active &&
        nextIsOwner &&
        !wasActiveOwner
      ) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Solo un administrador de plataforma puede asignar el grupo owner.',
        );
      }

      if (
        wasActiveOwner &&
        !(nextStatus === MembershipStatus.active && nextIsOwner)
      ) {
        await assertNotLastOwner(tx, establishmentId);
      }

      await tx.membership.update({
        where: { id: membership.id },
        data: { status: nextStatus },
      });

      const group = dto.groupSlug
        ? await findTenantGroup(tx, establishmentId, dto.groupSlug)
        : currentGroup(membership, nextIsOwner);

      if (dto.groupSlug) {
        await tx.membershipGroup.deleteMany({
          where: { membershipId: membership.id },
        });
        await tx.membershipGroup.create({
          data: {
            membershipId: membership.id,
            groupId: group.id,
            establishmentId,
          },
        });
      }

      return buildMembershipSummary(
        membership.id,
        membership.userId,
        establishmentId,
        nextStatus,
        group,
      );
    });

    this.audit('membership.updated', {
      actorId,
      establishmentId,
      membershipId: result.id,
      targetUserId: result.userId,
      status: dto.status ?? result.status,
      groupSlug: dto.groupSlug ?? result.groups[0]?.slug,
    });

    return result;
  }

  /** Soft-removes a membership (`status = removed`) with last-owner protection. */
  async removeMembership(
    tenant: TenantRequestContext,
    actorId: string,
    establishmentId: string,
    membershipId: string,
  ): Promise<MembershipSummary> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockEstablishment(tx, establishmentId);

      const membership = await tx.membership.findFirst({
        where: { id: membershipId, establishmentId },
        select: membershipWithGroupsSelect,
      });

      if (!membership) {
        throw membershipNotFound();
      }

      if (isActiveOwner(membership)) {
        await assertNotLastOwner(tx, establishmentId);
      }

      await tx.membership.update({
        where: { id: membership.id },
        data: { status: MembershipStatus.removed },
      });

      return buildMembershipSummary(
        membership.id,
        membership.userId,
        establishmentId,
        MembershipStatus.removed,
        currentGroup(membership, true),
      );
    });

    this.audit('membership.removed', {
      actorId,
      establishmentId,
      membershipId: result.id,
      targetUserId: result.userId,
    });

    return result;
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

function toMembershipSummary(membership: MembershipRow): MembershipSummary {
  return {
    id: membership.id,
    userId: membership.userId,
    establishmentId: membership.establishmentId,
    status: membership.status,
    user: {
      email: membership.user.email,
      displayName: membership.user.profile?.displayName ?? null,
    },
    groups: membership.groups.map((assignment) => ({
      slug: assignment.group.slug,
      name: assignment.group.name,
    })),
  };
}

function buildMembershipSummary(
  membershipId: string,
  userId: string,
  establishmentId: string,
  status: MembershipStatus,
  group: { slug: string; name: string },
): MembershipSummary {
  return {
    id: membershipId,
    userId,
    establishmentId,
    status,
    groups: [{ slug: group.slug, name: group.name }],
  };
}

function isActiveOwner(membership: MembershipWithGroups): boolean {
  return (
    membership.status === MembershipStatus.active &&
    membership.groups.some(
      (assignment) => assignment.group.slug === OWNER_GROUP_SLUG,
    )
  );
}

function currentGroup(
  membership: MembershipWithGroups,
  preferOwner: boolean,
): { id: string; slug: string; name: string } {
  const owner = membership.groups.find(
    (assignment) => assignment.group.slug === OWNER_GROUP_SLUG,
  );
  const staff = membership.groups.find(
    (assignment) => assignment.group.slug === STAFF_GROUP_SLUG,
  );
  const chosen = preferOwner ? (owner ?? staff) : (staff ?? owner);

  if (!chosen) {
    throw new AppError(
      409,
      'INVALID_STATE',
      'La membresía no tiene un grupo de establecimiento asignado.',
    );
  }

  return chosen.group;
}

function assertCanAssignGroup(
  tenant: TenantRequestContext,
  groupSlug: string,
): void {
  if (groupSlug === OWNER_GROUP_SLUG && !tenant.isPlatformAdmin) {
    throw new AppError(
      403,
      'PERMISSION_DENIED',
      'Solo un administrador de plataforma puede asignar el grupo owner.',
    );
  }
}

async function findTenantGroup(
  tx: Prisma.TransactionClient,
  establishmentId: string,
  slug: string,
): Promise<{ id: string; slug: string; name: string }> {
  const group = await tx.securityGroup.findFirst({
    where: {
      establishmentId,
      slug,
      scope: GroupScope.establishment,
    },
    select: { id: true, slug: true, name: true },
  });

  if (!group) {
    throw new AppError(
      409,
      'INVALID_STATE',
      `El establecimiento no tiene configurado el grupo "${slug}".`,
    );
  }

  return group;
}

/**
 * Serializes membership mutations per establishment. `FOR UPDATE` on the
 * establishment row plus the active-owner count makes the last-owner check
 * safe under concurrent removals/demotions.
 */
async function lockEstablishment(
  tx: Prisma.TransactionClient,
  establishmentId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id
    FROM establishments
    WHERE id = ${establishmentId}::uuid
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new AppError(
      404,
      'ESTABLISHMENT_NOT_FOUND',
      'El establecimiento no existe.',
    );
  }
}

async function assertNotLastOwner(
  tx: Prisma.TransactionClient,
  establishmentId: string,
): Promise<void> {
  const activeOwners = await tx.membership.count({
    where: {
      establishmentId,
      status: MembershipStatus.active,
      groups: {
        some: {
          group: {
            slug: OWNER_GROUP_SLUG,
            establishmentId,
          },
        },
      },
    },
  });

  if (activeOwners <= 1) {
    throw new AppError(
      409,
      'INVALID_STATE',
      'No se puede quitar o degradar al último owner activo del establecimiento.',
    );
  }
}

function isLifecycleStatus(
  status: EstablishmentStatus,
): status is EstablishmentLifecycleStatus {
  return (ESTABLISHMENT_LIFECYCLE_STATUSES as readonly string[]).includes(
    status,
  );
}

/** The only two transitions accepted by the lifecycle endpoint. */
function isAllowedStatusTransition(
  from: EstablishmentStatus,
  to: EstablishmentLifecycleStatus,
): boolean {
  return (
    (from === EstablishmentStatus.active &&
      to === EstablishmentStatus.suspended) ||
    (from === EstablishmentStatus.suspended &&
      to === EstablishmentStatus.active)
  );
}

function membershipNotFound(): AppError {
  return new AppError(
    404,
    'MEMBERSHIP_NOT_FOUND',
    'La membresía no existe en este establecimiento.',
  );
}

// Re-exported for tests that assert the invariant in isolation.
export { assertNotLastOwner };
