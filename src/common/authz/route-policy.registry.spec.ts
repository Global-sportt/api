import 'reflect-metadata';
import { Controller, Get, Module, type DynamicModule, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { Public } from '../decorators/public.decorator';
import { AuthenticatedOnly } from './authenticated-only.decorator';
import { Authorize } from './authorize.decorator';
import { RoutePolicyRegistry } from './route-policy.registry';

@Controller('authorized')
class AuthorizedFixtureController {
  @Get()
  @Authorize('booking', 'read')
  list(): void {}

  @Get('create')
  @Authorize('booking', 'create')
  create(): void {}
}

@Controller('public')
class PublicFixtureController {
  @Get()
  @Public()
  ping(): void {}
}

@Controller('identity')
class AuthenticatedOnlyFixtureController {
  @Get()
  @AuthenticatedOnly()
  me(): void {}
}

@Controller('nested')
class NestedFixtureController {
  @Get()
  @Authorize('space', 'read')
  spaces(): void {}
}

@Module({ controllers: [NestedFixtureController] })
class NestedFixtureModule {}

@Module({
  imports: [NestedFixtureModule],
  controllers: [
    AuthorizedFixtureController,
    PublicFixtureController,
    AuthenticatedOnlyFixtureController,
  ],
})
class ValidFixtureModule {}

@Controller('unmarked')
class UnmarkedFixtureController {
  @Get()
  read(): void {}
}

@Module({ controllers: [UnmarkedFixtureController] })
class UnmarkedFixtureModule {}

@Controller('unknown-permission')
class UnknownPermissionFixtureController {
  @Get()
  @Authorize('booking', 'archive')
  archive(): void {}
}

@Module({ controllers: [UnknownPermissionFixtureController] })
class UnknownPermissionFixtureModule {}

function build(
  fixture: Type<unknown> | DynamicModule,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [DiscoveryModule, fixture],
    providers: [RoutePolicyRegistry],
  }).compile();
}

describe('RoutePolicyRegistry', () => {
  it('descubre rutas en módulos anidados y clasifica cada marcador', async () => {
    const moduleRef = await build(ValidFixtureModule);
    await moduleRef.init();

    const routes = moduleRef.get(RoutePolicyRegistry).inventory();
    const byPath = new Map(routes.map((route) => [route.path, route]));

    expect(byPath.get('/authorized')).toMatchObject({
      policy: 'authorize',
      permission: 'booking:read',
      httpMethod: 'GET',
    });
    expect(byPath.get('/public')).toMatchObject({ policy: 'public' });
    expect(byPath.get('/identity')).toMatchObject({
      policy: 'authenticated-only',
    });
    expect(byPath.get('/nested')).toMatchObject({
      policy: 'authorize',
      permission: 'space:read',
    });
    expect(routes.every((route) => route.policy !== 'missing')).toBe(true);

    await moduleRef.close();
  });

  it('aborta el arranque si un controlador privado no declara política', async () => {
    const moduleRef = await build(UnmarkedFixtureModule);

    await expect(moduleRef.init()).rejects.toThrow(
      /GET \/unmarked \(UnmarkedFixtureController\.read\) is private but has no @Authorize, @Public or @AuthenticatedOnly marker/,
    );
  });

  it('aborta el arranque si @Authorize usa un código fuera del catálogo', async () => {
    const moduleRef = await build(UnknownPermissionFixtureModule);

    await expect(moduleRef.init()).rejects.toThrow(
      /GET \/unknown-permission \(UnknownPermissionFixtureController\.archive\) declares permission "booking:archive" which is not in PERMISSION_CATALOG/,
    );
  });
});
