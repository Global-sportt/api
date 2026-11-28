-- Método de pago de la reserva.
--
-- La columna se añade nullable para poder rellenar las reservas históricas
-- con `cash` (el único medio soportado hasta ahora) y solo después se exige
-- NOT NULL. Sin el backfill, la migración fallaría en cualquier base con
-- reservas existentes.
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'transfer', 'card');

ALTER TABLE "bookings" ADD COLUMN "payment_method" "PaymentMethod";

UPDATE "bookings" SET "payment_method" = 'cash' WHERE "payment_method" IS NULL;

ALTER TABLE "bookings" ALTER COLUMN "payment_method" SET NOT NULL;
