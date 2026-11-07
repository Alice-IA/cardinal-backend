import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { buildGatewayApp, type GatewayOptions } from '../../src/gateway/app';
import type { FastifyInstance } from 'fastify';

export interface RunningGateway {
  app: FastifyInstance;
  port: number;
  httpUrl: string;
  wsUrl: string;
}

export async function startGateway(options: GatewayOptions = {}): Promise<RunningGateway> {
  const app = buildGatewayApp(options);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    app,
    port: address.port,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}

export class UpgradeHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`el gateway rechazó el upgrade con HTTP ${statusCode}`);
    this.name = 'UpgradeHttpError';
  }
}

interface CloseInfo {
  code: number;
  reason: string;
}

export class WsClient {
  readonly receivedText: string[] = [];
  readonly receivedBinary: Buffer[] = [];
  private readonly textQueue: string[] = [];
  private readonly binaryQueue: Buffer[] = [];
  private readonly textWaiters: Array<(value: string) => void> = [];
  private readonly binaryWaiters: Array<(value: Buffer) => void> = [];
  private closeInfo: CloseInfo | undefined;
  private readonly closePromise: Promise<CloseInfo>;
  private closeResolve!: (value: CloseInfo) => void;

  private constructor(readonly ws: WebSocket) {
    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.from(data as Buffer);
        this.receivedBinary.push(buffer);
        const waiter = this.binaryWaiters.shift();
        if (waiter) waiter(buffer);
        else this.binaryQueue.push(buffer);
      } else {
        const text = data.toString();
        this.receivedText.push(text);
        const waiter = this.textWaiters.shift();
        if (waiter) waiter(text);
        else this.textQueue.push(text);
      }
    });

    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      this.closeResolve(this.closeInfo);
    });
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      let settled = false;

      ws.once('open', () => {
        settled = true;
        resolve(new WsClient(ws));
      });

      ws.once('unexpected-response', (_request, response) => {
        settled = true;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          reject(new UpgradeHttpError(response.statusCode ?? 0, Buffer.concat(chunks).toString()));
        });
        response.on('error', (error) => reject(error));
      });

      ws.once('error', (error) => {
        if (!settled) reject(error);
      });
    });
  }

  send(data: string | Buffer): void {
    this.ws.send(data);
  }

  nextText(timeoutMs = 4000): Promise<string> {
    const queued = this.textQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.textWaiters.indexOf(waiter);
        if (index >= 0) this.textWaiters.splice(index, 1);
        reject(new Error('timeout esperando frame de texto'));
      }, timeoutMs);
      const waiter = (value: string) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.textWaiters.push(waiter);
    });
  }

  nextBinary(timeoutMs = 4000): Promise<Buffer> {
    const queued = this.binaryQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.binaryWaiters.indexOf(waiter);
        if (index >= 0) this.binaryWaiters.splice(index, 1);
        reject(new Error('timeout esperando frame binario'));
      }, timeoutMs);
      const waiter = (value: Buffer) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.binaryWaiters.push(waiter);
    });
  }

  waitClose(timeoutMs = 4000): Promise<CloseInfo> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout esperando close del socket')),
        timeoutMs,
      );
      this.closePromise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  close(): void {
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close();
    }
  }

  /** Corte forzado para el afterEach; no simula el comportamiento del gateway. */
  terminate(): void {
    this.ws.terminate();
  }
}

/** Abre un WS y espera el rechazo HTTP del upgrade (401/404/...). */
export async function connectExpectHttpStatus(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 4000,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error('timeout esperando el rechazo HTTP del upgrade'));
    }, timeoutMs);

    ws.once('unexpected-response', (_request, response) => {
      settled = true;
      clearTimeout(timer);
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(new Error('el gateway abrió el WS cuando debía rechazarlo por HTTP'));
    });

    ws.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function closeCodeWithReason(reason: string): boolean {
  return reason.length > 0;
}
