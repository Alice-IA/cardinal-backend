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
