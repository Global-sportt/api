/**
 * T1a — evidencia local de OAuth/OIDC sin red, sin credenciales de Google y
 * sin base de datos.
 *
 * El spec ejercita OAuthService de punta a punta con:
 *  - un store en memoria para `oauth_states` (mock de Prisma);
 *  - el endpoint de token de Google mockeado (fetch global);
 *  - el JWKS de Google mockeado (par RSA generado en el proceso).
 *
 * Es una prueba de integración del servicio, no un e2e HTTP contra Postgres.
 * Al final se agregan pruebas directas de AuthController + AuthCookiesService
 * para verificar el Set-Cookie del binding GAP-1 sin levantar la app.
 *
 * Ejecutar:
 *   npx jest --config test/jest-e2e.json test/oauth.e2e-spec.ts
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { AuthEventType, UserStatus } from '@prisma/client';
import type { RequestMetadata } from '../src/common/http/request-metadata';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  sha256,
  sha256Base64Url,
} from '../src/common/utils/crypto.util';
import { AuthController } from '../src/modules/auth/auth.controller';
import { OAUTH_STATE_COOKIE } from '../src/modules/auth/auth.constants';
import { AuthCookiesService } from '../src/modules/auth/services/auth-cookies.service';
import {
  OAuthCallbackError,
  OAuthService,
} from '../src/modules/auth/services/oauth.service';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'client-secret';
const REDIRECT_URI =
  'http://localhost:3000/api/v1/auth/oauth/google/callback';
const WEB_APP_URL = 'http://localhost:5173';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KID = 'test-kid';

const META: RequestMetadata = {
  requestId: 'req-oauth-test',
  ipHash: 'ip-hash-test',
  userAgent: 'jest',
};

interface OAuthStateRow {
  id: string;
  stateHash: string;
  provider: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface BuildOptions {
  googleConfigured?: boolean;
  existingAccount?: boolean;
  rows?: OAuthStateRow[];
}

function makeKeys(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const keys = makeKeys();
const attackerKeys = makeKeys();

function basePayload(
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: 'google-sub-1',
    email: 'person@example.com',
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...payload,
  };
}

function signIdToken(
  privatePem: string,
  payload: Record<string, unknown> = {},
  options: SignOptions = {},
): string {
  const algorithm = options.algorithm ?? 'RS256';
  return jwt.sign(
    basePayload(payload),
    algorithm === 'HS256' ? CLIENT_SECRET : privatePem,
    { algorithm, keyid: KID, ...options },
  );
}

/** Firma un JWT RS256 válido pero sin `kid` en el header. */
function signIdTokenWithoutKid(
  privatePem: string,
  payload: Record<string, unknown> = {},
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const body = encode(basePayload(payload));
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${body}`)
    .sign(privatePem, 'base64url');
  return `${header}.${body}.${signature}`;
}

function buildService(options: BuildOptions = {}) {
  const rows = options.rows ?? [];
  let sequence = rows.length;

  const prisma = {
    oAuthState: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<OAuthStateRow, 'id' | 'consumedAt' | 'createdAt'>;
        }) => {
          const row: OAuthStateRow = {
            id: `state-${++sequence}`,
            consumedAt: null,
            createdAt: new Date(),
            ...data,
          };
          rows.push(row);
          return row;
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { stateHash: string } }) =>
          rows.find((row) => row.stateHash === where.stateHash) ?? null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; consumedAt: null };
          data: { consumedAt: Date };
        }) => {
          const row = rows.find(
            (candidate) =>
              candidate.id === where.id && candidate.consumedAt === null,
          );
          if (!row) return { count: 0 };
          row.consumedAt = data.consumedAt;
          return { count: 1 };
        },
      ),
    },
  };

  const config = {
    googleOAuth:
      options.googleConfigured === false
        ? null
        : {
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUri: REDIRECT_URI,
          },
    env: { WEB_APP_URL },
  } as unknown as AppConfigService;

  const user = {
    id: 'user-1',
    email: 'person@example.com',
    status: UserStatus.active,
  };
  const users = {
    findOAuthAccount: jest.fn(async () =>
      options.existingAccount === false ? null : user,
    ),
    findByEmail: jest.fn(async () => null),
    createOAuthUser: jest.fn(async () => user),
    linkOAuthAccount: jest.fn(async () => undefined),
    markEmailVerified: jest.fn(async () => undefined),
    updateOAuthLogin: jest.fn(async () => undefined),
  };

  const refreshExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const sessions = {
    createSession: jest.fn(async () => ({
      refreshToken: 'v1.test-session.refresh-secret',
      refreshTokenExpiresAt: refreshExpiresAt,
    })),
  };
  const events = { record: jest.fn(async () => undefined) };
  const logger = { raw: { warn: jest.fn() } };

  const service = new OAuthService(
    prisma as never,
    config,
    users as never,
    sessions as never,
    events as never,
    logger as never,
  );

  return {
    service,
    prisma,
    users,
    sessions,
    events,
    logger,
    rows,
    user,
  };
}

function mockJwks(service: OAuthService, publicPem: string) {
  const internals = service as unknown as {
    jwks: {
      getSigningKey: (
        kid: string,
        callback: (
          error: Error | null,
          key?: { getPublicKey(): string },
        ) => void,
      ) => void;
    };
  };
  return jest
    .spyOn(internals.jwks, 'getSigningKey')
    .mockImplementation((requestedKid, callback) => {
      if (requestedKid !== KID) {
        callback(new Error('unknown kid'));
        return;
      }
      callback(null, { getPublicKey: () => publicPem });
    });
}

function mockTokenEndpoint(body: unknown, ok = true) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    json: async () => body,
  } as unknown as Response);
}

async function startFlow(
  service: OAuthService,
  returnTo = '/auth/callback',
): Promise<{
  url: URL;
  state: string;
  nonce: string;
  stateHash: string;
  authorization: { url: string; stateHash: string };
}> {
  const authorization = await service.buildAuthorizationUrl(returnTo);
  const url = new URL(authorization.url);
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  expect(state).toEqual(expect.any(String));
  expect(nonce).toEqual(expect.any(String));
  expect(authorization.stateHash).toBe(sha256(state as string));
  return {
    url,
    state: state as string,
    nonce: nonce as string,
    stateHash: authorization.stateHash,
    authorization,
  };
}

function fakeResponse() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
}

function fakeRequest(cookies: Record<string, string> = {}) {
  return {
    id: 'req-oauth-http',
    headers: {},
    cookies,
  } as unknown as ExpressRequest;
}

async function expectCallbackError(
  promise: Promise<unknown>,
  reason: string,
): Promise<URL> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OAuthCallbackError);
  const redirect = new URL((error as OAuthCallbackError).redirectUrl);
  expect(redirect.searchParams.get('oauth')).toBe('error');
  expect(redirect.searchParams.get('reason')).toBe(reason);
  return redirect;
}

describe('OAuthService (T1a: mock JWKS, sin red ni Google)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('authorization request', () => {
    it('usa authorization code + PKCE S256, state y nonce de un solo uso', async () => {
      const { service, rows } = buildService();
      const { url, state, nonce } = await startFlow(service);

      expect(`${url.origin}${url.pathname}`).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('prompt')).toBe('select_account');

      // El client_secret nunca viaja en la URL de autorización.
      expect(url.searchParams.has('client_secret')).toBe(false);

      const row = rows.at(-1) as OAuthStateRow;
      expect(row.provider).toBe('google');
      expect(row.returnTo).toBe('/auth/callback');
      expect(row.stateHash).toBe(sha256(state));
      expect(row.stateHash).not.toBe(state);
      expect(row.nonce).toBe(nonce);
      expect(row.codeVerifier).toHaveLength(64);
      expect(url.searchParams.get('code_challenge')).toBe(
        sha256Base64Url(row.codeVerifier),
      );
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('normaliza return_to y descarta destinos absolutos o peligrosos', async () => {
      const { service, rows } = buildService();

      await service.buildAuthorizationUrl('https://sitio-malicioso.example');
      expect((rows.at(-1) as OAuthStateRow).returnTo).toBe('/auth/callback');

      await service.buildAuthorizationUrl('//sitio-malicioso.example');
      expect((rows.at(-1) as OAuthStateRow).returnTo).toBe('/auth/callback');

      await service.buildAuthorizationUrl('/mis-reservas?tab=proximas');
      expect((rows.at(-1) as OAuthStateRow).returnTo).toBe(
        '/mis-reservas?tab=proximas',
      );

      await service.buildAuthorizationUrl(`/${'a'.repeat(600)}`);
      expect((rows.at(-1) as OAuthStateRow).returnTo).toBe('/auth/callback');
    });
  });

  describe('state', () => {
    it('consume el state una sola vez y rechaza el replay sin llamar a Google', async () => {
      const { service, sessions, rows } = buildService();
      const { state, nonce, stateHash } = await startFlow(service);
      const fetchMock = mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, { nonce }),
      });
      mockJwks(service, keys.publicPem);

      await service.handleCallback(
        { code: 'auth-code', state },
        META,
        stateHash,
      );

      const redirect = await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state },
          META,
          stateHash,
        ),
        'invalid_state',
      );

      expect(redirect.pathname).toBe('/auth/callback');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sessions.createSession).toHaveBeenCalledTimes(1);
      expect((rows.at(-1) as OAuthStateRow).consumedAt).toBeInstanceOf(Date);
    });

    it('rechaza un state desconocido, expirado o de otro proveedor', async () => {
      const { service, rows } = buildService();
      const fetchMock = mockTokenEndpoint({ id_token: 'no-deberia-usarse' });

      await expectCallbackError(
        service.handleCallback(
          { code: 'x', state: 'state-desconocido' },
          META,
          sha256('state-desconocido'),
        ),
        'invalid_state',
      );

      const expired = await startFlow(service);
      (rows.at(-1) as OAuthStateRow).expiresAt = new Date(Date.now() - 1000);
      await expectCallbackError(
        service.handleCallback(
          { code: 'x', state: expired.state },
          META,
          expired.stateHash,
        ),
        'invalid_state',
      );

      const foreign = await startFlow(service);
      (rows.at(-1) as OAuthStateRow).provider = 'github';
      await expectCallbackError(
        service.handleCallback(
          { code: 'x', state: foreign.state },
          META,
          foreign.stateHash,
        ),
        'invalid_state',
      );

      const oversized = 'a'.repeat(513);
      await expectCallbackError(
        service.handleCallback(
          { code: 'x', state: oversized },
          META,
          sha256(oversized),
        ),
        'invalid_state',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rechaza la carrera entre dos callbacks que consumen el mismo state', async () => {
      const { service, prisma } = buildService();
      const { state, stateHash } = await startFlow(service);
      mockTokenEndpoint({ id_token: 'no-deberia-usarse' });

      prisma.oAuthState.updateMany.mockResolvedValueOnce({ count: 0 });

      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state },
          META,
          stateHash,
        ),
        'invalid_state',
      );
    });

    it('usa el return_to guardado en el redirect de error', async () => {
      const { service } = buildService();
      const { state, stateHash } = await startFlow(service, '/mis-reservas');

      const redirect = await expectCallbackError(
        service.handleCallback(
          { state, error: 'access_denied' },
          META,
          stateHash,
        ),
        'access_denied',
      );

      expect(`${redirect.origin}${redirect.pathname}`).toBe(
        'http://localhost:5173/mis-reservas',
      );
    });

    it('rechaza el callback sin cookie de binding y no consume el state', async () => {
      const { service, rows, sessions, events } = buildService();
      const { state } = await startFlow(service);
      const fetchMock = mockTokenEndpoint({ id_token: 'no-deberia-usarse' });

      const redirect = await expectCallbackError(
        service.handleCallback({ code: 'auth-code', state }, META),
        'oauth_failed',
      );

      expect(`${redirect.origin}${redirect.pathname}`).toBe(
        'http://localhost:5173/auth/callback',
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessions.createSession).not.toHaveBeenCalled();
      expect((rows.at(-1) as OAuthStateRow).consumedAt).toBeNull();
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_failed,
          metadata: { provider: 'google', reason: 'state_binding_missing' },
        }),
      );
    });

    it('rechaza el callback con una cookie de binding distinta', async () => {
      const { service, rows, sessions, events } = buildService();
      const { state } = await startFlow(service);
      const fetchMock = mockTokenEndpoint({ id_token: 'no-deberia-usarse' });

      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state },
          META,
          sha256('otro-state'),
        ),
        'oauth_failed',
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessions.createSession).not.toHaveBeenCalled();
      expect((rows.at(-1) as OAuthStateRow).consumedAt).toBeNull();
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_failed,
          metadata: { provider: 'google', reason: 'state_binding_mismatch' },
        }),
      );
    });
  });

  describe('callback', () => {
    it('intercambia el code con PKCE, valida el ID token y no expone tokens en la URL', async () => {
      const { service, rows, users, sessions, events, user } = buildService();
      const { state, nonce, stateHash } = await startFlow(
        service,
        '/mis-reservas',
      );
      const row = rows.at(-1) as OAuthStateRow;
      const fetchMock = mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, { nonce }),
      });
      mockJwks(service, keys.publicPem);

      const result = await service.handleCallback(
        { code: 'auth-code', state },
        META,
        stateHash,
      );

      // El redirect solo contiene el resultado; los tokens van por cookie.
      expect(result.redirectUrl).toBe(
        'http://localhost:5173/mis-reservas?oauth=success',
      );
      const redirect = new URL(result.redirectUrl);
      expect([...redirect.searchParams.keys()]).toEqual(['oauth']);
      for (const forbidden of [
        'access_token',
        'refresh_token',
        'id_token',
        'token',
        'code',
        'state',
      ]) {
        expect(redirect.searchParams.has(forbidden)).toBe(false);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [tokenUrl, init] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe(TOKEN_URL);
      expect((init as RequestInit).method).toBe('POST');
      const body = new URLSearchParams(String((init as RequestInit).body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('code_verifier')).toBe(row.codeVerifier);
      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('client_secret')).toBe(CLIENT_SECRET);
      expect(body.get('redirect_uri')).toBe(REDIRECT_URI);

      expect(users.findOAuthAccount).toHaveBeenCalledWith(
        'google',
        'google-sub-1',
      );
      expect(sessions.createSession).toHaveBeenCalledWith(user, META);
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_succeeded,
          userId: user.id,
        }),
      );
      expect(result.refreshToken).toBe('v1.test-session.refresh-secret');
      expect(result.csrfToken).toEqual(expect.any(String));
      expect(row.consumedAt).toBeInstanceOf(Date);
    });

    it('rechaza un nonce distinto como oauth_failed, no como email_unverified', async () => {
      const { service, sessions, events } = buildService();
      const { state, stateHash } = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, { nonce: 'nonce-ajeno' }),
      });
      mockJwks(service, keys.publicPem);

      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state },
          META,
          stateHash,
        ),
        'oauth_failed',
      );
      expect(sessions.createSession).not.toHaveBeenCalled();
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_failed,
          metadata: { provider: 'google', reason: 'invalid_nonce' },
        }),
      );
    });

    it('exige email_verified y acepta la variante string "true" de Google', async () => {
      const { service } = buildService();
      const asString = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, {
          nonce: asString.nonce,
          email_verified: 'true',
        }),
      });
      mockJwks(service, keys.publicPem);
      await expect(
        service.handleCallback(
          { code: 'auth-code', state: asString.state },
          META,
          asString.stateHash,
        ),
      ).resolves.toMatchObject({
        redirectUrl: 'http://localhost:5173/auth/callback?oauth=success',
      });

      const unverified = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, {
          nonce: unverified.nonce,
          email_verified: false,
        }),
      });
      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: unverified.state },
          META,
          unverified.stateHash,
        ),
        'email_unverified',
      );
    });

    it('distingue nonce inválido de claims inválidos y de email no verificado', async () => {
      const { service, events } = buildService();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ nonce: undefined }, 'invalid_nonce'],
        [{ sub: undefined }, 'invalid_claims'],
        [{ email: undefined }, 'invalid_claims'],
      ];

      for (const [overrides, reason] of cases) {
        const flow = await startFlow(service);
        mockTokenEndpoint({
          id_token: signIdToken(keys.privatePem, {
            nonce: flow.nonce,
            ...overrides,
          }),
        });
        mockJwks(service, keys.publicPem);
        await expectCallbackError(
          service.handleCallback(
            { code: 'auth-code', state: flow.state },
            META,
            flow.stateHash,
          ),
          'oauth_failed',
        );
        expect(events.record).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: AuthEventType.oauth_login_failed,
            metadata: { provider: 'google', reason },
          }),
        );
      }
    });

    it('rechaza firma inválida, algoritmo distinto y kid desconocido', async () => {
      const { service, sessions } = buildService();

      const badSignature = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(attackerKeys.privatePem, {
          nonce: badSignature.nonce,
        }),
      });
      mockJwks(service, keys.publicPem);
      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: badSignature.state },
          META,
          badSignature.stateHash,
        ),
        'oauth_failed',
      );

      const hs256 = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, { nonce: hs256.nonce }, {
          algorithm: 'HS256',
        }),
      });      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: hs256.state },
          META,
          hs256.stateHash,
        ),
        'oauth_failed',
      );

      const unknownKid = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(
          keys.privatePem,
          { nonce: unknownKid.nonce },
          { keyid: 'kid-desconocido' },
        ),
      });
      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: unknownKid.state },
          META,
          unknownKid.stateHash,
        ),
        'oauth_failed',
      );

      expect(sessions.createSession).not.toHaveBeenCalled();
    });

    it('rechaza iss, aud, azp y exp inválidos', async () => {
      const { service } = buildService();
      const now = Math.floor(Date.now() / 1000);

      const cases: Array<[string, Record<string, unknown>]> = [
        ['issuer', { iss: 'https://sitio-malicioso.example' }],
        ['audience', { aud: 'otro-cliente' }],
        ['azp', { azp: 'otro-cliente' }],
        ['expiración', { exp: now - 300 }],
      ];

      for (const [, overrides] of cases) {
        const flow = await startFlow(service);
        mockTokenEndpoint({
          id_token: signIdToken(keys.privatePem, {
            nonce: flow.nonce,
            ...overrides,
          }),
        });
        mockJwks(service, keys.publicPem);
        await expectCallbackError(
          service.handleCallback(
            { code: 'auth-code', state: flow.state },
            META,
            flow.stateHash,
          ),
          'oauth_failed',
        );
      }
    });

    it('acepta un ID token sin azp cuando aud coincide', async () => {
      const { service } = buildService();
      const flow = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, {
          nonce: flow.nonce,
          azp: undefined,
        }),
      });
      mockJwks(service, keys.publicPem);

      await expect(
        service.handleCallback(
          { code: 'auth-code', state: flow.state },
          META,
          flow.stateHash,
        ),
      ).resolves.toMatchObject({
        redirectUrl: 'http://localhost:5173/auth/callback?oauth=success',
      });
    });

    it('rechaza un token sin kid antes de consultar el JWKS', async () => {
      const { service } = buildService();
      const flow = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdTokenWithoutKid(keys.privatePem, {
          nonce: flow.nonce,
        }),
      });
      const jwks = mockJwks(service, keys.publicPem);

      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: flow.state },
          META,
          flow.stateHash,
        ),
        'oauth_failed',
      );
      expect(jwks).not.toHaveBeenCalled();
    });

    it('resuelve el usuario, crea sesión y registra el evento', async () => {
      const { service, users, sessions, events, user } = buildService();
      const flow = await startFlow(service);
      mockTokenEndpoint({
        id_token: signIdToken(keys.privatePem, { nonce: flow.nonce }),
      });
      mockJwks(service, keys.publicPem);

      await service.handleCallback(
        { code: 'auth-code', state: flow.state },
        META,
        flow.stateHash,
      );

      expect(users.updateOAuthLogin).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          provider: 'google',
          providerAccountId: 'google-sub-1',
        }),
      );
      expect(sessions.createSession).toHaveBeenCalledTimes(1);
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_succeeded,
          identifier: user.email,
          metadata: { provider: 'google' },
        }),
      );
    });
  });

  describe('token endpoint y configuración', () => {
    it('falla cerrado si Google rechaza el code o no devuelve id_token', async () => {
      const { service, sessions, events } = buildService();

      const rejected = await startFlow(service);
      mockTokenEndpoint({ error: 'invalid_grant' }, false);
      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: rejected.state },
          META,
          rejected.stateHash,
        ),
        'oauth_failed',
      );

      const incomplete = await startFlow(service);
      mockTokenEndpoint({});
      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: incomplete.state },
          META,
          incomplete.stateHash,
        ),
        'oauth_failed',
      );

      expect(sessions.createSession).not.toHaveBeenCalled();
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_failed,
          metadata: { provider: 'google', reason: 'token_exchange_failed' },
        }),
      );
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AuthEventType.oauth_login_failed,
          metadata: { provider: 'google', reason: 'invalid_response' },
        }),
      );
    });

    it('mapea un fallo de red a oauth_failed sin romper el callback', async () => {
      const { service } = buildService();
      const flow = await startFlow(service);
      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network down'));

      await expectCallbackError(
        service.handleCallback(
          { code: 'auth-code', state: flow.state },
          META,
          flow.stateHash,
        ),
        'oauth_failed',
      );
    });

    it('responde 503 OAUTH_NOT_CONFIGURED sin consumir state', async () => {
      const { service, prisma } = buildService({ googleConfigured: false });

      await expect(
        service.buildAuthorizationUrl('/auth/callback'),
      ).rejects.toMatchObject({ code: 'OAUTH_NOT_CONFIGURED', status: 503 });

      await expect(
        service.handleCallback(
          { code: 'auth-code', state: 'state-cualquiera' },
          META,
        ),
      ).rejects.toMatchObject({ code: 'OAUTH_NOT_CONFIGURED', status: 503 });

      expect(prisma.oAuthState.findUnique).not.toHaveBeenCalled();
      expect(prisma.oAuthState.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('cookie httpOnly de binding (controller + AuthCookiesService)', () => {
    function buildController() {
      const config = {
        env: { API_PREFIX: 'api/v1', COOKIE_DOMAIN: '' },
        cookieSecure: true,
        cookieSameSite: 'lax',
      } as unknown as AppConfigService;
      const oauth = {
        buildAuthorizationUrl: jest.fn(),
        handleCallback: jest.fn(),
        redirectToError: jest.fn(
          (reason: string) =>
            `http://localhost:5173/auth/callback?oauth=error&reason=${reason}`,
        ),
      };
      const cookies = new AuthCookiesService(config);
      const controller = new AuthController(
        {} as never,
        {} as never,
        oauth as never,
        cookies,
        { raw: { warn: jest.fn() } } as never,
        config,
      );
      return { controller, oauth };
    }

    it('start setea una cookie httpOnly con el hash del state, Lax, Secure y 10 min', async () => {
      const { controller, oauth } = buildController();
      const res = fakeResponse();
      const state = 'state-secreto-que-no-debe-salir';
      const stateHash = sha256(state);
      oauth.buildAuthorizationUrl.mockResolvedValue({
        url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        stateHash,
      });

      await controller.googleStart(
        { return_to: '/auth/callback' },
        res as unknown as ExpressResponse,
      );

      expect(oauth.buildAuthorizationUrl).toHaveBeenCalledWith('/auth/callback');
      expect(res.cookie).toHaveBeenCalledWith(
        OAUTH_STATE_COOKIE,
        stateHash,
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/api/v1/auth/oauth/google',
          maxAge: 10 * 60 * 1000,
        }),
      );
      const cookieValue = res.cookie.mock.calls[0][1] as string;
      expect(cookieValue).not.toBe(state);
      expect(cookieValue).toBe(sha256(state));
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        expect.stringContaining('accounts.google.com'),
      );
    });

    it('callback reenvía la cookie, crea la sesión y borra la cookie de binding', async () => {
      const { controller, oauth } = buildController();
      const res = fakeResponse();
      const state = 'state-secreto';
      const stateHash = sha256(state);
      const req = fakeRequest({ [OAUTH_STATE_COOKIE]: stateHash });
      oauth.handleCallback.mockResolvedValue({
        redirectUrl: 'http://localhost:5173/auth/callback?oauth=success',
        refreshToken: 'v1.test.refresh',
        refreshExpiresAt: new Date(Date.now() + 60_000),
        csrfToken: 'csrf-test',
      });

      await controller.googleCallback(
        { code: 'auth-code', state },
        req,
        res as unknown as ExpressResponse,
      );

      expect(oauth.handleCallback).toHaveBeenCalledWith(
        { code: 'auth-code', state, error: undefined },
        expect.objectContaining({ requestId: 'req-oauth-http' }),
        stateHash,
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'reservas_refresh',
        'v1.test.refresh',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        OAUTH_STATE_COOKIE,
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/api/v1/auth/oauth/google',
        }),
      );
      expect(res.clearCookie.mock.invocationCallOrder[0]).toBeLessThan(
        res.redirect.mock.invocationCallOrder[0],
      );
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        'http://localhost:5173/auth/callback?oauth=success',
      );
    });

    it('callback sin cookie delega el fallo, no crea sesión y borra la cookie', async () => {
      const { controller, oauth } = buildController();
      const res = fakeResponse();
      const req = fakeRequest();
      const redirectUrl =
        'http://localhost:5173/auth/callback?oauth=error&reason=oauth_failed';
      oauth.handleCallback.mockRejectedValue(
        new OAuthCallbackError(redirectUrl),
      );

      await controller.googleCallback(
        { code: 'auth-code', state: 'state-secreto' },
        req,
        res as unknown as ExpressResponse,
      );

      expect(oauth.handleCallback).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'state-secreto' }),
        expect.anything(),
        undefined,
      );
      expect(res.cookie).not.toHaveBeenCalledWith(
        'reservas_refresh',
        expect.anything(),
        expect.anything(),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        OAUTH_STATE_COOKIE,
        expect.objectContaining({ path: '/api/v1/auth/oauth/google' }),
      );
      expect(res.clearCookie.mock.invocationCallOrder[0]).toBeLessThan(
        res.redirect.mock.invocationCallOrder[0],
      );
      expect(res.redirect).toHaveBeenCalledWith(302, redirectUrl);
    });

    it('callback con error inesperado también borra la cookie', async () => {
      const { controller, oauth } = buildController();
      const res = fakeResponse();
      const req = fakeRequest({ [OAUTH_STATE_COOKIE]: sha256('state') });
      oauth.handleCallback.mockRejectedValue(new Error('boom'));

      await controller.googleCallback(
        { code: 'auth-code', state: 'state' },
        req,
        res as unknown as ExpressResponse,
      );

      expect(res.clearCookie).toHaveBeenCalledWith(
        OAUTH_STATE_COOKIE,
        expect.objectContaining({ path: '/api/v1/auth/oauth/google' }),
      );
      expect(res.clearCookie.mock.invocationCallOrder[0]).toBeLessThan(
        res.redirect.mock.invocationCallOrder[0],
      );
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        'http://localhost:5173/auth/callback?oauth=error&reason=oauth_failed',
      );
    });
  });
});
