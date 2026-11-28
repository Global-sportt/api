/**
 * Pruebas SQL negativas de las invariantes Q8/F-10 (F-10 del Gate 3).
 *
 * Cada caso corre en una transacción que se revierte (por error esperado o
 * por un sentinel deliberado), por lo que no altera `reservas_test`.
 */
import { randomUUID } from 'node:crypto';
import { PermissionScope, Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ROLLBACK_SENTINEL = 'A2A_ROLLBACK_SENTINEL';

async function runAndRollback(
  work: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await expect(
    prisma.$transaction(async (tx) => {
      await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    }),
  ).rejects.toThrow(ROLLBACK_SENTINEL);
}

async function expectSqlFailure(
  work: (tx: Prisma.TransactionClient) => Promise<void>,
  pattern?: RegExp,
): Promise<void> {
  const promise = prisma.$transaction(work);
  if (pattern) {
    await expect(promise).rejects.toThrow(pattern);
  } else {
    await expect(promise).rejects.toThrow();
  }
}

async function platformAdminGroupId(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM security_groups WHERE system_key = 'global:platform-admin'`,
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Invariantes SQL de autorización (F-10)', () => {
  it('no permite reducir allowed_scopes si invalida concesiones existentes', async () => {
    const before = await prisma.permission.findUniqueOrThrow({
      where: { code: 'booking:read' },
      select: { allowedScopes: true },
    });

    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE permissions
            SET allowed_scopes = ARRAY['own']::"PermissionScope"[]
          WHERE code = 'booking:read'`,
      );
    }, /allowed_scopes|invalidar|42501/);

    const after = await prisma.permission.findUniqueOrThrow({
      where: { code: 'booking:read' },
      select: { allowedScopes: true },
    });
    expect(after.allowedScopes).toEqual(before.allowedScopes);
    expect(after.allowedScopes).toContain(PermissionScope.establishment);
    expect(after.allowedScopes).toContain(PermissionScope.platform);
  });

  it('no permite allowed_scopes NULL con concesiones existentes', async () => {
    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE permissions SET allowed_scopes = NULL WHERE code = 'booking:read'`,
      );
    }, /allowed_scopes|42501/);
  });

  it('system_key es inmutable una vez asignado', async () => {
    const before = await prisma.securityGroup.findFirstOrThrow({
      where: { systemKey: 'global:platform-admin' },
      select: { id: true, systemKey: true },
    });

    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE security_groups SET system_key = 'global:player' WHERE id = $1::uuid`,
        before.id,
      );
    }, /system_key is immutable|42501/);

    const after = await prisma.securityGroup.findUniqueOrThrow({
      where: { id: before.id },
      select: { systemKey: true },
    });
    expect(after.systemKey).toBe('global:platform-admin');
  });

  it('rechaza un system_key que no corresponde al scope', async () => {
    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO security_groups
           (id, establishment_id, slug, name, scope, is_system, system_key, created_at, updated_at)
         VALUES
           ($1::uuid, NULL, $2, 'Temporal', 'global', true, 'establishment:owner', now(), now())`,
        randomUUID(),
        `tmp-${randomUUID()}`,
      );
    });
  });

  it('reserva platform para el system_key platform-admin, no para el slug', async () => {
    const adminId = await platformAdminGroupId();

    // Renombrar platform-admin no rompe sus concesiones platform: el trigger
    // ya no depende del slug.
    await runAndRollback(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE security_groups SET slug = 'platform-admin-renamed' WHERE id = $1::uuid`,
        adminId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE security_group_permissions sgp
            SET scope = 'platform'
           FROM permissions p
          WHERE sgp.group_id = $1::uuid
            AND sgp.permission_id = p.id
            AND p.code = 'booking:read'`,
        adminId,
      );
    });
  });

  it('no concede platform a un grupo llamado platform-admin sin system_key', async () => {
    const adminId = await platformAdminGroupId();
    const fakeGroupId = randomUUID();

    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE security_groups SET slug = 'platform-admin-renamed' WHERE id = $1::uuid`,
        adminId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO security_groups
           (id, establishment_id, slug, name, scope, is_system, system_key, created_at, updated_at)
         VALUES
           ($1::uuid, NULL, 'platform-admin', 'Fake admin', 'global', true, NULL, now(), now())`,
        fakeGroupId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         SELECT $1::uuid, p.id, 'platform'
           FROM permissions p
          WHERE p.code = 'establishment:create'`,
        fakeGroupId,
      );
    }, /platform scope is reserved|42501/);
  });

  it('rechaza una concesión platform a un grupo global que no es platform-admin', async () => {
    const player = await prisma.securityGroup.findFirstOrThrow({
      where: { systemKey: 'global:player' },
      select: { id: true },
    });

    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         SELECT $1::uuid, p.id, 'platform'
           FROM permissions p
          WHERE p.code = 'establishment:create'`,
        player.id,
      );
    }, /platform scope is reserved|42501/);
  });

  it('rechaza una concesión con scope fuera de allowed_scopes', async () => {
    const player = await prisma.securityGroup.findFirstOrThrow({
      where: { systemKey: 'global:player' },
      select: { id: true },
    });

    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         SELECT $1::uuid, p.id, 'own'
           FROM permissions p
          WHERE p.code = 'establishment:create'`,
        player.id,
      );
    }, /scope own is not allowed|42501/);
  });

  it('rechaza cambiar el scope de un grupo si invalida sus concesiones', async () => {
    const establishmentId = randomUUID();
    const groupId = randomUUID();
    const slug = `tmp-${randomUUID()}`;

    await expectSqlFailure(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO establishments (id, name, slug, updated_at)
         VALUES ($1::uuid, 'Temporal', $2, now())`,
        establishmentId,
        slug,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO security_groups
           (id, establishment_id, slug, name, scope, is_system, system_key, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, 'owner', 'Owner temporal', 'establishment', true,
            'establishment:owner', now(), now())`,
        groupId,
        establishmentId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         SELECT $1::uuid, p.id, 'establishment'
           FROM permissions p
          WHERE p.code = 'space:read'`,
        groupId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE security_groups
            SET scope = 'global', establishment_id = NULL
          WHERE id = $1::uuid`,
        groupId,
      );
    }, /would invalidate|42501/);
  });
});

