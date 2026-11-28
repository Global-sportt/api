import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
  SpaceStatus,
} from '@prisma/client';
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
import { wallClockToUtc } from '../src/common/time/zoned-time';
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

interface EstablishmentProfileBody extends EstablishmentBody {
  timezone: string;
  currency: string;
  address: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  cancellationPolicy: string | null;
  usagePolicy: string | null;
  rules: string | null;
}

interface AvailabilitySlotBody {
  startsAt: string;
  endsAt: string;
  priceMinor: string;
  currency: string;
  available: boolean;
}

interface AvailabilityBody {
  date: string;
  timezone: string;
  currency: string;
  spaces: Array<{ id: string; slots: AvailabilitySlotBody[] }>;
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

  it('RT-14/RT-15: solo platform-admin accede a /admin/establishments', async () => {
    await bearer(
      request(server()).get('/api/v1/admin/establishments'),
      admin.token,
    ).expect(200);

    const anonymous = await request(server())
      .get('/api/v1/admin/establishments')
      .set('Origin', ORIGIN)
      .expect(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');

    for (const user of [player, owner1, staff1, owner2]) {
      const denied = await bearer(
        request(server()).get('/api/v1/admin/establishments'),
        user.token,
      ).expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
    }

    const deniedBodies = {
      name: 'No permitido',
      slug: `e2e-denegado-${Date.now()}`,
      ownerUserId: player.userId,
    };

    const anonymousCreate = await request(server())
      .post('/api/v1/admin/establishments')
      .set('Origin', ORIGIN)
      .send(deniedBodies)
      .expect(401);
    expect(anonymousCreate.body.code).toBe('UNAUTHENTICATED');

    for (const user of [player, owner1, staff1, owner2]) {
      const deniedCreate = await bearer(
        request(server())
          .post('/api/v1/admin/establishments')
          .send({ ...deniedBodies, slug: `${deniedBodies.slug}-${user.userId}` }),
        user.token,
      ).expect(403);
      expect(deniedCreate.body.code).toBe('PERMISSION_DENIED');
    }

    // RT-14 positive cell: platform-admin can create an establishment.
    const adminCreate = await bearer(
      request(server())
        .post('/api/v1/admin/establishments')
        .send({
          name: 'E2E Admin Extra',
          slug: `e2e-admin-${Date.now()}`,
          ownerUserId: owner2.userId,
        }),
      admin.token,
    ).expect(201);
    expect(adminCreate.body.owner).toEqual(
      expect.objectContaining({ userId: owner2.userId, groups: ['owner'] }),
    );
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

  it('NEG-02: aplica tenant guard: 403 sin membresía, 404 si la sede no existe', async () => {
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

  it('NEG-02: owner de una sede recibe 403 T en la otra', async () => {
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

  it('RT-10/RT-11: owner agrega staff; matriz de principals de membresías', async () => {
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

    // RT-10: GET memberships for the six principals of the matrix.
    const ownerList = await listMemberships(owner1.token, e1.id);
    expect(
      ownerList.some((membership) => membership.userId === staff1.userId),
    ).toBe(true);
    await listMemberships(admin.token, e1.id);

    const staffDenied = await bearer(
      request(server()).get(
        `/api/v1/establishments/${e1.id}/memberships`,
      ),
      staff1.token,
    ).expect(403);
    expect(staffDenied.body.code).toBe('PERMISSION_DENIED');

    const playerDenied = await bearer(
      request(server()).get(
        `/api/v1/establishments/${e1.id}/memberships`,
      ),
      player.token,
    ).expect(403);
    expect(playerDenied.body.code).toBe('TENANT_FORBIDDEN');

    const crossTenantDenied = await bearer(
      request(server()).get(
        `/api/v1/establishments/${e1.id}/memberships`,
      ),
      owner2.token,
    ).expect(403);
    expect(crossTenantDenied.body.code).toBe('TENANT_FORBIDDEN');

    const anonymous = await request(server())
      .get(`/api/v1/establishments/${e1.id}/memberships`)
      .set('Origin', ORIGIN)
      .expect(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');

    // RT-11: POST memberships for the six principals.
    const staffPost = await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/memberships`)
        .send({ userId: owner3.userId, groupSlug: 'staff' }),
      staff1.token,
    ).expect(403);
    expect(staffPost.body.code).toBe('PERMISSION_DENIED');

    for (const [user, code] of [
      [player, 'TENANT_FORBIDDEN'],
      [owner2, 'TENANT_FORBIDDEN'],
    ] as const) {
      const denied = await bearer(
        request(server())
          .post(`/api/v1/establishments/${e1.id}/memberships`)
          .send({ userId: owner3.userId, groupSlug: 'staff' }),
        user.token,
      ).expect(403);
      expect(denied.body.code).toBe(code);
    }

    const anonymousPost = await request(server())
      .post(`/api/v1/establishments/${e1.id}/memberships`)
      .set('Origin', ORIGIN)
      .send({ userId: owner3.userId, groupSlug: 'staff' })
      .expect(401);
    expect(anonymousPost.body.code).toBe('UNAUTHENTICATED');

    const adminPost = await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/memberships`)
        .send({ userId: owner3.userId, groupSlug: 'staff' }),
      admin.token,
    ).expect(201);
    expect(adminPost.body).toEqual(
      expect.objectContaining({
        userId: owner3.userId,
        groups: [{ slug: 'staff', name: 'Staff' }],
      }),
    );
  });

  it('RT-12: PATCH memberships respeta la matriz de seis principals', async () => {
    const memberships = await listMemberships(admin.token, e1.id);
    const staffMembership = memberships.find(
      (membership) => membership.userId === staff1.userId,
    );
    expect(staffMembership).toBeDefined();
    const path = `/api/v1/establishments/${e1.id}/memberships/${staffMembership?.id}`;

    const anonymous = await request(server())
      .patch(path)
      .set('Origin', ORIGIN)
      .send({ status: 'active' })
      .expect(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');

    const playerDenied = await bearer(
      request(server()).patch(path).send({ status: 'active' }),
      player.token,
    ).expect(403);
    expect(playerDenied.body.code).toBe('TENANT_FORBIDDEN');

    const staffDenied = await bearer(
      request(server()).patch(path).send({ status: 'active' }),
      staff1.token,
    ).expect(403);
    expect(staffDenied.body.code).toBe('PERMISSION_DENIED');

    const crossTenantDenied = await bearer(
      request(server()).patch(path).send({ status: 'active' }),
      owner2.token,
    ).expect(403);
    expect(crossTenantDenied.body.code).toBe('TENANT_FORBIDDEN');

    const ownerAllowed = await bearer(
      request(server()).patch(path).send({ status: 'active' }),
      owner1.token,
    ).expect(200);
    expect(ownerAllowed.body.status).toBe('active');

    const adminAllowed = await bearer(
      request(server()).patch(path).send({ status: 'active' }),
      admin.token,
    ).expect(200);
    expect(adminAllowed.body.status).toBe('active');
  });

  it('RT-13: DELETE memberships respeta la matriz de seis principals', async () => {
    const memberships = await listMemberships(admin.token, e1.id);
    const target = memberships.find(
      (membership) => membership.userId === owner3.userId,
    );
    expect(target).toBeDefined();
    const path = `/api/v1/establishments/${e1.id}/memberships/${target?.id}`;

    const anonymous = await request(server())
      .delete(path)
      .set('Origin', ORIGIN)
      .expect(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');

    const playerDenied = await bearer(
      request(server()).delete(path),
      player.token,
    ).expect(403);
    expect(playerDenied.body.code).toBe('TENANT_FORBIDDEN');

    const staffDenied = await bearer(
      request(server()).delete(path),
      staff1.token,
    ).expect(403);
    expect(staffDenied.body.code).toBe('PERMISSION_DENIED');

    const crossTenantDenied = await bearer(
      request(server()).delete(path),
      owner2.token,
    ).expect(403);
    expect(crossTenantDenied.body.code).toBe('TENANT_FORBIDDEN');

    const ownerAllowed = await bearer(
      request(server()).delete(path),
      owner1.token,
    ).expect(200);
    expect(ownerAllowed.body.status).toBe('removed');

    // Idempotent for the platform-admin cell; the row stays removed.
    const adminAllowed = await bearer(
      request(server()).delete(path),
      admin.token,
    ).expect(200);
    expect(adminAllowed.body.status).toBe('removed');
  });

  it('NEG-11: owner no puede asignar owner y el intento no crea membresía', async () => {
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

  it('RT-12/Q9: solo una membresía activa habilita tenant (suspender staff → 403 T)', async () => {
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

    // Q9/NEG-02: invited and removed memberships are treated as no membership.
    for (const status of ['invited', 'removed'] as const) {
      await prisma.membership.update({
        where: { id: staffMembership?.id },
        data: { status },
      });

      const denied = await bearer(
        request(server()).get(`/api/v1/establishments/${e1.id}`),
        staff1.token,
      ).expect(403);
      expect(denied.body.code).toBe('TENANT_FORBIDDEN');
    }

    await prisma.membership.update({
      where: { id: staffMembership?.id },
      data: { status: 'active' },
    });

    await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}`),
      staff1.token,
    ).expect(200);
  });

  it('NEG-12/RT-12/RT-13: protege al último owner: DELETE, degradación y suspensión → 409', async () => {
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

  it('RT-11/RT-13/NEG-12: con un segundo owner se puede retirar el primero; el último sigue protegido', async () => {
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

  describe('Ciclo de vida del establecimiento (e2e)', () => {
    const TIMEZONE = 'America/Bogota';
    const lifecycleIpBase = ipCounter;

    let lifecycleOwner: TestUser;
    let lifecycleStaff: TestUser;
    let lifecyclePlayer: TestUser;
    let lifecycle: EstablishmentBody;
    let spaceId: string;
    let bookingDay: string;
    let baselineBookingId: string;

    function lifecyclePath(establishmentId: string = lifecycle.id): string {
      return `/api/v1/admin/establishments/${establishmentId}/status`;
    }

    function changeStatus(
      token: string,
      status: string,
      establishmentId: string = lifecycle.id,
    ): request.Test {
      return bearer(
        request(server()).patch(lifecyclePath(establishmentId)).send({ status }),
        token,
      );
    }

    function slotAt(date: string, hour: number): { startsAt: string; endsAt: string } {
      return {
        startsAt: wallClockToUtc(date, hour * 60, TIMEZONE).instant.toISOString(),
        endsAt: wallClockToUtc(date, (hour + 1) * 60, TIMEZONE).instant.toISOString(),
      };
    }

    function createOwnBooking(
      token: string,
      targetSpaceId: string,
      slot: { startsAt: string; endsAt: string },
    ): request.Test {
      return bearer(
        request(server())
          .post('/api/v1/bookings')
          .send({ spaceId: targetSpaceId, ...slot }),
        token,
      );
    }

    async function publicAvailability(
      slug: string,
      date: string,
    ): Promise<AvailabilityBody> {
      const response = await request(server())
        .get(`/api/v1/public/establishments/${slug}/availability`)
        .set('Origin', ORIGIN)
        .query({ date })
        .expect(200);

      return response.body as AvailabilityBody;
    }

    function statusChangedAudits(
      info: jest.SpyInstance,
    ): Array<[Record<string, unknown>, string]> {
      return info.mock.calls.filter(
        ([payload]) =>
          (payload as { event?: string }).event === 'establishment.status_changed',
      ) as Array<[Record<string, unknown>, string]>;
    }

    beforeAll(async () => {
      lifecycleOwner = await registerUser('lifecycle-owner');
      lifecycleStaff = await registerUser('lifecycle-staff');
      lifecyclePlayer = await registerUser('lifecycle-player');

      const created = await bearer(
        request(server())
          .post('/api/v1/admin/establishments')
          .send({
            name: 'E2E Ciclo de Vida',
            slug: `e2e-ciclo-vida-${Date.now()}-${lifecycleIpBase}`,
            timezone: TIMEZONE,
            currency: 'COP',
            ownerUserId: lifecycleOwner.userId,
          }),
        admin.token,
      ).expect(201);
      lifecycle = created.body as EstablishmentBody;

      await bearer(
        request(server())
          .post(`/api/v1/establishments/${lifecycle.id}/memberships`)
          .send({ userId: lifecycleStaff.userId, groupSlug: 'staff' }),
        lifecycleOwner.token,
      ).expect(201);

      const space = await prisma.space.create({
        data: {
          establishmentId: lifecycle.id,
          name: 'Cancha Ciclo de Vida',
          slug: `ciclo-vida-${Date.now()}`,
          sport: 'futbol',
          slotMinutes: 60,
          bufferMinutes: 0,
          status: SpaceStatus.active,
          operatingHours: {
            create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
              dayOfWeek,
              opensAtMinutes: 8 * 60,
              closesAtMinutes: 20 * 60,
            })),
          },
          priceRules: {
            create: [
              {
                dayOfWeek: null,
                startsAtMinutes: 0,
                endsAtMinutes: 1440,
                amountMinor: 25_000n,
                currency: 'COP',
                priority: 0,
              },
            ],
          },
        },
        select: { id: true },
      });
      spaceId = space.id;

      bookingDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(Date.now() + 86_400_000));

      const baseline = await createOwnBooking(
        lifecyclePlayer.token,
        spaceId,
        slotAt(bookingDay, 10),
      ).expect(201);
      baselineBookingId = baseline.body.id as string;
    });

    it('solo platform-admin puede cambiar el estado: owner, staff y player reciben 403', async () => {
      const anonymous = await request(server())
        .patch(lifecyclePath())
        .set('Origin', ORIGIN)
        .send({ status: 'suspended' })
        .expect(401);
      expect(anonymous.body.code).toBe('UNAUTHENTICATED');

      for (const user of [lifecycleOwner, lifecycleStaff, lifecyclePlayer]) {
        const denied = await changeStatus(user.token, 'suspended').expect(403);
        expect(denied.body.code).toBe('PERMISSION_DENIED');
      }

      const stored = await prisma.establishment.findUniqueOrThrow({
        where: { id: lifecycle.id },
      });
      expect(stored.status).toBe(EstablishmentStatus.active);
    });

    it('suspende, audita actor/from/to y la repetición es idempotente sin escritura', async () => {
      const info = jest.spyOn(app.get(AppLogger).raw, 'info');
      info.mockClear();

      const suspended = await changeStatus(admin.token, 'suspended').expect(200);
      expect(suspended.body).toMatchObject({
        id: lifecycle.id,
        status: EstablishmentStatus.suspended,
      });

      const audits = statusChangedAudits(info);
      expect(audits).toHaveLength(1);
      expect(audits[0][1]).toBe('establishment.status_changed');
      expect(audits[0][0]).toMatchObject({
        actorId: admin.userId,
        establishmentId: lifecycle.id,
        from: EstablishmentStatus.active,
        to: EstablishmentStatus.suspended,
        decision: 'allow',
      });

      info.mockClear();
      const repeated = await changeStatus(admin.token, 'suspended').expect(200);
      expect(repeated.body.status).toBe(EstablishmentStatus.suspended);
      expect(statusChangedAudits(info)).toHaveLength(0);

      // Suspension changes only the establishment state: the space, its
      // schedule and the existing booking are untouched.
      const space = await prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
      expect(space.status).toBe(SpaceStatus.active);
      expect(await prisma.operatingHour.count({ where: { spaceId } })).toBe(7);
      expect(
        await prisma.booking.count({ where: { establishmentId: lifecycle.id } }),
      ).toBe(1);

      info.mockRestore();
    });

    it('con la sede suspendida bloquea reservas nuevas y conserva el histórico consultable', async () => {
      const blocked = await createOwnBooking(
        lifecyclePlayer.token,
        spaceId,
        slotAt(bookingDay, 11),
      ).expect(404);
      expect(blocked.body.code).toBe('ESTABLISHMENT_NOT_FOUND');

      const publicResponse = await request(server())
        .get(`/api/v1/public/establishments/${lifecycle.slug}/availability`)
        .set('Origin', ORIGIN)
        .query({ date: bookingDay })
        .expect(404);
      expect(publicResponse.body.code).toBe('ESTABLISHMENT_NOT_FOUND');

      // The existing booking is still readable by its player...
      const detail = await bearer(
        request(server()).get(`/api/v1/me/bookings/${baselineBookingId}`),
        lifecyclePlayer.token,
      ).expect(200);
      expect(detail.body).toMatchObject({
        id: baselineBookingId,
        establishmentId: lifecycle.id,
        status: 'confirmed',
      });

      // ...and the existing space is still listed for the owner.
      const spaces = await bearer(
        request(server()).get(`/api/v1/establishments/${lifecycle.id}/spaces`),
        lifecycleOwner.token,
      ).expect(200);
      expect(spaces.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: spaceId,
            status: SpaceStatus.active,
          }),
        ]),
      );

      const status = await bearer(
        request(server()).get(`/api/v1/establishments/${lifecycle.id}`),
        lifecycleOwner.token,
      ).expect(200);
      expect(status.body.status).toBe(EstablishmentStatus.suspended);

      expect(
        await prisma.booking.count({ where: { establishmentId: lifecycle.id } }),
      ).toBe(1);
    });

    it('al reactivar, la disponibilidad y la creación de reservas vuelven a funcionar', async () => {
      const info = jest.spyOn(app.get(AppLogger).raw, 'info');
      info.mockClear();

      const reactivated = await changeStatus(admin.token, 'active').expect(200);
      expect(reactivated.body.status).toBe(EstablishmentStatus.active);

      const audits = statusChangedAudits(info);
      expect(audits).toHaveLength(1);
      expect(audits[0][0]).toMatchObject({
        actorId: admin.userId,
        establishmentId: lifecycle.id,
        from: EstablishmentStatus.suspended,
        to: EstablishmentStatus.active,
      });

      info.mockClear();
      const repeated = await changeStatus(admin.token, 'active').expect(200);
      expect(repeated.body.status).toBe(EstablishmentStatus.active);
      expect(statusChangedAudits(info)).toHaveLength(0);
      info.mockRestore();

      const availability = await publicAvailability(lifecycle.slug, bookingDay);
      const slots = availability.spaces.find((space) => space.id === spaceId)?.slots ?? [];
      expect(slots.some((slot) => slot.startsAt === slotAt(bookingDay, 10).startsAt)).toBe(false);
      expect(slots.some((slot) => slot.startsAt === slotAt(bookingDay, 12).startsAt)).toBe(true);

      const created = await createOwnBooking(
        lifecyclePlayer.token,
        spaceId,
        slotAt(bookingDay, 12),
      ).expect(201);
      expect(created.body).toMatchObject({
        establishmentId: lifecycle.id,
        spaceId,
        status: 'confirmed',
      });

      expect(
        await prisma.booking.count({ where: { establishmentId: lifecycle.id } }),
      ).toBe(2);
    });

    it('una sede en pending no admite transiciones: 409 INVALID_STATE', async () => {
      await prisma.establishment.update({
        where: { id: lifecycle.id },
        data: { status: EstablishmentStatus.pending },
      });

      for (const target of [EstablishmentStatus.suspended, EstablishmentStatus.active]) {
        const rejected = await changeStatus(admin.token, target).expect(409);
        expect(rejected.body.code).toBe('INVALID_STATE');
      }

      const stored = await prisma.establishment.findUniqueOrThrow({
        where: { id: lifecycle.id },
      });
      expect(stored.status).toBe(EstablishmentStatus.pending);

      await prisma.establishment.update({
        where: { id: lifecycle.id },
        data: { status: EstablishmentStatus.active },
      });
    });

    it('rechaza bodies inválidos con 400 VALIDATION_ERROR', async () => {
      const invalidBodies: Array<Record<string, unknown>> = [
        {},
        { status: 'pending' },
        { status: 'ACTIVE' },
        { status: 'suspended', name: 'no permitido' },
      ];

      for (const body of invalidBodies) {
        const rejected = await bearer(
          request(server()).patch(lifecyclePath()).send(body),
          admin.token,
        ).expect(400);
        expect(rejected.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('responde 404 ESTABLISHMENT_NOT_FOUND si la sede no existe', async () => {
      const response = await changeStatus(
        admin.token,
        'suspended',
        MISSING_ESTABLISHMENT,
      ).expect(404);
      expect(response.body.code).toBe('ESTABLISHMENT_NOT_FOUND');
    });
  });

  describe('Perfil del establecimiento (e2e)', () => {
    let profileOwner: TestUser;
    let profileStaff: TestUser;
    let profileOtherOwner: TestUser;
    let own: EstablishmentProfileBody;
    let other: EstablishmentProfileBody;
    let suspended: EstablishmentProfileBody;
    let slugCounter = 0;

    const profile = {
      address: 'Calle 123 #45-67, Bogotá',
      contactPhone: '+57 601 555 0101',
      contactEmail: 'perfil@cancha.example',
      cancellationPolicy: 'Cancelación sin costo hasta 24 horas antes.',
      usagePolicy: 'Uso exclusivo para actividades deportivas.',
      rules: 'Prohibido ingresar con alimentos.',
    };

    async function createProfileEstablishment(
      name: string,
      ownerUserId: string,
    ): Promise<EstablishmentProfileBody> {
      slugCounter += 1;
      const response = await bearer(
        request(server())
          .post('/api/v1/admin/establishments')
          .send({
            name,
            slug: `e2e-perfil-${slugCounter}-${Date.now()}`,
            ownerUserId,
          }),
        admin.token,
      ).expect(201);

      return response.body as EstablishmentProfileBody;
    }

    function patchProfile(
      establishmentId: string,
      token: string,
      body: Record<string, unknown>,
    ): request.Test {
      return bearer(
        request(server()).patch(`/api/v1/establishments/${establishmentId}`).send(body),
        token,
      );
    }

    beforeAll(async () => {
      profileOwner = await registerUser('profile-owner');
      profileStaff = await registerUser('profile-staff');
      profileOtherOwner = await registerUser('profile-other');

      own = await createProfileEstablishment(
        'E2E Perfil Propio',
        profileOwner.userId,
      );
      other = await createProfileEstablishment(
        'E2E Perfil Ajeno',
        profileOtherOwner.userId,
      );
      suspended = await createProfileEstablishment(
        'E2E Perfil Suspendido',
        profileOtherOwner.userId,
      );

      await bearer(
        request(server())
          .post(`/api/v1/establishments/${own.id}/memberships`)
          .send({ userId: profileStaff.userId, groupSlug: 'staff' }),
        profileOwner.token,
      ).expect(201);

      await prisma.establishment.update({
        where: { id: suspended.id },
        data: { status: EstablishmentStatus.suspended },
      });
    });

    it('el owner edita su sede: PATCH y GET devuelven los campos nuevos con status', async () => {
      const updated = await patchProfile(own.id, profileOwner.token, {
        ...profile,
        name: 'E2E Perfil Propio Editado',
        timezone: 'America/Lima',
        currency: 'PEN',
      }).expect(200);

      expect(updated.body).toMatchObject({
        id: own.id,
        name: 'E2E Perfil Propio Editado',
        timezone: 'America/Lima',
        currency: 'PEN',
        status: 'active',
        ...profile,
      });

      const fetched = await bearer(
        request(server()).get(`/api/v1/establishments/${own.id}`),
        profileOwner.token,
      ).expect(200);

      expect(fetched.body).toMatchObject({ ...profile, status: 'active' });

      const stored = await prisma.establishment.findUnique({
        where: { id: own.id },
      });
      expect(stored).toMatchObject({
        name: 'E2E Perfil Propio Editado',
        timezone: 'America/Lima',
        currency: 'PEN',
        address: profile.address,
        contactEmail: profile.contactEmail,
        rules: profile.rules,
      });
    });

    it('staff recibe 403 PERMISSION_DENIED y no modifica la sede', async () => {
      const denied = await patchProfile(own.id, profileStaff.token, {
        address: 'Dirección del staff',
      }).expect(403);

      expect(denied.body.code).toBe('PERMISSION_DENIED');
      const stored = await prisma.establishment.findUnique({
        where: { id: own.id },
      });
      expect(stored?.address).toBe(profile.address);
    });

    it('el dueño de otra sede recibe 403 T (Q4) y una sede inexistente 404', async () => {
      const denied = await patchProfile(own.id, profileOtherOwner.token, {
        address: 'Dirección ajena',
      }).expect(403);
      expect(denied.body.code).toBe('TENANT_FORBIDDEN');

      const missing = await patchProfile(
        MISSING_ESTABLISHMENT,
        profileOwner.token,
        { address: 'Sede fantasma' },
      ).expect(404);
      expect(missing.body.code).toBe('ESTABLISHMENT_NOT_FOUND');
    });

    it('platform-admin edita cualquier sede', async () => {
      const updated = await patchProfile(other.id, admin.token, {
        contactPhone: '+57 300 999 8888',
      }).expect(200);

      expect(updated.body.contactPhone).toBe('+57 300 999 8888');
      expect(updated.body.status).toBe('active');
    });

    it('rechaza body vacío, valores inválidos y campos fuera del contrato', async () => {
      const empty = await patchProfile(own.id, profileOwner.token, {}).expect(
        400,
      );
      expect(empty.body.code).toBe('VALIDATION_ERROR');

      const invalidBodies: Array<Record<string, unknown>> = [
        { timezone: 'No/Existe' },
        { currency: 'cop' },
        { currency: 'CO' },
        { contactEmail: 'no-es-un-email' },
        { name: '' },
        { name: 'x'.repeat(121) },
        { address: 'x'.repeat(301) },
        { contactPhone: '1'.repeat(41) },
        { cancellationPolicy: 'x'.repeat(4001) },
        { usagePolicy: 'x'.repeat(4001) },
        { rules: 'x'.repeat(4001) },
        { status: 'suspended' },
      ];

      for (const body of invalidBodies) {
        const rejected = await patchProfile(
          own.id,
          profileOwner.token,
          body,
        ).expect(400);
        expect(rejected.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('audita actor, sede y nombres de campos sin registrar valores', async () => {
      const logger = app.get(AppLogger);
      const info = jest.spyOn(logger.raw, 'info');
      info.mockClear();

      await patchProfile(own.id, profileOwner.token, {
        cancellationPolicy: 'Nueva política de cancelación.',
        contactPhone: '+57 601 000 1111',
      }).expect(200);

      const call = info.mock.calls.find(
        ([payload]) =>
          (payload as { event?: string }).event === 'establishment.updated',
      );
      expect(call).toBeDefined();

      const [payload, message] = call as [Record<string, unknown>, string];
      expect(message).toBe('establishment.updated');
      expect(payload).toMatchObject({
        actorId: profileOwner.userId,
        establishmentId: own.id,
        changedFields: ['contactPhone', 'cancellationPolicy'],
        decision: 'allow',
      });

      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('Nueva política de cancelación.');
      expect(serialized).not.toContain('+57 601 000 1111');

      info.mockRestore();
    });

    it('la consulta pública devuelve el perfil de una sede activa sin autenticación', async () => {
      const response = await request(server())
        .get(`/api/v1/public/establishments/${own.slug}`)
        .set('Origin', ORIGIN)
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual(
        [
          'name',
          'slug',
          'timezone',
          'currency',
          'address',
          'contactPhone',
          'contactEmail',
          'cancellationPolicy',
          'usagePolicy',
          'rules',
        ].sort(),
      );
      expect(response.body).not.toHaveProperty('id');
      expect(response.body).not.toHaveProperty('status');

      const stored = await prisma.establishment.findUnique({
        where: { id: own.id },
      });
      expect(response.body).toEqual({
        name: stored?.name,
        slug: stored?.slug,
        timezone: stored?.timezone,
        currency: stored?.currency,
        address: stored?.address,
        contactPhone: stored?.contactPhone,
        contactEmail: stored?.contactEmail,
        cancellationPolicy: stored?.cancellationPolicy,
        usagePolicy: stored?.usagePolicy,
        rules: stored?.rules,
      });
    });

    it('la consulta pública responde 404 en sede suspendida o inexistente', async () => {
      const suspendedResponse = await request(server())
        .get(`/api/v1/public/establishments/${suspended.slug}`)
        .set('Origin', ORIGIN)
        .expect(404);
      expect(suspendedResponse.body.code).toBe('ESTABLISHMENT_NOT_FOUND');

      const missing = await request(server())
        .get('/api/v1/public/establishments/no-existe-perfil')
        .set('Origin', ORIGIN)
        .expect(404);
      expect(missing.body.code).toBe('ESTABLISHMENT_NOT_FOUND');
    });
  });
});
