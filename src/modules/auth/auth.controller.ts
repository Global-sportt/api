import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthenticatedOnly } from '../../common/authz/authenticated-only.decorator';
import { AppError } from '../../common/errors/app-error';
import { AppLogger } from '../../common/logging/app-logger.service';
import { requestMetadata } from '../../common/http/request-metadata';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedPrincipal } from '../../common/types/express';
import { randomToken } from '../../common/utils/crypto.util';
import { AppConfigService } from '../../config/app-config.service';
import { AuthService } from './services/auth.service';
import { AuthCookiesService } from './services/auth-cookies.service';
import { OAuthService, OAuthCallbackError } from './services/oauth.service';
import { SessionService, type IssuedSession } from './services/session.service';
import type { ClientType } from './auth.constants';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { OAuthStartQueryDto } from './dto/oauth-start.query';
import {
  AuthResponseDto,
  MessageResponseDto,
  RegisterResponseDto,
  UserResponseDto,
} from './dto/auth-response.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauth: OAuthService,
    private readonly cookies: AuthCookiesService,
    private readonly logger: AppLogger,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Registrar una cuenta con correo y contraseña',
    description:
      'La respuesta es genérica para no revelar si el correo ya está registrado.',
  })
  @ApiResponse({ status: 201, type: RegisterResponseDto })
  @ApiResponse({ status: 422, description: 'Contraseña débil' })
  @ApiResponse({ status: 429, description: 'Demasiadas solicitudes' })
  register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<RegisterResponseDto> {
    return this.auth.register(dto, requestMetadata(req));
  }

  @Public()
  @Post('verify-email')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar el correo con el token del enlace' })
  @ApiOkResponse({ type: MessageResponseDto })
  verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: Request,
  ): Promise<MessageResponseDto> {
    return this.auth.verifyEmail(dto.token, requestMetadata(req));
  }

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Iniciar sesión con correo y contraseña',
    description:
      'La web recibe cookies httpOnly + CSRF. Los clientes móviles piden client=mobile y reciben el refresh token en el body.',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  @ApiResponse({ status: 403, description: 'Correo sin verificar o cuenta inactiva' })
  @ApiResponse({ status: 429, description: 'Rate limit o cuenta bloqueada' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const session = await this.auth.login(dto, requestMetadata(req));
    return this.respondWithSession(
      req,
      res,
      session,
      dto.client ?? 'web',
      randomToken(32),
    );
  }

  @Public()
  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @ApiCookieAuth('refresh-cookie')
  @ApiOperation({
    summary: 'Rotar la sesión y obtener un access token nuevo',
    description:
      'La web envía la cookie httpOnly y el header X-CSRF-Token. Los clientes móviles envían refreshToken en el body.',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Refresh token inválido o reutilizado' })
  async refresh(
    @Body() dto: RefreshDto = {},
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const fromBody =
      typeof dto.refreshToken === 'string' && dto.refreshToken.length > 0;
    const raw = fromBody ? dto.refreshToken : this.cookies.getRefreshToken(req);
    if (!raw) {
      throw new AppError(
        401,
        'REFRESH_TOKEN_REQUIRED',
        'No se recibió un refresh token.',
      );
    }

    const session = await this.sessions.refresh(raw, requestMetadata(req));
    return this.respondWithSession(
      req,
      res,
      session,
      fromBody ? (dto.client ?? 'mobile') : 'web',
    );
  }

  @Public()
  @Post('logout')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(204)
  @ApiCookieAuth('refresh-cookie')
  @ApiOperation({ summary: 'Cerrar la sesión actual' })
  async logout(
    @Body() dto: LogoutDto = {},
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const raw =
      (typeof dto.refreshToken === 'string' && dto.refreshToken.length > 0
        ? dto.refreshToken
        : undefined) ?? this.cookies.getRefreshToken(req);

    await this.auth.logout(req.principal, raw, requestMetadata(req));
    this.cookies.clearSessionCookies(res);
  }

  @AuthenticatedOnly()
  @Post('logout-all')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cerrar todas las sesiones de la cuenta' })
  @ApiOkResponse({ type: MessageResponseDto })
  async logoutAll(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageResponseDto> {
    const result = await this.auth.logoutAll(
      principal,
      requestMetadata(req),
    );
    this.cookies.clearSessionCookies(res);
    return result;
  }

  @AuthenticatedOnly()
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Perfil de la sesión actual' })
  @ApiOkResponse({ type: UserResponseDto })
  async me(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<UserResponseDto> {
    const user = await this.auth.getMe(principal.userId);
    return UserResponseDto.from(user);
  }

  @AuthenticatedOnly()
  @Post('password/change')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cambiar la contraseña de la cuenta' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiResponse({ status: 409, description: 'La cuenta usa Google' })
  changePassword(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<MessageResponseDto> {
    return this.auth.changePassword(principal, dto, requestMetadata(req));
  }

  @Public()
  @Post('password/forgot')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(202)
  @ApiOperation({
    summary: 'Solicitar un enlace para restablecer la contraseña',
    description:
      'La respuesta es genérica para no revelar si la cuenta existe.',
  })
  @ApiResponse({ status: 202, type: MessageResponseDto })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string; dev?: { resetToken: string } }> {
    return this.auth.forgotPassword(dto.email, requestMetadata(req));
  }

  @Public()
  @Post('password/reset')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @ApiOperation({ summary: 'Restablecer la contraseña con el token del enlace' })
  @ApiOkResponse({ type: MessageResponseDto })
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<MessageResponseDto> {
    return this.auth.resetPassword(dto, requestMetadata(req));
  }

  @Public()
  @Get('csrf')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Obtener el token CSRF de doble envío para la web',
  })
  csrf(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { csrfToken: string } {
    const token = this.cookies.issueCsrfToken(req);
    this.cookies.setCsrfCookie(
      res,
      token,
      new Date(Date.now() + this.config.refreshTokenTtlMs),
    );
    return { csrfToken: token };
  }

  @Public()
  @Get('providers')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Métodos de autenticación habilitados en el servidor',
  })
  providers(): { password: boolean; google: boolean } {
    return {
      password: true,
      google: this.config.googleOAuth !== null,
    };
  }

  @Public()
  @Get('oauth/google/start')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Iniciar el flujo OAuth de Google' })
  @ApiResponse({ status: 302, description: 'Redirección a Google' })
  @ApiResponse({ status: 503, description: 'Google OAuth no configurado' })
  async googleStart(
    @Query() query: OAuthStartQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { url, stateHash } =
      await this.oauth.buildAuthorizationUrl(query.return_to);
    this.cookies.setOAuthStateCookie(res, stateHash);
    res.redirect(302, url);
  }

  @Public()
  @Get('oauth/google/callback')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Callback de Google',
    description:
      'Valida state, nonce y PKCE; crea la sesión y redirige a la web sin exponer tokens en la URL.',
  })
  @ApiResponse({ status: 302, description: 'Redirección a la web' })
  async googleCallback(
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const first = (value: string | string[] | undefined) =>
      typeof value === 'string' ? value : undefined;
    let redirectUrl: string;

    try {
      const result = await this.oauth.handleCallback(
        {
          code: first(query.code),
          state: first(query.state),
          error: first(query.error),
        },
        requestMetadata(req),
        this.cookies.getOAuthStateCookie(req),
      );
      this.cookies.setSessionCookies(res, {
        refreshToken: result.refreshToken,
        refreshExpiresAt: result.refreshExpiresAt,
        csrfToken: result.csrfToken,
      });
      redirectUrl = result.redirectUrl;
    } catch (error) {
      if (error instanceof OAuthCallbackError) {
        redirectUrl = error.redirectUrl;
      } else if (
        error instanceof AppError &&
        error.code === 'OAUTH_NOT_CONFIGURED'
      ) {
        redirectUrl = this.oauth.redirectToError('oauth_not_configured');
      } else {
        this.logger.raw.warn(
          {
            event: 'oauth_callback_unhandled',
            requestId: req.id,
            err: error,
          },
          'oauth_callback_unhandled',
        );
        redirectUrl = this.oauth.redirectToError('oauth_failed');
      }
    }

    // Se borra antes del 302: tras res.redirect() la respuesta ya terminó y
    // no se pueden agregar headers Set-Cookie.
    this.cookies.clearOAuthStateCookie(res);
    res.redirect(302, redirectUrl);
  }

  private respondWithSession(
    req: Request,
    res: Response,
    session: IssuedSession,
    client: ClientType,
    csrfToken?: string,
  ): AuthResponseDto {
    const common = {
      accessToken: session.accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: session.accessTokenExpiresIn,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      user: UserResponseDto.from(session.user),
    };

    if (client === 'web') {
      const csrf = csrfToken ?? this.cookies.issueCsrfToken(req);
      this.cookies.setSessionCookies(res, {
        refreshToken: session.refreshToken,
        refreshExpiresAt: session.refreshTokenExpiresAt,
        csrfToken: csrf,
      });
      return { ...common, csrfToken: csrf };
    }

    return {
      ...common,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    };
  }
}
