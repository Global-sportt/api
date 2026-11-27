import {
  NON_TEST_DATABASE_OVERRIDE,
  TEST_DATABASE_NAME,
  assertTestDatabaseUrl,
  inspectTestDatabaseUrl,
} from './test-database';

const SAFE_URL =
  'postgresql://reservas:secret@127.0.0.1:5432/reservas_test?schema=public';
const DEV_URL =
  'postgresql://reservas:super-secret-password@127.0.0.1:5432/reservas?schema=public';

describe('test database guard', () => {
  it('acepta la base dedicada reservas_test', () => {
    expect(inspectTestDatabaseUrl(SAFE_URL, {})).toEqual({
      allowed: true,
      databaseName: TEST_DATABASE_NAME,
      overridden: false,
    });
    expect(assertTestDatabaseUrl(SAFE_URL, {})).toBe(TEST_DATABASE_NAME);
  });

  it('rechaza la base de desarrollo sin override', () => {
    const inspection = inspectTestDatabaseUrl(DEV_URL, {});

    expect(inspection.allowed).toBe(false);
    expect(inspection.databaseName).toBe('reservas');
    expect(inspection.reason).toContain('reservas_test');
    expect(() => assertTestDatabaseUrl(DEV_URL, {})).toThrow(
      /test-db-guard.*reservas.*reservas_test/,
    );
  });

  it('no filtra credenciales en el mensaje de error', () => {
    expect(() => assertTestDatabaseUrl(DEV_URL, {})).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret-password'),
      }),
    );
  });

  it('rechaza una URL ausente, inválida o sin nombre de base', () => {
    for (const url of [
      undefined,
      '',
      'no-es-una-url',
      'mysql://user:pass@127.0.0.1:3306/reservas_test',
      'postgresql://reservas:reservas@127.0.0.1:5432/',
    ]) {
      expect(inspectTestDatabaseUrl(url, {}).allowed).toBe(false);
      expect(() => assertTestDatabaseUrl(url, {})).toThrow(/test-db-guard/);
    }
  });

  it('solo acepta el override explícito ALLOW_NON_TEST_DATABASE=1', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      expect(
        inspectTestDatabaseUrl(DEV_URL, {
          [NON_TEST_DATABASE_OVERRIDE]: value,
        }).allowed,
      ).toBe(false);
    }

    const overridden = inspectTestDatabaseUrl(DEV_URL, {
      [NON_TEST_DATABASE_OVERRIDE]: '1',
    });
    expect(overridden).toEqual({
      allowed: true,
      databaseName: 'reservas',
      overridden: true,
    });

    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        assertTestDatabaseUrl(DEV_URL, { [NON_TEST_DATABASE_OVERRIDE]: '1' }),
      ).toBe('reservas');
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('ALLOW_NON_TEST_DATABASE=1'),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('acepta parámetros de conexión y nombres codificados', () => {
    expect(
      inspectTestDatabaseUrl(
        'postgresql://u:p@127.0.0.1:5432/reservas_test?schema=public&connection_limit=5',
        {},
      ).databaseName,
    ).toBe('reservas_test');

    expect(
      inspectTestDatabaseUrl(
        'postgresql://u:p@127.0.0.1:5432/reservas%5Ftest',
        {},
      ).databaseName,
    ).toBe('reservas_test');
  });
});