describe('Grilla semanal con varias franjas (operating_hours)', () => {
  it('reemplaza el índex único por día por uno por día y apertura, más el índice de lectura', async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ indexname: string; indexdef: string }>
    >(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'operating_hours'`,
    );
    const indexes = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    expect(indexes.has('operating_hours_space_id_day_of_week_key')).toBe(false);

    const unique = indexes.get(
      'operating_hours_space_id_day_of_week_opens_at_minutes_key',
    );
    expect(unique).toBeDefined();
    expect(unique).toContain('UNIQUE INDEX');
    expect(unique).toContain('(space_id, day_of_week, opens_at_minutes)');

    const lookup = indexes.get('operating_hours_space_id_day_of_week_idx');
    expect(lookup).toBeDefined();
    expect(lookup).toContain('(space_id, day_of_week)');
  });

  it('permite dos franjas del mismo día y rechaza una apertura duplicada', async () => {
    const establishmentId = randomUUID();
    const spaceId = randomUUID();
    const slug = `tmp-oh-${randomUUID()}`;

    const insertFixture = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO establishments (id, name, slug, updated_at)
         VALUES ($1::uuid, 'Temporal grilla', $2, now())`,
        establishmentId,
        slug,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO spaces
           (id, establishment_id, name, slug, status, slot_minutes, buffer_minutes, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Cancha temporal', $3, 'active', 60, 0, now(), now())`,
        spaceId,
        establishmentId,
        `cancha-${slug}`,
      );
    };

    await runAndRollback(async (tx) => {
      await insertFixture(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO operating_hours
           (id, space_id, day_of_week, opens_at_minutes, closes_at_minutes)
         VALUES ($1::uuid, $2::uuid, 1, 540, 660), ($3::uuid, $2::uuid, 1, 840, 960)`,
        randomUUID(),
        spaceId,
        randomUUID(),
      );
      const count = await tx.operatingHour.count({ where: { spaceId } });
      expect(count).toBe(2);
    });

    await expectSqlFailure(async (tx) => {
      await insertFixture(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO operating_hours
           (id, space_id, day_of_week, opens_at_minutes, closes_at_minutes)
         VALUES ($1::uuid, $2::uuid, 1, 540, 660), ($3::uuid, $2::uuid, 1, 540, 780)`,
        randomUUID(),
        spaceId,
        randomUUID(),
      );
    }, /operating_hours_space_id_day_of_week_opens_at_minutes_key|23505/);
  });
});
