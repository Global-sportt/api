import { Injectable } from '@nestjs/common';
import { AuthEventType, Prisma, UserStatus } from '@prisma/client';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { AppConfigService } from '../../../config/app-config.service';
import { AppLogger } from '../../../common/logging/app-logger.service';
import type { RequestMetadata } from '../../../common/http/request-metadata';
import { AppError } from '../../../common/errors/app-error';
import {
  isRelativePath,
  randomToken,
  sha256,
  sha256Base64Url,
} from '../../../common/utils/crypto.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { UsersService } from '../../users/users.service';
import { AuthEventsService } from './auth-events.service';
import { SessionService } from './session.service';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS: [string, ...string[]] = [
  'https://accounts.google.com',
  'accounts.google.com',
];
const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RETURN_TO = '/auth/callback';

interface GoogleTokenResponse {
  id_token?: string;
  error?: string;
}

interface GoogleIdTokenPayload extends JwtPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  nonce?: string;
  azp?: string;
}

export interface OAuthCallbackInput {
  code?: string;
  state?: string;
  error?: string;
}

export interface OAuthCallbackSuccess {
  redirectUrl: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
}

export type OAuthErrorReason =
  | 'access_denied'
  | 'invalid_state'
  | 'invalid_response'
  | 'oauth_failed'
  | 'account_suspended'
  | 'email_unverified'
  | 'oauth_not_configured';

export class OAuthCallbackError extends Error {
  constructor(readonly redirectUrl: string) {
    super('oauth_callback_failed');
    this.name = 'OAuthCallbackError';
  }
}

