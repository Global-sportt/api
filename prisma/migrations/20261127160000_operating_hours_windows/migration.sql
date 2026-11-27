-- Varias franjas por día: la unicidad pasa de (space_id, day_of_week) a
-- (space_id, day_of_week, opens_at_minutes) y se añade el índice compuesto
-- que usan la grilla y la generación de slots.
DROP INDEX "operating_hours_space_id_day_of_week_key";

CREATE UNIQUE INDEX "operating_hours_space_id_day_of_week_opens_at_minutes_key"
  ON "operating_hours"("space_id", "day_of_week", "opens_at_minutes");

CREATE INDEX "operating_hours_space_id_day_of_week_idx"
  ON "operating_hours"("space_id", "day_of_week");
