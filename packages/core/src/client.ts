/**
 * The local API client that `cc-axi` and the MCP relay use (P1-05): find the endpoint
 * through the record, verify it, connect, and run the mutual-proof handshake (ADR 0002
 * decision 6) before any other call. It never sends anything derived from the token to an
 * endpoint that has not proved it knows the token.
 *
 * Imported as `@cc/core/client`; it loads no store, domain or schema code.
 */
import net from 'node:net';

import { APP_NOT_RUNNING_HELP, CoreError } from './errors.js';
import { assertSocketPathFits, discoverEndpoint } from './endpoint.js';
import { clientProof, newNonce, proofsMatch, serverProof } from './handshake.js';
import { errorFromResponse, LineSplitter, type JsonRpcId } from './jsonrpc.js';
import { readToken } from './tokens.js';

export interface ConnectOptions {
  readonly userData: string;
  readonly principal: string;
  /** Defaults to the token file `<userData>/run/tokens/<principal>.token`. */
  readonly token?: string;
  /** Connect here instead of discovering the endpoint (tests). */
  readonly path?: string;
  /** Per-call timeout; default 30 s. */
  readonly timeoutMs?: number;
}

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly workstreamFilter: readonly string[] | 'all';
  readonly sensitiveAccess: boolean;
}

export interface LocalApiClient {
  readonly principal: AuthenticatedPrincipal;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** A raw JSON-RPC connection, before authentication. */
class Connection {
  readonly #socket: net.Socket;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #closedError: CoreError | undefined;

  constructor(socket: net.Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    const splitter = new LineSplitter(64 * 1024 * 1024);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.#receive(line);
    });
    socket.on('close', () =>
      this.#failAll(
        new CoreError('E_APP_NOT_RUNNING', 'the connection closed', [APP_NOT_RUNNING_HELP]),
      ),
    );
    socket.on('error', () => socket.destroy());
  }

  call(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (this.#closedError !== undefined) return Promise.reject(this.#closedError);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CoreError('E_APP_NOT_RUNNING', `${method} timed out`, [APP_NOT_RUNNING_HELP]));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  close(): void {
    this.#socket.end();
    this.#socket.destroy();
  }

  #receive(line: string): void {
    let message: { id?: JsonRpcId; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    const pending = this.#pending.get(message.id ?? null);
    if (pending === undefined) return;
    this.#pending.delete(message.id ?? null);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(errorFromResponse(message.error));
    else pending.resolve(message.result);
  }

  #failAll(error: CoreError): void {
    this.#closedError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  assertSocketPathFits(socketPath);
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        new CoreError(
          'E_APP_NOT_RUNNING',
          `cannot reach Command Center at ${socketPath} (${error.code ?? error.message})`,
          [APP_NOT_RUNNING_HELP],
        ),
      );
    });
  });
}

function isProofResult(value: unknown): value is { serverNonce: string; serverProof: string } {
  const result = value as Record<string, unknown> | null;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof result['serverNonce'] === 'string' &&
    typeof result['serverProof'] === 'string'
  );
}

/** Connects and authenticates as `principal`. */
export async function connectLocalApi(options: ConnectOptions): Promise<LocalApiClient> {
  // Reach the endpoint first: with no app running the answer is E_APP_NOT_RUNNING (07 §4.4),
  // even in a profile that has no token files yet. Nothing is sent before the token is read.
  const socketPath = options.path ?? discoverEndpoint({ userData: options.userData }).path;
  const socket = await connectSocket(socketPath);
  const token = options.token ?? readToken(options.userData, options.principal);
  if (token === undefined) {
    socket.destroy();
    throw new CoreError('E_FORBIDDEN', `no token for principal ${options.principal}`, [
      'Ask the user to add this principal in Settings → Agent access',
    ]);
  }
  const connection = new Connection(socket, options.timeoutMs ?? 30_000);
  try {
    const clientNonce = newNonce();
    const hello = await connection.call('auth.hello', {
      principal: options.principal,
      nonce: clientNonce,
    });
    if (
      !isProofResult(hello) ||
      !proofsMatch(
        serverProof(token, options.principal, clientNonce, hello.serverNonce),
        hello.serverProof,
      )
    ) {
      // The endpoint does not know the token: it is not this profile's Command Center.
      throw new CoreError(
        'E_ENDPOINT_UNSAFE',
        `the endpoint at ${socketPath} could not prove it is Command Center`,
        ['Quit whatever is serving that path, then restart Command Center'],
      );
    }
    const proved = (await connection.call('auth.prove', {
      proof: clientProof(token, options.principal, clientNonce, hello.serverNonce),
    })) as { principal: AuthenticatedPrincipal };
    return {
      principal: proved.principal,
      call: <T>(method: string, params?: Record<string, unknown>) =>
        connection.call(method, params) as Promise<T>,
      close: () => connection.close(),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
