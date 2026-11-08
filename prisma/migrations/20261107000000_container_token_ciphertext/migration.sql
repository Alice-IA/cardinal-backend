-- ─────────────────────────────────────────────────────────────
-- Cifrado del capability token del contenedor.
--
-- `token_ciphertext` guarda base64url(iv || authTag || ciphertext) de
-- AES-256-GCM. Es NULLABLE: los contenedores provisionados antes de esta
-- migración no tienen token y /internal/credentials debe responder 404
-- SANDBOX_NOT_FOUND (no 500).
--
-- `token_rotated_at` permite auditar una rotación futura. No se añade índice:
-- las consultas son por PK (`containers.id`).
--
-- NO se guarda el sha256 del token: ese hash lo calcula el backend al
-- provisionar y se lo pasa al contenedor; la BD solo necesita el ciphertext
-- para entregarlo por /internal/credentials.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "containers"
  ADD COLUMN "token_ciphertext" TEXT;

ALTER TABLE "containers"
  ADD COLUMN "token_rotated_at" TIMESTAMPTZ(6);
