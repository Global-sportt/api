import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/prisma/prisma.service';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'frase-segura-2026';

let app: INestApplication;
let prisma: PrismaService;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `10.10.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function server() {
  return app.getHttpServer();
}

function cookiesFrom(
  response: request.Response,
  name: string,
): string | undefined {
  const header = response.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(header)
    ? header
    : typeof header === 'string'
      ? [header]
      : [];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) return undefined;
  return cookie.split(';')[0].slice(name.length + 1);
}

function csrfFrom(response: request.Response): string {
  const token = response.body?.csrfToken;
  if (typeof token !== 'string') {
    throw new Error('La respuesta no incluyó csrfToken');
  }
  return token;
}

async function registerAndVerify(): Promise<{
  email: string;
  password: string;
  ip: string;
}> {
  const ip = nextIp();
  const email = `jugador-${Date.now()}-${ipCounter}@example.com`;

  const registered = await request(server())
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ email, password: PASSWORD, displayName: 'Jugador de prueba' })
    .expect(201);

  const token = registered.body?.dev?.verificationToken;
  expect(typeof token).toBe('string');

  await request(server())
    .post('/api/v1/auth/verify-email')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ token })
    .expect(200);

  return { email, password: PASSWORD, ip };
}

async function login(
  email: string,
  password: string,
  ip: string,
): Promise<{
  agent: ReturnType<typeof request.agent>;
  response: request.Response;
  csrf: string;
}> {
  const agent = request.agent(server());
  const response = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ email, password })
    .expect(200);

  return { agent, response, csrf: csrfFrom(response) };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  configureApp(app, app.get(AppConfigService), { swagger: false });
  await app.init();
  prisma = app.get(PrismaService);

  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "auth_events", "oauth_states", "refresh_tokens", "sessions", "verification_tokens", "oauth_accounts", "profiles", "users" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await app.close();
});

describe('Auth (e2e)', () => {
  it('registra, verifica el correo, inicia sesión y protege /me', async () => {
    const { email, password, ip } = await registerAndVerify();
    const { response, agent, csrf } = await login(email, password, ip);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user.email).toBe(email);
    expect(response.body.user.emailVerified).toBe(true);
    expect(response.body.refreshToken).toBeUndefined();
    expect(csrfFrom(response)).toBe(csrf);
    expect(cookiesFrom(response, 'reservas_refresh')).toBeTruthy();
    expect(cookiesFrom(response, 'reservas_csrf')).toBe(csrf);

    const me = await agent
      .get('/api/v1/auth/me')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${response.body.accessToken}`)
      .expect(200);

    expect(me.body.email).toBe(email);
    expect(me.body).not.toHaveProperty('passwordHash');
  });

  it('rechaza /me sin access token con problem+json', async () => {
    const response = await request(server())
      .get('/api/v1/auth/me')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .expect(401);

    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(response.body.trace_id).toEqual(expect.any(String));
  });

  it('rota el refresh token con CSRF y exige el header', async () => {
    const { email, password, ip } = await registerAndVerify();
    const { agent, csrf } = await login(email, password, ip);

    const noCsrf = await agent
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({})
      .expect(403);
    expect(noCsrf.body.code).toBe('CSRF_TOKEN_INVALID');

    const rotated = await agent
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200);

    expect(rotated.body.accessToken).toEqual(expect.any(String));
    expect(rotated.body.refreshToken).toBeUndefined();
    expect(rotated.body.csrfToken).toBe(csrf);
    expect(rotated.body.user.email).toBe(email);
  });

  it('detecta reutilización de refresh token y revoca la sesión', async () => {
    const { email, password, ip } = await registerAndVerify();
    const { agent, response, csrf } = await login(email, password, ip);
    const oldRefresh = cookiesFrom(response, 'reservas_refresh');
    expect(oldRefresh).toBeTruthy();

    await agent
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200);

    const reuse = await request(server())
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ refreshToken: oldRefresh, client: 'mobile' })
      .expect(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');

    const afterReuse = await agent
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(401);
    expect(afterReuse.body.code).toBe('SESSION_EXPIRED');
  });

  it('cierra la sesión y deja de aceptar el refresh token', async () => {
    const { email, password, ip } = await registerAndVerify();
    const { agent, csrf } = await login(email, password, ip);

    await agent
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(204);

    await agent
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(401);
  });

  it('exige verificar el correo antes del login local', async () => {
    const ip = nextIp();
    const email = `sin-verificar-${Date.now()}-${ipCounter}@example.com`;

    await request(server())
      .post('/api/v1/auth/register')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD })
      .expect(201);

    const response = await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD })
      .expect(403);

    expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('bloquea la cuenta tras cinco contraseñas incorrectas', async () => {
    const { email, ip } = await registerAndVerify();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'incorrecta-2026' })
        .expect(401);
      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    }

    const locked = await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD })
      .expect(429);

    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.details.retryAfterSeconds).toEqual(expect.any(Number));
  });

  it('restablece la contraseña con token de un solo uso', async () => {
    const { email, ip } = await registerAndVerify();
    const newPassword = 'nueva-frase-segura-2026';

    const forgot = await request(server())
      .post('/api/v1/auth/password/forgot')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email })
      .expect(202);

    const resetToken = forgot.body?.dev?.resetToken;
    expect(typeof resetToken).toBe('string');

    await request(server())
      .post('/api/v1/auth/password/reset')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ token: resetToken, password: newPassword })
      .expect(200);

    await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD })
      .expect(401);

    await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password: newPassword })
      .expect(200);

    await request(server())
      .post('/api/v1/auth/password/reset')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ token: resetToken, password: newPassword })
      .expect(400);
  });

  it('cambia la contraseña y conserva solo la sesión actual', async () => {
    const { email, password, ip } = await registerAndVerify();
    const { agent, response, csrf } = await login(email, password, ip);
    const newPassword = 'cambiada-segura-2026';

    await agent
      .post('/api/v1/auth/password/change')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .set('Authorization', `Bearer ${response.body.accessToken}`)
      .send({ currentPassword: password, newPassword })
      .expect(200);

    await agent
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200);

    await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password })
      .expect(401);

    await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password: newPassword })
      .expect(200);
  });

  it('rechaza contraseñas débiles y orígenes no permitidos', async () => {
    const weak = await request(server())
      .post('/api/v1/auth/register')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({
        email: `debil-${Date.now()}@example.com`,
        password: 'password1234',
      })
      .expect(422);
    expect(weak.body.code).toBe('WEAK_PASSWORD');

    const badOrigin = await request(server())
      .post('/api/v1/auth/login')
      .set('Origin', 'https://sitio-malicioso.example')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'x@example.com', password: PASSWORD })
      .expect(403);
    expect(badOrigin.body.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('responde 503 si Google OAuth no está configurado', async () => {
    const response = await request(server())
      .get('/api/v1/auth/oauth/google/start')
      .set('X-Forwarded-For', nextIp())
      .expect(503);

    expect(response.body.code).toBe('OAUTH_NOT_CONFIGURED');
  });

  it('propaga el request id y expone health sin prefijo', async () => {
    const response = await request(server())
      .get('/health/live')
      .set('X-Request-Id', 'test-request-123')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('test-request-123');
    expect(response.body.status).toBe('ok');
  });
});
