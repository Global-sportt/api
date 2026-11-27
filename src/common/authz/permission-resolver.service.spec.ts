import {
  GroupScope,
  MembershipStatus,
  PermissionScope,
} from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from './permission-resolver.service';
import {
  OWNER_GRANT_CODES,
  OWNER_GROUP_SLUG,
  PERMISSION_CODES,
  PLATFORM_ADMIN_GRANT_CODES,
  PLATFORM_ADMIN_GROUP_SLUG,
  PLAYER_GRANT_CODES,
  PLAYER_GROUP_SLUG,
  STAFF_GRANT_CODES,
  STAFF_GROUP_SLUG,
  type PermissionCode,
} from './permissions';

interface GrantRecord {
  scope: PermissionScope;
  permission: { code: string };
}

interface GroupRecord {
  slug: string;
  scope: GroupScope;
  permissions: GrantRecord[];
}

interface GlobalAssignmentRecord {
  group: GroupRecord;
}

interface MembershipRecord {
  status: MembershipStatus;
  groups: Array<{ group: GroupRecord }>;
}

interface UserRecord extends Record<string, unknown> {
  globalGroups: GlobalAssignmentRecord[];
}

/**
 * Fake mínimo de Prisma: solo los tres métodos que usa el resolver. No toca
 * base de datos; devuelve las formas exactas que el resolver selecciona.
 */
class FakePrisma {
  version = 1n;

  readonly calls = {
    authorizationVersion: 0,
    user: 0,
    membership: 0,
  };

  private readonly users = new Map<string, UserRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();

  readonly authorizationVersion = {
    findUnique: jest.fn(async () => {
      this.calls.authorizationVersion += 1;
      return { version: this.version };
    }),
  };

  readonly user = {
    findUnique: jest.fn(async (args: { where: { id: string } }) => {
      this.calls.user += 1;
      return this.users.get(args.where.id) ?? null;
    }),
  };

  readonly membership = {
    findUnique: jest.fn(
      async (args: {
        where: {
          userId_establishmentId: {
            userId: string;
            establishmentId: string;
          };
        };
      }) => {
        this.calls.membership += 1;
        const { userId, establishmentId } =
          args.where.userId_establishmentId;

        return this.memberships.get(`${userId}::${establishmentId}`) ?? null;
      },
    ),
  };

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }

  addUser(
    userId: string,
    globalGroups: GlobalAssignmentRecord[],
    extra: Record<string, unknown> = {},
  ): void {
    this.users.set(userId, { ...extra, globalGroups });
  }

  addMembership(
    userId: string,
    establishmentId: string,
    record: MembershipRecord,
  ): void {
    this.memberships.set(`${userId}::${establishmentId}`, record);
  }
}

function makeGroup(
  slug: string,
  scope: GroupScope,
  codes: readonly PermissionCode[],
  grantScope: PermissionScope,
): GroupRecord {
  return {
    slug,
    scope,
    permissions: codes.map((code) => ({
      scope: grantScope,
      permission: { code },
    })),
  };
}

function globalGroup(
  slug: string,
  codes: readonly PermissionCode[],
  grantScope: PermissionScope,
): GlobalAssignmentRecord {
  return {
    group: makeGroup(slug, GroupScope.global, codes, grantScope),
  };
}

function membership(
  status: MembershipStatus,
  ...groups: GroupRecord[]
): MembershipRecord {
  return { status, groups: groups.map((group) => ({ group })) };
}

function playerGroup(): GlobalAssignmentRecord {
  return globalGroup(
    PLAYER_GROUP_SLUG,
    PLAYER_GRANT_CODES,
    PermissionScope.own,
  );
}

function platformAdminGroup(): GlobalAssignmentRecord {
  return globalGroup(
    PLATFORM_ADMIN_GROUP_SLUG,
    PLATFORM_ADMIN_GRANT_CODES,
    PermissionScope.platform,
  );
}

function ownerGroup(): GroupRecord {
  return makeGroup(
    OWNER_GROUP_SLUG,
    GroupScope.establishment,
    OWNER_GRANT_CODES,
    PermissionScope.establishment,
  );
}

function staffGroup(): GroupRecord {
  return makeGroup(
    STAFF_GROUP_SLUG,
    GroupScope.establishment,
    STAFF_GRANT_CODES,
    PermissionScope.establishment,
  );
}

function grantsFor(
  codes: readonly PermissionCode[],
  scope: PermissionScope,
): Record<string, PermissionScope> {
  return Object.fromEntries(
    codes.map((code): [string, PermissionScope] => [code, scope]),
  );
}

const playerOwn = grantsFor(PLAYER_GRANT_CODES, PermissionScope.own);
const ownerAtEstablishment = grantsFor(
  OWNER_GRANT_CODES,
  PermissionScope.establishment,
);
const staffAtEstablishment = grantsFor(
  STAFF_GRANT_CODES,
  PermissionScope.establishment,
);
const platformAtPlatform = grantsFor(
  PERMISSION_CODES,
  PermissionScope.platform,
);

