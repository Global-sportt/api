-- Perfil del establecimiento: datos de contacto y políticas operativas.
-- Todos los campos son opcionales para no invalidar las sedes existentes.
--
-- Nota: `prisma migrate diff` también propone un índice único total sobre
-- `security_groups(establishment_id, slug)`. La unicidad real de esa tabla son
-- índices parciales creados a mano (ADR-016); ese índice no se incluye aquí.

-- AlterTable
ALTER TABLE "establishments" ADD COLUMN     "address" TEXT,
ADD COLUMN     "cancellation_policy" TEXT,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "rules" TEXT,
ADD COLUMN     "usage_policy" TEXT;

-- CheckConstraints
-- Límites del contrato replicados como backstop en la base de datos.
ALTER TABLE "establishments"
  ADD CONSTRAINT "establishments_address_length_check"
  CHECK ("address" IS NULL OR char_length("address") <= 300);

ALTER TABLE "establishments"
  ADD CONSTRAINT "establishments_contact_phone_length_check"
  CHECK ("contact_phone" IS NULL OR char_length("contact_phone") <= 40);

ALTER TABLE "establishments"
  ADD CONSTRAINT "establishments_cancellation_policy_length_check"
  CHECK ("cancellation_policy" IS NULL OR char_length("cancellation_policy") <= 4000);

ALTER TABLE "establishments"
  ADD CONSTRAINT "establishments_usage_policy_length_check"
  CHECK ("usage_policy" IS NULL OR char_length("usage_policy") <= 4000);

ALTER TABLE "establishments"
  ADD CONSTRAINT "establishments_rules_length_check"
  CHECK ("rules" IS NULL OR char_length("rules") <= 4000);

-- Rollback manual (Prisma no genera migraciones inversas):
-- ALTER TABLE "establishments"
--   DROP CONSTRAINT IF EXISTS "establishments_address_length_check",
--   DROP CONSTRAINT IF EXISTS "establishments_contact_phone_length_check",
--   DROP CONSTRAINT IF EXISTS "establishments_cancellation_policy_length_check",
--   DROP CONSTRAINT IF EXISTS "establishments_usage_policy_length_check",
--   DROP CONSTRAINT IF EXISTS "establishments_rules_length_check";
-- ALTER TABLE "establishments"
--   DROP COLUMN IF EXISTS "address",
--   DROP COLUMN IF EXISTS "cancellation_policy",
--   DROP COLUMN IF EXISTS "contact_email",
--   DROP COLUMN IF EXISTS "contact_phone",
--   DROP COLUMN IF EXISTS "rules",
--   DROP COLUMN IF EXISTS "usage_policy";
