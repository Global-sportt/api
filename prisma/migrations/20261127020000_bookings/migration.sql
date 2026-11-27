-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM (
  'pending_payment',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'expired',
  'no_show'
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "public_code" TEXT NOT NULL,
    "establishment_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'confirmed',
    "total_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_public_code_key" ON "bookings"("public_code");

-- CreateIndex
-- La clave es opcional. PostgreSQL permite múltiples NULL, así que las
-- peticiones sin Idempotency-Key no compiten entre sí.
CREATE UNIQUE INDEX "bookings_created_by_user_id_idempotency_key_key"
  ON "bookings"("created_by_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "bookings_space_id_starts_at_idx" ON "bookings"("space_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_player_id_starts_at_idx" ON "bookings"("player_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_establishment_id_starts_at_idx" ON "bookings"("establishment_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_status_expires_at_idx" ON "bookings"("status", "expires_at");

-- Composite key required by the cross-tenant FK below.
CREATE UNIQUE INDEX "spaces_id_establishment_id_key" ON "spaces"("id", "establishment_id");

-- AddForeignKey
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_establishment_id_fkey"
  FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_space_id_fkey"
  FOREIGN KEY ("space_id") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_player_id_fkey"
  FOREIGN KEY ("player_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Backstop de integridad multi-sede: el par (space_id, establishment_id) debe
-- existir en spaces. La API responde 404 SPACE_NOT_FOUND antes de llegar aquí.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_space_id_establishment_id_fkey"
  FOREIGN KEY ("space_id", "establishment_id") REFERENCES "spaces"("id", "establishment_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_time_range_check"
  CHECK ("ends_at" > "starts_at");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_total_minor_check"
  CHECK ("total_minor" >= 0);

-- Un hold sin vencimiento no es un hold: el job de expiración necesita una
-- fecha límite para liberar la franja.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_pending_expiry_check"
  CHECK ("status" <> 'pending_payment' OR "expires_at" IS NOT NULL);

-- Exclusion GiST: una misma cancha no puede tener dos reservas activas que se
-- solapen. El rango es semiabierto [starts_at, ends_at): 10:00-11:00 y
-- 11:00-12:00 conviven; 10:00-11:00 y 10:30-11:30 no.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "space_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" IN ('pending_payment', 'confirmed', 'checked_in'));
