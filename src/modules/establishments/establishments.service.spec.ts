import {
  EstablishmentStatus,
  MembershipStatus,
  UserStatus,
} from '@prisma/client';
import { provisionEstablishmentGroups } from '../../common/authz/establishment-groups';
import { AppError } from '../../common/errors/app-error';
import type { AppLogger } from '../../common/logging/app-logger.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TenantRequestContext } from '../../common/types/express';
import { EstablishmentsService } from './establishments.service';

jest.mock('../../common/authz/establishment-groups', () => ({
  provisionEstablishmentGroups: jest.fn(),
}));

const provisionMock =
  provisionEstablishmentGroups as jest.MockedFunction<
    typeof provisionEstablishmentGroups
  >;

const OWNER_GROUP = {
  id: 'group-owner-e1',
  slug: 'owner',
  name: 'Dueño de sede',
};
const STAFF_GROUP = { id: 'group-staff-e1', slug: 'staff', name: 'Staff' };

const ESTABLISHMENT = {
  id: 'e1',
  name: 'Cancha Norte',
  slug: 'cancha-norte',
  timezone: 'America/Bogota',
  currency: 'COP',
  address: null,
  contactPhone: null,
  contactEmail: null,
  cancellationPolicy: null,
  usagePolicy: null,
  rules: null,
  status: EstablishmentStatus.active,
  createdAt: new Date('2026-11-26T12:00:00.000Z'),
};

interface TxMock {
  $queryRaw: jest.Mock;
  user: { findUnique: jest.Mock };
  establishment: { create: jest.Mock };
  membership: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  securityGroup: { findFirst: jest.Mock };
  membershipGroup: { create: jest.Mock; deleteMany: jest.Mock };
}

function buildTx(): TxMock {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ESTABLISHMENT.id }]),
    user: { findUnique: jest.fn() },
    establishment: { create: jest.fn().mockResolvedValue(ESTABLISHMENT) },
    membership: {
      create: jest.fn().mockResolvedValue({ id: 'm-new' }),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(2),
    },
    securityGroup: {
      findFirst: jest
        .fn()
        .mockImplementation(
          ({
            where,
          }: {
            where: { slug: string };
          }): Promise<typeof OWNER_GROUP> =>
            Promise.resolve(
              where.slug === OWNER_GROUP.slug ? OWNER_GROUP : STAFF_GROUP,
            ),
        ),
    },
    membershipGroup: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function tenant(isPlatformAdmin = false): TenantRequestContext {
  return {
    establishmentId: ESTABLISHMENT.id,
    isPlatformAdmin,
    auditBypass: false,
  };
}

function activeOwnerMembership(
  overrides: Partial<{
    id: string;
    userId: string;
    status: MembershipStatus;
    slugs: string[];
  }> = {},
) {
  const slugs = overrides.slugs ?? [OWNER_GROUP.slug];
  return {
    id: overrides.id ?? 'm-owner',
    userId: overrides.userId ?? 'u-owner',
    establishmentId: ESTABLISHMENT.id,
    status: overrides.status ?? MembershipStatus.active,
    createdAt: new Date('2026-11-26T12:00:00.000Z'),
    groups: slugs.map((slug) => ({
      group: slug === OWNER_GROUP.slug ? OWNER_GROUP : STAFF_GROUP,
    })),
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Se esperaba un AppError ${status} ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
  }
}

