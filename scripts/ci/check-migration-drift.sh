#!/usr/bin/env bash
#
# Verificación de deriva entre las migraciones aplicadas y schema.prisma.
#
# `prisma migrate diff --exit-code` no se puede usar tal cual en este
# repositorio: ADR-016 documenta un drift residual aceptado e intencional —el
# índice único parcial (establishment_id, slug) que Prisma 6.19 no puede
# expresar en schema.prisma—, así que `--exit-code` devuelve 2 en cada
# ejecución.
#
# Variante equivalente que se usa aquí: se genera el SQL del diff y se elimina
# exactamente la sentencia documentada en ADR-016. Cualquier otra diferencia
# (tablas, columnas, índices, constraints) falla el paso. Si una versión de
# Prisma cambia el texto de esa sentencia, el paso también falla para forzar
# una revisión explícita.
#
# Uso (desde la raíz del repositorio de la API, con las migraciones aplicadas
# por `prepare-db` o `prisma migrate deploy`):
#   DATABASE_URL=postgresql://.../reservas_test bash scripts/ci/check-migration-drift.sh

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "::error::DATABASE_URL es obligatoria para verificar la deriva" >&2
  exit 1
fi

allowed_statement='CREATE UNIQUE INDEX "security_groups_establishment_id_slug_key" ON "security_groups"("establishment_id", "slug");'

status=0
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code > /dev/null 2>&1 || status=$?

if [[ $status -eq 0 ]]; then
  echo "Sin deriva de migraciones."
  exit 0
fi

if [[ $status -ne 2 ]]; then
  echo "::error::prisma migrate diff falló (exit $status); no se pudo verificar la deriva" >&2
  exit 1
fi

# Exit 2 significa que hay diferencias. Se inspecciona el SQL para distinguir
# el residual documentado de una deriva real.
if ! diff_sql="$(npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script)"; then
  echo "::error::prisma migrate diff --script falló; no se pudo clasificar la deriva" >&2
  exit 1
fi

# Descarta líneas vacías y comentarios del script SQL generado.
statements="$(printf '%s\n' "$diff_sql" \
  | sed -e 's/\r$//' \
  | grep -v -E '^[[:space:]]*(--.*)?$' \
  || true)"

unexpected="$(printf '%s\n' "$statements" \
  | grep -v -F -x "$allowed_statement" \
  || true)"

if [[ -n "$unexpected" ]]; then
  echo "::error::Deriva de migraciones: el esquema aplicado no coincide con prisma/schema.prisma" >&2
  printf '%s\n' "$diff_sql" >&2
  exit 1
fi

if printf '%s\n' "$statements" | grep -F -x -q "$allowed_statement"; then
  echo "Drift residual aceptado (ADR-016): índice único parcial security_groups_establishment_id_slug_key."
fi

echo "Sin deriva de migraciones."
