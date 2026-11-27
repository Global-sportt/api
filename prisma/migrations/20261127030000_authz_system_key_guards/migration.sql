-- F-10: marcador estable de grupos de sistema y guardas de integridad de
-- concesiones. `slug` es editable, así que no puede identificar al grupo
-- platform-admin ni sostener la invariante Q8.

-- 1. Identificador inmutable para grupos de sistema.
ALTER TABLE "security_groups" ADD COLUMN "system_key" TEXT;

COMMENT ON COLUMN "security_groups"."system_key" IS
  'Identificador estable e inmutable de grupos de sistema. No usar slug para autorización.';

-- Backfill de los grupos existentes creados por seed/provisioning.
UPDATE "security_groups"
SET "system_key" = CASE
  WHEN "scope" = 'global' AND "slug" = 'player' THEN 'global:player'
  WHEN "scope" = 'global' AND "slug" = 'platform-admin' THEN 'global:platform-admin'
  WHEN "scope" = 'establishment' AND "slug" = 'owner' THEN 'establishment:owner'
  WHEN "scope" = 'establishment' AND "slug" = 'staff' THEN 'establishment:staff'
END
WHERE "system_key" IS NULL
  AND "is_system" = true
  AND (
    ("scope" = 'global' AND "slug" IN ('player', 'platform-admin'))
    OR ("scope" = 'establishment' AND "slug" IN ('owner', 'staff'))
  );

-- Un system_key solo puede existir en un grupo de sistema y debe coincidir
-- con su scope. Añadir un grupo de sistema nuevo exige ampliar este check en
-- una migración explícita (no se aceptan claves arbitrarias).
ALTER TABLE "security_groups"
  ADD CONSTRAINT "security_groups_system_key_check"
  CHECK (
    "system_key" IS NULL
    OR (
      "is_system"
      AND (
        ("scope" = 'global' AND "system_key" IN ('global:player', 'global:platform-admin'))
        OR ("scope" = 'establishment' AND "system_key" IN ('establishment:owner', 'establishment:staff'))
      )
    )
  );

-- Los índices parciales reproducen la unicidad real: global por system_key y
-- tenant por (establishment_id, system_key). Prisma no puede expresarlos en
-- schema.prisma; el verificador los comprueba.
CREATE UNIQUE INDEX "security_groups_global_system_key_key"
  ON "security_groups" ("system_key")
  WHERE "establishment_id" IS NULL AND "system_key" IS NOT NULL;

CREATE UNIQUE INDEX "security_groups_establishment_id_system_key_key"
  ON "security_groups" ("establishment_id", "system_key")
  WHERE "establishment_id" IS NOT NULL AND "system_key" IS NOT NULL;

-- 2. Q8 usa el marcador estable, no el slug mutable.
CREATE OR REPLACE FUNCTION "enforce_group_grant_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  group_scope "GroupScope";
  group_system_key TEXT;
  permission_scopes "PermissionScope"[];
BEGIN
  SELECT sg."scope", sg."system_key"
  INTO group_scope, group_system_key
  FROM "security_groups" sg
  WHERE sg."id" = NEW."group_id";

  IF NOT FOUND THEN
    -- La FK compuesta o simple rechazará la fila.
    RETURN NEW;
  END IF;

  IF NEW."scope" = 'platform' THEN
    IF group_scope = 'establishment' THEN
      RAISE EXCEPTION 'platform scope cannot be granted to establishment group %', NEW."group_id"
        USING ERRCODE = '42501';
    END IF;

    IF group_system_key IS DISTINCT FROM 'global:platform-admin' THEN
      RAISE EXCEPTION 'platform scope is reserved for the platform-admin system group'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW."scope" = 'establishment' AND group_scope = 'global' THEN
    RAISE EXCEPTION 'establishment scope cannot be granted to global group %', NEW."group_id"
      USING ERRCODE = '42501';
  END IF;

  SELECT p."allowed_scopes"
  INTO permission_scopes
  FROM "permissions" p
  WHERE p."id" = NEW."permission_id";

  IF NOT FOUND THEN
    -- La FK de permission_id rechazará la fila.
    RETURN NEW;
  END IF;

  -- Un array NULL no puede autorizar ningún scope: fail closed.
  IF permission_scopes IS NULL OR NOT (NEW."scope" = ANY (permission_scopes)) THEN
    RAISE EXCEPTION 'scope % is not allowed for permission %', NEW."scope", NEW."permission_id"
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Cambiar permissions.allowed_scopes no puede dejar concesiones existentes
-- fuera del catálogo. El UPDATE se aborta completo (fail closed).
CREATE OR REPLACE FUNCTION "enforce_permission_allowed_scopes"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  offending_scope "PermissionScope";
  offending_group UUID;
BEGIN
  SELECT sgp."scope", sgp."group_id"
  INTO offending_scope, offending_group
  FROM "security_group_permissions" sgp
  WHERE sgp."permission_id" = NEW."id"
    AND (
      NEW."allowed_scopes" IS NULL
      OR NOT (sgp."scope" = ANY (NEW."allowed_scopes"))
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'allowed_scopes for permission % would invalidate grant of scope % on group %',
      NEW."id", offending_scope, offending_group
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_permissions_allowed_scopes"
BEFORE UPDATE OF "allowed_scopes" ON "permissions"
FOR EACH ROW EXECUTE FUNCTION "enforce_permission_allowed_scopes"();

-- 4. system_key inmutable. Si cambia scope/establishment_id/system_key de un
-- grupo con concesiones, se revalidan todas contra el nuevo contexto.
CREATE OR REPLACE FUNCTION "enforce_security_group_grant_integrity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  offending_scope "PermissionScope";
  offending_permission UUID;
BEGIN
  IF OLD."system_key" IS NOT NULL
     AND NEW."system_key" IS DISTINCT FROM OLD."system_key" THEN
    RAISE EXCEPTION 'system_key is immutable (group %, old %, new %)',
      OLD."id", OLD."system_key", NEW."system_key"
      USING ERRCODE = '42501';
  END IF;

  IF NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."establishment_id" IS DISTINCT FROM OLD."establishment_id"
     OR NEW."system_key" IS DISTINCT FROM OLD."system_key" THEN
    SELECT sgp."scope", sgp."permission_id"
    INTO offending_scope, offending_permission
    FROM "security_group_permissions" sgp
    JOIN "permissions" p ON p."id" = sgp."permission_id"
    WHERE sgp."group_id" = NEW."id"
      AND (
        (
          sgp."scope" = 'platform'
          AND (
            NEW."scope" <> 'global'
            OR NEW."system_key" IS DISTINCT FROM 'global:platform-admin'
          )
        )
        OR (sgp."scope" = 'establishment' AND NEW."scope" = 'global')
        OR p."allowed_scopes" IS NULL
        OR NOT (sgp."scope" = ANY (p."allowed_scopes"))
      )
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'group % change would invalidate grant of scope % for permission %',
        NEW."id", offending_scope, offending_permission
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_security_groups_grant_integrity"
BEFORE UPDATE ON "security_groups"
FOR EACH ROW EXECUTE FUNCTION "enforce_security_group_grant_integrity"();
