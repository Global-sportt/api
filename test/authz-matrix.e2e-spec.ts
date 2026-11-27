import {
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
  PrismaClient,
} from '@prisma/client';
import { CerbosAuthorizationService } from '../src/common/authz/authorization.service';
import { CerbosClient } from '../src/common/authz/cerbos.client';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';
import { PermissionResolver } from '../src/common/authz/permission-resolver.service';
import { PERMISSION_CATALOG } from '../src/common/authz/permissions';
import type {
  AuthorizationService,
  AuthorizedPrincipal,
} from '../src/common/authz/authorization.types';
import { PLAN_KIND } from '../src/common/authz/authorization.types';
import type { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120_000);

/**
 * F-05 — the 80 cells of docs/authorization-acceptance-matrix.md §2.
 *
 * The expected matrix is written literally below (not derived from the grant
 * constants) so a drift in the seed/catalogue is detected. Every cell is
 * resolved from PostgreSQL through `PermissionResolver` and decided by the
 * Cerbos PDP (`E2E_REAL_CERBOS=1`) or, for the default local run, by a small
 * scope double that implements the same contract.
 */

type ExpectedScope = 'own' | 'establishment' | 'platform' | null;
type GroupName = 'player' | 'platform-admin' | 'owner' | 'staff';

const PLAYER_MATRIX: Record<string, ExpectedScope> = {
  'establishment:read': null,
  'establishment:create': null,
  'establishment:update': null,
  'establishment:suspend': null,
  'membership:read': null,
  'membership:manage': null,
  'space:read': null,
  'space:create': null,
  'space:update': null,
  'space:delete': null,
  'schedule:read': null,
  'schedule:manage': null,
  'price:read': null,
  'price:manage': null,
  'booking:read': 'own',
  'booking:create': 'own',
  'booking:cancel': 'own',
  'booking:manage': null,
  'report:read': null,
  'day:close': null,
};

const PLATFORM_ADMIN_MATRIX: Record<string, ExpectedScope> = Object.fromEntries(
  PERMISSION_CATALOG.map((permission) => [permission.code, 'platform']),
);

const OWNER_MATRIX: Record<string, ExpectedScope> = {
  'establishment:read': 'establishment',
  'establishment:create': null,
  'establishment:update': 'establishment',
  'establishment:suspend': null,
  'membership:read': 'establishment',
  'membership:manage': 'establishment',
  'space:read': 'establishment',
  'space:create': 'establishment',
  'space:update': 'establishment',
  'space:delete': 'establishment',
  'schedule:read': 'establishment',
  'schedule:manage': 'establishment',
  'price:read': 'establishment',
  'price:manage': 'establishment',
  'booking:read': 'establishment',
  'booking:create': 'establishment',
  'booking:cancel': 'establishment',
  'booking:manage': 'establishment',
  'report:read': 'establishment',
  'day:close': 'establishment',
};

const STAFF_MATRIX: Record<string, ExpectedScope> = {
  'establishment:read': 'establishment',
  'establishment:create': null,
  'establishment:update': null,
  'establishment:suspend': null,
  'membership:read': null,
  'membership:manage': null,
  'space:read': 'establishment',
  'space:create': null,
  'space:update': null,
  'space:delete': null,
  'schedule:read': 'establishment',
  'schedule:manage': null,
  'price:read': 'establishment',
  'price:manage': null,
  'booking:read': 'establishment',
  'booking:create': 'establishment',
  'booking:cancel': 'establishment',
  'booking:manage': 'establishment',
  'report:read': 'establishment',
  'day:close': 'establishment',
};

const MATRICES: Record<GroupName, Record<string, ExpectedScope>> = {
  player: PLAYER_MATRIX,
  'platform-admin': PLATFORM_ADMIN_MATRIX,
  owner: OWNER_MATRIX,
  staff: STAFF_MATRIX,
};

interface MatrixCell {
  id: string;
  permission: string;
  group: GroupName;
  expected: ExpectedScope;
  expectedLabel: string;
}