@Injectable()
export class OAuthService {
  private readonly jwks = jwksClient({
    jwksUri: GOOGLE_JWKS_URI,
    cache: true,
    cacheMaxEntries: 10,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
    timeout: 10_000,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly events: AuthEventsService,
    private readonly logger: AppLogger,
  ) {}

  async buildAuthorizationUrl(returnToRaw?: string): Promise<string> {
    const google = this.requireGoogleConfig();
    const returnTo = this.normalizeReturnTo(returnToRaw);
    const state = randomToken(32);
    const nonce = randomToken(16);
    const codeVerifier = randomToken(48);
    const codeChallenge = sha256Base64Url(codeVerifier);

    await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.prisma.oAuthState.create({
      data: {
        stateHash: sha256(state),
        provider: 'google',
        codeVerifier,
        nonce,
        returnTo,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();

    return url.toString();
  }

  async handleCallback(
    input: OAuthCallbackInput,
    meta: RequestMetadata,
  ): Promise<OAuthCallbackSuccess> {
    const google = this.requireGoogleConfig();
    const state = await this.consumeState(input.state);

    if (input.error) {
      throw new OAuthCallbackError(
        this.errorRedirect(
          state.returnTo,
          input.error === 'access_denied' ? 'access_denied' : 'oauth_failed',
        ),
      );
    }

    if (!input.code) {
      throw new OAuthCallbackError(
        this.errorRedirect(state.returnTo, 'invalid_response'),
      );
    }

    try {
      const idToken = await this.exchangeCode(input.code, state.codeVerifier);
      const profile = await this.verifyIdToken(
        idToken,
        state.nonce,
        google.clientId,
      );
      const user = await this.resolveUser(profile);

      const session = await this.sessions.createSession(user, meta);
      await this.events.record({
        type: AuthEventType.oauth_login_succeeded,
        userId: user.id,
        identifier: user.email,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        metadata: { provider: 'google' },
      });

      return {
        redirectUrl: this.successRedirect(state.returnTo),
        refreshToken: session.refreshToken,
        refreshExpiresAt: session.refreshTokenExpiresAt,
        csrfToken: randomToken(32),
      };
    } catch (error) {
      if (error instanceof OAuthCallbackError) throw error;

      const reason = this.toReason(error);
      await this.events.record({
        type: AuthEventType.oauth_login_failed,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        metadata: { provider: 'google', reason },
      });
      this.logger.raw.warn(
        {
          event: 'oauth_callback_failed',
          requestId: meta.requestId,
          reason,
          err: error,
        },
        'oauth_callback_failed',
      );

      throw new OAuthCallbackError(
        this.errorRedirect(state.returnTo, reason),
      );
    }
  }

  redirectToError(reason: OAuthErrorReason): string {
    return this.errorRedirect(DEFAULT_RETURN_TO, reason);
  }

  private async consumeState(
    rawState: string | undefined,
  ): Promise<{ returnTo: string; codeVerifier: string; nonce: string }> {
    if (!rawState || rawState.length > 512) {
      throw new OAuthCallbackError(
        this.errorRedirect(DEFAULT_RETURN_TO, 'invalid_state'),
      );
    }

    const state = await this.prisma.oAuthState.findUnique({
      where: { stateHash: sha256(rawState) },
    });

    if (
      !state ||
      state.provider !== 'google' ||
      state.consumedAt !== null ||
      state.expiresAt <= new Date()
    ) {
      throw new OAuthCallbackError(
        this.errorRedirect(
          state?.returnTo ?? DEFAULT_RETURN_TO,
          'invalid_state',
        ),
      );
    }

    const consumed = await this.prisma.oAuthState.updateMany({
      where: { id: state.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new OAuthCallbackError(
        this.errorRedirect(state.returnTo, 'invalid_state'),
      );
    }

    return {
      returnTo: state.returnTo,
      codeVerifier: state.codeVerifier,
      nonce: state.nonce,
    };
  }

  private async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<string> {
    const google = this.requireGoogleConfig();
    let response: Response;

    try {
      response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          code,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: google.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(
        503,
        'OAUTH_UNAVAILABLE',
        'No pudimos contactar a Google. Intenta de nuevo.',
      );
    }

    if (!response.ok) {
      throw new AppError(
        502,
        'OAUTH_TOKEN_EXCHANGE_FAILED',
        'Google rechazó la autenticación.',
      );
    }

    const data = (await response.json()) as GoogleTokenResponse;
    if (!data.id_token) {
      throw new AppError(
        502,
        'OAUTH_INVALID_RESPONSE',
        'Google devolvió una respuesta incompleta.',
      );
    }

    return data.id_token;
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
    clientId: string,
  ): Promise<{
    providerAccountId: string;
    email: string;
    displayName?: string;
    avatarUrl?: string;
  }> {
    const decoded = jwt.decode(idToken, { complete: true });
    const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : null;
    if (!kid) {
      throw new AppError(401, 'OAUTH_INVALID_TOKEN', 'Token de Google inválido.');
    }

    const publicKey = await this.getSigningKey(kid);
    let payload: GoogleIdTokenPayload;
    try {
      payload = jwt.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        audience: clientId,
        issuer: GOOGLE_ISSUERS,
        clockTolerance: 5,
      }) as GoogleIdTokenPayload;
    } catch {
      throw new AppError(401, 'OAUTH_INVALID_TOKEN', 'Token de Google inválido.');
    }

    const emailVerified =
      payload.email_verified === true || payload.email_verified === 'true';
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      !emailVerified ||
      payload.nonce !== expectedNonce
    ) {
      throw new AppError(
        401,
        'OAUTH_EMAIL_UNVERIFIED',
        'Google no confirmó el correo de la cuenta.',
      );
    }

    if (payload.azp && payload.azp !== clientId) {
      throw new AppError(401, 'OAUTH_INVALID_TOKEN', 'Token de Google inválido.');
    }

    return {
      providerAccountId: payload.sub,
      email: payload.email,
      displayName: this.safeName(payload.name),
      avatarUrl: this.safeAvatar(payload.picture),
    };
  }

  private async resolveUser(profile: {
    providerAccountId: string;
    email: string;
    displayName?: string;
    avatarUrl?: string;
  }) {
    const existingAccount = await this.users.findOAuthAccount(
      'google',
      profile.providerAccountId,
    );

    if (existingAccount) {
      if (existingAccount.status !== UserStatus.active) {
        throw new AppError(
          403,
          'ACCOUNT_SUSPENDED',
          'La cuenta no está activa.',
        );
      }
      await this.users.updateOAuthLogin({
        userId: existingAccount.id,
        provider: 'google',
        providerAccountId: profile.providerAccountId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      });
      return existingAccount;
    }

    const existingUser = await this.users.findByEmail(profile.email);
    if (existingUser) {
      if (existingUser.status !== UserStatus.active) {
        throw new AppError(
          403,
          'ACCOUNT_SUSPENDED',
          'La cuenta no está activa.',
        );
      }

      await this.users.markEmailVerified(existingUser.id);
      await this.users.linkOAuthAccount({
        userId: existingUser.id,
        provider: 'google',
        providerAccountId: profile.providerAccountId,
        email: profile.email,
      });
      await this.users.updateOAuthLogin({
        userId: existingUser.id,
        provider: 'google',
        providerAccountId: profile.providerAccountId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      });
      return existingUser;
    }

    try {
      return await this.users.createOAuthUser({
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        provider: 'google',
        providerAccountId: profile.providerAccountId,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.users.findOAuthAccount(
          'google',
          profile.providerAccountId,
        );
        if (raced) return raced;
      }
      throw error;
    }
  }

  private getSigningKey(kid: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.jwks.getSigningKey(kid, (error, key) => {
        if (error || !key) {
          reject(error ?? new Error('No signing key'));
          return;
        }
        const publicKey = key.getPublicKey();
        resolve(publicKey);
      });
    });
  }

  private requireGoogleConfig(): {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } {
    const google = this.config.googleOAuth;
    if (!google) {
      throw new AppError(
        503,
        'OAUTH_NOT_CONFIGURED',
        'El inicio de sesión con Google no está configurado.',
      );
    }
    return google;
  }

  private normalizeReturnTo(value: string | undefined): string {
    if (!value) return DEFAULT_RETURN_TO;
    return isRelativePath(value) && value.length <= 512
      ? value
      : DEFAULT_RETURN_TO;
  }

  private successRedirect(returnTo: string): string {
    return this.redirect(returnTo, { oauth: 'success' });
  }

  private errorRedirect(returnTo: string, reason: OAuthErrorReason): string {
    return this.redirect(returnTo, { oauth: 'error', reason });
  }

  private redirect(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.config.env.WEB_APP_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private toReason(error: unknown): OAuthErrorReason {
    if (error instanceof AppError) {
      if (error.code === 'OAUTH_EMAIL_UNVERIFIED') return 'email_unverified';
      if (error.code === 'ACCOUNT_SUSPENDED') return 'account_suspended';
      if (error.code === 'OAUTH_NOT_CONFIGURED') return 'oauth_not_configured';
    }
    return 'oauth_failed';
  }

  private safeName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().slice(0, 120);
    return trimmed.length >= 2 ? trimmed : undefined;
  }

  private safeAvatar(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }
}
