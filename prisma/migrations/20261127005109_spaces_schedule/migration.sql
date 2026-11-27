-- CreateEnum
CREATE TYPE "SpaceStatus" AS ENUM ('active', 'inactive', 'maintenance');

-- CreateTable
CREATE TABLE "spaces" (
    "id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sport" TEXT,
    "slot_minutes" INTEGER NOT NULL DEFAULT 60,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
    "status" "SpaceStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operating_hours" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "opens_at_minutes" INTEGER NOT NULL,
    "closes_at_minutes" INTEGER NOT NULL,

    CONSTRAINT "operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_exceptions" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "opens_at_minutes" INTEGER,
    "closes_at_minutes" INTEGER,
    "reason" TEXT,

    CONSTRAINT "schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_rules" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "day_of_week" INTEGER,
    "starts_at_minutes" INTEGER NOT NULL,
    "ends_at_minutes" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spaces_establishment_id_slug_key" ON "spaces"("establishment_id", "slug");

-- CreateIndex
CREATE INDEX "spaces_establishment_id_status_idx" ON "spaces"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "operating_hours_space_id_day_of_week_key" ON "operating_hours"("space_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_exceptions_space_id_date_key" ON "schedule_exceptions"("space_id", "date");

-- CreateIndex
CREATE INDEX "price_rules_space_id_day_of_week_idx" ON "price_rules"("space_id", "day_of_week");

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operating_hours" ADD CONSTRAINT "operating_hours_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints
-- Una cancha debe tener una duración de franja positiva y un buffer no negativo.
ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_slot_minutes_check"
  CHECK ("slot_minutes" > 0 AND "slot_minutes" <= 1440);

ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_buffer_minutes_check"
  CHECK ("buffer_minutes" >= 0 AND "buffer_minutes" < 1440);

-- 0 = domingo ... 6 = sábado.
ALTER TABLE "operating_hours"
  ADD CONSTRAINT "operating_hours_day_of_week_check"
  CHECK ("day_of_week" BETWEEN 0 AND 6);

-- 0 = 00:00 y 1440 = 24:00; la apertura debe ser anterior al cierre.
ALTER TABLE "operating_hours"
  ADD CONSTRAINT "operating_hours_minutes_check"
  CHECK ("opens_at_minutes" >= 0 AND "opens_at_minutes" < "closes_at_minutes" AND "closes_at_minutes" <= 1440);

-- Una excepción cerrada no lleva horario alterno; si lleva horario, debe ser
-- un rango completo y válido. Sin horario y con is_closed = false se usan las
-- horas habituales de la cancha.
ALTER TABLE "schedule_exceptions"
  ADD CONSTRAINT "schedule_exceptions_minutes_check"
  CHECK (
    ("opens_at_minutes" IS NULL AND "closes_at_minutes" IS NULL)
    OR (
      "is_closed" = false
      AND "opens_at_minutes" IS NOT NULL
      AND "closes_at_minutes" IS NOT NULL
      AND "opens_at_minutes" >= 0
      AND "opens_at_minutes" < "closes_at_minutes"
      AND "closes_at_minutes" <= 1440
    )
  );

ALTER TABLE "schedule_exceptions"
  ADD CONSTRAINT "schedule_exceptions_closed_hours_check"
  CHECK ("is_closed" = false OR ("opens_at_minutes" IS NULL AND "closes_at_minutes" IS NULL));

-- day_of_week NULL significa "todos los días".
ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_day_of_week_check"
  CHECK ("day_of_week" IS NULL OR "day_of_week" BETWEEN 0 AND 6);

ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_minutes_check"
  CHECK ("starts_at_minutes" >= 0 AND "starts_at_minutes" < "ends_at_minutes" AND "ends_at_minutes" <= 1440);

ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_amount_minor_check"
  CHECK ("amount_minor" >= 0);