describe('EstablishmentsService', () => {
  let tx: TxMock;
  let prisma: {
    $transaction: jest.Mock;
    establishment: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    membership: { findMany: jest.Mock };
  };
  let logger: { raw: { info: jest.Mock } };
  let service: EstablishmentsService;

  beforeEach(() => {
    tx = buildTx();
    prisma = {
      $transaction: jest.fn(),
      establishment: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      membership: { findMany: jest.fn() },
    };
    prisma.$transaction.mockImplementation(
      (callback: (client: TxMock) => Promise<unknown>) => callback(tx),
    );
    logger = { raw: { info: jest.fn() } };
    provisionMock.mockReset();
    provisionMock.mockResolvedValue(undefined);

    service = new EstablishmentsService(
      prisma as unknown as PrismaService,
      logger as unknown as AppLogger,
    );
  });

  describe('create', () => {
    const dto = {
      name: 'Cancha Norte',
      slug: 'cancha-norte',
      ownerUserId: 'u-owner',
      timezone: 'America/Bogota',
      currency: 'cop',
    };

    it('crea sede, grupos, membresía owner activa y asignación en una transacción', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'u-owner',
        status: UserStatus.active,
      });
      tx.membership.create.mockResolvedValue({ id: 'm-owner' });

      const result = await service.create('admin-1', dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u-owner' },
        select: { id: true, status: true },
      });
      expect(tx.establishment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Cancha Norte',
            slug: 'cancha-norte',
            status: EstablishmentStatus.active,
            currency: 'COP',
          }),
        }),
      );
      expect(provisionMock).toHaveBeenCalledWith(tx, ESTABLISHMENT.id);
      expect(tx.membership.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-owner',
          establishmentId: ESTABLISHMENT.id,
          status: MembershipStatus.active,
        },
        select: { id: true },
      });
      expect(tx.membershipGroup.create).toHaveBeenCalledWith({
        data: {
          membershipId: 'm-owner',
          groupId: OWNER_GROUP.id,
          establishmentId: ESTABLISHMENT.id,
        },
      });
      expect(result.owner).toEqual({
        membershipId: 'm-owner',
        userId: 'u-owner',
        status: MembershipStatus.active,
        groups: [OWNER_GROUP.slug],
      });
      expect(logger.raw.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'establishment.created',
          actorId: 'admin-1',
          establishmentId: ESTABLISHMENT.id,
          ownerUserId: 'u-owner',
        }),
        'establishment.created',
      );
    });

    it('rechaza owner inexistente con 422 OWNER_NOT_FOUND y no crea nada', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expectAppError(
        service.create('admin-1', dto),
        422,
        'OWNER_NOT_FOUND',
      );

      expect(tx.establishment.create).not.toHaveBeenCalled();
      expect(provisionMock).not.toHaveBeenCalled();
      expect(tx.membership.create).not.toHaveBeenCalled();
    });

    it('rechaza owner suspendido con 422 OWNER_NOT_FOUND', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'u-owner',
        status: UserStatus.suspended,
      });

      await expectAppError(
        service.create('admin-1', dto),
        422,
        'OWNER_NOT_FOUND',
      );

      expect(tx.establishment.create).not.toHaveBeenCalled();
    });

    it('rechaza una zona horaria IANA inválida antes de abrir la transacción', async () => {
      await expectAppError(
        service.create('admin-1', { ...dto, timezone: 'No/Existe' }),
        400,
        'VALIDATION_ERROR',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.establishment.create).not.toHaveBeenCalled();
    });
  });

  describe('addMembership', () => {
    const dto = { userId: 'u-target', groupSlug: 'staff' as const };

    beforeEach(() => {
      tx.user.findUnique.mockResolvedValue({
        id: 'u-target',
        status: UserStatus.active,
      });
    });

    it('un owner no puede asignar el grupo owner (403 PERMISSION_DENIED)', async () => {
      await expectAppError(
        service.addMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          {
            userId: 'u-target',
            groupSlug: 'owner',
          },
        ),
        403,
        'PERMISSION_DENIED',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un owner puede asignar staff: upsert a active y asignación del grupo', async () => {
      tx.membership.findUnique.mockResolvedValue(null);

      const result = await service.addMembership(
        tenant(false),
        'owner-1',
        ESTABLISHMENT.id,
        dto,
      );

      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.membership.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-target',
          establishmentId: ESTABLISHMENT.id,
          status: MembershipStatus.active,
        },
        select: { id: true },
      });
      expect(tx.membershipGroup.create).toHaveBeenCalledWith({
        data: {
          membershipId: 'm-new',
          groupId: STAFF_GROUP.id,
          establishmentId: ESTABLISHMENT.id,
        },
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'm-new',
          status: MembershipStatus.active,
          groups: [{ slug: STAFF_GROUP.slug, name: STAFF_GROUP.name }],
        }),
      );
    });

    it('cuando reactiva una membresía existente reemplaza la asignación de grupo', async () => {
      tx.membership.findUnique.mockResolvedValue(
        activeOwnerMembership({
          id: 'm-existing',
          userId: 'u-target',
          status: MembershipStatus.removed,
        }),
      );
      tx.membership.count.mockResolvedValue(2);

      await service.addMembership(
        tenant(false),
        'owner-1',
        ESTABLISHMENT.id,
        dto,
      );

      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm-existing' },
        data: { status: MembershipStatus.active },
      });
      expect(tx.membershipGroup.deleteMany).toHaveBeenCalledWith({
        where: { membershipId: 'm-existing' },
      });
      expect(tx.membershipGroup.create).toHaveBeenCalledWith({
        data: {
          membershipId: 'm-existing',
          groupId: STAFF_GROUP.id,
          establishmentId: ESTABLISHMENT.id,
        },
      });
    });

    it('no degrada al último owner al hacer upsert de staff (409 INVALID_STATE)', async () => {
      tx.membership.findUnique.mockResolvedValue(
        activeOwnerMembership({ userId: 'u-target' }),
      );
      tx.membership.count.mockResolvedValue(1);

      await expectAppError(
        service.addMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          dto,
        ),
        409,
        'INVALID_STATE',
      );

      expect(tx.membership.update).not.toHaveBeenCalled();
      expect(tx.membershipGroup.deleteMany).not.toHaveBeenCalled();
    });

    it('permite degradar a un owner cuando existe otro owner activo', async () => {
      tx.membership.findUnique.mockResolvedValue(
        activeOwnerMembership({ userId: 'u-target' }),
      );
      tx.membership.count.mockResolvedValue(2);

      await service.addMembership(
        tenant(false),
        'owner-1',
        ESTABLISHMENT.id,
        dto,
      );

      expect(tx.membership.update).toHaveBeenCalled();
      expect(tx.membershipGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ groupId: STAFF_GROUP.id }),
        }),
      );
    });

    it('un platform-admin puede asignar owner', async () => {
      tx.membership.findUnique.mockResolvedValue(null);

      const result = await service.addMembership(
        tenant(true),
        'admin-1',
        ESTABLISHMENT.id,
        { userId: 'u-target', groupSlug: 'owner' },
      );

      expect(result.groups[0]?.slug).toBe(OWNER_GROUP.slug);
    });

    it('rechaza usuario inexistente con 404 USER_NOT_FOUND', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expectAppError(
        service.addMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          dto,
        ),
        404,
        'USER_NOT_FOUND',
      );

      expect(tx.membership.create).not.toHaveBeenCalled();
    });
  });

  describe('updateMembership', () => {
    it('rechaza una actualización vacía con 400 VALIDATION_ERROR', async () => {
      await expectAppError(
        service.updateMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-1',
          {},
        ),
        400,
        'VALIDATION_ERROR',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un owner no puede convertir staff en owner (403 PERMISSION_DENIED)', async () => {
      await expectAppError(
        service.updateMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-1',
          { groupSlug: 'owner' },
        ),
        403,
        'PERMISSION_DENIED',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un owner no puede reactivar una membresía owner retirada (403)', async () => {
      tx.membership.findFirst.mockResolvedValue(
        activeOwnerMembership({ status: MembershipStatus.removed }),
      );

      await expectAppError(
        service.updateMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-owner',
          { status: MembershipStatus.active },
        ),
        403,
        'PERMISSION_DENIED',
      );

      expect(tx.membership.update).not.toHaveBeenCalled();
    });

    it('un platform-admin sí puede reactivar una membresía owner retirada', async () => {
      tx.membership.findFirst.mockResolvedValue(
        activeOwnerMembership({ status: MembershipStatus.removed }),
      );

      const result = await service.updateMembership(
        tenant(true),
        'admin-1',
        ESTABLISHMENT.id,
        'm-owner',
        { status: MembershipStatus.active },
      );

      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm-owner' },
        data: { status: MembershipStatus.active },
      });
      expect(result.groups[0]?.slug).toBe(OWNER_GROUP.slug);
    });

    it('protege al último owner al intentar suspenderlo (409 INVALID_STATE)', async () => {
      tx.membership.findFirst.mockResolvedValue(activeOwnerMembership());
      tx.membership.count.mockResolvedValue(1);

      await expectAppError(
        service.updateMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-owner',
          { status: MembershipStatus.suspended },
        ),
        409,
        'INVALID_STATE',
      );

      expect(tx.membership.update).not.toHaveBeenCalled();
    });

    it('protege al último owner al intentar degradarlo a staff', async () => {
      tx.membership.findFirst.mockResolvedValue(activeOwnerMembership());
      tx.membership.count.mockResolvedValue(1);

      await expectAppError(
        service.updateMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-owner',
          { groupSlug: 'staff' },
        ),
        409,
        'INVALID_STATE',
      );

      expect(tx.membership.update).not.toHaveBeenCalled();
      expect(tx.membershipGroup.deleteMany).not.toHaveBeenCalled();
    });

    it('permite degradar a owner si hay otro owner activo', async () => {
      tx.membership.findFirst.mockResolvedValue(activeOwnerMembership());
      tx.membership.count.mockResolvedValue(2);

      const result = await service.updateMembership(
        tenant(false),
        'owner-1',
        ESTABLISHMENT.id,
        'm-owner',
        { groupSlug: 'staff', status: MembershipStatus.active },
      );

      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm-owner' },
        data: { status: MembershipStatus.active },
      });
      expect(tx.membershipGroup.create).toHaveBeenCalledWith({
        data: {
          membershipId: 'm-owner',
          groupId: STAFF_GROUP.id,
          establishmentId: ESTABLISHMENT.id,
        },
      });
      expect(result.groups[0]?.slug).toBe(STAFF_GROUP.slug);
    });

    it('un owner puede suspender a un staff sin tocar el grupo', async () => {
      tx.membership.findFirst.mockResolvedValue(
        activeOwnerMembership({
          id: 'm-staff',
          userId: 'u-staff',
          slugs: [STAFF_GROUP.slug],
        }),
      );

      const result = await service.updateMembership(
        tenant(false),
        'owner-1',
        ESTABLISHMENT.id,
        'm-staff',
        { status: MembershipStatus.suspended },
      );

      expect(tx.membership.count).not.toHaveBeenCalled();
      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm-staff' },
        data: { status: MembershipStatus.suspended },
      });
      expect(result.groups[0]?.slug).toBe(STAFF_GROUP.slug);
    });

    it('rechaza una membresía de otro establecimiento con 404 MEMBERSHIP_NOT_FOUND', async () => {
      tx.membership.findFirst.mockResolvedValue(null);

      await expectAppError(
        service.updateMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-other',
          { status: MembershipStatus.suspended },
        ),
        404,
        'MEMBERSHIP_NOT_FOUND',
      );

      expect(tx.membership.update).not.toHaveBeenCalled();
    });
  });

  describe('removeMembership', () => {
    it('protege al último owner (409 INVALID_STATE)', async () => {
      tx.membership.findFirst.mockResolvedValue(activeOwnerMembership());
      tx.membership.count.mockResolvedValue(1);

      await expectAppError(
        service.removeMembership(
          tenant(false),
          'owner-1',
          ESTABLISHMENT.id,
          'm-owner',
        ),
        409,
        'INVALID_STATE',
      );

      expect(tx.membership.update).not.toHaveBeenCalled();
    });

    it('retira lógicamente a un staff (status removed)', async () => {
      tx.membership.findFirst.mockResolvedValue(
        activeOwnerMembership({
          id: 'm-staff',
          userId: 'u-staff',
          slugs: [STAFF_GROUP.slug],
        }),
      );

      const result = await service.removeMembership(
        tenant(false),
        'owner-1',
        ESTABLISHMENT.id,
        'm-staff',
      );

      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm-staff' },
        data: { status: MembershipStatus.removed },
      });
      expect(result.status).toBe(MembershipStatus.removed);
    });

    it('un platform-admin puede retirar un owner si queda otro activo', async () => {
      tx.membership.findFirst.mockResolvedValue(activeOwnerMembership());
      tx.membership.count.mockResolvedValue(2);

      const result = await service.removeMembership(
        tenant(true),
        'admin-1',
        ESTABLISHMENT.id,
        'm-owner',
      );

      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm-owner' },
        data: { status: MembershipStatus.removed },
      });
      expect(result.status).toBe(MembershipStatus.removed);
    });
  });

  describe('listMine', () => {
    it('devuelve solo las membresías del usuario con sus grupos', async () => {
      prisma.membership.findMany.mockResolvedValue([
        {
          id: 'm-owner',
          status: MembershipStatus.active,
          establishment: {
            id: ESTABLISHMENT.id,
            name: ESTABLISHMENT.name,
            slug: ESTABLISHMENT.slug,
            status: EstablishmentStatus.active,
          },
          groups: [{ group: { slug: OWNER_GROUP.slug } }],
        },
      ]);

      const result = await service.listMine('u-owner');

      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u-owner' } }),
      );
      expect(result).toEqual([
        {
          id: ESTABLISHMENT.id,
          name: ESTABLISHMENT.name,
          slug: ESTABLISHMENT.slug,
          status: MembershipStatus.active,
          groups: [OWNER_GROUP.slug],
        },
      ]);
    });
  });

  describe('update', () => {
    const profile = {
      name: 'Cancha Norte Renovada',
      timezone: 'America/Lima',
      currency: 'PEN',
      address: 'Av. Siempreviva 742',
      contactPhone: '+51 999 888 777',
      contactEmail: 'reservas@cancha.example',
      cancellationPolicy: 'Cancelación sin costo hasta 24 h antes.',
      usagePolicy: 'Uso exclusivo para actividades deportivas.',
      rules: 'Prohibido ingresar con alimentos.',
    };

    beforeEach(() => {
      prisma.establishment.findUnique.mockResolvedValue({
        id: ESTABLISHMENT.id,
      });
      prisma.establishment.update.mockResolvedValue({
        ...ESTABLISHMENT,
        ...profile,
      });
    });

    it('actualiza los campos del perfil y devuelve los nuevos valores con status', async () => {
      const result = await service.update('owner-1', ESTABLISHMENT.id, profile);

      expect(prisma.establishment.findUnique).toHaveBeenCalledWith({
        where: { id: ESTABLISHMENT.id },
        select: { id: true },
      });
      expect(prisma.establishment.update).toHaveBeenCalledWith({
        where: { id: ESTABLISHMENT.id },
        data: profile,
        select: expect.objectContaining({
          address: true,
          contactPhone: true,
          contactEmail: true,
          cancellationPolicy: true,
          usagePolicy: true,
          rules: true,
          status: true,
        }),
      });
      expect(result).toMatchObject({
        status: EstablishmentStatus.active,
        ...profile,
      });
    });

    it('rechaza un body vacío con 400 VALIDATION_ERROR sin tocar la base', async () => {
      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, {}),
        400,
        'VALIDATION_ERROR',
      );

      expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
      expect(prisma.establishment.update).not.toHaveBeenCalled();
    });

    it('rechaza una zona horaria que no es IANA válida', async () => {
      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, {
          timezone: 'No/Existe',
        }),
        400,
        'VALIDATION_ERROR',
      );

      expect(prisma.establishment.update).not.toHaveBeenCalled();
    });

    it('rechaza una moneda que no son 3 letras mayúsculas', async () => {
      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, { currency: 'cop' }),
        400,
        'VALIDATION_ERROR',
      );

      expect(prisma.establishment.update).not.toHaveBeenCalled();
    });

    it('rechaza textos por encima del límite del contrato', async () => {
      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, {
          cancellationPolicy: 'x'.repeat(4001),
        }),
        400,
        'VALIDATION_ERROR',
      );

      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, {
          address: 'x'.repeat(301),
        }),
        400,
        'VALIDATION_ERROR',
      );

      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, {
          contactPhone: '1'.repeat(41),
        }),
        400,
        'VALIDATION_ERROR',
      );

      expect(prisma.establishment.update).not.toHaveBeenCalled();
    });

    it('responde 404 ESTABLISHMENT_NOT_FOUND si la sede no existe', async () => {
      prisma.establishment.findUnique.mockResolvedValue(null);

      await expectAppError(
        service.update('owner-1', ESTABLISHMENT.id, { name: 'Otra' }),
        404,
        'ESTABLISHMENT_NOT_FOUND',
      );

      expect(prisma.establishment.update).not.toHaveBeenCalled();
    });

    it('permite limpiar los campos de contacto enviando null', async () => {
      await service.update('owner-1', ESTABLISHMENT.id, {
        address: null,
        contactEmail: null,
      });

      expect(prisma.establishment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { address: null, contactEmail: null },
        }),
      );
    });

    it('audita actor, sede y nombres de campos sin registrar valores', async () => {
      await service.update('owner-1', ESTABLISHMENT.id, profile);

      expect(logger.raw.info).toHaveBeenCalledWith(
        {
          event: 'establishment.updated',
          actorId: 'owner-1',
          establishmentId: ESTABLISHMENT.id,
          changedFields: [
            'name',
            'timezone',
            'currency',
            'address',
            'contactPhone',
            'contactEmail',
            'cancellationPolicy',
            'usagePolicy',
            'rules',
          ],
          decision: 'allow',
        },
        'establishment.updated',
      );

      const [payload] = logger.raw.info.mock.calls[0] as [
        Record<string, unknown>,
      ];
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(profile.contactPhone);
      expect(serialized).not.toContain(profile.contactEmail);
      expect(serialized).not.toContain(profile.address);
      expect(serialized).not.toContain(profile.rules);
    });
  });

  describe('getPublicBySlug', () => {
    it('devuelve solo el perfil público de una sede activa', async () => {
      prisma.establishment.findUnique.mockResolvedValue({
        name: ESTABLISHMENT.name,
        slug: ESTABLISHMENT.slug,
        timezone: ESTABLISHMENT.timezone,
        currency: ESTABLISHMENT.currency,
        address: 'Av. Siempreviva 742',
        contactPhone: '+57 300 123 4567',
        contactEmail: 'contacto@cancha.example',
        cancellationPolicy: 'Política de cancelación.',
        usagePolicy: 'Política de uso.',
        rules: 'Reglas internas.',
        status: EstablishmentStatus.active,
      });

      const result = await service.getPublicBySlug(ESTABLISHMENT.slug);

      expect(prisma.establishment.findUnique).toHaveBeenCalledWith({
        where: { slug: ESTABLISHMENT.slug },
        select: expect.objectContaining({
          name: true,
          slug: true,
          timezone: true,
          currency: true,
          address: true,
          contactPhone: true,
          contactEmail: true,
          cancellationPolicy: true,
          usagePolicy: true,
          rules: true,
        }),
      });
      expect(result).toEqual({
        name: ESTABLISHMENT.name,
        slug: ESTABLISHMENT.slug,
        timezone: ESTABLISHMENT.timezone,
        currency: ESTABLISHMENT.currency,
        address: 'Av. Siempreviva 742',
        contactPhone: '+57 300 123 4567',
        contactEmail: 'contacto@cancha.example',
        cancellationPolicy: 'Política de cancelación.',
        usagePolicy: 'Política de uso.',
        rules: 'Reglas internas.',
      });
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('id');
    });

    it('oculta una sede suspendida con 404', async () => {
      prisma.establishment.findUnique.mockResolvedValue({
        name: ESTABLISHMENT.name,
        slug: ESTABLISHMENT.slug,
        timezone: ESTABLISHMENT.timezone,
        currency: ESTABLISHMENT.currency,
        address: null,
        contactPhone: null,
        contactEmail: null,
        cancellationPolicy: null,
        usagePolicy: null,
        rules: null,
        status: EstablishmentStatus.suspended,
      });

      await expectAppError(
        service.getPublicBySlug(ESTABLISHMENT.slug),
        404,
        'ESTABLISHMENT_NOT_FOUND',
      );
    });

    it('responde 404 si el slug no existe', async () => {
      prisma.establishment.findUnique.mockResolvedValue(null);

      await expectAppError(
        service.getPublicBySlug('no-existe'),
        404,
        'ESTABLISHMENT_NOT_FOUND',
      );
    });
  });
});
