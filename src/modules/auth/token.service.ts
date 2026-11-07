import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { errors as joseErrors, SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { AppError, tokenInvalid } from '../../utils/errors';

/** TTLs y algoritmo: constantes de diseño, no configurables por entorno. */
const ALG = 'HS256';
const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const accessKey = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
const refreshKey = new TextEncoder().encode(env.REFRESH_TOKEN_SECRET);

export interface RefreshTokenIssued {
  token: string;
  tokenId: string;
  familyId: string;
  expiresAt: Date;
}

/**
 * El token de refresh nunca se guarda en claro: en `refresh_tokens.token_hash`
 * sólo entra su sha256 hex.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const toSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/** Access token: payload { sub, iat, exp, jti } y nada más. */
export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(accessKey);
}

async function signRefreshToken(userId: string, tokenId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(userId)
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime(toSeconds(expiresAt))
    .sign(refreshKey);
}

export interface AuthUser {
  id: string;
  jti: string;
  exp: number;
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, accessKey, { algorithms: [ALG] }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AppError('TOKEN_EXPIRED', 401, 'Token expirado');
    }
    throw tokenInvalid();
  }

  const { sub, jti, exp } = payload;
  if (typeof sub !== 'string' || typeof jti !== 'string' || typeof exp !== 'number') {
    throw tokenInvalid();
  }
  return { id: sub, jti, exp };
}

interface DecodedRefresh {
  userId: string;
  tokenId: string;
}

async function verifyRefreshToken(token: string): Promise<DecodedRefresh> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, refreshKey, { algorithms: [ALG] }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AppError('TOKEN_EXPIRED', 401, 'Refresh token expirado');
    }
    throw tokenInvalid();
  }

  const { sub, jti } = payload;
  if (typeof sub !== 'string' || typeof jti !== 'string') {
    throw tokenInvalid();
  }
  return { userId: sub, tokenId: jti };
}

/** Crea una familia nueva (login) o continúa una existente (rotación). */
export async function issueRefreshToken(
  userId: string,
  familyId: string = randomUUID(),
  client: Prisma.TransactionClient = prisma,
): Promise<RefreshTokenIssued> {
  const tokenId = randomUUID();
  // Truncamos a segundos para que `expires_at` y el `exp` del JWT coincidan.
  const expiresAt = new Date(
    Math.floor((Date.now() + REFRESH_TOKEN_TTL_MS) / 1000) * 1000,
  );
  const token = await signRefreshToken(userId, tokenId, expiresAt);

  await client.refreshToken.create({
    data: { id: tokenId, userId, tokenHash: hashToken(token), familyId, expiresAt },
  });

  return { token, tokenId, familyId, expiresAt };
}

interface LockedTokenRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
}

const REUSE_MESSAGE = 'Sesión revocada por reutilización de token';

/**
 * Error del refresh que perdió una carrera benigna (doble submit del mismo
 * token por dos requests concurrentes). Es un 401 pero NO debe borrar la
 * cookie: el navegador recibiría el borrado después del 200 del ganador y
 * tiraría una sesión que sigue siendo válida.
 */
export class RefreshRaceLostError extends AppError {
  constructor() {
    super('TOKEN_INVALID', 401, 'Token inválido');
    this.name = 'RefreshRaceLostError';
  }
}

async function revokeFamily(
  tx: Prisma.TransactionClient,
  familyId: string,
  at: Date,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: at },
  });
}

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  userId: string;
}

/**
 * Resultado de la transacción. Devolvemos un estado en vez de lanzar dentro:
 * un throw dentro de una transacción interactiva de Prisma hace ROLLBACK, y
 * nos llevaría por delante la revocación de la familia que acabamos de escribir.
 */
type RotationOutcome =
  | { status: 'rotated'; accessToken: string; refreshToken: string; expiresAt: Date; userId: string }
  | { status: 'benign_race' }
  | { status: 'reuse' }
  | { status: 'expired' }
  | { status: 'invalid' };

/**
 * Rotación obligatoria y atómica.
 *
 * Concurrencia: `SELECT ... FOR UPDATE` sobre la fila del token presentado,
 * dentro de una transacción interactiva (ReadCommitted). El segundo request
 * se bloquea en el lock hasta que el primero commitea, y al releer ve
 * `used_at` ya escrito: entra por la rama de "ya usado" en vez de rotar dos
 * veces. No usamos SERIALIZABLE porque obligaría a reintentar en cada 40001
 * y a exponer errores de serialización al cliente.
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotatedTokens> {
  const tokenHash = hashToken(rawToken);
  const decoded = await verifyRefreshToken(rawToken);

  const outcome = await prisma.$transaction<RotationOutcome>(async (tx) => {
    const rows = await tx.$queryRaw<LockedTokenRow[]>`
      SELECT id,
             user_id             AS "userId",
             family_id           AS "familyId",
             expires_at          AS "expiresAt",
             used_at             AS "usedAt",
             revoked_at          AS "revokedAt",
             replaced_by_token_id AS "replacedByTokenId"
      FROM refresh_tokens
      WHERE token_hash = ${tokenHash}
      FOR UPDATE
    `;

    const current = rows[0];
    if (!current) return { status: 'invalid' };
    // El hash y las claims tienen que apuntar a la misma fila.
    if (current.id !== decoded.tokenId || current.userId !== decoded.userId) {
      return { status: 'invalid' };
    }

    const now = new Date();

    if (current.revokedAt) return { status: 'invalid' };

    if (current.expiresAt.getTime() <= now.getTime()) {
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { revokedAt: now },
      });
      return { status: 'expired' };
    }

    if (current.usedAt) {
      const successor = current.replacedByTokenId
        ? await tx.refreshToken.findUnique({ where: { id: current.replacedByTokenId } })
        : null;

      // Regla estructural: el reuso sólo es benigno si el sucesor existe y
      // sigue virgen (ni usado ni revocado). Cualquier otra cosa es reuso real.
      const benignRace =
        successor !== null && successor.usedAt === null && successor.revokedAt === null;

      if (benignRace) return { status: 'benign_race' };

      await revokeFamily(tx, current.familyId, now);
      return { status: 'reuse' };
    }

    const issued = await issueRefreshToken(current.userId, current.familyId, tx);
    await tx.refreshToken.update({
      where: { id: current.id },
      data: { usedAt: now, replacedByTokenId: issued.tokenId },
    });

    const accessToken = await signAccessToken(current.userId);
    return {
      status: 'rotated',
      accessToken,
      refreshToken: issued.token,
      expiresAt: issued.expiresAt,
      userId: current.userId,
    };
  });

  switch (outcome.status) {
    case 'rotated':
      return outcome;
    case 'benign_race':
      throw new RefreshRaceLostError();
    case 'reuse':
      throw new AppError('TOKEN_INVALID', 401, REUSE_MESSAGE);
    case 'expired':
      throw new AppError('TOKEN_EXPIRED', 401, 'Refresh token expirado');
    case 'invalid':
      throw tokenInvalid();
  }
}

/** Logout: revoca el token presentado. Idempotente. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row || row.revokedAt) return;

  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
}
