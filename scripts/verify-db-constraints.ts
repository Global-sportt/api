/**
 * Verificador determinista de las constraints SQL que Prisma no puede
 * representar en `schema.prisma` (F-04) y de las invariantes Q8/F-10.
 *
 * Uso:
 *   npm run db:verify-constraints --workspace=@reservas/api
 *   DATABASE_URL=...postgresql://.../reservas_test npx ts-node scripts/verify-db-constraints.ts
 *
 * Falla con exit code 1 si falta cualquier FK, constraint de exclusión,
 * índice parcial, trigger o marcador de sistema. Se ejecuta en cada
 * `npm run test:e2e` después de migrar y sembrar `reservas_test`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Row = Record<string, unknown>;

const checks: Array<{ name: string; run: () => Promise<void> }> = [];

function check(name: string, run: () => Promise<void>): void {
  checks.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function query<T extends Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

function includesAll(value: string, fragments: readonly string[]): boolean {
  return fragments.every((fragment) => value.includes(fragment));
}

async function constraintDefinition(name: string): Promise<string | null> {
  const rows = await query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'public.bookings'::regclass
        AND conname = $1`,
    name,
  );
  return rows[0]?.definition ?? null;
}

async function indexDefinitions(): Promise<Map<string, string>> {
  const rows = await query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'security_groups'`,
  );
  return new Map(rows.map((row) => [row.indexname, row.indexdef]));
}

check('migración authz_system_key_guards aplicada', async () => {
  const rows = await query<{ count: bigint }>(
    `SELECT count(*) AS count
       FROM "_prisma_migrations"
      WHERE migration_name = '20261127030000_authz_system_key_guards'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL`,
  );
  assert(
    rows[0]?.count === 1n,
    'La migración 20261127030000_authz_system_key_guards no está aplicada',
  );
});

check('columna security_groups.system_key', async () => {
  const rows = await query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'security_groups'
        AND column_name = 'system_key'`,
  );
  assert(rows.length === 1, 'Falta security_groups.system_key');
  assert(rows[0].data_type === 'text', 'system_key debe ser TEXT');
  assert(rows[0].is_nullable === 'YES', 'system_key debe ser nullable');
});

check('FK compuesta bookings(space_id, establishment_id)', async () => {
  const definition = await constraintDefinition(
    'bookings_space_id_establishment_id_fkey',
  );
  assert(definition, 'Falta la FK compuesta de bookings');
  assert(
    includesAll(definition, [
      'FOREIGN KEY (space_id, establishment_id)',
      'REFERENCES spaces(id, establishment_id)',
      'ON DELETE CASCADE',
    ]),
    `FK compuesta inesperada: ${definition}`,
  );
});

check('FK simple bookings(space_id) usada por Prisma', async () => {
  const definition = await constraintDefinition('bookings_space_id_fkey');
  assert(definition, 'Falta bookings_space_id_fkey');
  assert(
    includesAll(definition, [
      'FOREIGN KEY (space_id) REFERENCES spaces(id)',
      'ON DELETE CASCADE',
    ]),
    `FK simple inesperada: ${definition}`,
  );
});

check('exclusión bookings_no_overlap (GiST)', async () => {
  const rows = await query<{ contype: string; definition: string }>(
    `SELECT contype::text AS contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'public.bookings'::regclass
        AND conname = 'bookings_no_overlap'`,
  );
  assert(rows.length === 1, 'Falta bookings_no_overlap');
  assert(rows[0].contype === 'x', 'bookings_no_overlap no es EXCLUDE');
  assert(
    includesAll(rows[0].definition, [
      'EXCLUDE USING gist',
      'space_id WITH =',
      "tstzrange(starts_at, ends_at, '[)'::text) WITH &&",
      "'pending_payment'",
      "'confirmed'",
      "'checked_in'",
    ]),
    `Definición de exclusión inesperada: ${rows[0].definition}`,
  );
});

check('checks de bookings (rango, total, hold)', async () => {
  const expected: Record<string, readonly string[]> = {
    bookings_time_range_check: ['CHECK', 'ends_at > starts_at'],
    bookings_total_minor_check: ['CHECK', 'total_minor >= 0'],
    bookings_pending_expiry_check: [
      'CHECK',
      "status <> 'pending_payment'",
      'expires_at IS NOT NULL',
    ],
  };

  for (const [name, fragments] of Object.entries(expected)) {
    const definition = await constraintDefinition(name);
    assert(definition, `Falta ${name}`);
    assert(
      includesAll(definition, fragments),
      `Definición inesperada de ${name}: ${definition}`,
    );
  }
});

check('índices parciales de security_groups', async () => {
  const indexes = await indexDefinitions();

  const expected: Record<string, readonly string[]> = {
    security_groups_global_slug_key: [
      'CREATE UNIQUE INDEX',
      'USING btree (slug)',
      'WHERE (establishment_id IS NULL)',
    ],
    security_groups_establishment_id_slug_key: [
      'CREATE UNIQUE INDEX',
      'USING btree (establishment_id, slug)',
      'WHERE (establishment_id IS NOT NULL)',
    ],
    security_groups_global_system_key_key: [
      'CREATE UNIQUE INDEX',
      'USING btree (system_key)',
      'WHERE ((establishment_id IS NULL) AND (system_key IS NOT NULL))',
    ],
    security_groups_establishment_id_system_key_key: [
      'CREATE UNIQUE INDEX',
      'USING btree (establishment_id, system_key)',
      'WHERE ((establishment_id IS NOT NULL) AND (system_key IS NOT NULL))',
    ],
  };

  for (const [name, fragments] of Object.entries(expected)) {
    const definition = indexes.get(name);
    assert(definition, `Falta el índice parcial ${name}`);
    assert(
      includesAll(definition, fragments),
      `Índice ${name} inesperado: ${definition}`,
    );
  }

  const tenantSlug = indexes.get(
    'security_groups_establishment_id_slug_key',
  );
  assert(
    tenantSlug && tenantSlug.includes('WHERE'),
    'El índice tenant (establishment_id, slug) dejó de ser parcial',
  );
});

check('trigger Q8 usa system_key y no slug', async () => {
  const rows = await query<{ definition: string }>(
    `SELECT pg_get_functiondef('public.enforce_group_grant_scope()'::regprocedure) AS definition`,
  );
  assert(rows.length === 1, 'Falta enforce_group_grant_scope()');
  const definition = rows[0].definition;
  assert(
    definition.includes('system_key'),
    'enforce_group_grant_scope no usa system_key',
  );
  assert(
    !definition.includes('group_slug'),
    'enforce_group_grant_scope todavía depende del slug mutable',
  );
  assert(
    definition.includes("'global:platform-admin'"),
    'enforce_group_grant_scope no reserva platform para global:platform-admin',
  );
});

check('triggers esperados y sus eventos', async () => {
  const rows = await query<{
    trigger_name: string;
    table_name: string;
    function_name: string;
    definition: string;
  }>(
    `SELECT t.tgname AS trigger_name,
            c.relname AS table_name,
            p.proname AS function_name,
            pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  );
  const triggers = new Map(rows.map((row) => [row.trigger_name, row]));

  const versionTriggers: Record<string, string> = {
    trg_permissions_authz_version: 'permissions',
    trg_security_groups_authz_version: 'security_groups',
    trg_security_group_permissions_authz_version:
      'security_group_permissions',
    trg_memberships_authz_version: 'memberships',
    trg_user_global_groups_authz_version: 'user_global_groups',
    trg_membership_groups_authz_version: 'membership_groups',
  };

  for (const [name, table] of Object.entries(versionTriggers)) {
    const trigger = triggers.get(name);
    assert(trigger, `Falta el trigger ${name}`);
    assert(
      trigger.table_name === table,
      `${name} está en ${trigger.table_name}, se esperaba ${table}`,
    );
    assert(
      trigger.function_name === 'bump_authz_version',
      `${name} no ejecuta bump_authz_version`,
    );
    assert(
      trigger.definition.includes('AFTER INSERT OR DELETE OR UPDATE'),
      `${name} no es AFTER INSERT/UPDATE/DELETE`,
    );
  }

  const required: Record<
    string,
    { table: string; fn: string; fragments: readonly string[] }
  > = {
    trg_security_group_permissions_grant_scope: {
      table: 'security_group_permissions',
      fn: 'enforce_group_grant_scope',
      fragments: ['BEFORE INSERT OR UPDATE ON', 'FOR EACH ROW'],
    },
    trg_permissions_allowed_scopes: {
      table: 'permissions',
      fn: 'enforce_permission_allowed_scopes',
      fragments: ['BEFORE UPDATE OF allowed_scopes ON', 'FOR EACH ROW'],
    },
    trg_security_groups_grant_integrity: {
      table: 'security_groups',
      fn: 'enforce_security_group_grant_integrity',
      fragments: ['BEFORE UPDATE ON', 'FOR EACH ROW'],
    },
  };

  for (const [name, expected] of Object.entries(required)) {
    const trigger = triggers.get(name);
    assert(trigger, `Falta el trigger ${name}`);
    assert(
      trigger.table_name === expected.table,
      `${name} está en ${trigger.table_name}, se esperaba ${expected.table}`,
    );
    assert(
      trigger.function_name === expected.fn,
      `${name} no ejecuta ${expected.fn}`,
    );
    assert(
      includesAll(trigger.definition, expected.fragments),
      `${name} tiene un evento inesperado: ${trigger.definition}`,
    );
  }
});

check('check de system_key y extensión btree_gist', async () => {
  const rows = await query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'public.security_groups'::regclass
        AND conname = 'security_groups_system_key_check'`,
  );
  assert(rows.length === 1, 'Falta security_groups_system_key_check');
  assert(
    includesAll(rows[0].definition, [
      'system_key IS NULL',
      'is_system',
      "'global:platform-admin'",
      "'establishment:owner'",
    ]),
    `Check de system_key inesperado: ${rows[0].definition}`,
  );

  const extension = await query<{ count: bigint }>(
    `SELECT count(*) AS count FROM pg_extension WHERE extname = 'btree_gist'`,
  );
  assert(extension[0]?.count === 1n, 'Falta la extensión btree_gist');
});

check('marcadores de sistema sembrados y coherentes', async () => {
  const groups = await query<{
    slug: string;
    scope: string;
    system_key: string | null;
    is_system: boolean;
  }>(
    `SELECT slug, scope::text AS scope, system_key, is_system
       FROM security_groups`,
  );

  const expectedBySlug: Record<string, string> = {
    'global:player': 'player',
    'global:platform-admin': 'platform-admin',
    'establishment:owner': 'owner',
    'establishment:staff': 'staff',
  };

  const knownSlugs = new Set(Object.values(expectedBySlug));
  const known = groups.filter((group) => knownSlugs.has(group.slug));

  for (const group of groups) {
    if (group.system_key === null) continue;
    assert(group.is_system, `Grupo ${group.slug} tiene system_key sin is_system`);
    assert(
      group.system_key.startsWith(`${group.scope}:`),
      `system_key ${group.system_key} no coincide con scope ${group.scope}`,
    );
  }

  for (const group of known) {
    const expectedKey = Object.entries(expectedBySlug).find(
      ([, slug]) => slug === group.slug,
    )?.[0];
    assert(
      expectedKey,
      `No hay system_key esperado para el slug ${group.slug}`,
    );
    assert(
      group.system_key === expectedKey,
      `El grupo ${group.slug} (${group.scope}) tiene system_key ${group.system_key ?? 'NULL'}, se esperaba ${expectedKey}`,
    );
  }

  for (const key of ['global:player', 'global:platform-admin']) {
    const matches = groups.filter((group) => group.system_key === key);
    assert(
      matches.length === 1,
      `Se esperaba exactamente un grupo ${key}, hay ${matches.length}`,
    );
  }

  const establishments = await query<{ count: bigint }>(
    `SELECT count(*) AS count FROM establishments`,
  );
  const establishmentCount = establishments[0]?.count ?? 0n;

  if (establishmentCount > 0n) {
    const tenants = await query<{ establishment_id: string }>(
      `SELECT e.id AS establishment_id
         FROM establishments e
        WHERE NOT EXISTS (
          SELECT 1 FROM security_groups sg
           WHERE sg.establishment_id = e.id
             AND sg.system_key = 'establishment:owner'
        )
           OR NOT EXISTS (
          SELECT 1 FROM security_groups sg
           WHERE sg.establishment_id = e.id
             AND sg.system_key = 'establishment:staff'
        )`,
    );
    assert(
      tenants.length === 0,
      `Hay ${tenants.length} sede(s) sin grupos system_key owner/staff provisionados`,
    );
  }
});

async function main(): Promise<void> {
  let failures = 0;

  for (const item of checks) {
    try {
      await item.run();
      console.log(`[OK] ${item.name}`);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[FAIL] ${item.name}: ${message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} verificación(es) de constraints fallaron.`);
  }

  console.log(`\n${checks.length} verificaciones SQL OK.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
