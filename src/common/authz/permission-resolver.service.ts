import { Injectable } from '@nestjs/common';
import {
  GroupScope,
  MembershipStatus,
  PermissionScope,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_ADMIN_GROUP_SLUG } from './permissions';

const PERMISSIONS_CACHE_TTL_MS = 60_000;
const AUTHORIZATION_VERSION_ID = 1;

const SCOPE_RANK: Record<PermissionScope, number> = {
  [PermissionScope.own]: 1,
  [PermissionScope.establishment]: 2,
  [PermissionScope.platform]: 3,
};

type PermissionGrant = {
  scope: PermissionScope;
  permission: { code: string };
};

export interface ResolvedPermissions {
  userId: string;
  permissions: Record<string, PermissionScope>;
  establishmentId?: string;
  membershipStatus?: MembershipStatus;
  isPlatformAdmin: boolean;
}

interface CacheEntry {
  expiresAt: number;
  value: ResolvedPermissions;
}

/**
 * Resuelve los permisos efectivos de un usuario para un tenant concreto.
 *
 * - Contexto global: solo grupos globales (`user_global_groups`).
 * - Contexto tenant: grupos globales + grupos de la membresía **activa** de
 *   ese establecimiento. Nunca se unen permisos de otras membresías.
 * - Precedencia por permiso: platform > establishment > own.
 *
 * La caché es en memoria, por instancia, TTL 60 s y usa la versión global de
 * autorización en la clave. No se cachean decisiones de Cerbos.
 */
@Injectable()
export class PermissionResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    userId: string,
    establishmentId?: string | null,
  ): Promise<ResolvedPermissions> {
    const version = await this.readAuthorizationVersion();
    const tenantKey = establishmentId ?? 'global';
    const cacheKey = `authz:v1:user:${userId}:tenant:${tenantKey}:v${version}`;

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneResolved(cached.value);
    }

    const resolved = await this.load(userId, establishmentId);
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + PERMISSIONS_CACHE_TTL_MS,
      value: cloneResolved(resolved),
    });

    return resolved;
  }

  /**
   * Limpia toda la caché. Pensado para tests o para un reinicio controlado;
   * en operación normal la invalidación ocurre al cambiar la versión global.
   */
  invalidate(): void {
    this.cache.clear();
  }

  private async readAuthorizationVersion(): Promise<string> {
    const row = await this.prisma.authorizationVersion.findUnique({
      where: { id: AUTHORIZATION_VERSION_ID },
      select: { version: true },
    });

    return (row?.version ?? 1n).toString();
  }

  private async load(
    userId: string,
    establishmentId?: string | null,
  ): Promise<ResolvedPermissions> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        globalGroups: {
          select: {
            group: {
              select: {
                slug: true,
                scope: true,
                permissions: {
                  select: {
                    scope: true,
                    permission: { select: { code: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const permissions: Record<string, PermissionScope> = {};
    let isPlatformAdmin = false;

    for (const assignment of user?.globalGroups ?? []) {
      if (assignment.group.scope !== GroupScope.global) continue;
      if (assignment.group.slug === PLATFORM_ADMIN_GROUP_SLUG) {
        isPlatformAdmin = true;
      }
      this.mergeGrants(permissions, assignment.group.permissions);
    }

    let membershipStatus: MembershipStatus | undefined;

    if (establishmentId) {
      const membership = await this.prisma.membership.findUnique({
        where: {
          userId_establishmentId: { userId, establishmentId },
        },
        select: {
          status: true,
          groups: {
            select: {
              group: {
                select: {
                  permissions: {
                    select: {
                      scope: true,
                      permission: { select: { code: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      membershipStatus = membership?.status;

      // Solo una membresía activa habilita rutas tenant (Q9).
      if (membership?.status === MembershipStatus.active) {
        for (const assignment of membership.groups) {
          this.mergeGrants(permissions, assignment.group.permissions);
        }
      }
    }

    return {
      userId,
      permissions,
      ...(establishmentId ? { establishmentId } : {}),
      ...(membershipStatus ? { membershipStatus } : {}),
      isPlatformAdmin,
    };
  }

  private mergeGrants(
    target: Record<string, PermissionScope>,
    grants: PermissionGrant[],
  ): void {
    for (const grant of grants) {
      const code = grant.permission.code;
      const current = target[code];
      if (current === undefined || SCOPE_RANK[grant.scope] > SCOPE_RANK[current]) {
        target[code] = grant.scope;
      }
    }
  }
}

function cloneResolved(value: ResolvedPermissions): ResolvedPermissions {
  return {
    ...value,
    permissions: { ...value.permissions },
  };
}
