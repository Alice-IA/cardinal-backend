import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveRoute, listPrimaryAgents } from '../src/modules/agents/ownership.service';
import { prisma } from '../src/config/prisma';
import { resetDb, sqlState } from './helpers/db';
import { seedTenantFixture, type TenantFixture } from './helpers/fixtures';

let fixture: TenantFixture;

beforeEach(async () => {
  await resetDb();
  fixture = await seedTenantFixture({ includeAliceSubAgent: true });
});

/**
 * Fase 0a: `resolveRoute` es un stub que lanza `not implemented`. Para que el
 * test central falle por la aserción de tenant (expected null / received) y no
 * por un throw, convertimos SOLO ese error conocido en un valor visible.
 * En fase 1 se elimina este wrapper y se llama a `resolveRoute` directo.
 */
async function resolveRouteForPhase0a(userId: string, agentId: string): Promise<unknown> {
  try {
    return await resolveRoute(userId, agentId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('not implemented:')) {
      return { __phase0aStub: error.message };
    }
    throw error;
  }
}

describe('ownership: resolveRoute', () => {
  it('alice resuelve su agente primario a la ruta del nodo', async () => {
    const route = await resolveRoute(fixture.alice.id, fixture.alice.primaryAgentId);

    expect(route, 'alice debe resolver su propio agente').toEqual({
      host: '127.0.0.1',
      port: 9,
      nodeId: fixture.alice.nodeId,
    });
  });

  // CONTRATO CENTRAL DEL PROYECTO.
  // Si este test pasa en verde con `null` reemplazado por la fila de alice,
  // hay fuga de tenant: bob estaría recibiendo la ruta del contenedor ajeno.
  it('bob no puede resolver el agente de alice', async () => {
    const route = await resolveRouteForPhase0a(fixture.bob.id, fixture.alice.primaryAgentId);

    expect(
      route,
      'el stub de fase 0a no debe sobrevivir: la implementación debe reemplazarlo',
    ).not.toHaveProperty('__phase0aStub');
    expect(route, 'bob no debe resolver el agente de alice').toEqual(null);
  });

  it('un agente inexistente devuelve null', async () => {
    const route = await resolveRoute(fixture.alice.id, 'agent-inexistente');

    expect(route, 'un agentId inexistente no debe resolver ruta').toBeNull();
  });

  it('un contenedor en creating devuelve SANDBOX_NOT_READY', async () => {
    await prisma.container.update({
      where: { id: fixture.alice.containerId },
      data: { status: 'creating' },
    });

    const route = await resolveRoute(fixture.alice.id, fixture.alice.primaryAgentId);

    expect(route, 'un sandbox en creating no está listo para enrutar').toEqual({
      error: 'SANDBOX_NOT_READY',
    });
  });

  it('un nodo down devuelve NODE_UNAVAILABLE', async () => {
    await prisma.node.update({
      where: { id: fixture.alice.nodeId },
      data: { status: 'down' },
    });

    const route = await resolveRoute(fixture.alice.id, fixture.alice.primaryAgentId);

    expect(route, 'un nodo down no puede enrutar').toEqual({
      error: 'NODE_UNAVAILABLE',
    });
  });
});

describe('ownership: listPrimaryAgents', () => {
  it('lista exactamente el agente primario de alice y no el subagente', async () => {
    const agents = await listPrimaryAgents(fixture.alice.id);

    expect(agents, 'alice debe ver solo su agente primario').toHaveLength(1);
    expect(
      agents.map((agent) => agent.agentId),
      'el subagente is_primary=false no debe aparecer en el control plane',
    ).toEqual([fixture.alice.primaryAgentId]);
    expect(
      agents.some((agent) => agent.agentId === fixture.aliceSubAgentId),
      'listPrimaryAgents no debe incluir el subagente de alice',
    ).toBe(false);
  });

  it('la lista de bob no contiene el agente de alice', async () => {
    const agents = await listPrimaryAgents(fixture.bob.id);

    expect(
      agents.map((agent) => agent.agentId),
      'la lista de bob no debe contener el agentId de alice',
    ).not.toContain(fixture.alice.primaryAgentId);
  });
});

describe('ownership: garantías en la base de datos', () => {
  it('un agente no puede apuntar al contenedor de alice con el user_id de bob', async () => {
    const crossTenantAgentId = `agent-cruzado-${randomUUID()}`;
    let error: unknown;
    let inserted = false;

    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO agents (agent_id, container_id, user_id, agent_name, is_primary)
         VALUES ($1, $2, $3::uuid, $4, $5)`,
        crossTenantAgentId,
        fixture.alice.containerId,
        fixture.bob.id,
        'Intruso',
        false,
      );
      inserted = true;
    } catch (caught) {
      error = caught;
    }

    if (inserted) {
      await prisma.$executeRawUnsafe('DELETE FROM agents WHERE agent_id = $1', crossTenantAgentId);
    }

    expect(
      error,
      'falta agents_container_owner_fk: el INSERT cruzado (contenedor de alice + user_id de bob) fue aceptado',
    ).toBeDefined();
    expect(
      sqlState(error),
      'falta agents_container_owner_fk: la violación esperada era 23503 (FK compuesta)',
    ).toBe('23503');
  });

  it('no puede haber dos agentes is_primary=true en el mismo contenedor', async () => {
    const extraContainerId = `container-sin-primario-${randomUUID()}`;
    await prisma.container.create({
      data: {
        id: extraContainerId,
        userId: fixture.alice.id,
        containerPort: 42001,
        nodeId: fixture.alice.nodeId,
        status: 'running',
      },
    });

    const firstAgentId = `agent-primero-${randomUUID()}`;
    const secondAgentId = `agent-segundo-${randomUUID()}`;
    let firstError: unknown;
    let secondError: unknown;

    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO agents (agent_id, container_id, user_id, agent_name, is_primary)
         VALUES ($1, $2, $3::uuid, $4, true)`,
        firstAgentId,
        extraContainerId,
        fixture.alice.id,
        'Primero',
      );
    } catch (caught) {
      firstError = caught;
    }

    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO agents (agent_id, container_id, user_id, agent_name, is_primary)
         VALUES ($1, $2, $3::uuid, $4, true)`,
        secondAgentId,
        extraContainerId,
        fixture.alice.id,
        'Segundo',
      );
    } catch (caught) {
      secondError = caught;
    }

    await prisma.agent.deleteMany({ where: { containerId: extraContainerId } });
    await prisma.container.delete({ where: { id: extraContainerId } });

    expect(firstError, 'el primer agente primario del contenedor debe insertarse').toBeUndefined();
    expect(
      secondError,
      'falta agents_one_primary_per_container: se aceptaron dos is_primary=true en el mismo contenedor',
    ).toBeDefined();
    expect(
      sqlState(secondError),
      'falta agents_one_primary_per_container: la violación esperada era 23505 (índice parcial único)',
    ).toBe('23505');
  });
});
