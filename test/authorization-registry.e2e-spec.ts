import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import {
  RoutePolicyRegistry,
  type RegisteredRoute,
} from '../src/common/authz/route-policy.registry';

jest.setTimeout(60_000);

describe('Authorization route registry (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // `init()` runs the registry's OnApplicationBootstrap validation. Any
    // unannotated private controller would make this suite fail here.
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('valida las rutas reales descubiertas desde AppModule', () => {
    const registry = app.get(RoutePolicyRegistry);
    const routes = registry.validate();
    const byRoute = new Map(
      routes.map((route) => [
        `${route.httpMethod} ${route.path}`,
        route,
      ]),
    );

    expect(routes.length).toBeGreaterThan(10);
    expectRoute(byRoute, 'GET /me/establishments', 'authenticated-only');
    expectRoute(byRoute, 'GET /auth/me', 'authenticated-only');
    expectRoute(byRoute, 'POST /auth/logout-all', 'authenticated-only');
    expectRoute(
      byRoute,
      'POST /auth/password/change',
      'authenticated-only',
    );
    expectRoute(byRoute, 'POST /bookings', 'authorize', 'booking:create');
    expectRoute(
      byRoute,
      'GET /establishments/:id/spaces',
      'authorize',
      'space:read',
    );
    expectRoute(
      byRoute,
      'POST /establishments/:id/spaces',
      'authorize',
      'space:create',
    );
    expectRoute(
      byRoute,
      'PATCH /establishments/:id/spaces/:spaceId',
      'authorize',
      'space:update',
    );
    expectRoute(
      byRoute,
      'GET /establishments/:establishmentId/spaces/:spaceId/operating-hours',
      'authorize',
      'schedule:read',
    );
    expectRoute(
      byRoute,
      'PUT /establishments/:establishmentId/spaces/:spaceId/operating-hours',
      'authorize',
      'schedule:manage',
    );
    expectRoute(
      byRoute,
      'GET /establishments/:establishmentId/spaces/:spaceId/schedule-exceptions',
      'authorize',
      'schedule:read',
    );
    expectRoute(
      byRoute,
      'PUT /establishments/:establishmentId/spaces/:spaceId/schedule-exceptions/:date',
      'authorize',
      'schedule:manage',
    );
    expectRoute(
      byRoute,
      'DELETE /establishments/:establishmentId/spaces/:spaceId/schedule-exceptions/:date',
      'authorize',
      'schedule:manage',
    );
    expectRoute(byRoute, 'GET /health/ready', 'public');
  });
});

function expectRoute(
  routes: Map<string, RegisteredRoute>,
  key: string,
  policy: RegisteredRoute['policy'],
  permission?: string,
): void {
  const route = routes.get(key);
  expect(route).toBeDefined();
  expect(route).toMatchObject({
    policy,
    ...(permission ? { permission } : {}),
  });
}
