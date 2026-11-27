import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error';
import type { QueryPlan } from './authorization.types';
import { PLAN_KIND } from './authorization.types';

const DEFAULT_CERBOS_URL = 'http://127.0.0.1:3592';
const DEFAULT_TIMEOUT_MS = 200;
const CHECK_RESOURCES_PATH = '/api/check/resources';
const PLAN_RESOURCES_PATH = '/api/plan/resources';

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

/**
 * Raw Cerbos check response. Effects are interpreted by `CerbosClient` so any
 * unknown/missing decision can fail closed with a 503.
 */
export interface CerbosCheckResourcesResponse {
  results?: Array<{
    actions?: Record<string, unknown>;
  }>;
}

/**
 * Subset of the Cerbos HTTP API used by this adapter. The production
 * implementation uses native `fetch` (Node 22); tests inject a fake.
 */
export interface CerbosTransport {
  checkResources(
    request: {
      requestId?: string;
      principal: CerbosPrincipal;
      resources: Array<{ resource: CerbosResource; actions: string[] }>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<CerbosCheckResourcesResponse>;

  planResources(
    request: {
      requestId?: string;
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
  /** Test seam; production uses `FetchCerbosTransport`. */
  transport?: CerbosTransport;
}

export const CERBOS_CLIENT_OPTIONS = Symbol('CERBOS_CLIENT_OPTIONS');

type FetchLike = typeof fetch;

/**
 * Native `fetch` transport for the Cerbos REST API.
 *
 * The `@cerbos/http` SDK is ESM-only and cannot be loaded from this CommonJS
 * runtime with `require`, so the adapter talks to the documented HTTP
 * endpoints directly.
 */
export class FetchCerbosTransport implements CerbosTransport {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn?: FetchLike,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async checkResources(
    request: {
      requestId?: string;
      principal: CerbosPrincipal;
      resources: Array<{ resource: CerbosResource; actions: string[] }>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<CerbosCheckResourcesResponse> {
    const body = await this.post(
      CHECK_RESOURCES_PATH,
      {
        requestId: request.requestId ?? randomUUID(),
        principal: request.principal,
        resources: request.resources,
      },
      options,
    );

    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new Error('Malformed Cerbos checkResources response');
    }

    const result = body.results[0];
    if (!isRecord(result) || !isRecord(result.actions)) {
      throw new Error('Malformed Cerbos checkResources result');
    }

    return { results: [{ actions: result.actions }] };
  }

  async planResources(
    request: {
      requestId?: string;
      principal: CerbosPrincipal;
      resource: { kind: string };
      action: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<QueryPlan> {
    const body = await this.post(
      PLAN_RESOURCES_PATH,
      {
        requestId: request.requestId ?? randomUUID(),
        principal: request.principal,
        resource: { kind: request.resource.kind },
        action: request.action,
      },
      options,
    );

    if (!isRecord(body) || !isRecord(body.filter)) {
      throw new Error('Malformed Cerbos planResources response');
    }

    const filter = body.filter;
    const kind = filter.kind;
    if (!isPlanKind(kind)) {
      throw new Error('Unknown Cerbos plan kind');
    }

    const metadata = {
      ...(typeof body.cerbosCallId === 'string'
        ? { cerbosCallId: body.cerbosCallId }
        : {}),
      ...(typeof body.requestId === 'string'
        ? { requestId: body.requestId }
        : {}),
    };

    if (kind === PLAN_KIND.CONDITIONAL) {
      if (filter.condition === undefined || filter.condition === null) {
        throw new Error('Conditional Cerbos plan without condition');
      }

      return { kind, condition: filter.condition, ...metadata };
    }

    return { kind, ...metadata };
  }

  private async post(
    path: string,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      throw new Error('Global fetch is not available');
    }

    const response = await fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Cerbos request to ${path} failed with status ${response.status}`,
      );
    }

    return response.json();
  }
}

@Injectable()
export class CerbosClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly transport: CerbosTransport;

  constructor(
    @Optional()
    @Inject(CERBOS_CLIENT_OPTIONS)
    options: CerbosClientOptions = {},
  ) {
    this.url = options.url ?? process.env.CERBOS_URL ?? DEFAULT_CERBOS_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport ?? new FetchCerbosTransport(this.url);
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
      this.transport.checkResources(
        {
          principal,
          resources: [{ resource, actions: [action] }],
        },
        { signal },
      ),
    );

    const effect = response?.results?.[0]?.actions?.[action];
    if (effect === 'EFFECT_ALLOW') return true;
    if (effect === 'EFFECT_DENY') return false;

    throw this.unavailable();
  }

  /** Query plan used by list endpoints (fed to `@cerbos/orm-prisma`). */
  async plan(
    principal: CerbosPrincipal,
    resourceKind: string,
    action: string,
  ): Promise<QueryPlan> {
    const plan = await this.execute((signal) =>
      this.transport.planResources(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
