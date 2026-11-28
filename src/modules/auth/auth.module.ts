import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { AuthEventsService } from './services/auth-events.service';
import { AuthCookiesService } from './services/auth-cookies.service';
import { MailerService } from './services/mailer.service';
import { OAuthService } from './services/oauth.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { TokenService } from './services/token.service';
import { VerificationTokenService } from './services/verification-token.service';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.env.JWT_ACCESS_SECRET,
        signOptions: {
          algorithm: 'HS256',
          issuer: config.env.JWT_ISSUER,
          audience: config.env.JWT_AUDIENCE,
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: config.env.JWT_ISSUER,
          audience: config.env.JWT_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthEventsService,
    AuthCookiesService,
    MailerService,
    OAuthService,
    PasswordService,
    SessionService,
    TokenService,
    VerificationTokenService,
  ],
  exports: [TokenService, SessionService, AuthService, MailerService],
})
export class AuthModule {}
