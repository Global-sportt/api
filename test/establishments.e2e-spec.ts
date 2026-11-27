import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GroupScope, MembershipStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import { AppLogger } from '../src/common/logging/app-logger.service';
import {
  AUTHORIZATION_SERVICE,
  PLAN_KIND,
  type AuthorizationService,
} from '../src/common/authz/authorization.types';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'frase-segura-2026';
const MISSING_ESTABLISHMENT = '00000000-0000-4000-8000-000000000000';
const MISSING_USER = '99999999-9999-4999-8999-999999999999';

/**
 * The external Cerbos PDP is the only component replaced here. The test module
 * still uses the real controllers, guards, PermissionResolver, Prisma and auth
 * flow, so tenancy, escalation and last-owner invariants are exercised against
 * PostgreSQL. The scopes come from the resolver for the requested tenant; the
 * double only reads the resolved permission map.
 */
const fakePdp: AuthorizationService = {
  async can(principal, resourceKind, action): Promise<boolean> {
    return principal.permissions[`${resourceKind}:${action}`] !== undefined;
  },
  async plan() {
    return { kind: PLAN_KIND.ALWAYS_DENIED };
  },
};

interface TestUser {
  userId: string;
  email: string;
  token: string;
}

interface EstablishmentBody {
  id: string;
  name: string;
  slug: string;
  status: string;
  owner?: {
    membershipId: string;
    userId: string;
    status: string;
    groups: string[];
  };
}

interface MembershipBody {
  id: string;
  userId: string;
  status: string;
  groups: Array<{ slug: string; name: string }>;
}

let app: INestApplication;
let prisma: PrismaService;
let ipCounter = 200;

function server() {
  return app.getHttpServer();
}

