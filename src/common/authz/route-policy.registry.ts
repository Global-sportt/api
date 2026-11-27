import {
  Injectable,
  OnApplicationBootstrap,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  AUTHORIZE_METADATA_KEY,
  type AuthorizeMetadata,
} from './authorize.decorator';
import { AUTHENTICATED_ONLY_METADATA_KEY } from './authenticated-only.decorator';
import { PERMISSION_CODES } from './permissions';

export type RoutePolicy =
  | 'authorize'
  | 'public'
  | 'authenticated-only'
  | 'missing';

export interface RegisteredRoute {
  /** HTTP verb, e.g. `GET`; `ALL` for `@All()`. */
  httpMethod: string;
  /** Controller + handler path without the global API prefix. */
  path: string;
  controller: string;
  handler: string;
  policy: RoutePolicy;
  /** Catalogue code when `policy === 'authorize'`. */
  permission?: string;
}

interface ScanResult {
  routes: RegisteredRoute[];
  violations: string[];
}

const PERMISSION_CODE_SET = new Set<string>(PERMISSION_CODES);

/**
 * Startup guard against opt-in authorization.
 *
 * Nest only applies `AuthorizationGuard` where a controller declares it, so a
 * new private controller can otherwise ship with no `@Authorize`. This
 * registry discovers every controller registered in the module graph (not a
 * hand-maintained list) and aborts application startup when a route has no
 * explicit policy:
 *
 * - `@Authorize(...)`: Cerbos check (permission must exist in the catalogue).
 * - `@Public()`: unauthenticated by design.
 * - `@AuthenticatedOnly()`: valid access token only (identity/self-service).
 *
 * The registry does not enforce requests at runtime; `JwtAuthGuard` and
 * `AuthorizationGuard` keep doing that. It only prevents an unmarked route
 * from being deployed unnoticed.
 */
@Injectable()
export class RoutePolicyRegistry implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    this.validate();
  }

  /**
   * Returns every discovered route with its declared policy. Missing policies
   * are included so tests/diagnostics can report them; use `validate()` to
   * assert a deployable state.
   */
  inventory(): readonly RegisteredRoute[] {
    return this.scan().routes;
  }

  validate(): readonly RegisteredRoute[] {
    const { routes, violations } = this.scan();

    if (violations.length > 0) {
      throw new Error(
        [
          'Route policy registry rejected the application startup:',
          ...violations.map((violation) => `- ${violation}`),
        ].join('\n'),
      );
    }

    return routes;
  }

  private scan(): ScanResult {
    const routes: RegisteredRoute[] = [];
    const violations: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype as Type<unknown> | null;
      if (!metatype) continue;

      const prototype = metatype.prototype as object | undefined;
      if (!prototype) continue;

      const controllerPaths = readPaths(
        Reflect.getMetadata(PATH_METADATA, metatype),
      );

      for (const handlerName of this.metadataScanner.getAllMethodNames(
        prototype,
      )) {
        const handler = (prototype as Record<string, unknown>)[handlerName];
        if (typeof handler !== 'function') continue;

        const handlerPathMetadata = Reflect.getMetadata(
          PATH_METADATA,
          handler,
        );
        if (handlerPathMetadata === undefined) continue;

        const handlerPaths = readPaths(handlerPathMetadata);
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler);
        const httpMethod =
          typeof requestMethod === 'number'
            ? (RequestMethod[requestMethod] ?? 'UNKNOWN')
            : 'UNKNOWN';

        const isPublic =
          this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            handler,
            metatype,
          ]) === true;
        const authorize = this.reflector.getAllAndOverride<
          AuthorizeMetadata | undefined
        >(AUTHORIZE_METADATA_KEY, [handler, metatype]);
        const isAuthenticatedOnly =
          this.reflector.getAllAndOverride<boolean>(
            AUTHENTICATED_ONLY_METADATA_KEY,
            [handler, metatype],
          ) === true;

        const markers = [
          isPublic ? '@Public' : undefined,
          authorize ? '@Authorize' : undefined,
          isAuthenticatedOnly ? '@AuthenticatedOnly' : undefined,
        ].filter((marker): marker is string => marker !== undefined);

        const policy: RoutePolicy = isPublic
          ? 'public'
          : authorize
            ? 'authorize'
            : isAuthenticatedOnly
              ? 'authenticated-only'
              : 'missing';

        const location = `${metatype.name}.${handlerName}`;
        const paths =
          controllerPaths.length > 0 && handlerPaths.length > 0
            ? controllerPaths.flatMap((controllerPath) =>
                handlerPaths.map((handlerPath) =>
                  joinPaths(controllerPath, handlerPath),
                ),
              )
            : [joinPaths(controllerPaths[0] ?? '', handlerPaths[0] ?? '')];

        for (const path of paths) {
          const display = `${httpMethod} ${path} (${location})`;

          if (markers.length > 1) {
            violations.push(
              `${display} declares conflicting route markers: ${markers.join(', ')}`,
            );
          } else if (policy === 'missing') {
            violations.push(
              `${display} is private but has no @Authorize, @Public or @AuthenticatedOnly marker`,
            );
          } else if (policy === 'authorize' && !authorize) {
            // Defensive: unreachable with the policy derivation above.
            violations.push(`${display} has no @Authorize metadata`);
          } else if (
            policy === 'authorize' &&
            authorize &&
            !PERMISSION_CODE_SET.has(authorize.permission)
          ) {
            violations.push(
              `${display} declares permission "${authorize.permission}" which is not in PERMISSION_CATALOG`,
            );
          }

          routes.push({
            httpMethod,
            path,
            controller: metatype.name,
            handler: handlerName,
            policy,
            ...(authorize ? { permission: authorize.permission } : {}),
          });
        }
      }
    }

    if (routes.length === 0) {
      violations.push(
        'no controller routes were discovered; the route policy registry cannot validate authorization coverage',
      );
    }

    return { routes, violations };
  }
}

function readPaths(metadata: unknown): string[] {
  if (typeof metadata === 'string') return [metadata];
  if (Array.isArray(metadata)) {
    return metadata.filter(
      (value): value is string => typeof value === 'string',
    );
  }
  return [];
}

function joinPaths(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .filter((segment) => segment.length > 0)
    .join('/')
    .split('/')
    .filter((segment) => segment.length > 0);

  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}
