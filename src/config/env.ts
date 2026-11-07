import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

/**
 * Validación de variables de entorno. Falla rápido: si algo falta o está mal,
 * el proceso no arranca (exit 1) en vez de fallar a mitad de un request.
 */

const secret = (name: string) =>
  z
    .string({ error: `${name} es obligatorio` })
    .min(32, `${name} debe tener al menos 32 caracteres`);

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL es obligatorio' })
    .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
      message: 'DATABASE_URL debe ser una URL de PostgreSQL',
    }),
  CORS_ORIGINS: z
    .string({ error: 'CORS_ORIGINS es obligatorio' })
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean))
    .refine((origins) => origins.length > 0, { message: 'CORS_ORIGINS no puede estar vacío' }),
  ACCESS_TOKEN_SECRET: secret('ACCESS_TOKEN_SECRET'),
  REFRESH_TOKEN_SECRET: secret('REFRESH_TOKEN_SECRET'),
  // Secreto compartido con cardinal-gateway para autenticar /internal/*.
  //
  // Es el ÚNICO secreto que el gateway conoce. El `WS_TICKET_SECRET` (≥32
  // bytes, pendiente de conectar cuando exista el store Redis) vive SOLO en
  // el backend: el gateway ya no canjea tickets en proceso, los consume por
  // HTTP contra /internal/tickets/consume. Tampoco tiene Redis.
  INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
});

const parsed = rawSchema
  .refine((v) => v.ACCESS_TOKEN_SECRET !== v.REFRESH_TOKEN_SECRET, {
    message: 'ACCESS_TOKEN_SECRET y REFRESH_TOKEN_SECRET deben ser distintos',
    path: ['REFRESH_TOKEN_SECRET'],
  })
  .safeParse(process.env);

if (!parsed.success) {
  // No usamos el logger aquí a propósito: el logger depende del env.
  const detail = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('\n');
  process.stderr.write(`Configuración de entorno inválida:\n${detail}\n`);
  process.exit(1);
}

export const env = parsed.data;

export type Env = typeof env;
