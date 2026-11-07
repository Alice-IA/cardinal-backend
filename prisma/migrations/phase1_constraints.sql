-- ─────────────────────────────────────────────────────────────
-- Fase 1 — restricciones de ownership pendientes
--
-- NO aplicar todavía. Este archivo NO está dentro de una carpeta de migración
-- de Prisma, así que `prisma migrate deploy` no lo ejecuta.
--
-- Los tests 8 y 9 de `tests/ownership.test.ts` deben seguir rojos con
-- "falta agents_container_owner_fk" y
-- "falta agents_one_primary_per_container" hasta que se implemente la fase 1.
-- ─────────────────────────────────────────────────────────────

-- Prerrequisito: PostgreSQL exige un índice único exacto sobre las columnas
-- referenciadas por la FK compuesta. `containers.id` es PK, pero (id, user_id)
-- necesita su propio UNIQUE.
ALTER TABLE "containers"
  ADD CONSTRAINT "containers_id_user_id_key" UNIQUE ("id", "user_id");

-- Un agente solo puede apuntar a un contenedor que pertenece al mismo usuario.
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_container_owner_fk"
  FOREIGN KEY ("container_id", "user_id")
  REFERENCES "containers" ("id", "user_id");

-- Un solo agente primario por contenedor.
CREATE UNIQUE INDEX "agents_one_primary_per_container"
  ON "agents" ("container_id")
  WHERE "is_primary";