function setup(): {
  resolver: PermissionResolver;
  fake: FakePrisma;
} {
  const fake = new FakePrisma();

  return {
    resolver: new PermissionResolver(fake.asService()),
    fake,
  };
}

describe('PermissionResolver', () => {
  it('resuelve un jugador solo con sus permisos own y sin tenant', async () => {
    const { resolver, fake } = setup();
    fake.addUser('player-1', [playerGroup()]);

    const result = await resolver.resolve('player-1');

    expect(result).toEqual({
      userId: 'player-1',
      permissions: {
        'booking:read': PermissionScope.own,
        'booking:create': PermissionScope.own,
        'booking:cancel': PermissionScope.own,
      },
      isPlatformAdmin: false,
    });
    expect(result.establishmentId).toBeUndefined();
    expect(result.membershipStatus).toBeUndefined();
    expect(fake.membership.findUnique).not.toHaveBeenCalled();
  });

  it('combina player global con staff activo y aplica el alcance máximo', async () => {
    const { resolver, fake } = setup();
    fake.addUser('staff-1', [playerGroup()]);
    fake.addMembership(
      'staff-1',
      'E1',
      membership(MembershipStatus.active, staffGroup()),
    );

    const result = await resolver.resolve('staff-1', 'E1');

    expect(result).toEqual({
      userId: 'staff-1',
      permissions: { ...playerOwn, ...staffAtEstablishment },
      establishmentId: 'E1',
      membershipStatus: MembershipStatus.active,
      isPlatformAdmin: false,
    });
    // own en el grupo global queda elevado a establishment por el grupo staff.
    expect(result.permissions['booking:read']).toBe(
      PermissionScope.establishment,
    );
    expect(result.permissions['membership:read']).toBeUndefined();
  });

  it('una membresía suspendida solo conserva los permisos globales', async () => {
    const { resolver, fake } = setup();
    fake.addUser('staff-1', [playerGroup()]);
    fake.addMembership(
      'staff-1',
      'E1',
      membership(MembershipStatus.suspended, staffGroup()),
    );

    const result = await resolver.resolve('staff-1', 'E1');

    expect(result).toEqual({
      userId: 'staff-1',
      permissions: playerOwn,
      establishmentId: 'E1',
      membershipStatus: MembershipStatus.suspended,
      isPlatformAdmin: false,
    });
  });

  it('concede al owner membership y la familia de escritura de space', async () => {
    const { resolver, fake } = setup();
    fake.addUser('owner-1', [playerGroup()]);
    fake.addMembership(
      'owner-1',
      'E1',
      membership(MembershipStatus.active, ownerGroup()),
    );

    const result = await resolver.resolve('owner-1', 'E1');

    expect(result.permissions).toEqual({
      ...playerOwn,
      ...ownerAtEstablishment,
    });
    expect(result.membershipStatus).toBe(MembershipStatus.active);
    expect(result.permissions['membership:read']).toBe(
      PermissionScope.establishment,
    );
    expect(result.permissions['membership:manage']).toBe(
      PermissionScope.establishment,
    );

    for (const code of [
      'space:read',
      'space:create',
      'space:update',
      'space:delete',
    ] as const) {
      expect(result.permissions[code]).toBe(PermissionScope.establishment);
    }
  });

  it('resuelve cada tenant con su propia membresía y nunca con la unión', async () => {
    const { resolver, fake } = setup();
    fake.addUser('dual-1', [playerGroup()]);
    fake.addMembership(
      'dual-1',
      'E1',
      membership(MembershipStatus.active, ownerGroup()),
    );
    fake.addMembership(
      'dual-1',
      'E2',
      membership(MembershipStatus.active, staffGroup()),
    );

    const e1 = await resolver.resolve('dual-1', 'E1');
    const e2 = await resolver.resolve('dual-1', 'E2');

    expect(e1.establishmentId).toBe('E1');
    expect(e1.permissions).toEqual({
      ...playerOwn,
      ...ownerAtEstablishment,
    });
    expect(e1.permissions['membership:read']).toBe(
      PermissionScope.establishment,
    );

    expect(e2.establishmentId).toBe('E2');
    expect(e2.permissions).toEqual({
      ...playerOwn,
      ...staffAtEstablishment,
    });
    expect(e2.permissions['booking:read']).toBe(
      PermissionScope.establishment,
    );

    // Ningún permiso exclusivo de owner de E1 se filtra al contexto E2.
    const ownerOnly = OWNER_GRANT_CODES.filter(
      (code) => !STAFF_GRANT_CODES.includes(code),
    );
    expect(ownerOnly.length).toBeGreaterThan(0);
    for (const code of ownerOnly) {
      expect(e2.permissions[code]).toBeUndefined();
    }

    expect(fake.membership.findUnique).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          userId_establishmentId: { userId: 'dual-1', establishmentId: 'E1' },
        },
      }),
    );
    expect(fake.membership.findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          userId_establishmentId: { userId: 'dual-1', establishmentId: 'E2' },
        },
      }),
    );
  });

  it('da al platform-admin todo el catálogo a platform sin membresía', async () => {
    const { resolver, fake } = setup();
    fake.addUser('admin-1', [playerGroup(), platformAdminGroup()]);

    const global = await resolver.resolve('admin-1');

    expect(global.permissions).toEqual(platformAtPlatform);
    expect(global.permissions).toHaveProperty('establishment:create');
    expect(global.permissions['establishment:create']).toBe(
      PermissionScope.platform,
    );
    expect(global.isPlatformAdmin).toBe(true);
    expect(global.establishmentId).toBeUndefined();
    expect(fake.membership.findUnique).not.toHaveBeenCalled();

    // Tampoco necesita una membresía para operar en un tenant.
    const tenant = await resolver.resolve('admin-1', 'E9');

    expect(tenant.permissions).toEqual(platformAtPlatform);
    expect(tenant.isPlatformAdmin).toBe(true);
    expect(tenant.establishmentId).toBe('E9');
    expect(tenant.membershipStatus).toBeUndefined();
  });

  it('reutiliza la resolución para el mismo user, tenant y versión', async () => {
    const { resolver, fake } = setup();
    fake.addUser('staff-1', [playerGroup()]);
    fake.addMembership(
      'staff-1',
      'E1',
      membership(MembershipStatus.active, staffGroup()),
    );

    const first = await resolver.resolve('staff-1', 'E1');
    const second = await resolver.resolve('staff-1', 'E1');

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    // La versión se lee siempre para construir la clave; el usuario y la
    // membresía no se vuelven a cargar.
    expect(fake.calls).toEqual({
      authorizationVersion: 2,
      user: 1,
      membership: 1,
    });
  });

  it('vuelve a consultar cuando cambia la versión global', async () => {
    const { resolver, fake } = setup();
    fake.addUser('staff-1', [playerGroup()]);
    fake.addMembership(
      'staff-1',
      'E1',
      membership(MembershipStatus.active, staffGroup()),
    );

    const first = await resolver.resolve('staff-1', 'E1');
    expect(first.permissions['booking:read']).toBe(
      PermissionScope.establishment,
    );

    fake.version = 2n;
    fake.addMembership(
      'staff-1',
      'E1',
      membership(MembershipStatus.suspended, staffGroup()),
    );

    const refreshed = await resolver.resolve('staff-1', 'E1');

    expect(refreshed.membershipStatus).toBe(MembershipStatus.suspended);
    expect(refreshed.permissions).toEqual(playerOwn);
    expect(fake.calls).toEqual({
      authorizationVersion: 2,
      user: 2,
      membership: 2,
    });
  });

  it('invalidate() fuerza una nueva consulta aunque la versión no cambie', async () => {
    const { resolver, fake } = setup();
    fake.addUser('staff-1', [playerGroup()]);
    fake.addMembership(
      'staff-1',
      'E1',
      membership(MembershipStatus.active, staffGroup()),
    );

    await resolver.resolve('staff-1', 'E1');
    resolver.invalidate();
    const result = await resolver.resolve('staff-1', 'E1');

    expect(result.permissions).toEqual({
      ...playerOwn,
      ...staffAtEstablishment,
    });
    expect(fake.calls).toEqual({
      authorizationVersion: 2,
      user: 2,
      membership: 2,
    });
  });

  it('no expone datos personales en el principal resuelto', async () => {
    const { resolver, fake } = setup();
    fake.addUser('pii-1', [playerGroup()], {
      email: 'staff@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$secret',
      profile: { displayName: 'Nombre Real', phone: '+57 300 000 0000' },
    });
    fake.addMembership(
      'pii-1',
      'E1',
      membership(MembershipStatus.active, staffGroup()),
    );

    const global = await resolver.resolve('pii-1');
    const tenant = await resolver.resolve('pii-1', 'E1');

    expect(Object.keys(global).sort()).toEqual([
      'isPlatformAdmin',
      'permissions',
      'userId',
    ]);
    expect(Object.keys(tenant).sort()).toEqual([
      'establishmentId',
      'isPlatformAdmin',
      'membershipStatus',
      'permissions',
      'userId',
    ]);

    for (const principal of [global, tenant]) {
      const serialized = JSON.stringify(principal);

      expect(serialized).not.toContain('staff@example.com');
      expect(serialized).not.toContain('argon2id');
      expect(serialized).not.toContain('Nombre Real');
      expect(serialized).not.toContain('+57');
    }
  });
});
