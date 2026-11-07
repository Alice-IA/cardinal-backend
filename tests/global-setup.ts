import { execSync } from 'node:child_process';
import dotenv from 'dotenv';

/**
 * Aplica las migraciones sobre la base de datos de test antes de correr nada.
 * `prisma migrate deploy` es idempotente: si ya están aplicadas, no hace nada.
 */
export default function setup(): void {
  dotenv.config({ quiet: true });

  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL no está definida (revisa tu .env)');
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
