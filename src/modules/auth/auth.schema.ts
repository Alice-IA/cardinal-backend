import { z } from 'zod';

/** Email: se normaliza (trim + minúsculas) antes de validar el formato. */
const emailField = z
  .string({ error: 'El email es obligatorio' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Email inválido' }).max(254));

export const registerSchema = z.object({
  email: emailField,
  password: z
    .string({ error: 'La contraseña es obligatoria' })
    .min(12, 'La contraseña debe tener al menos 12 caracteres')
    .max(128, 'La contraseña no puede superar los 128 caracteres'),
  name: z.string().trim().min(1, 'El nombre no puede estar vacío').max(100).optional(),
});

export const loginSchema = z.object({
  email: emailField,
  // Sin mínimo de longitud a propósito: una contraseña corta en login es una
  // credencial inválida (401), no un error de validación (400). Si no, el
  // endpoint se convierte en un oráculo de la política de contraseñas.
  password: z
    .string({ error: 'La contraseña es obligatoria' })
    .min(1, 'La contraseña es obligatoria')
    .max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
