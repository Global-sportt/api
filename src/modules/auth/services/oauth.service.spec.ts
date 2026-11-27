import type { AppConfigService } from '../../../config/app-config.service';
import {
  sha256,
  sha256Base64Url,
} from '../../../common/utils/crypto.util';
import { OAuthService } from './oauth.service';

function buildService(googleConfigured = true) {
  const prisma = {
    oAuthState: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const config = {
    googleOAuth: googleConfigured
      ? {
          clientId: 'client-id.apps.googleusercontent.com',
          clientSecret: 'client-secret',
          redirectUri:
            'http://localhost:3000/api/v1/auth/oauth/google/callback',
        }
      : null,
    env: {
      WEB_APP_URL: 'http://localhost:5173',
    },
  } as unknown as AppConfigService;

  const service = new OAuthService(
    prisma as never,
    config,
    {} as never,
    {} as never,
    {} as never,
    { raw: { warn: jest.fn() } } as never,
  );

  return { service, prisma };
}

describe('OAuthService', () => {
  it('construye la URL de Google con state, nonce y PKCE S256', async () => {
    const { service, prisma } = buildService();
    const authorization = await service.buildAuthorizationUrl('/auth/callback');
    const url = new URL(authorization.url);

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('client_id')).toBe(
      'client-id.apps.googleusercontent.com',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const state = url.searchParams.get('state');
    expect(state).toEqual(expect.any(String));

    const created = prisma.oAuthState.create.mock.calls[0][0].data;
    expect(created.provider).toBe('google');
    expect(created.returnTo).toBe('/auth/callback');
    expect(created.stateHash).toBe(sha256(state as string));
    expect(authorization.stateHash).toBe(created.stateHash);
    expect(authorization.stateHash).not.toBe(state);
    expect(created.codeVerifier).toHaveLength(64);
    expect(url.searchParams.get('code_challenge')).toBe(
      sha256Base64Url(created.codeVerifier),
    );
    expect(created.nonce).toHaveLength(22);
    expect(url.searchParams.get('nonce')).toBe(created.nonce);
  });

  it('descarta return_to absolutos o peligrosos', async () => {
    const { service, prisma } = buildService();
    await service.buildAuthorizationUrl('https://sitio-malicioso.example');

    const created = prisma.oAuthState.create.mock.calls[0][0].data;
    expect(created.returnTo).toBe('/auth/callback');
  });

  it('falla con 503 cuando Google no está configurado', async () => {
    const { service } = buildService(false);
    await expect(service.buildAuthorizationUrl('/auth/callback')).rejects.toMatchObject(
      { code: 'OAUTH_NOT_CONFIGURED' },
    );
  });
});
