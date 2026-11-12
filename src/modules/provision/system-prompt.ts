/**
 * Carga de la persona de Alice desde `assets/alice-persona.md`.
 *
 * La persona es un archivo del repo (no un placeholder). La ruta relativa se
 * resuelve desde el archivo compilado (__dirname), NUNCA desde process.cwd():
 * el cwd cambia según cómo se arranque el proceso.
 *
 * Nota de implementación: este repo compila a CommonJS (`tsconfig.json` con
 * `module: node16` y sin `"type": "module"`), donde `import.meta.url` no es
 * válido (TS1343). `__dirname` es la resolución relativa al archivo, el mismo
 * semántico que se pedía, y funciona tanto en `src/` (tsx) como en `dist/`.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_SYSTEM_PROMPT_PATH = 'assets/alice-persona.md';

/**
 * Resuelve la ruta del prompt. `assets/...` cuelga de la raíz del repo, que
 * está tres niveles por encima de `src/modules/provision` y también de
 * `dist/modules/provision`.
 */
export function resolveSystemPromptPath(
  configured: string = DEFAULT_SYSTEM_PROMPT_PATH,
): string {
  if (isAbsolute(configured)) return configured;
  return resolve(__dirname, '..', '..', '..', configured);
}

/**
 * Lee el prompt completo. Si el archivo no existe o no es legible, lanza un
 * error explícito: NO se usa un placeholder ni una persona inventada.
 */
export function loadSystemPrompt(configured: string = DEFAULT_SYSTEM_PROMPT_PATH): string {
  const path = resolveSystemPromptPath(configured);

  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `AGENT_SYSTEM_PROMPT_PATH no es legible: ${path}. La persona de Alice es obligatoria y no se usa placeholder.`,
      { cause: error },
    );
  }
}
