import {
  GroupScope,
  PermissionScope,
  PrismaClient,
} from '@prisma/client';
import * as argon2 from 'argon2';
import {
  PERMISSION_CATALOG,
  PLATFORM_ADMIN_GRANT_CODES,
  PLATFORM_ADMIN_GROUP_SLUG,
  PLAYER_GRANT_CODES,
  PLAYER_GROUP_SLUG,
  SYSTEM_KEY_PLATFORM_ADMIN,
  SYSTEM_KEY_PLAYER,
} from '../src/common/authz/permissions';

const prisma = new PrismaClient();

type PermissionIds = Map<string, string>;

async function seedPermissions(): Promise<PermissionIds> {
  for (const permission of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      create: {
        code: permission.code,
        resource: permission.resource,
        action: permission.action,
        allowedScopes: [...permission.allowedScopes],
        isSensitive: permission.isSensitive,
      },
      update: {
        resource: permission.resource,
        action: permission.action,
        allowedScopes: [...permission.allowedScopes],
        isSensitive: permission.isSensitive,
      },
    });
  }

  const permissions = await prisma.permission.findMany({
    select: { id: true, code: true },
  });

  return new Map(
    permissions.map((permission) => [permission.code, permission.id]),
  );
}

async function upsertGlobalGroup(
  slug: string,
  name: string,
  systemKey: string,
): Promise<{ id: string }> {
  // El marcador estable manda; el slug solo se usa para adoptar una fila
  // creada por una versión anterior del seed.
  const existing =
    (await prisma.securityGroup.findFirst({
      where: { establishmentId: null, systemKey },
      select: { id: true },
    })) ??
    (await prisma.securityGroup.findFirst({
      where: { establishmentId: null, slug },
      select: { id: true },
    }));

  if (existing) {
    return prisma.securityGroup.update({
      where: { id: existing.id },
      data: {
        slug,
        name,
        scope: GroupScope.global,
        isSystem: true,
        systemKey,
      },
      select: { id: true },
    });
  }

  return prisma.securityGroup.create({
    data: {
      slug,
      name,
      scope: GroupScope.global,
      isSystem: true,
      systemKey,
    },
    select: { id: true },
  });
}

async function grantPermissions(
  groupId: string,
  permissionIds: PermissionIds,
  codes: readonly string[],
  scope: PermissionScope,
): Promise<void> {
  for (const code of codes) {
    const permissionId = permissionIds.get(code);
    if (!permissionId) {
      throw new Error(
        `Falta el permiso "${code}" en el catálogo. Revisa PERMISSION_CATALOG.`,
      );
    }

    await prisma.securityGroupPermission.upsert({
      where: {
        groupId_permissionId: { groupId, permissionId },
      },
      create: { groupId, permissionId, scope },
      update: { scope },
    });
  }
}

async function seedAuthorization(): Promise<{
  playerGroupId: string;
  platformAdminGroupId: string;
}> {
  const permissionIds = await seedPermissions();

  const player = await upsertGlobalGroup(
    PLAYER_GROUP_SLUG,
    'Jugador',
    SYSTEM_KEY_PLAYER,
  );
  const platformAdmin = await upsertGlobalGroup(
    PLATFORM_ADMIN_GROUP_SLUG,
    'Administrador de plataforma',
    SYSTEM_KEY_PLATFORM_ADMIN,
  );

  await grantPermissions(
    player.id,
    permissionIds,
    PLAYER_GRANT_CODES,
    PermissionScope.own,
  );
  await grantPermissions(
    platformAdmin.id,
    permissionIds,
    PLATFORM_ADMIN_GRANT_CODES,
    PermissionScope.platform,
  );

  console.log(
    `Catálogo listo: ${PERMISSION_CATALOG.length} permisos; grupos globales ${PLAYER_GROUP_SLUG} y ${PLATFORM_ADMIN_GROUP_SLUG}.`,
  );

  return {
    playerGroupId: player.id,
    platformAdminGroupId: platformAdmin.id,
  };
}

async function seedAdmin(input: {
  playerGroupId: string;
  platformAdminGroupId: string;
}): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const displayName = process.env.SEED_ADMIN_NAME?.trim() || 'Administrador';

  if (!email || !password) {
    console.log(
      'Seed de admin omitido: define SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD para crear un admin.',
    );
    return;
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD debe tener al menos 12 caracteres.');
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });

  const user = await prisma.$transaction(async (tx) => {
    const admin = await tx.user.upsert({
      where: { email },
      create: {
        email,
        passwordHash,
        emailVerifiedAt: new Date(),
        profile: { create: { displayName } },
      },
      update: {
        passwordHash,
        emailVerifiedAt: new Date(),
        status: 'active',
        profile: {
          upsert: {
            create: { displayName },
            update: { displayName },
          },
        },
      },
    });

    // Q11: todo usuario registrado conserva el grupo global player.
    await tx.userGlobalGroup.upsert({
      where: {
        userId_groupId: {
          userId: admin.id,
          groupId: input.playerGroupId,
        },
      },
      create: {
        userId: admin.id,
        groupId: input.playerGroupId,
        groupScope: GroupScope.global,
      },
      update: {
        groupScope: GroupScope.global,
      },
    });

    await tx.userGlobalGroup.upsert({
      where: {
        userId_groupId: {
          userId: admin.id,
          groupId: input.platformAdminGroupId,
        },
      },
      create: {
        userId: admin.id,
        groupId: input.platformAdminGroupId,
        groupScope: GroupScope.global,
      },
      update: {
        groupScope: GroupScope.global,
      },
    });

    return admin;
  });

  console.log(`Admin listo: ${user.email} (${user.id})`);
}

async function main(): Promise<void> {
  const groups = await seedAuthorization();
  await seedAdmin(groups);
}

main()
  .catch((error: unknown) => {
    console.error('No se pudo ejecutar el seed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
