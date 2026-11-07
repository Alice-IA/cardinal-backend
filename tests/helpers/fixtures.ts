import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/config/prisma';

/**
 * Fixture compartida por ownership, gateway y contract:
 * 2 usuarios, 1 nodo y 1 contenedor por usuario, 1 agente primario por
 * contenedor y (opcionalmente) 1 subagente en el contenedor de alice.
 */

export interface TenantUserFixture {
  id: string;
  email: string;
  containerId: string;
  primaryAgentId: string;
  nodeId: string;
}

export interface TenantFixture {
  alice: TenantUserFixture;
  bob: TenantUserFixture;
  aliceSubAgentId?: string;
}

export interface SeedOptions {
  includeAliceSubAgent?: boolean;
}

const ALICE_CONTAINER = 'container-alice';
const BOB_CONTAINER = 'container-bob';
const ALICE_AGENT = 'agent-alice-primary';
const BOB_AGENT = 'agent-bob-primary';
const ALICE_SUB_AGENT = 'agent-alice-sub';

export async function seedTenantFixture(options: SeedOptions = {}): Promise<TenantFixture> {
  const { includeAliceSubAgent = true } = options;

  const aliceNode = await prisma.node.create({
    data: {
      id: `node-alice-${randomUUID()}`,
      host: '127.0.0.1',
      port: 9,
      status: 'up',
      lastSeenAt: new Date(),
    },
  });
  const bobNode = await prisma.node.create({
    data: {
      id: `node-bob-${randomUUID()}`,
      host: '127.0.0.1',
      port: 9,
      status: 'up',
      lastSeenAt: new Date(),
    },
  });

  const alice = await prisma.user.create({
    data: {
      email: 'alice@example.com',
      passwordHash: 'test-only-not-a-real-hash',
      name: 'Alice',
    },
  });
  const bob = await prisma.user.create({
    data: {
      email: 'bob@example.com',
      passwordHash: 'test-only-not-a-real-hash',
      name: 'Bob',
    },
  });

  await prisma.container.create({
    data: {
      id: ALICE_CONTAINER,
      userId: alice.id,
      containerPort: 41001,
      nodeId: aliceNode.id,
      status: 'running',
    },
  });
  await prisma.container.create({
    data: {
      id: BOB_CONTAINER,
      userId: bob.id,
      containerPort: 41002,
      nodeId: bobNode.id,
      status: 'running',
    },
  });

  await prisma.agent.create({
    data: {
      agentId: ALICE_AGENT,
      containerId: ALICE_CONTAINER,
      userId: alice.id,
      agentName: 'Alice',
      isPrimary: true,
    },
  });
  await prisma.agent.create({
    data: {
      agentId: BOB_AGENT,
      containerId: BOB_CONTAINER,
      userId: bob.id,
      agentName: 'Alice',
      isPrimary: true,
    },
  });

  let aliceSubAgentId: string | undefined;
  if (includeAliceSubAgent) {
    aliceSubAgentId = ALICE_SUB_AGENT;
    await prisma.agent.create({
      data: {
        agentId: ALICE_SUB_AGENT,
        containerId: ALICE_CONTAINER,
        userId: alice.id,
        agentName: 'Subagente',
        isPrimary: false,
      },
    });
  }

  return {
    alice: {
      id: alice.id,
      email: alice.email,
      containerId: ALICE_CONTAINER,
      primaryAgentId: ALICE_AGENT,
      nodeId: aliceNode.id,
    },
    bob: {
      id: bob.id,
      email: bob.email,
      containerId: BOB_CONTAINER,
      primaryAgentId: BOB_AGENT,
      nodeId: bobNode.id,
    },
    aliceSubAgentId,
  };
}
