import {
  EstablishmentStatus,
  MembershipStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';

jest.setTimeout(60_000);

/**
 * F-05 / NEG-07, NEG-08, NEG-10 — PostgreSQL backstops.
 *
 * Every destructive statement runs inside a transaction that PostgreSQL rolls
 * back on the expected error. The test asserts the exact SQLSTATE, so it
 * distinguishes the intended constraint/trigger from an unrelated failure.
 */

const prisma = new PrismaClient();

let e1: string;
let e2: string;
let userId: string;
let membershipE1: string;
let ownerGroupE1: string;
let ownerGroupE2: string;
let platformAdminGroup: string;
let bookingReadId: string;
let spaceReadId: string;

async function expectSqlState(
  expected: string,
  work: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await prisma.$transaction(work);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const record = caught as {
    meta?: { code?: string };
    message?: string;
  };
  const code =
    record.meta?.code ?? /SQLSTATE|code: ['"]?([0-9A-Z]{5})/.exec(record.message ?? '')?.[1];
  expect({ state: code, message: record.message }).toEqual(
    expect.objectContaining({ state: expected }),
  );
}

function rawInsert(sql: string, ...values: unknown[]) {
  return (tx: Prisma.TransactionClient) =>
    tx.$executeRawUnsafe(sql, ...values);
}

describe('Invariantes SQL de autorización (NEG-07/08/10)', () => {
  beforeAll(async () => {
    await prisma.$connect();

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const e1Row = await prisma.establishment.create({
      data: {
        name: 'NEG E1',
        slug: `neg-e1-${suffix}`,
        status: EstablishmentStatus.active,
      },
      select: { id: true },
    });
    const e2Row = await prisma.establishment.create({
      data: {
        name: 'NEG E2',
        slug: `neg-e2-${suffix}`,
        status: EstablishmentStatus.active,
      },
      select: { id: true },
    });
    e1 = e1Row.id;
    e2 = e2Row.id;

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, e1);
      await provisionEstablishmentGroups(tx, e2);
    });

    const user = await prisma.user.create({
      data: { email: `neg-db-${suffix}@example.test` },
      select: { id: true },
    });
    userId = user.id;

    const membership = await prisma.membership.create({
      data: {
        userId,
        establishmentId: e1,
        status: MembershipStatus.active,
      },
      select: { id: true },
    });
    membershipE1 = membership.id;

    const groups = await prisma.securityGroup.findMany({
      where: {
        OR: [
          { establishmentId: e1, slug: 'owner' },
          { establishmentId: e2, slug: 'owner' },
          { establishmentId: null, slug: 'platform-admin' },
        ],
      },
      select: { id: true, slug: true, establishmentId: true },
    });
    ownerGroupE1 = groups.find(
      (group) => group.establishmentId === e1 && group.slug === 'owner',
    )!.id;
    ownerGroupE2 = groups.find(
      (group) => group.establishmentId === e2 && group.slug === 'owner',
    )!.id;
    platformAdminGroup = groups.find(
      (group) => group.establishmentId === null && group.slug === 'platform-admin',
    )!.id;

    bookingReadId = (
      await prisma.permission.findUniqueOrThrow({
        where: { code: 'booking:read' },
        select: { id: true },
      })
    ).id;
    spaceReadId = (
      await prisma.permission.findUniqueOrThrow({
        where: { code: 'space:read' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.establishment.deleteMany({
      where: { id: { in: [e1, e2].filter(Boolean) } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userId].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it('NEG-07: membresía E1 no recibe un grupo de E2 (FK compuesta 23503)', async () => {
    await expectSqlState(
      '23503',
      rawInsert(
        `INSERT INTO membership_groups (membership_id, group_id, establishment_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        membershipE1,
        ownerGroupE2,
        e1,
      ),
    );

    // The other direction: the membership belongs to E1, so the
    // (membership_id, establishment_id) FK rejects an E2 row too.
    await expectSqlState(
      '23503',
      rawInsert(
        `INSERT INTO membership_groups (membership_id, group_id, establishment_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        membershipE1,
        ownerGroupE2,
        e2,
      ),
    );

    expect(
      await prisma.membershipGroup.count({
        where: { membershipId: membershipE1, groupId: ownerGroupE2 },
      }),
    ).toBe(0);
  });

  it('NEG-08: un grupo de tenant no se inserta como grupo global (23503/23514)', async () => {
    await expectSqlState(
      '23503',
      rawInsert(
        `INSERT INTO user_global_groups (user_id, group_id, group_scope)
         VALUES ($1::uuid, $2::uuid, CAST($3 AS "GroupScope"))`,
        userId,
        ownerGroupE1,
        'global',
      ),
    );

    await expectSqlState(
      '23514',
      rawInsert(
        `INSERT INTO user_global_groups (user_id, group_id, group_scope)
         VALUES ($1::uuid, $2::uuid, CAST($3 AS "GroupScope"))`,
        userId,
        ownerGroupE1,
        'establishment',
      ),
    );

    // Positive control: the same user can receive a real global group.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO user_global_groups (user_id, group_id, group_scope)
         VALUES ($1::uuid, $2::uuid, CAST('global' AS "GroupScope"))`,
        userId,
        platformAdminGroup,
      );
      const rows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM user_global_groups
          WHERE user_id = $1::uuid AND group_id = $2::uuid`,
        userId,
        platformAdminGroup,
      );
      expect(rows[0].count).toBe(1n);
      const tenantRows = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM user_global_groups
          WHERE user_id = $1::uuid AND group_id = $2::uuid`,
        userId,
        ownerGroupE1,
      );
      expect(tenantRows[0].count).toBe(0n);
      throw new Error('ROLLBACK_POSITIVE_CONTROL');
    }).catch((error: unknown) => {
      expect((error as Error).message).toBe('ROLLBACK_POSITIVE_CONTROL');
    });
  });

  it('NEG-10: un grupo de sede no recibe platform (trigger 42501)', async () => {
    await expectSqlState(
      '42501',
      rawInsert(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         VALUES ($1::uuid, $2::uuid, CAST('platform' AS "PermissionScope"))`,
        ownerGroupE1,
        bookingReadId,
      ),
    );

    // own is not in space:read.allowed_scopes either.
    await expectSqlState(
      '42501',
      rawInsert(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         VALUES ($1::uuid, $2::uuid, CAST('own' AS "PermissionScope"))`,
        ownerGroupE1,
        spaceReadId,
      ),
    );

    // PK (group_id, permission_id): the existing owner grant cannot duplicate.
    await expectSqlState(
      '23505',
      rawInsert(
        `INSERT INTO security_group_permissions (group_id, permission_id, scope)
         VALUES ($1::uuid, $2::uuid, CAST('establishment' AS "PermissionScope"))`,
        ownerGroupE1,
        bookingReadId,
      ),
    );

    expect(
      await prisma.securityGroupPermission.count({
        where: {
          groupId: ownerGroupE1,
          permissionId: bookingReadId,
          scope: 'platform',
        },
      }),
    ).toBe(0);
  });
});
