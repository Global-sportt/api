/*
  Warnings:

  - You are about to drop the column `role` on the `users` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "GroupScope" AS ENUM ('global', 'establishment');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('own', 'establishment', 'platform');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('invited', 'active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "EstablishmentStatus" AS ENUM ('pending', 'active', 'suspended');

-- AlterTable
ALTER TABLE "users" DROP COLUMN "role";

-- DropEnum
DROP TYPE "UserRole";

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "allowed_scopes" "PermissionScope"[],
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_groups" (
    "id" UUID NOT NULL,
    "establishment_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "GroupScope" NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "security_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_group_permissions" (
    "group_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "scope" "PermissionScope" NOT NULL,

    CONSTRAINT "security_group_permissions_pkey" PRIMARY KEY ("group_id","permission_id")
);

-- CreateTable
CREATE TABLE "establishments" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "status" "EstablishmentStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "establishments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'invited',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_global_groups" (
    "user_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "group_scope" "GroupScope" NOT NULL DEFAULT 'global',

    CONSTRAINT "user_global_groups_pkey" PRIMARY KEY ("user_id","group_id")
);

-- CreateTable
CREATE TABLE "membership_groups" (
    "membership_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,

    CONSTRAINT "membership_groups_pkey" PRIMARY KEY ("membership_id","group_id")
);

-- CreateTable
CREATE TABLE "authorization_versions" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "authorization_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "security_groups_scope_idx" ON "security_groups"("scope");

-- CreateIndex
-- Los grupos globales no tienen establecimiento. PostgreSQL trata cada NULL
-- como distinto en un índice único, por eso la unicidad global usa un índice
-- parcial y la unicidad por tenant otro.
CREATE UNIQUE INDEX "security_groups_global_slug_key" ON "security_groups"("slug") WHERE "establishment_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "security_groups_establishment_id_slug_key" ON "security_groups"("establishment_id", "slug") WHERE "establishment_id" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "security_groups_id_scope_key" ON "security_groups"("id", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "security_groups_id_establishment_id_key" ON "security_groups"("id", "establishment_id");

-- CreateIndex
CREATE INDEX "security_group_permissions_permission_id_idx" ON "security_group_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "establishments_slug_key" ON "establishments"("slug");

-- CreateIndex
CREATE INDEX "memberships_establishment_id_status_idx" ON "memberships"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_establishment_id_key" ON "memberships"("user_id", "establishment_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_id_establishment_id_key" ON "memberships"("id", "establishment_id");

-- AddForeignKey
ALTER TABLE "security_groups" ADD CONSTRAINT "security_groups_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_group_permissions" ADD CONSTRAINT "security_group_permissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "security_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_group_permissions" ADD CONSTRAINT "security_group_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_global_groups" ADD CONSTRAINT "user_global_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_global_groups" ADD CONSTRAINT "user_global_groups_group_id_group_scope_fkey" FOREIGN KEY ("group_id", "group_scope") REFERENCES "security_groups"("id", "scope") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_groups" ADD CONSTRAINT "membership_groups_membership_id_establishment_id_fkey" FOREIGN KEY ("membership_id", "establishment_id") REFERENCES "memberships"("id", "establishment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_groups" ADD CONSTRAINT "membership_groups_group_id_establishment_id_fkey" FOREIGN KEY ("group_id", "establishment_id") REFERENCES "security_groups"("id", "establishment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints
-- Un grupo global no pertenece a ninguna sede; uno de sede siempre pertenece a una.
ALTER TABLE "security_groups"
  ADD CONSTRAINT "security_groups_scope_establishment_check"
  CHECK (
    ("scope" = 'global' AND "establishment_id" IS NULL)
    OR ("scope" = 'establishment' AND "establishment_id" IS NOT NULL)
  );

-- Solo los grupos globales pueden asignarse desde user_global_groups.
ALTER TABLE "user_global_groups"
  ADD CONSTRAINT "user_global_groups_group_scope_check"
  CHECK ("group_scope" = 'global');

-- memberships.status usa el enum MembershipStatus; PostgreSQL ya rechaza
-- valores fuera de invited/active/suspended/removed.

-- Autorización: versión global que invalida la caché de permisos.
CREATE OR REPLACE FUNCTION "bump_authz_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "authorization_versions"
  SET "version" = "version" + 1,
      "updated_at" = now()
  WHERE "id" = 1;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_permissions_authz_version"
AFTER INSERT OR UPDATE OR DELETE ON "permissions"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_authz_version"();

CREATE TRIGGER "trg_security_groups_authz_version"
AFTER INSERT OR UPDATE OR DELETE ON "security_groups"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_authz_version"();

CREATE TRIGGER "trg_security_group_permissions_authz_version"
AFTER INSERT OR UPDATE OR DELETE ON "security_group_permissions"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_authz_version"();

CREATE TRIGGER "trg_memberships_authz_version"
AFTER INSERT OR UPDATE OR DELETE ON "memberships"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_authz_version"();

CREATE TRIGGER "trg_user_global_groups_authz_version"
AFTER INSERT OR UPDATE OR DELETE ON "user_global_groups"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_authz_version"();

CREATE TRIGGER "trg_membership_groups_authz_version"
AFTER INSERT OR UPDATE OR DELETE ON "membership_groups"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_authz_version"();

-- Restricción de escalamiento de privilegios (Q8) y de scopes del catálogo.
-- Un grupo de sede solo recibe own/establishment; solo el grupo global
-- platform-admin recibe platform; un grupo global solo recibe own/platform.
-- Además, el scope concedido debe estar en permissions.allowed_scopes.
CREATE OR REPLACE FUNCTION "enforce_group_grant_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  group_scope "GroupScope";
  group_slug TEXT;
  permission_scopes "PermissionScope"[];
BEGIN
  SELECT sg."scope", sg."slug"
  INTO group_scope, group_slug
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

    IF group_slug IS DISTINCT FROM 'platform-admin' THEN
      RAISE EXCEPTION 'platform scope is reserved for the platform-admin global group'
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

CREATE TRIGGER "trg_security_group_permissions_grant_scope"
BEFORE INSERT OR UPDATE ON "security_group_permissions"
FOR EACH ROW EXECUTE FUNCTION "enforce_group_grant_scope"();

-- Fila singleton de versión. updated_at no tiene default en Prisma (@updatedAt).
INSERT INTO "authorization_versions" ("id", "version", "updated_at")
VALUES (1, 1, now())
ON CONFLICT ("id") DO NOTHING;
