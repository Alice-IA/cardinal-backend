-- ─────────────────────────────────────────────────────────────
-- Fase provision: estado de aprovisionamiento en `containers`.
--
-- El backend es la única fuente de verdad del estado. `job_id` es el
-- identificador que genera el backend y que el Sandbox Manager devuelve tal
-- cual (decisión A); es UNIQUE porque un job pertenece a una sola fila.
--
-- Columnas añadidas:
--   * job_id, provider, transport, tls_servername
--   * provision_attempts / agent_creation_attempts (DOS contadores; el
--     reintento del contenedor toca solo el primero, el del agente solo el
--     segundo — corrección 1 del documento)
--   * provision_error / provision_error_code (siempre code + message, máx.
--     500 chars, sin stack ni objetos)
--
-- `internal_host` y `container_id` no estaban en la lista original del
-- documento, pero el callback y el test 7 los escriben; se añaden aquí
-- (confirmado con Jesús).
--
-- `container_port` pasa a NULLABLE: enqueueProvision inserta antes de conocer
-- el puerto y el manager lo devuelve en el callback. El UNIQUE existente se
-- mantiene para los valores no nulos. El CHECK de rango ya tolera NULL.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "containers" ADD COLUMN "job_id" TEXT;
ALTER TABLE "containers" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'docker';
ALTER TABLE "containers" ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'ws';
ALTER TABLE "containers" ADD COLUMN "tls_servername" TEXT;
ALTER TABLE "containers" ADD COLUMN "provision_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "containers" ADD COLUMN "agent_creation_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "containers" ADD COLUMN "provision_error" TEXT;
ALTER TABLE "containers" ADD COLUMN "provision_error_code" TEXT;

-- Requeridas por el callback del manager (ver nota arriba).
ALTER TABLE "containers" ADD COLUMN "internal_host" TEXT;
ALTER TABLE "containers" ADD COLUMN "container_id" TEXT;

CREATE UNIQUE INDEX "containers_job_id_key" ON "containers"("job_id");

-- El puerto se conoce en el callback, no al encolar.
ALTER TABLE "containers" ALTER COLUMN "container_port" DROP NOT NULL;

-- Ampliar los estados permitidos SIN perder los históricos: los tests y el
-- código previos usan 'creating' y no se pueden romper. Valores nuevos:
-- provisioning | agent_failed | removing.
ALTER TABLE "containers" DROP CONSTRAINT "containers_status_check";
ALTER TABLE "containers"
  ADD CONSTRAINT "containers_status_check"
  CHECK ("status" IN (
    'creating',
    'provisioning',
    'running',
    'agent_failed',
    'error',
    'stopped',
    'removing'
  ));
