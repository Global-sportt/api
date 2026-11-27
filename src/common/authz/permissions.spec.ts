import { PermissionScope } from '@prisma/client';
import {
  OWNER_GRANT_CODES,
  OWNER_GROUP_SLUG,
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  PLATFORM_ADMIN_GRANT_CODES,
  PLATFORM_ADMIN_GROUP_SLUG,
  PLAYER_GRANT_CODES,
  PLAYER_GROUP_SLUG,
  STAFF_GRANT_CODES,
  STAFF_GROUP_SLUG,
  type PermissionCode,
  type PermissionDefinition,
} from './permissions';

/**
 * Catálogo congelado en `docs/autorizacion.md` §2.1 (Gate 0, Q2).
 * Se enumera aquí de forma independiente del código para detectar derivas.
 */
const CONTRACT_CODES = [
  'establishment:read',
  'establishment:create',
  'establishment:update',
  'establishment:suspend',
  'membership:read',
  'membership:manage',
  'space:read',
  'space:create',
  'space:update',
  'space:delete',
  'schedule:read',
  'schedule:manage',
  'price:read',
  'price:manage',
  'booking:read',
  'booking:create',
  'booking:cancel',
  'booking:manage',
  'report:read',
  'day:close',
] as const satisfies readonly PermissionCode[];

const CONTRACT_SCOPES: Record<string, readonly PermissionScope[]> = {
  'establishment:read': [
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'establishment:create': [PermissionScope.platform],
  'establishment:update': [
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'establishment:suspend': [PermissionScope.platform],
  'membership:read': [
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'membership:manage': [
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'space:read': [PermissionScope.establishment, PermissionScope.platform],
  'space:create': [PermissionScope.establishment, PermissionScope.platform],
  'space:update': [PermissionScope.establishment, PermissionScope.platform],
  'space:delete': [PermissionScope.establishment, PermissionScope.platform],
  'schedule:read': [PermissionScope.establishment, PermissionScope.platform],
  'schedule:manage': [PermissionScope.establishment, PermissionScope.platform],
  'price:read': [PermissionScope.establishment, PermissionScope.platform],
  'price:manage': [PermissionScope.establishment, PermissionScope.platform],
  'booking:read': [
    PermissionScope.own,
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'booking:create': [
    PermissionScope.own,
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'booking:cancel': [
    PermissionScope.own,
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'booking:manage': [
    PermissionScope.establishment,
    PermissionScope.platform,
  ],
  'report:read': [PermissionScope.establishment, PermissionScope.platform],
  'day:close': [PermissionScope.establishment, PermissionScope.platform],
};

const CATALOG_BY_CODE = new Map<string, PermissionDefinition>(
  PERMISSION_CATALOG.map((permission) => [permission.code, permission]),
);

interface GroupFixture {
  slug: string;
  codes: readonly PermissionCode[];
  seedScope: PermissionScope;
  expectedGrants: number;
}

/** Grupos de sistema y alcance con el que `prisma/seed.ts` los concede. */
const GROUP_FIXTURES: readonly GroupFixture[] = [
  {
    slug: PLAYER_GROUP_SLUG,
    codes: PLAYER_GRANT_CODES,
    seedScope: PermissionScope.own,
    expectedGrants: 3,
  },
  {
    slug: PLATFORM_ADMIN_GROUP_SLUG,
    codes: PLATFORM_ADMIN_GRANT_CODES,
    seedScope: PermissionScope.platform,
    expectedGrants: 20,
  },
  {
    slug: OWNER_GROUP_SLUG,
    codes: OWNER_GRANT_CODES,
    seedScope: PermissionScope.establishment,
    expectedGrants: 18,
  },
  {
    slug: STAFF_GROUP_SLUG,
    codes: STAFF_GRANT_CODES,
    seedScope: PermissionScope.establishment,
    expectedGrants: 10,
  },
];

describe('PERMISSION_CATALOG', () => {
  it('contiene exactamente 20 códigos únicos', () => {
    expect(PERMISSION_CATALOG).toHaveLength(20);
    expect(PERMISSION_CODES).toHaveLength(20);
    expect(new Set(PERMISSION_CATALOG.map((permission) => permission.code)).size).toBe(
      20,
    );
    expect(new Set(PERMISSION_CODES).size).toBe(20);
  });

  it('coincide con los códigos del contrato congelado', () => {
    expect([...PERMISSION_CODES].sort()).toEqual([...CONTRACT_CODES].sort());
  });

  it('usa código recurso:acción y los allowedScopes del contrato', () => {
    for (const permission of PERMISSION_CATALOG) {
      expect(permission.code).toBe(
        `${permission.resource}:${permission.action}`,
      );
      expect([...permission.allowedScopes].sort()).toEqual(
        [...CONTRACT_SCOPES[permission.code]].sort(),
      );
    }
  });
});

describe.each(GROUP_FIXTURES)('grupo $slug', ({
  codes,
  seedScope,
  expectedGrants,
}) => {
  it('solo concede códigos del catálogo y no los repite', () => {
    const catalogCodes = new Set<string>(PERMISSION_CODES);

    expect(codes).toHaveLength(expectedGrants);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((code) => !catalogCodes.has(code))).toEqual([]);
  });

  it('usa un alcance permitido por allowedScopes para cada concesión', () => {
    for (const code of codes) {
      const definition = CATALOG_BY_CODE.get(code);

      expect(definition).toBeDefined();
      expect(definition?.allowedScopes).toContain(seedScope);
    }
  });
});
