import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildControlPlaneApp } from '../src/control-plane/app';

const app = buildControlPlaneApp();

const REQUIRED_PATHS = [
  '/api/agents',
  '/api/agents/{agentId}',
  '/api/agents/{agentId}/ws-ticket',
  '/api/sandbox',
  '/api/sandbox/restart',
] as const;

const PUBLIC_AUTH_PATHS = new Set([
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
]);

const INTERNAL_PROPERTY_NAMES = [
  'internalHost',
  'containerPort',
  'wsSecretPath',
  'nodeId',
] as const;

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function fetchDocument(): Promise<Record<string, any>> {
  const response = await app.inject({ method: 'GET', url: '/docs/json' });
  expect(response.statusCode, 'GET /docs/json debe existir y responder 200').toBe(200);
  return response.json() as Record<string, any>;
}

describe('OpenAPI', () => {
  it('GET /docs/json devuelve OpenAPI 3.1.x', async () => {
    const document = await fetchDocument();

    expect(document.openapi, 'la versión debe ser 3.1.x').toMatch(/^3\.1\.\d+$/);
  });

  it('documenta todas las rutas del control plane', async () => {
    const document = await fetchDocument();
    const paths = document.paths as Record<string, unknown> | undefined;

    expect(paths, 'el documento debe tener paths').toBeDefined();
    for (const path of REQUIRED_PATHS) {
      expect(paths, `falta documentar la ruta ${path}`).toHaveProperty(path);
    }
  });

  it('cada endpoint no público declara security bearerAuth', async () => {
    const document = await fetchDocument();
    const paths = document.paths as Record<string, any> | undefined;

    expect(paths, 'el documento debe tener paths').toBeDefined();
    for (const [path, pathItem] of Object.entries(paths!)) {
      if (PUBLIC_AUTH_PATHS.has(path)) continue;
      for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
        expect(
          operation.security,
          `el endpoint ${method.toUpperCase()} ${path} debe declarar security bearerAuth`,
        ).toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
      }
    }
  });

  it('ningún schema de respuesta expone infraestructura interna', async () => {
    const document = await fetchDocument();
    const violations = findForbiddenProperties(document);

    expect(
      violations,
      `los schemas no deben declarar propiedades internas: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});

function findForbiddenProperties(value: unknown, path = 'document'): string[] {
  if (typeof value !== 'object' || value === null) return [];

  const violations: string[] = [];
  const record = value as Record<string, unknown>;

  const properties = record.properties;
  if (typeof properties === 'object' && properties !== null) {
    for (const propertyName of Object.keys(properties)) {
      if ((INTERNAL_PROPERTY_NAMES as readonly string[]).includes(propertyName)) {
        violations.push(`${path}.properties.${propertyName}`);
      }
    }
  }

  for (const [key, child] of Object.entries(record)) {
    violations.push(...findForbiddenProperties(child, `${path}.${key}`));
  }

  return violations;
}
