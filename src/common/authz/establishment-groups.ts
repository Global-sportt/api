import {
  GroupScope,
  PermissionScope,
  Prisma,
} from '@prisma/client';
import {
  OWNER_GRANT_CODES,
  OWNER_GROUP_SLUG,
  STAFF_GRANT_CODES,
  STAFF_GROUP_SLUG,
  type PermissionCode,
} from './permissions';

interface TenantGroupDefinition {
  slug: string;
  name: string;
  grantCodes: PermissionCode[];
}

const TENANT_GROUPS: TenantGroupDefinition[] = [
  {
    slug: OWNER_GROUP_SLUG,
    name: 'Dueño de sede',
    grantCodes: OWNER_GRANT_CODES,
  },
  {
    slug: STAFF_GROUP_SLUG,
    name: 'Staff',
    grantCodes: STAFF_GRANT_CODES,
  },
];

/**
 * Crea (o actualiza) los grupos de sistema `owner` y `staff` de un
 * establecimiento con las concesiones del contrato. Es idempotente: puede
 * llamarse en cada alta de sede y repetirse en el seed sin duplicar filas.
 *
 * Debe ejecutarse dentro de la misma transacción que crea el establecimiento
 * y su primera membresía (T4), para no dejar una sede sin owner activo.
 */
export async function provisionEstablishmentGroups(
  tx: Prisma.TransactionClient,
  establishmentId: string,
): Promise<void> {
  const permissionCodes = TENANT_GROUPS.flatMap((group) => group.grantCodes);
  const permissions = await tx.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true, code: true },
  });
  const permissionIdByCode = new Map(
    permissions.map((permission) => [permission.code, permission.id]),
  );

  for (const definition of TENANT_GROUPS) {
    // El índice único por tenant es parcial (WHERE establishment_id IS NOT
    // NULL), así que PostgreSQL no puede inferirlo con ON CONFLICT. Se hace
    // find + update/create dentro de la misma transacción; el índice sigue
    // siendo el backstop ante una carrera.
    const existing = await tx.securityGroup.findFirst({
      where: {
        establishmentId,
        slug: definition.slug,
      },
      select: { id: true },
    });

    const group = existing
      ? await tx.securityGroup.update({
          where: { id: existing.id },
          data: {
            name: definition.name,
            scope: GroupScope.establishment,
            isSystem: true,
          },
          select: { id: true },
        })
      : await tx.securityGroup.create({
          data: {
            establishmentId,
            slug: definition.slug,
            name: definition.name,
            scope: GroupScope.establishment,
            isSystem: true,
          },
          select: { id: true },
        });

    for (const code of definition.grantCodes) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) {
        throw new Error(
          `Falta el permiso "${code}" en el catálogo. Ejecuta "prisma db seed" antes de provisionar grupos.`,
        );
      }

      await tx.securityGroupPermission.upsert({
        where: {
          groupId_permissionId: {
            groupId: group.id,
            permissionId,
          },
        },
        create: {
          groupId: group.id,
          permissionId,
          scope: PermissionScope.establishment,
        },
        update: {
          scope: PermissionScope.establishment,
        },
      });
    }
  }
}
