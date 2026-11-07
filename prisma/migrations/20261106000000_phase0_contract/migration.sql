-- ─────────────────────────────────────────────────────────────
-- Fase 0a: esquema mínimo para poder EXPRESAR los tests de contrato.
--
-- Esta migración añade columnas y la tabla `nodes` para que los fixtures
-- puedan describir el dominio (agente primario, nodo, ruta del secreto).
--
-- NO añade las dos restricciones que los tests de ownership 8 y 9 exigen:
--
--   * agents_container_owner_fk   (FK compuesta container_id + user_id)
--   * agents_one_primary_per_container (índice parcial único is_primary)
--
-- Esas restricciones son el contrato a implementar y sus tests deben estar
-- ROJOS hasta que se añadan. Añadirlas aquí convertiría esos tests en verdes
-- sin haber implementado la garantía de aislamiento que defienden.
-- ─────────────────────────────────────────────────────────────

-- Un agente puede ser el primario del contenedor o un subagente.
ALTER TABLE "agents"
  ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- Nodos donde corren los contenedores. `resolveRoute` devuelve host/port/nodeId
-- y debe negarse a enrutar si el nodo está down.
CREATE TABLE "nodes" (
    "id"           TEXT NOT NULL,
    "host"         TEXT NOT NULL,
    "port"         INTEGER NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'up',
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "nodes_port_check" CHECK ("port" BETWEEN 1 AND 65535),
    CONSTRAINT "nodes_status_check" CHECK ("status" IN ('up', 'down'))
);

-- Cada contenedor corre en un nodo. Nullable para no romper filas históricas;
-- `resolveRoute` debe devolver NODE_UNAVAILABLE si no hay nodo.
ALTER TABLE "containers"
  ADD COLUMN "node_id" TEXT;

-- Se guarda la RUTA al secreto compartido del app-server, nunca el secreto.
-- (Test 1 de sandbox-manager.)
ALTER TABLE "containers"
  ADD COLUMN "ws_secret_path" TEXT;

ALTER TABLE "containers"
  ADD CONSTRAINT "containers_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "nodes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "containers_node_idx" ON "containers"("node_id");
