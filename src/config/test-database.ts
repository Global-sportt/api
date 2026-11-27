/**
 * Safety guard for the test database.
 *
 * The e2e suites delete tenants, users and bookings before each run. Pointing
 * `TEST_DATABASE_URL`/`DATABASE_URL` at the development database by mistake
 * would destroy local data, so the test bootstrap refuses to start unless the
 * URL targets the dedicated `reservas_test` database.
 *
 * `ALLOW_NON_TEST_DATABASE=1` is the explicit, documented escape hatch for an
 * isolated database with a different name (for example a CI service). It must
 * never be set for normal local runs.
 */

export const TEST_DATABASE_NAME = 'reservas_test';
export const NON_TEST_DATABASE_OVERRIDE = 'ALLOW_NON_TEST_DATABASE';

export interface TestDatabaseUrlInspection {
  /** Whether the URL may be used by the e2e suite. */
  allowed: boolean;
  /** Database name parsed from the URL, or `null` when it cannot be parsed. */
  databaseName: string | null;
  /** True when the explicit override allowed a non-standard database name. */
  overridden: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
}

function readDatabaseName(databaseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return null;
  }

  const raw = parsed.pathname.replace(/^\/+/, '');
  if (raw.length === 0) return null;

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Pure inspection helper, exported so unit tests and scripts can explain a
 * rejection without throwing.
 */
export function inspectTestDatabaseUrl(
  databaseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): TestDatabaseUrlInspection {
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    return {
      allowed: false,
      databaseName: null,
      overridden: false,
      reason: 'DATABASE_URL no está definida.',
    };
  }

  const databaseName = readDatabaseName(databaseUrl);
  if (databaseName === null) {
    return {
      allowed: false,
      databaseName: null,
      overridden: false,
      reason:
        'DATABASE_URL no es una URL válida de PostgreSQL (postgresql://…/base).',
    };
  }

  if (databaseName === TEST_DATABASE_NAME) {
    return { allowed: true, databaseName, overridden: false };
  }

  if (env[NON_TEST_DATABASE_OVERRIDE] === '1') {
    return { allowed: true, databaseName, overridden: true };
  }

  return {
    allowed: false,
    databaseName,
    overridden: false,
    reason:
      `La base de datos "${databaseName}" no es la base de test dedicada ` +
      `"${TEST_DATABASE_NAME}". Los tests borran datos y se niegan a ` +
      `ejecutarse. Define TEST_DATABASE_URL con una base terminada en ` +
      `"${TEST_DATABASE_NAME}" o, solo para una base aislada, exporta ` +
      `${NON_TEST_DATABASE_OVERRIDE}=1.`,
  };
}

/**
 * Fails fast (throws) when the configured database is not safe for e2e.
 * Returns the database name when the URL is accepted.
 */
export function assertTestDatabaseUrl(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  env: Record<string, string | undefined> = process.env,
): string {
  const inspection = inspectTestDatabaseUrl(databaseUrl, env);

  if (!inspection.allowed) {
    throw new Error(
      `[test-db-guard] ${inspection.reason ?? 'DATABASE_URL no es segura.'}`,
    );
  }

  if (inspection.overridden) {
    // Visible in CI logs: make the bypass explicit, never silent.
    console.warn(
      `[test-db-guard] ${NON_TEST_DATABASE_OVERRIDE}=1 permite usar ` +
        `"${inspection.databaseName}" en lugar de "${TEST_DATABASE_NAME}".`,
    );
  }

  return inspection.databaseName as string;
}
