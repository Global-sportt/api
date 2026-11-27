import { PermissionScope } from '@prisma/client';

export interface PermissionDefinition {
  code: string;
  resource: string;
  action: string;
  allowedScopes: readonly PermissionScope[];
  isSensitive: boolean;
}

/**
 * Catálogo congelado de permisos (Gate 0, Q2).
 *
 * El código es `recurso:acción` y `allowedScopes` es la lista de alcances que
 * la base de datos acepta para una concesión de ese permiso.
 */
export const PERMISSION_CATALOG = [
  {
    code: 'establishment:read',
    resource: 'establishment',
    action: 'read',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'establishment:create',
    resource: 'establishment',
    action: 'create',
    allowedScopes: [PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'establishment:update',
    resource: 'establishment',
    action: 'update',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'establishment:suspend',
    resource: 'establishment',
    action: 'suspend',
    allowedScopes: [PermissionScope.platform],
    isSensitive: true,
  },
  {
    code: 'membership:read',
    resource: 'membership',
    action: 'read',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'membership:manage',
    resource: 'membership',
    action: 'manage',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: true,
  },
  {
    code: 'space:read',
    resource: 'space',
    action: 'read',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'space:create',
    resource: 'space',
    action: 'create',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'space:update',
    resource: 'space',
    action: 'update',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'space:delete',
    resource: 'space',
    action: 'delete',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: true,
  },
  {
    code: 'schedule:read',
    resource: 'schedule',
    action: 'read',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'schedule:manage',
    resource: 'schedule',
    action: 'manage',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: true,
  },
  {
    code: 'price:read',
    resource: 'price',
    action: 'read',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'price:manage',
    resource: 'price',
    action: 'manage',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: true,
  },
  {
    code: 'booking:read',
    resource: 'booking',
    action: 'read',
    allowedScopes: [
      PermissionScope.own,
      PermissionScope.establishment,
      PermissionScope.platform,
    ],
    isSensitive: false,
  },
  {
    code: 'booking:create',
    resource: 'booking',
    action: 'create',
    allowedScopes: [
      PermissionScope.own,
      PermissionScope.establishment,
      PermissionScope.platform,
    ],
    isSensitive: false,
  },
  {
    code: 'booking:cancel',
    resource: 'booking',
    action: 'cancel',
    allowedScopes: [
      PermissionScope.own,
      PermissionScope.establishment,
      PermissionScope.platform,
    ],
    isSensitive: false,
  },
  {
    code: 'booking:manage',
    resource: 'booking',
    action: 'manage',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: true,
  },
  {
    code: 'report:read',
    resource: 'report',
    action: 'read',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: false,
  },
  {
    code: 'day:close',
    resource: 'day',
    action: 'close',
    allowedScopes: [PermissionScope.establishment, PermissionScope.platform],
    isSensitive: true,
  },
] as const satisfies readonly PermissionDefinition[];

export type PermissionCode = (typeof PERMISSION_CATALOG)[number]['code'];

export const PERMISSION_CODES: PermissionCode[] = PERMISSION_CATALOG.map(
  (permission) => permission.code,
);

export const PLAYER_GROUP_SLUG = 'player';
export const PLATFORM_ADMIN_GROUP_SLUG = 'platform-admin';
export const OWNER_GROUP_SLUG = 'owner';
export const STAFF_GROUP_SLUG = 'staff';

/**
 * Marcadores estables de los grupos de sistema (columna
 * `security_groups.system_key`). Son inmutables y no dependen del slug, que
 * puede renombrarse. La base de datos valida la correspondencia con `scope` y
 * el trigger Q8 identifica platform-admin por `global:platform-admin`.
 */
export const SYSTEM_KEY_PLAYER = 'global:player';
export const SYSTEM_KEY_PLATFORM_ADMIN = 'global:platform-admin';
export const SYSTEM_KEY_OWNER = 'establishment:owner';
export const SYSTEM_KEY_STAFF = 'establishment:staff';

export const PLAYER_GRANT_CODES: PermissionCode[] = [
  'booking:read',
  'booking:create',
  'booking:cancel',
];

export const PLATFORM_ADMIN_GRANT_CODES: PermissionCode[] = [...PERMISSION_CODES];

export const OWNER_GRANT_CODES: PermissionCode[] = [
  'establishment:read',
  'establishment:update',
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
];

export const STAFF_GRANT_CODES: PermissionCode[] = [
  'establishment:read',
  'space:read',
  'schedule:read',
  'price:read',
  'booking:read',
  'booking:create',
  'booking:cancel',
  'booking:manage',
  'report:read',
  'day:close',
];
