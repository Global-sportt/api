import { Injectable } from '@nestjs/common';
import {
  AuthEventType,
  Prisma,
  UserStatus,
  VerificationTokenType,
} from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import type { AuthenticatedPrincipal } from '../../../common/types/express';
import { AppError } from '../../../common/errors/app-error';
import { AppLogger } from '../../../common/logging/app-logger.service';
import type { RequestMetadata } from '../../../common/http/request-metadata';
import { normalizeEmail } from '../../../common/utils/crypto.util';
import { UsersService } from '../../users/users.service';
import { AuthEventsService } from './auth-events.service';
import { MailerService } from './mailer.service';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession } from './session.service';
import { VerificationTokenService } from './verification-token.service';
import type { RegisterDto } from '../dto/register.dto';
import type { LoginDto } from '../dto/login.dto';
import type { ResetPasswordDto } from '../dto/reset-password.dto';
import type { ChangePasswordDto } from '../dto/change-password.dto';

const GENERIC_REGISTER_MESSAGE =
  'Si el correo puede registrarse, enviamos un enlace de verificación. Revisa tu bandeja de entrada y spam.';
const GENERIC_FORGOT_MESSAGE =
  'Si existe una cuenta con ese correo, enviamos un enlace para restablecer la contraseña.';

export interface MessageResult {
  message: string;
}

export interface RegisterResult extends MessageResult {
  dev?: { verificationToken: string };
}

