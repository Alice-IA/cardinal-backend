-- ─────────────────────────────────────────────────────────────
-- `container_port` deja de ser UNIQUE.
--
-- Es el puerto INTERNO del sandbox (p. ej. SANDBOX_PORT=4500 del nodo) y se
-- comparte entre todos los contenedores de ese nodo; no se publica en el host.
-- El UNIQUE impedía que el segundo callback escribiera su puerto.
--
-- Nombre real verificado en `pg_indexes`:
--   CREATE UNIQUE INDEX containers_container_port_key
--     ON public.containers USING btree (container_port)
--
-- Se cubren las dos formas (índice o constraint) para que la migración sea
-- segura en bases creadas con distintas versiones del esquema.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "containers"
  DROP CONSTRAINT IF EXISTS "containers_container_port_key";

DROP INDEX IF EXISTS "containers_container_port_key";
