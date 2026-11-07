-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "container_port" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "agent_id" TEXT NOT NULL,
    "container_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_name" TEXT NOT NULL DEFAULT 'Alice',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_token_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" BIGSERIAL NOT NULL,
    "ip" INET NOT NULL,
    "email" TEXT NOT NULL,
    "success_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "containers_container_port_key" ON "containers"("container_port");

-- CreateIndex
CREATE INDEX "containers_user_idx" ON "containers"("user_id");

-- CreateIndex
CREATE INDEX "agents_container_idx" ON "agents"("container_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_token_id_key" ON "refresh_tokens"("replaced_by_token_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "login_attempts_rate_idx" ON "login_attempts"("ip", "email", "created_at");

-- CreateIndex
CREATE INDEX "login_attempts_created_idx" ON "login_attempts"("created_at");

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_token_id_fkey" FOREIGN KEY ("replaced_by_token_id") REFERENCES "refresh_tokens"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ─────────────────────────────────────────────────────────────
-- Añadido a mano (no representable en schema.prisma)
-- ─────────────────────────────────────────────────────────────

-- Unicidad de email case-insensitive. El servicio normaliza a minúsculas
-- antes de escribir; este índice es la garantía a nivel de DB.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

-- Rango válido de puerto TCP.
ALTER TABLE "containers"
  ADD CONSTRAINT "containers_container_port_check"
  CHECK ("container_port" BETWEEN 1 AND 65535);

-- Estados permitidos del contenedor.
ALTER TABLE "containers"
  ADD CONSTRAINT "containers_status_check"
  CHECK ("status" IN ('creating', 'running', 'stopped', 'error'));

-- Un contenedor en error debe traer diagnóstico.
ALTER TABLE "containers"
  ADD CONSTRAINT "containers_error_requires_message_check"
  CHECK ("status" <> 'error' OR "error_message" IS NOT NULL);