function nextIp(): string {
  ipCounter += 1;
  return `10.42.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function registerUser(label: string): Promise<TestUser> {
  const ip = nextIp();
  const email = `e2e-${label}-${Date.now()}-${ipCounter}@example.com`;

  const registered = await request(server())
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ email, password: PASSWORD, displayName: label })
    .expect(201);

  const verificationToken = registered.body?.dev?.verificationToken as
    | string
    | undefined;
  expect(typeof verificationToken).toBe('string');

  await request(server())
    .post('/api/v1/auth/verify-email')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ token: verificationToken })
    .expect(200);

  const login = await request(server())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', nextIp())
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    userId: login.body.user.id as string,
    email,
    token: login.body.accessToken as string,
  };
}

async function login(
  email: string,
  token: string,
): Promise<{ token: string; userId: string }> {
  const response = await request(server())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', nextIp())
    .send({ email, password: PASSWORD })
    .expect(200);

  expect(token).toEqual(expect.any(String));
  return { token: response.body.accessToken as string, userId: response.body.user.id as string };
}

async function assignPlatformAdmin(userId: string): Promise<void> {
  const group = await prisma.securityGroup.findFirst({
    where: { establishmentId: null, slug: 'platform-admin' },
    select: { id: true },
  });

  if (!group) {
    throw new Error('Falta el grupo global platform-admin; ejecuta el seed.');
  }

  await prisma.userGlobalGroup.create({
    data: {
      userId,
      groupId: group.id,
      groupScope: GroupScope.global,
    },
  });
}

function bearer(requestBuilder: request.Test, token: string): request.Test {
  return requestBuilder
    .set('Authorization', `Bearer ${token}`)
    .set('Origin', ORIGIN);
}

async function listMemberships(
  token: string,
  establishmentId: string,
): Promise<MembershipBody[]> {
  const response = await bearer(
    request(server()).get(
      `/api/v1/establishments/${establishmentId}/memberships`,
    ),
    token,
  ).expect(200);

  return response.body as MembershipBody[];
}

async function countActiveOwners(establishmentId: string): Promise<number> {
  return prisma.membership.count({
    where: {
      establishmentId,
      status: MembershipStatus.active,
      groups: {
        some: {
          group: { slug: 'owner', establishmentId },
        },
      },
    },
  });
}

describe('Establishments y membresías (e2e)', () => {
  let admin: TestUser;
  let owner1: TestUser;
  let owner2: TestUser;
  let staff1: TestUser;
  let owner3: TestUser;
  let player: TestUser;
  let e1: EstablishmentBody;
  let e2: EstablishmentBody;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [AppModule],
    });

    // The default suite uses a PDP double so it can run without the external
    // process. Gate 1 also runs the same suite against the real Cerbos PDP by
    // setting E2E_REAL_CERBOS=1 (Cerbos must be listening on CERBOS_URL).
    if (process.env.E2E_REAL_CERBOS !== '1') {
      builder
        .overrideProvider(AUTHORIZATION_SERVICE)
        .useValue(fakePdp);
    }

    const moduleRef = await builder.compile();

    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService), { swagger: false });
    await app.init();
    prisma = app.get(PrismaService);

    // Establishments cascade to memberships and tenant groups. Auth tables are
    // reset as in test/auth.e2e-spec.ts so registrations start clean.
    await prisma.establishment.deleteMany();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "auth_events", "oauth_states", "refresh_tokens", "sessions", "verification_tokens", "oauth_accounts", "profiles", "users" RESTART IDENTITY CASCADE',
    );

    admin = await registerUser('admin');
    await assignPlatformAdmin(admin.userId);
    owner1 = await registerUser('owner1');
    owner2 = await registerUser('owner2');
    staff1 = await registerUser('staff1');
    owner3 = await registerUser('owner3');
    player = await registerUser('player');

    // The token issued at registration is still valid after adding the global
    // group; permissions are resolved per request. Re-login keeps the flow
    // identical to a real platform admin.
    admin = { ...admin, ...(await login(admin.email, admin.token)) };
  });

  afterAll(async () => {
    await app.close();
  });

  it('crea E1 con el primer owner activo, grupos de sistema y auditoría', async () => {
    const response = await bearer(
      request(server())
        .post('/api/v1/admin/establishments')
        .send({
          name: 'E2E Cancha Norte',
          slug: `e2e-norte-${Date.now()}`,
          timezone: 'America/Bogota',
          currency: 'COP',
          ownerUserId: owner1.userId,
        }),
      admin.token,
    ).expect(201);

    e1 = response.body as EstablishmentBody;
    expect(e1.status).toBe('active');
    expect(e1.owner).toEqual({
      membershipId: expect.any(String),
      userId: owner1.userId,
      status: 'active',
      groups: ['owner'],
    });

    const membership = await prisma.membership.findUnique({
      where: {
        userId_establishmentId: {
          userId: owner1.userId,
          establishmentId: e1.id,
        },
      },
      include: { groups: { include: { group: true } } },
    });

    expect(membership?.status).toBe(MembershipStatus.active);
    expect(membership?.groups.map((assignment) => assignment.group.slug)).toEqual([
      'owner',
    ]);

    const groups = await prisma.securityGroup.findMany({
      where: { establishmentId: e1.id },
      select: { slug: true, permissions: { select: { permissionId: true } } },
    });
    expect(groups.map((group) => group.slug).sort()).toEqual(['owner', 'staff']);
    const ownerGroup = groups.find((group) => group.slug === 'owner');
    expect(ownerGroup?.permissions.length).toBeGreaterThan(0);
  });

  it('rechaza la creación con owner inexistente sin dejar sede huérfana', async () => {
    const slug = `e2e-huerfana-${Date.now()}`;

    const response = await bearer(
      request(server())
        .post('/api/v1/admin/establishments')
        .send({
          name: 'Sin owner',
          slug,
          ownerUserId: MISSING_USER,
        }),
      admin.token,
    ).expect(422);

    expect(response.body.code).toBe('OWNER_NOT_FOUND');
    expect(
      await prisma.establishment.findUnique({ where: { slug } }),
    ).toBeNull();
  });

  it('solo platform-admin accede a /admin/establishments', async () => {
    await bearer(
      request(server()).get('/api/v1/admin/establishments'),
      admin.token,
    ).expect(200);

    for (const user of [player, owner1, staff1]) {
      const denied = await bearer(
        request(server()).get('/api/v1/admin/establishments'),
        user.token,
      ).expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
    }

    const deniedCreate = await bearer(
      request(server())
        .post('/api/v1/admin/establishments')
        .send({
          name: 'No permitido',
          slug: `e2e-denegado-${Date.now()}`,
          ownerUserId: player.userId,
        }),
      player.token,
    ).expect(403);
    expect(deniedCreate.body.code).toBe('PERMISSION_DENIED');
  });

  it('GET /me/establishments devuelve solo las membresías propias', async () => {
    const ownerResponse = await bearer(
      request(server()).get('/api/v1/me/establishments'),
      owner1.token,
    ).expect(200);

    expect(ownerResponse.body).toEqual([
      expect.objectContaining({
        id: e1.id,
        name: e1.name,
        slug: e1.slug,
        status: 'active',
        groups: ['owner'],
      }),
    ]);

    const playerResponse = await bearer(
      request(server()).get('/api/v1/me/establishments'),
      player.token,
    ).expect(200);
    expect(playerResponse.body).toEqual([]);
  });

  it('crea E2 con otro owner para probar IDOR vertical', async () => {
    const response = await bearer(
      request(server())
        .post('/api/v1/admin/establishments')
        .send({
          name: 'E2E Cancha Sur',
          slug: `e2e-sur-${Date.now()}`,
          ownerUserId: owner2.userId,
        }),
      admin.token,
    ).expect(201);

    e2 = response.body as EstablishmentBody;
    expect(e2.owner?.userId).toBe(owner2.userId);
  });

  it('aplica tenant guard: 403 sin membresía, 404 si la sede no existe', async () => {
    await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      owner1.token,
    ).expect(200);

    const playerDenied = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      player.token,
    ).expect(403);
    expect(playerDenied.body.code).toBe('TENANT_FORBIDDEN');

    const missing = await bearer(
      request(server()).get(
        `/api/v1/establishments/${MISSING_ESTABLISHMENT}`,
      ),
      owner1.token,
    ).expect(404);
    expect(missing.body.code).toBe('ESTABLISHMENT_NOT_FOUND');
  });

  it('E1/E2: owner de una sede recibe 403 en la otra', async () => {
    const owner1InE2 = await bearer(
      request(server()).get(`/api/v1/establishments/${e2.id}`),
      owner1.token,
    ).expect(403);
    expect(owner1InE2.body.code).toBe('TENANT_FORBIDDEN');

    const owner2InE1 = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      owner2.token,
    ).expect(403);
    expect(owner2InE1.body.code).toBe('TENANT_FORBIDDEN');

    const membershipsDenied = await bearer(
      request(server()).get(
        `/api/v1/establishments/${e1.id}/memberships`,
      ),
      owner2.token,
    ).expect(403);
    expect(membershipsDenied.body.code).toBe('TENANT_FORBIDDEN');
  });

  it('platform-admin entra sin membresía y deja el bypass auditado', async () => {
    const logger = app.get(AppLogger);
    const info = jest.spyOn(logger.raw, 'info');

    await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      admin.token,
    ).expect(200);

    const membership = await prisma.membership.findUnique({
      where: {
        userId_establishmentId: {
          userId: admin.userId,
          establishmentId: e1.id,
        },
      },
    });
    expect(membership).toBeNull();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tenant.platform_admin_bypass',
        actorId: admin.userId,
        establishmentId: e1.id,
        decision: 'allow',
      }),
      'tenant_access_without_membership',
    );

    info.mockRestore();
  });

  it('owner agrega staff; staff tiene tenant pero no membership:read', async () => {
    const created = await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/memberships`)
        .send({ userId: staff1.userId, groupSlug: 'staff' }),
      owner1.token,
    ).expect(201);

    expect(created.body).toEqual(
      expect.objectContaining({
        userId: staff1.userId,
        status: 'active',
        groups: [{ slug: 'staff', name: 'Staff' }],
      }),
    );

    const mine = await bearer(
      request(server()).get('/api/v1/me/establishments'),
      staff1.token,
    ).expect(200);
    expect(mine.body).toEqual([
      expect.objectContaining({ id: e1.id, status: 'active', groups: ['staff'] }),
    ]);

    await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      staff1.token,
    ).expect(200);

    const denied = await bearer(
      request(server()).get(
        `/api/v1/establishments/${e1.id}/memberships`,
      ),
      staff1.token,
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });

  it('owner no puede asignar owner y el intento no crea membresía', async () => {
    const denied = await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/memberships`)
        .send({ userId: player.userId, groupSlug: 'owner' }),
      owner1.token,
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');

    expect(
      await prisma.membership.findUnique({
        where: {
          userId_establishmentId: {
            userId: player.userId,
            establishmentId: e1.id,
          },
        },
      }),
    ).toBeNull();

    const memberships = await listMemberships(admin.token, e1.id);
    const staffMembership = memberships.find(
      (membership) => membership.userId === staff1.userId,
    );

    const patchDenied = await bearer(
      request(server())
        .patch(
          `/api/v1/establishments/${e1.id}/memberships/${staffMembership?.id}`,
        )
        .send({ groupSlug: 'owner' }),
      owner1.token,
    ).expect(403);
    expect(patchDenied.body.code).toBe('PERMISSION_DENIED');

    const after = await prisma.membership.findUnique({
      where: { id: staffMembership?.id },
      include: { groups: { include: { group: true } } },
    });
    expect(after?.groups.map((assignment) => assignment.group.slug)).toEqual([
      'staff',
    ]);
  });

  it('solo una membresía activa habilita tenant (suspender staff → 403 T)', async () => {
    const memberships = await listMemberships(admin.token, e1.id);
    const staffMembership = memberships.find(
      (membership) => membership.userId === staff1.userId,
    );

    const suspended = await bearer(
      request(server())
        .patch(
          `/api/v1/establishments/${e1.id}/memberships/${staffMembership?.id}`,
        )
        .send({ status: 'suspended' }),
      owner1.token,
    ).expect(200);
    expect(suspended.body.status).toBe('suspended');

    const denied = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      staff1.token,
    ).expect(403);
    expect(denied.body.code).toBe('TENANT_FORBIDDEN');

    await bearer(
      request(server())
        .patch(
          `/api/v1/establishments/${e1.id}/memberships/${staffMembership?.id}`,
        )
        .send({ status: 'active' }),
      owner1.token,
    ).expect(200);

    await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      staff1.token,
    ).expect(200);
  });

  it('protege al último owner: DELETE, degradación y suspensión → 409', async () => {
    const memberships = await listMemberships(admin.token, e1.id);
    const ownerMembership = memberships.find(
      (membership) => membership.userId === owner1.userId,
    );
    expect(ownerMembership?.groups[0]?.slug).toBe('owner');

    const deleted = await bearer(
      request(server()).delete(
        `/api/v1/establishments/${e1.id}/memberships/${ownerMembership?.id}`,
      ),
      owner1.token,
    ).expect(409);
    expect(deleted.body.code).toBe('INVALID_STATE');

    const demoted = await bearer(
      request(server())
        .patch(
          `/api/v1/establishments/${e1.id}/memberships/${ownerMembership?.id}`,
        )
        .send({ groupSlug: 'staff' }),
      owner1.token,
    ).expect(409);
    expect(demoted.body.code).toBe('INVALID_STATE');

    const suspended = await bearer(
      request(server())
        .patch(
          `/api/v1/establishments/${e1.id}/memberships/${ownerMembership?.id}`,
        )
        .send({ status: 'suspended' }),
      owner1.token,
    ).expect(409);
    expect(suspended.body.code).toBe('INVALID_STATE');

    expect(await countActiveOwners(e1.id)).toBe(1);
    const stillOwner = await prisma.membership.findUnique({
      where: { id: ownerMembership?.id },
      include: { groups: { include: { group: true } } },
    });
    expect(stillOwner?.status).toBe(MembershipStatus.active);
    expect(
      stillOwner?.groups.map((assignment) => assignment.group.slug),
    ).toEqual(['owner']);
  });

  it('con un segundo owner se puede retirar el primero; el último sigue protegido', async () => {
    const created = await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/memberships`)
        .send({ userId: owner3.userId, groupSlug: 'owner' }),
      admin.token,
    ).expect(201);
    expect(created.body.groups[0].slug).toBe('owner');
    expect(await countActiveOwners(e1.id)).toBe(2);

    const memberships = await listMemberships(admin.token, e1.id);
    const owner1Membership = memberships.find(
      (membership) => membership.userId === owner1.userId,
    );
    const owner3Membership = memberships.find(
      (membership) => membership.userId === owner3.userId,
    );

    const removed = await bearer(
      request(server()).delete(
        `/api/v1/establishments/${e1.id}/memberships/${owner1Membership?.id}`,
      ),
      owner1.token,
    ).expect(200);
    expect(removed.body.status).toBe('removed');
    expect(await countActiveOwners(e1.id)).toBe(1);

    const lastOwner = await bearer(
      request(server()).delete(
        `/api/v1/establishments/${e1.id}/memberships/${owner3Membership?.id}`,
      ),
      admin.token,
    ).expect(409);
    expect(lastOwner.body.code).toBe('INVALID_STATE');
    expect(await countActiveOwners(e1.id)).toBe(1);

    // owner1 lost the tenant when its owner membership was removed.
    const noLongerTenant = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      owner1.token,
    ).expect(403);
    expect(noLongerTenant.body.code).toBe('TENANT_FORBIDDEN');
  });

  it('concurrencia: dos retiros simultáneos de owners solo dejan uno activo', async () => {
    await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/memberships`)
        .send({ userId: owner1.userId, groupSlug: 'owner' }),
      admin.token,
    ).expect(201);

    const memberships = await listMemberships(admin.token, e1.id);
    const owner1Membership = memberships.find(
      (membership) => membership.userId === owner1.userId,
    );
    const owner3Membership = memberships.find(
      (membership) => membership.userId === owner3.userId,
    );
    expect(await countActiveOwners(e1.id)).toBe(2);

    const [first, second] = await Promise.all([
      bearer(
        request(server()).delete(
          `/api/v1/establishments/${e1.id}/memberships/${owner1Membership?.id}`,
        ),
        admin.token,
      ),
      bearer(
        request(server()).delete(
          `/api/v1/establishments/${e1.id}/memberships/${owner3Membership?.id}`,
        ),
        admin.token,
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const rejected = first.status === 409 ? first : second;
    expect(rejected.body.code).toBe('INVALID_STATE');
    expect(await countActiveOwners(e1.id)).toBe(1);
  });
});
