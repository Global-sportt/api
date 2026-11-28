-- Cierre diario: foto congelada por sede y totales por espacio.
--
-- `date` es la fecha local de la sede (calendario), no un instante: se guarda
-- como DATE para que la unicidad (establishment_id, date) no dependa de la
-- zona horaria del servidor.
CREATE TABLE "day_closes" (
    "id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "closed_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_by_user_id" UUID NOT NULL,
    "reopened_at" TIMESTAMPTZ(6),
    "reopened_by_user_id" UUID,
    "bookings_count" INTEGER NOT NULL,
    "no_show_count" INTEGER NOT NULL,
    "cancelled_count" INTEGER NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "day_closes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "day_close_space_totals" (
    "id" UUID NOT NULL,
    "day_close_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "bookings_count" INTEGER NOT NULL,
    "no_show_count" INTEGER NOT NULL,
    "total_minor" BIGINT NOT NULL,

    CONSTRAINT "day_close_space_totals_pkey" PRIMARY KEY ("id")
);

-- Un solo cierre por sede y fecha local. Un cierre reabierto conserva la fila
-- y se actualiza al volver a cerrar; no se inserta un duplicado.
CREATE UNIQUE INDEX "day_closes_establishment_id_date_key"
  ON "day_closes"("establishment_id", "date");

-- Un solo total por espacio dentro de un cierre.
CREATE UNIQUE INDEX "day_close_space_totals_day_close_id_space_id_key"
  ON "day_close_space_totals"("day_close_id", "space_id");

ALTER TABLE "day_closes"
  ADD CONSTRAINT "day_closes_establishment_id_fkey"
  FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- El actor del cierre es evidencia de auditoría: RESTRICT impide borrar un
-- usuario que firmó un cierre.
ALTER TABLE "day_closes"
  ADD CONSTRAINT "day_closes_closed_by_user_id_fkey"
  FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "day_closes"
  ADD CONSTRAINT "day_closes_reopened_by_user_id_fkey"
  FOREIGN KEY ("reopened_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "day_close_space_totals"
  ADD CONSTRAINT "day_close_space_totals_day_close_id_fkey"
  FOREIGN KEY ("day_close_id") REFERENCES "day_closes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- `space_id` no lleva FK a `spaces`: la foto es inmutable y debe sobrevivir al
-- borrado del espacio. RESTRICT rompería la cascada de borrado de la sede y
-- CASCADE borraría totales contables.

-- La foto es un agregado no negativo. `no_show_count` es un subconjunto de
-- `bookings_count` (el no-show sí suma al total y al conteo de reservas).
ALTER TABLE "day_closes"
  ADD CONSTRAINT "day_closes_counts_check"
  CHECK (
    "bookings_count" >= 0 AND
    "no_show_count" >= 0 AND
    "no_show_count" <= "bookings_count" AND
    "cancelled_count" >= 0
  );

ALTER TABLE "day_closes"
  ADD CONSTRAINT "day_closes_total_minor_check"
  CHECK ("total_minor" >= 0);

ALTER TABLE "day_close_space_totals"
  ADD CONSTRAINT "day_close_space_totals_counts_check"
  CHECK (
    "bookings_count" >= 0 AND
    "no_show_count" >= 0 AND
    "no_show_count" <= "bookings_count"
  );

ALTER TABLE "day_close_space_totals"
  ADD CONSTRAINT "day_close_space_totals_total_minor_check"
  CHECK ("total_minor" >= 0);
