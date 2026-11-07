import type { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { prisma } from '../../config/prisma';
import { emailTaken, invalidCredentials, tokenInvalid } from '../../utils/errors';
import { issueRefreshToken, signAccessToken } from './token.service';
import type { LoginInput, RegisterInput } from './auth.schema';

/**
 * Parámetros argon2id explícitos (OWASP "m=19 MiB, t=2, p=1"). No usamos los
 * defaults de la librería: cambian entre versiones y no son auditables.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash señuelo para igualar tiempos cuando el email no existe. Es un argon2id
 * con los mismos parámetros que los reales; no es un secreto (no protege nada,
 * sólo consume el mismo CPU). Se genera con hashPassword().
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$Hj65Xhltu4aQtt7/cjIiNQ$ir1DbVu8z9rdRPiNIh7I/vz5pL7pufxOxROoTXx9YQo';

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, ARGON2_OPTIONS);

/** `false` en vez de throw: un hash corrupto no debe tumbar el login con 500. */
const verifyPassword = async (hash: string, password: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
};

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
}

const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
});

/**
 * El email no es único en el schema (la unicidad vive en el índice funcional
 * lower(email)), así que Prisma no permite findUnique: usamos findFirst contra
 * users_email_idx.
 */
const findByEmail = (email: string) => prisma.user.findFirst({ where: { email } });

const isUniqueViolation = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return true;
  }
  // El índice funcional lower(email) no está en el schema, así que Prisma no
  // siempre lo mapea a P2002: lo reconocemos por nombre en el mensaje.
  return error instanceof Error && error.message.includes('users_email_lower_key');
};

export async function register(input: RegisterInput): Promise<PublicUser> {
  const existing = await findByEmail(input.email);
  if (existing) {
    // Mismo coste que un registro real: verifica contra el señuelo antes de
    // responder. Sin esto, el 409 sería medible en tiempo (~30 ms).
    await verifyPassword(DUMMY_HASH, input.password);
    throw emailTaken();
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name ?? null,
      },
    });
    return toPublicUser(user);
  } catch (error) {
    // Carrera: dos registros concurrentes con el mismo email.
    if (isUniqueViolation(error)) {
      await verifyPassword(DUMMY_HASH, input.password);
      throw emailTaken();
    }
    throw error;
  }
}

/** Registra el intento. En éxito limpia los fallos previos de esa combinación. */
async function recordLoginAttempt(
  ip: string,
  email: string,
  success: boolean,
): Promise<void> {
  const now = new Date();

  if (!success) {
    await prisma.loginAttempt.create({ data: { ip, email } });
    return;
  }

  await prisma.$transaction([
    prisma.loginAttempt.create({ data: { ip, email, successAt: now } }),
    prisma.loginAttempt.deleteMany({ where: { ip, email, successAt: null } }),
  ]);
}

export interface LoginResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export async function login(
  input: LoginInput,
  ip: string,
): Promise<LoginResult> {
  const user = await findByEmail(input.email);

  if (!user) {
    // Tiempo de respuesta comparable al de un usuario real con password mala.
    await verifyPassword(DUMMY_HASH, input.password);
    await recordLoginAttempt(ip, input.email, false);
    throw invalidCredentials();
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk) {
    await recordLoginAttempt(ip, input.email, false);
    throw invalidCredentials();
  }

  await recordLoginAttempt(ip, input.email, true);

  const [accessToken, refresh] = await Promise.all([
    signAccessToken(user.id),
    issueRefreshToken(user.id),
  ]);

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  // Token válido de un usuario que ya no existe.
  if (!user) throw tokenInvalid();
  return toPublicUser(user);
}
