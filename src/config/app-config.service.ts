import { Injectable } from '@nestjs/common';
import { Env, validateEnv } from './env';

@Injectable()
export class AppConfigService {
  readonly env: Env;

  constructor() {
    this.env = validateEnv(process.env);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  get accessTokenTtlSeconds(): number {
    return this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  get refreshTokenTtlMs(): number {
    return this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  get sessionAbsoluteTtlMs(): number {
    return this.env.SESSION_ABSOLUTE_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  get corsOrigins(): string[] {
    const configured = this.env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim().replace(/\/$/, '').toLowerCase())
      .filter((origin) => origin.length > 0 && origin !== '*');
    return Array.from(
      new Set([
        ...configured,
        new URL(this.env.WEB_APP_URL).origin.toLowerCase(),
      ]),
    );
  }

  get cookieSecure(): boolean {
    return this.env.COOKIE_SECURE ?? this.isProduction;
  }

  get cookieSameSite(): 'lax' | 'strict' | 'none' {
    return this.env.COOKIE_SAME_SITE;
  }

  get docsEnabled(): boolean {
    return this.env.ENABLE_DOCS;
  }

  get googleOAuth():
    | {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
      }
    | null {
    if (
      !this.env.GOOGLE_CLIENT_ID ||
      !this.env.GOOGLE_CLIENT_SECRET ||
      !this.env.GOOGLE_REDIRECT_URI
    ) {
      return null;
    }

    return {
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
      redirectUri: this.env.GOOGLE_REDIRECT_URI,
    };
  }

  get smtp():
    | {
        host: string;
        port: number;
        secure: boolean;
        user?: string;
        pass?: string;
        from: string;
      }
    | null {
    if (!this.env.SMTP_HOST || !this.env.MAIL_FROM) {
      return null;
    }

    return {
      host: this.env.SMTP_HOST,
      port: this.env.SMTP_PORT,
      secure: this.env.SMTP_SECURE,
      user: this.env.SMTP_USER,
      pass: this.env.SMTP_PASS,
      from: this.env.MAIL_FROM,
    };
  }
}