function buildCells(): MatrixCell[] {
  return (Object.keys(MATRICES) as GroupName[]).flatMap((group) =>
    PERMISSION_CATALOG.map((permission) => {
      const expected = MATRICES[group][permission.code] ?? null;
      return {
        id: `M-${permission.code.replace(':', '-')}-${group}`,
        permission: permission.code,
        group,
        expected,
        expectedLabel: expected ?? 'DENY',
      };
    }),
  );
}

const CELLS = buildCells();
const PERMISSION_BY_CODE = new Map<
  string,
  (typeof PERMISSION_CATALOG)[number]
>(PERMISSION_CATALOG.map((permission) => [permission.code, permission]));

/** Scope double for runs without the external PDP (same contract as Cerbos). */
const scopePdp: AuthorizationService = {
  async can(principal, resourceKind, action, resource): Promise<boolean> {
    const scope = principal.permissions[`${resourceKind}:${action}`];
    if (!scope) return false;
    if (scope === 'platform') return true;
    if (scope === 'establishment') {
      return (
        typeof principal.establishmentId === 'string' &&
        resource?.establishmentId === principal.establishmentId
      );
    }
    if (scope === 'own') {
      return resource?.playerId === principal.userId;
    }
    return false;
  },
  async plan() {
    return { kind: PLAN_KIND.ALWAYS_DENIED };
  },
};

function resourceAttrs(
  permissionCode: string,
  input: { establishmentId?: string; playerId?: string },
): Record<string, unknown> {
  const permission = PERMISSION_BY_CODE.get(permissionCode);
  if (!permission) throw new Error(`Permiso desconocido: ${permissionCode}`);

  const attrs: Record<string, unknown> = {};
  if (input.establishmentId !== undefined) {
    attrs.establishmentId = input.establishmentId;
  }
  if (permission.resource === 'booking' && input.playerId !== undefined) {
    attrs.playerId = input.playerId;
  }
  return attrs;
}

