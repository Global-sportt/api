import { JwtService } from '@nestjs/jwt';
import type { AppConfigService } from '../../../config/app-config.service';
import { AppError } from '../../../common/errors/app-error';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const secret = 'unit-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
  const jwt = new JwtService({
    secret,
    signOptions: {
      algorithm: 'HS256',
      issuer: 'reservas-api-test',
      audience: 'reservas-web-test',
    },
    verifyOptions: {
      algorithms: ['HS256'],
      issuer: 'reservas-api-test',
      audience: 'reservas-web-test',
    },
  });
  const config = {
    accessTokenTtlSeconds: 900,
  } as unknown as AppConfigService;
  const service = new TokenService(jwt, config);

  it('firma y verifica un access token', async () => {
    const signed = await service.signAccessToken({
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
    });

    expect(signed.expiresIn).toBe(900);
    const principal = await service.verifyAccessToken(signed.token);
    expect(principal).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('rechaza tokens manipulados', async () => {
    const signed = await service.signAccessToken({
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
    });

    const tampered = `${signed.token.slice(0, -2)}xx`;
    await expect(service.verifyAccessToken(tampered)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('no acepta un token firmado por otro issuer/audience', async () => {
    const other = new JwtService({
      secret,
      signOptions: {
        algorithm: 'HS256',
        issuer: 'otro-issuer',
        audience: 'otra-audiencia',
      },
    });
    const token = await other.signAsync({
      sub: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      typ: 'access',
    });

    await expect(service.verifyAccessToken(token)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
