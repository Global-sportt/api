-- Tarifa fija por hora en unidades menores (COP). Opcional: los espacios que
-- ya existen siguen operando con sus reglas de precio.
ALTER TABLE "spaces" ADD COLUMN "base_price_minor" BIGINT;