describe('Matriz de autorización M-* (80 celdas, Prisma + Cerbos)', () => {
  const prisma = new PrismaClient();
  const resolver = new PermissionResolver(prisma as unknown as PrismaService);

  let establishmentE1: string;
  let establishmentE2: string;
  let playerId: string;
  let adminId: string;
  let ownerId: string;
  let staffId: string;
  let dualId: string;
  let noPermsId: string;

  let playerGlobal: AuthorizedPrincipal;
  let adminGlobal: AuthorizedPrincipal;
  let adminE1: AuthorizedPrincipal;
  let ownerE1: AuthorizedPrincipal;
  let staffE1: AuthorizedPrincipal;

  let authorization: AuthorizationService;

  beforeAll(async () => {
    await prisma.$connect();

    if (process.env.E2E_REAL_CERBOS === '1') {
      const cerbosUrl = process.env.CERBOS_URL ?? 'http://127.0.0.1:3592';
      const health = await fetch(`${cerbosUrl}/_cerbos/health`).catch(
        () => null,
      );
      if (!health?.ok) {
        throw new Error(
          `F-05: E2E_REAL_CERBOS=1 pero Cerbos no responde en ${cerbosUrl}.`,
        );
      }
      const client = new CerbosClient({ url: cerbosUrl });
      authorization = new CerbosAuthorizationService(client);
    } else {
      authorization = scopePdp;
    }

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [e1, e2] = await Promise.all([
      prisma.establishment.create({
        data: {
          name: 'F05 E1',
          slug: `f05-e1-${suffix}`,
          timezone: 'America/Bogota',
          currency: 'COP',
          status: EstablishmentStatus.active,
        },
        select: { id: true },
      }),
      prisma.establishment.create({
        data: {
          name: 'F05 E2',
          slug: `f05-e2-${suffix}`,
          timezone: 'America/Bogota',
          currency: 'COP',
          status: EstablishmentStatus.active,
        },
        select: { id: true },
      }),
    ]);
    establishmentE1 = e1.id;
    establishmentE2 = e2.id;

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, establishmentE1);
      await provisionEstablishmentGroups(tx, establishmentE2);
    });

    const playerGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: null, slug: 'player' },
      select: { id: true },
    });
    const adminGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: null, slug: 'platform-admin' },
      select: { id: true },
    });

    const users = await Promise.all(
      ['player', 'admin', 'owner', 'staff', 'dual', 'no-perms'].map((label) =>
        prisma.user.create({
          data: { email: `f05-${label}-${suffix}@example.test` },
          select: { id: true },
        }),
      ),
    );
    [playerId, adminId, ownerId, staffId, dualId, noPermsId] = users.map(
      (user) => user.id,
    );

    await prisma.userGlobalGroup.createMany({
      data: [
        { userId: playerId, groupId: playerGroup.id, groupScope: GroupScope.global },
        { userId: adminId, groupId: playerGroup.id, groupScope: GroupScope.global },
        { userId: ownerId, groupId: playerGroup.id, groupScope: GroupScope.global },
        { userId: staffId, groupId: playerGroup.id, groupScope: GroupScope.global },
        { userId: dualId, groupId: playerGroup.id, groupScope: GroupScope.global },
        { userId: adminId, groupId: adminGroup.id, groupScope: GroupScope.global },
      ],
    });

    async function addMembership(
      userId: string,
      establishmentId: string,
      slug: 'owner' | 'staff',
    ): Promise<void> {
      const group = await prisma.securityGroup.findFirstOrThrow({
        where: { establishmentId, slug },
        select: { id: true },
      });
      const membership = await prisma.membership.create({
        data: {
          userId,
          establishmentId,
          status: MembershipStatus.active,
        },
        select: { id: true },
      });
      await prisma.membershipGroup.create({
        data: {
          membershipId: membership.id,
          groupId: group.id,
          establishmentId,
        },
      });
    }

    await addMembership(ownerId, establishmentE1, 'owner');
    await addMembership(staffId, establishmentE1, 'staff');
    // dual = owner of E1 + staff of E2: NEG-03 tenant isolation fixture.
    await addMembership(dualId, establishmentE1, 'owner');
    await addMembership(dualId, establishmentE2, 'staff');

    [playerGlobal, adminGlobal, adminE1, ownerE1, staffE1] = await Promise.all([
      resolver.resolve(playerId),
      resolver.resolve(adminId),
      resolver.resolve(adminId, establishmentE1),
      resolver.resolve(ownerId, establishmentE1),
      resolver.resolve(staffId, establishmentE1),
    ]);
  });

  afterAll(async () => {
    resolver.invalidate();
    await prisma.establishment.deleteMany({
      where: { id: { in: [establishmentE1, establishmentE2] } },
    });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [playerId, adminId, ownerId, staffId, dualId, noPermsId],
        },
      },
    });
    await prisma.$disconnect();
  });

  function principalFor(cell: MatrixCell): {
    principal: AuthorizedPrincipal;
    tenantId?: string;
  } {
    if (cell.group === 'player') return { principal: playerGlobal };
    if (cell.group === 'platform-admin') return { principal: adminGlobal };
    if (cell.group === 'owner') {
      return { principal: ownerE1, tenantId: establishmentE1 };
    }
    return { principal: staffE1, tenantId: establishmentE1 };
  }

  it('genera exactamente 80 IDs M-* únicos (20 permisos × 4 grupos)', () => {
    expect(CELLS).toHaveLength(80);
    expect(new Set(CELLS.map((cell) => cell.id)).size).toBe(80);
    expect(
      new Set(CELLS.map((cell) => cell.permission)).size,
    ).toBe(PERMISSION_CATALOG.length);
    expect(
      CELLS.filter((cell) => cell.expected === null),
    ).toHaveLength(29); // 29 celdas DENY del contrato
  });

  it.each(CELLS)(
    '$id · $permission · $group = $expectedLabel',
    async (cell) => {
      const permission = PERMISSION_BY_CODE.get(cell.permission);
      expect(permission).toBeDefined();
      const { principal, tenantId } = principalFor(cell);

      if (cell.expected === null) {
        expect(principal.permissions[cell.permission]).toBeUndefined();
        const denied = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, {
            establishmentId: tenantId ?? establishmentE1,
            playerId: cell.group === 'player' ? playerId : ownerId,
          }),
        );
        expect(denied).toBe(false);
        return;
      }

      expect(principal.permissions[cell.permission]).toBe(cell.expected);

      if (cell.expected === 'own') {
        const allowed = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, { playerId }),
        );
        expect(allowed).toBe(true);

        const otherPlayer = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, { playerId: ownerId }),
        );
        expect(otherPlayer).toBe(false);
        return;
      }

      if (cell.expected === 'establishment') {
        const ownTenant = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, {
            establishmentId: establishmentE1,
            playerId: ownerId,
          }),
        );
        expect(ownTenant).toBe(true);

        const otherTenant = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, {
            establishmentId: establishmentE2,
            playerId: ownerId,
          }),
        );
        expect(otherTenant).toBe(false);

        const noTenant = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, { playerId: ownerId }),
        );
        expect(noTenant).toBe(false);
        return;
      }

      // platform: no membership needed, both tenants are reachable.
      for (const establishmentId of [establishmentE1, establishmentE2]) {
        const allowed = await authorization.can(
          principal,
          permission!.resource,
          permission!.action,
          resourceAttrs(cell.permission, {
            establishmentId,
            playerId: adminId,
          }),
        );
        expect(allowed).toBe(true);
      }

      // The tenant-context principal of a platform admin resolves the same
      // platform scope (Q11/Q14), so the bypass also works with TenantGuard.
      expect(adminE1.permissions[cell.permission]).toBe('platform');
    },
  );

  it('NEG-03: dual (owner E1 + staff E2) no mezcla permisos entre tenants', async () => {
    const dualE1 = await resolver.resolve(dualId, establishmentE1);
    const dualE2 = await resolver.resolve(dualId, establishmentE2);

    expect(dualE1.permissions['membership:read']).toBe('establishment');
    expect(dualE1.permissions['booking:manage']).toBe('establishment');
    expect(dualE2.permissions['membership:read']).toBeUndefined();
    expect(dualE2.permissions['membership:manage']).toBeUndefined();
    expect(dualE2.permissions['establishment:update']).toBeUndefined();
    expect(dualE2.permissions['space:create']).toBeUndefined();
    expect(dualE2.permissions['booking:read']).toBe('establishment');

    const membership = PERMISSION_BY_CODE.get('membership:read')!;
    await expect(
      authorization.can(
        dualE1,
        membership.resource,
        membership.action,
        resourceAttrs('membership:read', {
          establishmentId: establishmentE1,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      authorization.can(
        dualE2,
        membership.resource,
        membership.action,
        resourceAttrs('membership:read', {
          establishmentId: establishmentE2,
        }),
      ),
    ).resolves.toBe(false);

    // Warm the E1 cache, then E2, then E1: keys are tenant-specific.
    const dualE1Again = await resolver.resolve(dualId, establishmentE1);
    expect(dualE1Again.permissions).toEqual(dualE1.permissions);
    expect(dualE2.permissions).not.toEqual(dualE1.permissions);
  });

  it('NEG-05 (runtime): principal sin permisos y permiso desconocido fallan cerrado', async () => {
    const anonymousPrincipal = await resolver.resolve(noPermsId);
    expect(anonymousPrincipal.permissions).toEqual({});

    for (const permission of PERMISSION_CATALOG) {
      const allowed = await authorization.can(
        anonymousPrincipal,
        permission.resource,
        permission.action,
        resourceAttrs(permission.code, {
          establishmentId: establishmentE1,
          playerId: noPermsId,
        }),
      );
      expect(allowed).toBe(false);
    }

    // Unknown action (typo in @Authorize('booking','reed')): the PDP has no
    // rule, so it must deny instead of allowing by default.
    const unknown = await authorization.can(
      adminGlobal,
      'booking',
      'reed',
      { establishmentId: establishmentE1, playerId: adminId },
    );
    expect(unknown).toBe(false);
  });
});
