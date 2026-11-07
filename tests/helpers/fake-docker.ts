import type { DockerResult, DockerRunner } from '../../src/modules/sandbox/sandbox-manager';

/**
 * Docker falso: registra cada argv en memoria y responde con la cola
 * configurada. No ejecuta nada.
 */
export class FakeDocker implements DockerRunner {
  readonly commands: string[][] = [];
  readonly results: DockerResult[] = [];
  defaultResult: DockerResult = { exitCode: 0, stdout: '', stderr: '' };

  async run(argv: string[]): Promise<DockerResult> {
    this.commands.push([...argv]);
    return this.results.shift() ?? this.defaultResult;
  }

  /** Último comando cuyo argv contiene todas las piezas indicadas. */
  findCommand(...parts: string[]): string[] | undefined {
    return this.commands.find((argv) => parts.every((part) => argv.includes(part)));
  }

  commandsMatching(...parts: string[]): string[][] {
    return this.commands.filter((argv) => parts.every((part) => argv.includes(part)));
  }
}
