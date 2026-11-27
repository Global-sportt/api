process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.API_PREFIX = 'api/v1';
process.env.API_PUBLIC_URL = 'http://localhost:3001';
process.env.WEB_APP_URL = 'http://localhost:5173';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.TRUST_PROXY = 'true';
process.env.ENABLE_DOCS = 'false';
process.env.LOG_LEVEL = 'silent';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://reservas:reservas@127.0.0.1:5432/reservas_test?schema=public';

process.env.JWT_ACCESS_SECRET =
  'test-access-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
process.env.JWT_ISSUER = 'reservas-api-test';
process.env.JWT_AUDIENCE = 'reservas-web-test';
process.env.ACCESS_TOKEN_TTL_SECONDS = '900';
process.env.REFRESH_TOKEN_TTL_DAYS = '30';
process.env.SESSION_ABSOLUTE_TTL_DAYS = '90';
process.env.PII_HASH_SECRET = 'test-pii-secret-0123456789';

process.env.COOKIE_SECURE = 'false';
process.env.COOKIE_SAME_SITE = 'lax';
process.env.COOKIE_DOMAIN = '';
process.env.AUTH_DEV_EXPOSE_TOKENS = 'true';

process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GOOGLE_REDIRECT_URI = '';

process.env.SMTP_HOST = '';
process.env.SMTP_PORT = '587';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.MAIL_FROM = '';
