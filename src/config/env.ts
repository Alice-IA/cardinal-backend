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
  // Es el ÚNICO secreto que el gateway conoce. El `WS_TICKET_SECRET` vive SOLO
  // en el backend: el gateway ya no canjea tickets en proceso, los consume por
  // HTTP contra /internal/tickets/consume. Tampoco tiene Redis.
  INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
  // Redis del backend: reservas NX de tickets (ticket:used:<jti>).
  // En `NODE_ENV=test` basta una URL ficticia: los tests inyectan FakeRedis.
  // Nunca se loguea (puede contener credenciales en la URL).
  REDIS_URL: z.url({ error: 'REDIS_URL es obligatorio' }),
  // Clave HMAC de los tickets WS. Solo la conoce el backend.
  WS_TICKET_SECRET: secret('WS_TICKET_SECRET'),
  // Clave de cifrado del capability token en la BD: base64 de 32 bytes.
  // Se valida la forma canónica (ida y vuelta base64) para no aceptar texto
  // que Buffer.from(..., 'base64') "decodifique" ignorando caracteres.
  TOKEN_ENCRYPTION_KEY: z
    .string({ error: 'TOKEN_ENCRYPTION_KEY es obligatorio' })
    .refine(
      (value) => {
        const decoded = Buffer.from(value, 'base64');
        return decoded.length === 32 && decoded.toString('base64') === value;
      },
      { message: 'TOKEN_ENCRYPTION_KEY debe ser base64 de exactamente 32 bytes' },
    ),
  // ── Aprovisionamiento (fase provision) ──────────────────────────────────
  // URL del Sandbox Manager (servicio aparte; habla Docker y no toca Prisma).
  // No es un secreto: el token interno viaja en el header.
  MANAGER_URL: z
    .url({ error: 'MANAGER_URL debe ser una URL' })
    .default('http://sandbox-manager:8090'),
  // Nombre del agente primario creado con el SDK.
  AGENT_NAME: z.string().min(1).default('Alice'),
  // Fuente del systemPrompt. Si es relativa se resuelve desde el archivo
  // compilado (__dirname), NUNCA desde process.cwd(): el cwd cambia según
  // cómo se arranque el proceso. Si no existe, el arranque falla.
  AGENT_SYSTEM_PROMPT_PATH: z
    .string()
    .min(1)
    .default('assets/alice-persona.md'),
  // Timeout de las llamadas HTTP al manager (el manager tiene el suyo para
  // deploy.sh).
  PROVISION_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
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
