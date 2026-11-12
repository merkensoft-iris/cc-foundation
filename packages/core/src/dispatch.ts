/**
 * One handler per local API method, and one gate in front of all of them (04 §1 item 2,
 * C-04-01, C-07-03). Every caller (the UI over IPC, the CLI and MCP over the socket, the AI
 * layer) goes through `Dispatcher.call`, in this order:
 *
 * 1. Human-only (04 §4.3): an agent caller gets `E_HUMAN_REQUIRED` with a deep link, before
 *    any handler lookup or parameter check, for every catalogued operation and every method
 *    whose schema says `humanOnly`.
 * 2. The method must exist (`E_USAGE` otherwise).
 * 3. Scope (07 §5): an agent caller needs the method's scope (`E_FORBIDDEN` otherwise).
 * 4. Parameters are validated with the schema from @cc/schemas (`E_USAGE`).
 * 5. The handler runs with the actor the transport attached (04 §4.3): `user` only for the
 *    app UI, `agent` bound to the principal for every socket connection. A domain error it
 *    throws keeps its code and help lines; any other failure is `E_INTERNAL`.
 */
import type { Actor, ApiMethod } from '@cc/schemas';
import type { z } from 'zod';

import type { Clock } from './clock.js';
import { AGENT_ACCESS_HELP, CoreError, asCoreError, isCoreError } from './errors.js';
import { humanRequired, isHumanOnlyMethod } from './human-only.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { PrincipalSummary } from './principals.js';

/** Who is calling, as the transport established it. Callers never choose it themselves. */
export type Caller =
  { readonly kind: 'user' } | { readonly kind: 'agent'; readonly principal: PrincipalSummary };

export interface HandlerContext {
  /** The actor recorded in domain events (03 §5.10). */
  readonly actor: Actor;
  /** The calling principal, for scope and workstream filtering (C-03-03); absent for the user. */
  readonly principal?: PrincipalSummary;
  readonly clock: Clock;
}

export type Handler<M extends ApiMethod> = (
  params: z.output<M['params']>,
  context: HandlerContext,
) => Promise<z.input<M['result']>> | z.input<M['result']>;

interface Registration {
  readonly definition: ApiMethod;
  readonly handler: Handler<ApiMethod>;
}

export interface DispatcherOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Validate every result against its schema too (tests and headless mode). */
  readonly validateResults?: boolean;
}

/** Methods the socket connection itself answers; never registered as handlers. */
export const AUTH_METHODS: ReadonlySet<string> = new Set(['auth.hello', 'auth.prove']);

export function actorOf(caller: Caller): Actor {
  return caller.kind === 'user'
    ? { kind: 'user' }
    : { kind: 'agent', principalId: caller.principal.id };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(params)'}: ${issue.message}`,
    )
    .join('; ');
}

export class Dispatcher {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #validateResults: boolean;
  readonly #handlers = new Map<string, Registration>();

  constructor(options: DispatcherOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger ?? silentLogger;
    this.#validateResults = options.validateResults ?? false;
  }

  /** Registers the one handler of a method. */
  register<M extends ApiMethod>(definition: M, handler: Handler<M>): void {
    if (AUTH_METHODS.has(definition.method)) {
      throw new Error(`${definition.method} is answered by the connection, not a handler`);
    }
    if (this.#handlers.has(definition.method)) {
      throw new Error(`${definition.method} already has a handler`);
    }
    this.#handlers.set(definition.method, {
      definition,
      handler: handler as unknown as Handler<ApiMethod>,
    });
  }

  has(method: string): boolean {
    return this.#handlers.has(method);
  }

  methods(): string[] {
    return [...this.#handlers.keys()];
  }

  /** Runs one call through the gate and its handler. Failures are thrown as `CoreError`. */
  async call(caller: Caller, method: string, params: unknown): Promise<unknown> {
    const registration = this.#handlers.get(method);

    // 1. Human-only, before anything else.
    if (
      caller.kind === 'agent' &&
      (isHumanOnlyMethod(method) || registration?.definition.humanOnly === true)
    ) {
      throw humanRequired(method, params);
    }

    // 2. The method must exist.
    if (registration === undefined) {
      throw new CoreError('E_USAGE', `unknown method ${method}`, [
        AUTH_METHODS.has(method)
          ? `${method} is only valid as the first call on a connection`
          : 'Methods are <namespace>.<verb>; see packages/schemas/api/ for the list',
      ]);
    }
    const { definition, handler } = registration;

    // 3. Scope.
    if (caller.kind === 'agent' && definition.scope !== undefined) {
      if (!caller.principal.scopes.includes(definition.scope)) {
        throw new CoreError(
          'E_FORBIDDEN',
          `principal ${caller.principal.name} lacks scope ${definition.scope} for ${method}`,
          [AGENT_ACCESS_HELP],
        );
      }
    }

    // 4. Parameters.
    const parsed = definition.params.safeParse(params ?? {});
    if (!parsed.success) {
      throw new CoreError(
        'E_USAGE',
        `invalid params for ${method}: ${describeIssues(parsed.error)}`,
        [`See packages/schemas/api/${method}.json for the parameters`],
      );
    }

    // 5. The handler, with the transport's actor.
    const context: HandlerContext = {
      actor: actorOf(caller),
      ...(caller.kind === 'agent' ? { principal: caller.principal } : {}),
      clock: this.#clock,
    };
    let result: unknown;
    try {
      result = await handler(parsed.data, context);
    } catch (thrown) {
      const error = asCoreError(thrown);
      if (isCoreError(error)) throw error;
      this.#logger.error('dispatch.failed', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CoreError('E_INTERNAL', `internal error in ${method}`, [
        'The core logged the failure; retry, and report it if it repeats',
      ]);
    }
    if (this.#validateResults) {
      const checked = definition.result.safeParse(result);
      if (!checked.success) {
        this.#logger.error('dispatch.bad_result', {
          method,
          issues: describeIssues(checked.error),
        });
        throw new CoreError('E_INTERNAL', `${method} returned a result outside its schema`, [
          describeIssues(checked.error),
        ]);
      }
      return checked.data;
    }
    return result;
  }
}
