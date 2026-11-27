import { Inject, Injectable, Optional } from '@nestjs/common';
import { createRequire } from 'node:module';
import { AppError } from '../errors/app-error';
import type { QueryPlan } from './authorization.types';
import { PLAN_KIND } from './authorization.types';

const DEFAULT_CERBOS_URL = 'http://127.0.0.1:3592';
const DEFAULT_TIMEOUT_MS = 200;

/** JSON-serializable attributes only; no PII is added by this layer. */
export interface CerbosPrincipal {
  id: string;
  roles: string[];
  attr?: Record<string, unknown>;
}

export interface CerbosResource {
  kind: string;
  id: string;
  attr?: Record<string, unknown>;
}

export interface CerbosCheckResourcesResponse {
  results?: Array<{
    isAllowed(action: string): boolean | undefined;
  }>;
}

/**
 * Subset of the `@cerbos/http` client used by this adapter. Keeping the
 * interface local avoids importing the ESM-only SDK into this CommonJS build
 * (the project's tsconfig uses `moduleResolution: node10`).
 */
export interface CerbosTransport {
  checkResources(
    request: {
      principal: CerbosPrincipal;
      resources: Array<{ resource: CerbosResource; actions: string[] }>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<CerbosCheckResourcesResponse>;

  planResources(
    request: {
      principal: CerbosPrincipal;
      resource: { kind: string };
      action: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<QueryPlan>;
}

export interface CerbosClientOptions {
  url?: string;
  timeoutMs?: number;
  /** Test seam; production loads `@cerbos/http` lazily. */
  transport?: CerbosTransport;
}

export const CERBOS_CLIENT_OPTIONS = Symbol('CERBOS_CLIENT_OPTIONS');

const requireModule = createRequire(__filename);

@Injectable()
export class CerbosClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private transport?: CerbosTransport;

  constructor(
    @Optional()
    @Inject(CERBOS_CLIENT_OPTIONS)
    options: CerbosClientOptions = {},
  ) {
    this.url = options.url ?? process.env.CERBOS_URL ?? DEFAULT_CERBOS_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport;
  }

  /**
   * Single-resource check. Returns `false` only for an explicit Cerbos DENY;
   * malformed responses and transport failures fail closed with a 503.
   */
  async check(
    principal: CerbosPrincipal,
    resource: CerbosResource,
    action: string,
  ): Promise<boolean> {
    const response = await this.execute((signal) =>
      this.getTransport().checkResources(
        {
          principal,
          resources: [{ resource, actions: [action] }],
        },
        { signal },
      ),
    );

    const result = response?.results?.[0];
    if (!result) {
      throw this.unavailable();
    }

    const allowed = result.isAllowed(action);
    if (allowed === undefined) {
      throw this.unavailable();
    }

    return allowed;
  }

  /** Query plan used by list endpoints (fed to `@cerbos/orm-prisma`). */
  async plan(
    principal: CerbosPrincipal,
    resourceKind: string,
    action: string,
  ): Promise<QueryPlan> {
    const plan = await this.execute((signal) =>
      this.getTransport().planResources(
        {
          principal,
          resource: { kind: resourceKind },
          action,
        },
        { signal },
      ),
    );

    if (!plan || !isPlanKind(plan.kind)) {
      throw this.unavailable();
    }

    if (plan.kind === PLAN_KIND.CONDITIONAL && plan.condition === undefined) {
      throw this.unavailable();
    }

    return plan;
  }

  private getTransport(): CerbosTransport {
    if (this.transport) return this.transport;

    try {
      const module = requireModule('@cerbos/http') as {
        HTTP?: new (url: string) => CerbosTransport;
      };

      if (typeof module.HTTP !== 'function') {
        throw new Error('@cerbos/http does not export HTTP');
      }

      this.transport = new module.HTTP(this.url);
      return this.transport;
    } catch {
      // Do not cache the failure: a later call may succeed after the runtime
      // or configuration is fixed.
      throw this.unavailable();
    }
  }

  private async execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Cerbos request timed out'));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw this.unavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private unavailable(): AppError {
    return new AppError(
      503,
      'AUTHORIZATION_UNAVAILABLE',
      'El servicio de autorización no está disponible. Intenta de nuevo más tarde.',
    );
  }
}

function isPlanKind(value: unknown): value is QueryPlan['kind'] {
  return (
    value === PLAN_KIND.ALWAYS_ALLOWED ||
    value === PLAN_KIND.ALWAYS_DENIED ||
    value === PLAN_KIND.CONDITIONAL
  );
}
