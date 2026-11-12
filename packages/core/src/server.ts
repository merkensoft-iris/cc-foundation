/**
 * The local API socket server (04 §4.1, §4.2). Every connection starts unauthenticated and
 * must finish the mutual-proof handshake (`auth.hello`, then `auth.prove`, ADR 0002
 * decision 6) before any other call; until then every call gets `E_FORBIDDEN`. After it, the
 * connection is bound to one agent principal, and every call runs as that agent (04 §4.3
 * rule 2): no socket call can act as the user.
 *
 * Requests on one connection are answered in order. A connection that does not authenticate
 * within the auth timeout, sends a bad proof, or sends an over-long line is closed.
 */
import net from 'node:net';

import { methods } from '@cc/schemas';

import type { Clock, TimerHandle } from './clock.js';
import type { Caller, Dispatcher } from './dispatch.js';
import { AUTH_METHODS } from './dispatch.js';
import { AGENT_ACCESS_HELP, CoreError, isCoreError } from './errors.js';
import { newNonce, proofsMatch, clientProof, serverProof } from './handshake.js';
import {
  BadRequest,
  LineSplitter,
  MAX_LINE_BYTES,
  RPC_INVALID_REQUEST,
  badRequestResponse,
  errorResponse,
  parseRequest,
  resultResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { Principals, PrincipalSummary } from './principals.js';
import { summarize } from './principals.js';

export interface LocalApiServerOptions {
  readonly dispatcher: Dispatcher;
  readonly principals: Principals;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Default 10 s. */
  readonly authTimeoutMs?: number;
  readonly maxLineBytes?: number;
}

type ConnectionState =
  | { readonly phase: 'new' }
  | {
      readonly phase: 'challenged';
      readonly principal: string;
      readonly token: string;
      readonly clientNonce: string;
      readonly serverNonce: string;
    }
  | { readonly phase: 'authenticated'; readonly principal: PrincipalSummary };

const AUTH_FIRST_HELP = 'Start every connection with auth.hello, then auth.prove (04 §4.2)';

function forbidden(message: string): CoreError {
  return new CoreError('E_FORBIDDEN', message, [AGENT_ACCESS_HELP]);
}

export class LocalApiServer {
  readonly #options: LocalApiServerOptions;
  readonly #logger: Logger;
  readonly #sockets = new Set<net.Socket>();
  readonly #listeners = new Set<net.Server>();

  constructor(options: LocalApiServerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
  }

  /** A new listening server bound to this API. The watchdog makes a new one to rebind. */
  createListener(): net.Server {
    const server = net.createServer({ allowHalfOpen: false }, (socket) => this.#accept(socket));
    this.#listeners.add(server);
    server.once('close', () => this.#listeners.delete(server));
    return server;
  }

  /** Number of open connections. */
  get connections(): number {
    return this.#sockets.size;
  }

  /** Closes every listener and connection. */
  async close(): Promise<void> {
    const closing = [...this.#listeners].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    for (const socket of this.#sockets) socket.destroy();
    await Promise.all(closing);
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding('utf8');
    const splitter = new LineSplitter(this.#options.maxLineBytes ?? MAX_LINE_BYTES);
    let state: ConnectionState = { phase: 'new' };
    let queue: Promise<void> = Promise.resolve();
    const clock = this.#options.clock;
    let authTimer: TimerHandle | undefined = clock.setTimeout(() => {
      if (state.phase !== 'authenticated') socket.destroy();
    }, this.#options.authTimeoutMs ?? 10_000);
    const clearAuthTimer = () => {
      if (authTimer !== undefined) clock.clearTimeout(authTimer);
      authTimer = undefined;
    };

    const send = (response: JsonRpcResponse) => {
      if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(response)}\n`);
    };

    const handle = async (line: string): Promise<void> => {
      let request: JsonRpcRequest;
      try {
        request = parseRequest(line);
      } catch (error) {
        if (error instanceof BadRequest) send(badRequestResponse(error));
        return;
      }
      const respond = request.id !== undefined;
      const id = request.id ?? null;
      let closeAfter = false;
      try {
        if (AUTH_METHODS.has(request.method)) {
          const outcome = await this.#authenticate(state, request);
          state = outcome.state;
          if (state.phase === 'authenticated') clearAuthTimer();
          if (respond) send(resultResponse(id, outcome.result));
          return;
        }
        if (state.phase !== 'authenticated') {
          throw new CoreError(
            'E_FORBIDDEN',
            `${request.method} needs an authenticated connection`,
            [AUTH_FIRST_HELP],
          );
        }
        // Re-read the principal on every call: a revocation or a scope change applies at once.
        const current = await this.#options.principals.get(state.principal.name);
        if (current === undefined || current.revokedAt !== undefined) {
          closeAfter = true;
          throw forbidden(`principal ${state.principal.name} has been revoked`);
        }
        const caller: Caller = { kind: 'agent', principal: summarize(current) };
        const result = await this.#options.dispatcher.call(caller, request.method, request.params);
        if (respond) send(resultResponse(id, result));
      } catch (error) {
        const coreError = isCoreError(error)
          ? error
          : new CoreError('E_INTERNAL', `internal error in ${request.method}`, []);
        if (!isCoreError(error)) {
          this.#logger.error('api.failed', { method: request.method, error: String(error) });
        }
        if (respond) send(errorResponse(id, coreError, request.method));
        // A failed handshake or a revoked principal ends the connection.
        if (closeAfter || (AUTH_METHODS.has(request.method) && coreError.code === 'E_FORBIDDEN')) {
          socket.end();
        }
      }
    };

    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        send(
          badRequestResponse(
            new BadRequest(null, RPC_INVALID_REQUEST, 'invalid request: line too long'),
          ),
        );
        socket.end();
        return;
      }
      for (const line of lines) queue = queue.then(() => handle(line));
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearAuthTimer();
      this.#sockets.delete(socket);
    });
  }

  async #authenticate(
    state: ConnectionState,
    request: JsonRpcRequest,
  ): Promise<{ state: ConnectionState; result: unknown }> {
    if (request.method === 'auth.hello') {
      if (state.phase !== 'new') {
        throw forbidden('auth.hello is only valid once, as the first call on a connection');
      }
      const params = methods.authHello.params.safeParse(request.params ?? {});
      if (!params.success) throw forbidden('auth.hello needs a principal name and a nonce');
      const credentials = await this.#options.principals.credentials(params.data.principal);
      if (credentials === undefined) {
        throw forbidden(`unknown or revoked principal ${params.data.principal}`);
      }
      const serverNonce = newNonce();
      const proof = serverProof(
        credentials.token,
        params.data.principal,
        params.data.nonce,
        serverNonce,
      );
      return {
        state: {
          phase: 'challenged',
          principal: params.data.principal,
          token: credentials.token,
          clientNonce: params.data.nonce,
          serverNonce,
        },
        result: { serverNonce, serverProof: proof },
      };
    }

    // auth.prove
    if (state.phase !== 'challenged') {
      throw forbidden('auth.prove must follow auth.hello on the same connection');
    }
    const params = methods.authProve.params.safeParse(request.params ?? {});
    const expected = clientProof(
      state.token,
      state.principal,
      state.clientNonce,
      state.serverNonce,
    );
    if (!params.success || !proofsMatch(expected, params.data.proof)) {
      this.#logger.warn('auth.failed', { principal: state.principal });
      throw forbidden(`authentication failed for principal ${state.principal}`);
    }
    // Re-read the principal: it may have been revoked between hello and prove.
    const credentials = await this.#options.principals.credentials(state.principal);
    if (credentials === undefined || credentials.token !== state.token) {
      throw forbidden(`unknown or revoked principal ${state.principal}`);
    }
    await this.#options.principals.touch(state.principal);
    const principal = summarize(credentials.principal);
    this.#logger.info('auth.ok', { principal: principal.name });
    return { state: { phase: 'authenticated', principal }, result: { principal } };
  }
}