export interface ForgotPasswordResult extends MessageResult {
  dev?: { resetToken: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationTokenService,
    private readonly events: AuthEventsService,
    private readonly mailer: MailerService,
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {}

  async register(dto: RegisterDto, meta: RequestMetadata): Promise<RegisterResult> {
    const email = normalizeEmail(dto.email);
    const existing = await this.users.findByEmail(email);

    if (existing) {
      if (
        existing.status === UserStatus.active &&
        existing.emailVerifiedAt === null &&
        existing.passwordHash !== null
      ) {
        const token = await this.verification.issue(
          existing.id,
          VerificationTokenType.verify_email,
        );
        await this.mailer.sendVerificationEmail(email, token);
        return this.registerResult(token);
      }
      return this.registerResult();
    }

    this.passwords.assertPolicy(dto.password, {
      email,
      displayName: dto.displayName,
    });
    const passwordHash = await this.passwords.hash(dto.password);

    try {
      const user = await this.users.createLocalUser({
        email,
        passwordHash,
        displayName: dto.displayName,
      });
      const token = await this.verification.issue(
        user.id,
        VerificationTokenType.verify_email,
      );

      await this.events.record({
        type: AuthEventType.register,
        userId: user.id,
        identifier: email,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
      await this.mailer.sendVerificationEmail(email, token);
      return this.registerResult(token);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.registerResult();
      }
      throw error;
    }
  }

  async verifyEmail(token: string, meta: RequestMetadata): Promise<MessageResult> {
    const userId = await this.verification.consume(
      token,
      VerificationTokenType.verify_email,
    );
    const user = await this.users.findById(userId);
    if (!user || user.status !== UserStatus.active) {
      throw new AppError(
        400,
        'TOKEN_INVALID',
        'El enlace no es válido o ya expiró.',
      );
    }

    await this.users.markEmailVerified(userId);
    await this.events.record({
      type: AuthEventType.email_verified,
      userId,
      identifier: user.email,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    });

    return { message: 'Correo verificado. Ya puedes iniciar sesión.' };
  }

  async login(dto: LoginDto, meta: RequestMetadata): Promise<IssuedSession> {
    const email = normalizeEmail(dto.email);
    const lockout = await this.events.getLockout(email);
    if (lockout.locked) {
      await this.events.record({
        type: AuthEventType.login_locked,
        identifier: email,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
      throw new AppError(
        429,
        'ACCOUNT_LOCKED',
        'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.',
        { retryAfterSeconds: lockout.retryAfterSeconds },
      );
    }

    const user = await this.users.findByEmail(email);
    if (!user) {
      await this.passwords.verifyDummy(dto.password);
      await this.recordLoginFailure(
        email,
        undefined,
        meta,
        'unknown_user',
      );
      throw this.invalidCredentials();
    }

    const validPassword = user.passwordHash
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verifyDummy(dto.password);

    if (!validPassword || !user.passwordHash) {
      await this.recordLoginFailure(
        email,
        user.id,
        meta,
        'invalid_password',
      );
      throw this.invalidCredentials();
    }

    if (user.status !== UserStatus.active) {
      await this.events.record({
        type: AuthEventType.login_blocked,
        userId: user.id,
        identifier: email,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        metadata: { reason: 'account_not_active' },
      });
      throw new AppError(
        403,
        'ACCOUNT_SUSPENDED',
        'La cuenta no está activa. Contacta a soporte.',
      );
    }

    if (user.emailVerifiedAt === null) {
      await this.events.record({
        type: AuthEventType.login_blocked,
        userId: user.id,
        identifier: email,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        metadata: { reason: 'email_not_verified' },
      });
      throw new AppError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Verifica tu correo antes de iniciar sesión.',
      );
    }

    const session = await this.sessions.createSession(user, meta);
    await this.users.touchLastLogin(user.id);
    await this.events.record({
      type: AuthEventType.login_succeeded,
      userId: user.id,
      identifier: email,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    });

    return session;
  }

  async getMe(userId: string) {
    const user = await this.users.findById(userId);
    if (!user || user.status !== UserStatus.active) {
      throw new AppError(
        401,
        'SESSION_INVALID',
        'La sesión no es válida. Inicia sesión de nuevo.',
      );
    }
    return this.users.toPublicUser(user);
  }

  async forgotPassword(
    rawEmail: string,
    meta: RequestMetadata,
  ): Promise<ForgotPasswordResult> {
    const email = normalizeEmail(rawEmail);
    const user = await this.users.findByEmail(email);

    if (!user || user.status !== UserStatus.active) {
      return { message: GENERIC_FORGOT_MESSAGE };
    }

    const token = await this.verification.issue(
      user.id,
      VerificationTokenType.reset_password,
    );
    await this.events.record({
      type: AuthEventType.password_reset_requested,
      userId: user.id,
      identifier: email,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    });

    try {
      await this.mailer.sendPasswordResetEmail(email, token);
    } catch (error) {
      // No revelamos si la cuenta existe ni convertimos esto en un oráculo.
      this.logger.raw.error(
        {
          event: 'password_reset_email_failed',
          requestId: meta.requestId,
          err: error,
        },
        'password_reset_email_failed',
      );
    }

    return {
      message: GENERIC_FORGOT_MESSAGE,
      ...(this.shouldExposeDevTokens ? { dev: { resetToken: token } } : {}),
    };
  }

  async resetPassword(
    dto: ResetPasswordDto,
    meta: RequestMetadata,
  ): Promise<MessageResult> {
    const token = await this.verification.resolve(
      dto.token,
      VerificationTokenType.reset_password,
    );
    const user = await this.users.findById(token.userId);
    if (!user || user.status !== UserStatus.active) {
      throw new AppError(
        403,
        'ACCOUNT_SUSPENDED',
        'La cuenta no está activa. Contacta a soporte.',
      );
    }

    this.passwords.assertPolicy(dto.password, {
      email: user.email,
      displayName: user.profile?.displayName ?? undefined,
    });
    const passwordHash = await this.passwords.hash(dto.password);
    await this.verification.consume(
      dto.token,
      VerificationTokenType.reset_password,
    );
    await this.users.setPassword(user.id, passwordHash, true);
    const revokedSessions = await this.sessions.revokeAllForUser(user.id);

    await this.events.record({
      type: AuthEventType.password_reset_succeeded,
      userId: user.id,
      identifier: user.email,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      metadata: { revokedSessions },
    });

    return {
      message:
        'Contraseña actualizada. Por seguridad, cerramos todas tus sesiones.',
    };
  }

  async changePassword(
    principal: AuthenticatedPrincipal,
    dto: ChangePasswordDto,
    meta: RequestMetadata,
  ): Promise<MessageResult> {
    const user = await this.users.findById(principal.userId);
    if (!user || user.status !== UserStatus.active) {
      throw new AppError(
        401,
        'SESSION_INVALID',
        'La sesión no es válida. Inicia sesión de nuevo.',
      );
    }

    if (!user.passwordHash) {
      throw new AppError(
        409,
        'PASSWORD_NOT_SET',
        'Tu cuenta usa Google. Usa “Olvidé mi contraseña” para crear una.',
      );
    }

    const validCurrent = await this.passwords.verify(
      user.passwordHash,
      dto.currentPassword,
    );
    if (!validCurrent) {
      await this.events.record({
        type: AuthEventType.password_change_failed,
        userId: user.id,
        identifier: user.email,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
      throw new AppError(
        400,
        'INVALID_CURRENT_PASSWORD',
        'La contraseña actual no es correcta.',
      );
    }

    this.passwords.assertPolicy(dto.newPassword, {
      email: user.email,
      displayName: user.profile?.displayName ?? undefined,
    });
    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.users.setPassword(user.id, passwordHash);
    const revokedSessions = await this.sessions.revokeAllForUser(
      user.id,
      principal.sessionId,
    );

    await this.events.record({
      type: AuthEventType.password_changed,
      userId: user.id,
      identifier: user.email,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      metadata: { revokedSessions },
    });

    return {
      message:
        'Contraseña actualizada. Cerramos las demás sesiones por seguridad.',
    };
  }

  async logout(
    principal: AuthenticatedPrincipal | undefined,
    rawRefreshToken: string | undefined,
    meta: RequestMetadata,
  ): Promise<void> {
    if (rawRefreshToken) {
      const revoked = await this.sessions.revokeByRawToken(
        rawRefreshToken,
        meta,
      );
      if (revoked) return;
    }

    if (principal) {
      await this.sessions.revokeSession(principal.sessionId, 'logout');
      await this.events.record({
        type: AuthEventType.logout,
        userId: principal.userId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
    }
  }

  async logoutAll(
    principal: AuthenticatedPrincipal,
    meta: RequestMetadata,
  ): Promise<MessageResult> {
    const revokedSessions = await this.sessions.revokeAllForUser(
      principal.userId,
    );
    await this.events.record({
      type: AuthEventType.logout,
      userId: principal.userId,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      metadata: { scope: 'all', revokedSessions },
    });
    return { message: 'Cerramos todas tus sesiones.' };
  }

  private async recordLoginFailure(
    email: string,
    userId: string | undefined,
    meta: RequestMetadata,
    reason: string,
  ): Promise<void> {
    await this.events.record({
      type: AuthEventType.login_failed,
      userId,
      identifier: email,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      metadata: { reason },
    });
  }

  private invalidCredentials(): AppError {
    return new AppError(
      401,
      'INVALID_CREDENTIALS',
      'Correo o contraseña incorrectos.',
    );
  }

  private registerResult(token?: string): RegisterResult {
    return {
      message: GENERIC_REGISTER_MESSAGE,
      ...(token && this.shouldExposeDevTokens
        ? { dev: { verificationToken: token } }
        : {}),
    };
  }

  private get shouldExposeDevTokens(): boolean {
    return (
      this.config.env.AUTH_DEV_EXPOSE_TOKENS && !this.config.isProduction
    );
  }
}
