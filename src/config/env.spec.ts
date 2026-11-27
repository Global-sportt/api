import { envSchema } from './env';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://reservas:reservas@127.0.0.1:5432/reservas_test',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  PII_HASH_SECRET: 'y'.repeat(24),
};

function parse(overrides: Record<string, unknown> = {}) {
  return envSchema.safeParse({ ...base, ...overrides });
}

describe('envSchema', () => {
  it('acepta una configuración mínima de desarrollo', () => {
    const result = parse();
    expect(result.success).toBe(true);
  });

  it('exige SMTP en producción', () => {
    const result = parse({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path[0] === 'SMTP_HOST'),
      ).toBe(true);
    }
  });

  it('rechaza cookies inseguras en producción', () => {
    const result = parse({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      SMTP_HOST: 'smtp.example.com',
      MAIL_FROM: 'no-reply@example.com',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path[0] === 'COOKIE_SECURE'),
      ).toBe(true);
    }
  });

  it('rechaza credenciales Google incompletas', () => {
    const result = parse({ GOOGLE_CLIENT_ID: 'client-id' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path[0] === 'GOOGLE_CLIENT_ID'),
      ).toBe(true);
    }
  });

  it('rechaza una ventana de refresh mayor que la absoluta', () => {
    const result = parse({
      REFRESH_TOKEN_TTL_DAYS: '60',
      SESSION_ABSOLUTE_TTL_DAYS: '30',
    });
    expect(result.success).toBe(false);
  });
});
