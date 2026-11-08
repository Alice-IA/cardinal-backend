import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL no está definida (revisa tu .env)');
}

// Red de seguridad: los tests truncan tablas, nunca deben apuntar a otra DB.
const databaseName = new URL(testUrl).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(
    `TEST_DATABASE_URL debe apuntar a una base de datos terminada en _test (recibido: ${databaseName})`,
  );
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl;

// Por si alguien corre los tests sin .env: no son secretos reales.
process.env.ACCESS_TOKEN_SECRET ??= 'test_access_secret_at_least_32_characters_long';
process.env.REFRESH_TOKEN_SECRET ??= 'test_refresh_secret_at_least_32_characters_long';
process.env.CORS_ORIGINS ??= 'http://localhost:3000';
// Secreto compartido backend → gateway para /internal/*. Los tests lo usan
// como valor esperado del header X-Internal-Token.
process.env.INTERNAL_TOKEN ??= 'test_internal_token_at_least_32_characters_long';

// Redis: los tests nunca abren una conexión real. `REDIS_URL` solo debe ser una
// URL válida porque `env.ts` la exige; el store se ejercita con FakeRedis.
process.env.REDIS_URL ??= 'redis://localhost:6379';
// Clave HMAC de tickets WS (solo backend).
process.env.WS_TICKET_SECRET ??= 'test_ws_ticket_secret_at_least_32_characters_long';
// Base64 canónico de 32 bytes (Buffer.alloc(32, 7)); no es un secreto real.
process.env.TOKEN_ENCRYPTION_KEY ??= 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
