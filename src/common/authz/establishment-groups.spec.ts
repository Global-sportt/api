import { GroupScope, PermissionScope } from '@prisma/client';
import {
  OWNER_GRANT_CODES,
  STAFF_GRANT_CODES,
} from './permissions';
import { provisionEstablishmentGroups } from './establishment-groups';

const ESTABLISHMENT_ID = '11111111-1111-4111-8111-111111111111';

type GroupRow = { id: string; slug: string };

function buildTx(existingGroups: GroupRow[] = []) {
  const permissions = [...OWNER_GRANT_CODES, ...STAFF_GRANT_CODES]
    .filter((code, index, all) => all.indexOf(code) === index)
    .map((code) => ({ id: `perm-${code}`, code }));

  const tx = {
    permission: { findMany: jest.fn().mockResolvedValue(permissions) },
    securityGroup: {
      findFirst: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { slug: string } }): Promise<GroupRow | null> =>
            Promise.resolve(
              existingGroups.find((group) => group.slug === where.slug) ??
                null,
            ),
        ),
      create: jest
        .fn()
        .mockImplementation(
          ({ data }: { data: { slug: string } }): Promise<GroupRow> =>
            Promise.resolve({ id: `new-${data.slug}`, slug: data.slug }),
        ),
      update: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { id: string } }): Promise<GroupRow> => {
            const group = existingGroups.find((item) => item.id === where.id);
            if (!group) throw new Error('missing group');
            return Promise.resolve(group);
          },
        ),
    },
    securityGroupPermission: {
      upsert: jest.fn().mockResolvedValue({}),
    },
  };

  return tx;
}

describe('provisionEstablishmentGroups', () => {
  it('crea los grupos owner y staff con sus concesiones de establishment', async () => {
    const tx = buildTx();

    await provisionEstablishmentGroups(tx as never, ESTABLISHMENT_ID);

    expect(tx.permission.findMany).toHaveBeenCalledWith({
      where: {
        code: { in: [...OWNER_GRANT_CODES, ...STAFF_GRANT_CODES] },
      },
      select: { id: true, code: true },
    });
    expect(tx.securityGroup.create).toHaveBeenCalledTimes(2);
    expect(tx.securityGroup.create).toHaveBeenCalledWith({
      data: {
        establishmentId: ESTABLISHMENT_ID,
        slug: 'owner',
        name: 'Dueño de sede',
        scope: GroupScope.establishment,
        isSystem: true,
        systemKey: 'establishment:owner',
      },
      select: { id: true },
    });
    expect(tx.securityGroupPermission.upsert).toHaveBeenCalledTimes(
      OWNER_GRANT_CODES.length + STAFF_GRANT_CODES.length,
    );

    const ownerGrant = tx.securityGroupPermission.upsert.mock.calls.find(
      ([input]) => input.create.groupId === 'new-owner',
    )?.[0];
    expect(ownerGrant).toEqual(
      expect.objectContaining({
        create: expect.objectContaining({
          scope: PermissionScope.establishment,
        }),
        update: { scope: PermissionScope.establishment },
      }),
    );
  });

  it('es idempotente: actualiza los grupos existentes en vez de duplicarlos', async () => {
    const tx = buildTx([
      { id: 'existing-owner', slug: 'owner' },
      { id: 'existing-staff', slug: 'staff' },
    ]);

    await provisionEstablishmentGroups(tx as never, ESTABLISHMENT_ID);

    expect(tx.securityGroup.create).not.toHaveBeenCalled();
    expect(tx.securityGroup.update).toHaveBeenCalledTimes(2);
    expect(tx.securityGroup.update).toHaveBeenCalledWith({
      where: { id: 'existing-owner' },
      data: {
        slug: 'owner',
        name: 'Dueño de sede',
        scope: GroupScope.establishment,
        isSystem: true,
        systemKey: 'establishment:owner',
      },
      select: { id: true },
    });
    expect(
      tx.securityGroupPermission.upsert.mock.calls.map(
        ([input]) => input.create.groupId,
      ),
    ).toEqual(
      expect.arrayContaining(['existing-owner', 'existing-staff']),
    );
  });

  it('falla cerrado si el catálogo no tiene un permiso esperado', async () => {
    const tx = buildTx();
    tx.permission.findMany.mockResolvedValue([
      { id: 'perm-booking:read', code: 'booking:read' },
    ]);

    await expect(
      provisionEstablishmentGroups(tx as never, ESTABLISHMENT_ID),
    ).rejects.toThrow(/Falta el permiso "establishment:read"/);
    expect(tx.securityGroupPermission.upsert).not.toHaveBeenCalled();
  });
});
