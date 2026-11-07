import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export type FakeMode = 'echo' | 'slow' | 'reject' | 'stream';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RecordedUpgrade {
  url: string;
  headers: IncomingHttpHeaders;
}

const AGENTS = [
  { agent_id: 'upstream-primary', agent_name: 'Alice', is_primary: true },
  { agent_id: 'upstream-sub-1', agent_name: 'Sub 1', is_primary: false },
  { agent_id: 'upstream-sub-2', agent_name: 'Sub 2', is_primary: false },
  { agent_id: 'upstream-sub-3', agent_name: 'Sub 3', is_primary: false },
  { agent_id: 'upstream-sub-4', agent_name: 'Sub 4', is_primary: false },
];

/**
 * App-server falso. No usa el App Server real: registra headers, hace eco,
 * emite stream_delta y permite modos slow/reject.
 */
export class FakeAgentServer {
  readonly httpRequests: RecordedRequest[] = [];
  readonly upgradeRequests: RecordedUpgrade[] = [];
  readonly connections: WebSocket[] = [];
  mode: FakeMode = 'echo';

  private readonly requestQueue: RecordedRequest[] = [];
  private readonly upgradeQueue: RecordedUpgrade[] = [];
  private readonly requestWaiters: Array<(value: RecordedRequest) => void> = [];
  private readonly upgradeWaiters: Array<(value: RecordedUpgrade) => void> = [];
  private readonly connectionQueue: WebSocket[] = [];
  private readonly connectionWaiters: Array<(value: WebSocket) => void> = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private port = 0;

  private constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const recorded: RecordedRequest = {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers,
          body,
        };
        this.httpRequests.push(recorded);
        this.pushRequest(recorded);
        this.respond(request.url ?? '/', response);
      });
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (request, socket, head) => {
      const recorded: RecordedUpgrade = {
        url: request.url ?? '/',
        headers: request.headers,
      };
      this.upgradeRequests.push(recorded);
      this.pushUpgrade(recorded);

      if (this.mode === 'reject') {
        const body = JSON.stringify({
          error: { code: 'TICKET_INVALID', message: 'fake upstream rechaza el upgrade' },
        });
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n\r\n` +
            body,
        );
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.connections.push(ws);
        const waiter = this.connectionWaiters.shift();
        if (waiter) waiter(ws);
        else this.connectionQueue.push(ws);
        this.wss.emit('connection', ws, request);
        this.wire(ws);
      });
    });
  }

  static async start(mode: FakeMode = 'echo'): Promise<FakeAgentServer> {
    const fake = new FakeAgentServer();
    fake.mode = mode;
    await new Promise<void>((resolve) => {
      fake.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fake.server.address() as AddressInfo;
    fake.port = address.port;
    return fake;
  }

  get portNumber(): number {
    return this.port;
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  nextRequest(timeoutMs = 4000): Promise<RecordedRequest> {
    const queued = this.requestQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.requestWaiters.indexOf(resolve);
        if (index >= 0) this.requestWaiters.splice(index, 1);
        reject(new Error('timeout esperando request al upstream falso'));
      }, timeoutMs);
      this.requestWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  nextUpgrade(timeoutMs = 4000): Promise<RecordedUpgrade> {
    const queued = this.upgradeQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.upgradeWaiters.indexOf(resolve);
        if (index >= 0) this.upgradeWaiters.splice(index, 1);
        reject(new Error('timeout esperando upgrade al upstream falso'));
      }, timeoutMs);
      this.upgradeWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  nextConnection(timeoutMs = 4000): Promise<WebSocket> {
    const queued = this.connectionQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.connectionWaiters.indexOf(resolve);
        if (index >= 0) this.connectionWaiters.splice(index, 1);
        reject(new Error('timeout esperando conexión WS al upstream falso'));
      }, timeoutMs);
      this.connectionWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const ws of this.connections) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private pushRequest(value: RecordedRequest): void {
    const waiter = this.requestWaiters.shift();
    if (waiter) waiter(value);
    else this.requestQueue.push(value);
  }

  private pushUpgrade(value: RecordedUpgrade): void {
    const waiter = this.upgradeWaiters.shift();
    if (waiter) waiter(value);
    else this.upgradeQueue.push(value);
  }

  private wire(ws: WebSocket): void {
    ws.on('message', (data, isBinary) => {
      if (this.mode === 'slow') {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
        }, 2000);
        this.timers.add(timer);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
    });

    if (this.mode === 'stream') {
      let index = 0;
      const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'stream_delta', index }));
        index += 1;
        if (index === 5) {
          clearInterval(timer);
          this.timers.delete(timer);
        }
      }, 10);
      this.timers.add(timer);
      ws.on('close', () => clearInterval(timer));
    }
  }

  private respond(url: string, response: import('node:http').ServerResponse): void {
    const parsed = new URL(url, `http://127.0.0.1:${this.port}`);

    if (parsed.pathname === '/app-server-info') {
      this.json(response, 200, { ok: true, version: 'fake' });
      return;
    }
    if (parsed.pathname === '/error' || parsed.searchParams.get('status') === '500') {
      this.json(response, 500, { error: 'upstream broken' });
      return;
    }
    if (parsed.pathname === '/slow' || parsed.searchParams.get('delay') === '2000') {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.json(response, 200, { agents: AGENTS });
      }, 2000);
      this.timers.add(timer);
      return;
    }
    if (parsed.pathname === '/readyz') {
      this.json(response, 200, { ok: true });
      return;
    }
    if (parsed.pathname === '/v1/agents') {
      this.json(response, 200, { agents: AGENTS });
      return;
    }
    this.json(response, 404, { error: 'not found in fake upstream' });
  }

  private json(
    response: import('node:http').ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}
