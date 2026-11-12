/**
 * Agent principals (07 §5, 04 §4.2): who a local API connection is. Every CLI and MCP call
 * runs as one, never as the user (04 §4.3).
 *
 * Principals are created, changed and revoked only in the app (07 §5 rule 1): the methods
 * here that change them refuse every actor but the user with `E_HUMAN_REQUIRED`, and none is
 * reachable from the socket.
 *
 * Storage: the records are rows of the store's `agent_principals` table (03 §12), written
 * with one `agent_principal.<verb>` event each (`StorePrincipalDirectory`); the tokens are
 * files under `<userData>/tokens` (04 §4.2).
 */
import type { Actor, AgentPrincipal, Scope } from '@cc/schemas';

import type { Clock } from './clock.js';
import { AGENT_ACCESS_HELP, CoreError } from './errors.js';
import { humanRequired } from './human-only.js';
import { newId } from './ids.js';
import { deleteToken, readToken, tokenExists, tokenPathOf, writeToken } from './tokens.js';

/** The principal that exists from install (04 §4.2 rule 3). */
export const CLI_DEFAULT = 'cli-default';

/** `cli-default`'s scopes (07 §5 table): read, drafts, claims with evidence; nothing human-only. */
export const CLI_DEFAULT_SCOPES: readonly Scope[] = [
  'read',
  'items:write',
  'items:claim',
  'measures:write',
  'connectors:read',
  'sessions:read',
];

/**
 * Scopes no `cli`, `mcp_client` or `external_framework` principal has by default; the user
 * grants them per principal (07 §5 rule 3).
 */
export const GRANT_ONLY_SCOPES: readonly Scope[] = [
  'connectors:invoke',
  'discovery:request',
  'requests:propose',
  'onboarding:apply',
];

/** What `auth.prove` returns and what handlers see of their caller. */
export type PrincipalSummary = Pick<
  AgentPrincipal,
  'id' | 'name' | 'kind' | 'scopes' | 'workstreamFilter' | 'sensitiveAccess'
>;

export function summarize(principal: AgentPrincipal): PrincipalSummary {
  return {
    id: principal.id,
    name: principal.name,
    kind: principal.kind,
    scopes: [...principal.scopes],
    workstreamFilter:
      principal.workstreamFilter === 'all' ? 'all' : [...principal.workstreamFilter],
    sensitiveAccess: principal.sensitiveAccess,
  };
}

/** What a save records: the event verb, who did it, and the record it replaces. */
export interface PrincipalWrite {
  readonly verb: 'created' | 'updated' | 'revoked' | 'used';
  readonly actor: Actor;
  /** The record as read before the change; absent for a new principal. */
  readonly before?: AgentPrincipal;
}

/** Where principal records live: the store's `agent_principals` table in production. */
export interface PrincipalDirectory {
  get(name: string): Promise<AgentPrincipal | undefined>;
  list(): Promise<AgentPrincipal[]>;
  /**
   * Writes the record and its event together. With `before`, the stored record must still be
   * at `before.version` (`E_CONFLICT` otherwise).
   */
  save(principal: AgentPrincipal, write: PrincipalWrite): Promise<void>;
}

/** `lastUsedAt` is written at most this often per principal, not on every connection. */
export const LAST_USED_RESOLUTION_MS = 60_000;

export interface NewPrincipal {
  readonly name: string;
  readonly kind: AgentPrincipal['kind'];
  readonly scopes: readonly Scope[];
  readonly workstreamFilter?: AgentPrincipal['workstreamFilter'];
  readonly sensitiveAccess?: boolean;
}

export interface PrincipalChange {
  readonly scopes?: readonly Scope[];
  readonly workstreamFilter?: AgentPrincipal['workstreamFilter'];
  readonly sensitiveAccess?: boolean;
}

const INSTALL_ACTOR: Actor = { kind: 'system', component: 'migration' };

function requireUser(actor: Actor, method: string, name: string): void {
  if (actor.kind !== 'user') throw humanRequired(method, { name });
}

export interface PrincipalsOptions {
  readonly userData: string;
  readonly directory: PrincipalDirectory;
  readonly clock: Clock;
}

/** Principal records and their token files. */
export class Principals {
  readonly #userData: string;
  readonly #directory: PrincipalDirectory;
  readonly #clock: Clock;

  constructor(options: PrincipalsOptions) {
    this.#userData = options.userData;
    this.#directory = options.directory;
    this.#clock = options.clock;
  }

  get(name: string): Promise<AgentPrincipal | undefined> {
    return this.#directory.get(name);
  }

  list(): Promise<AgentPrincipal[]> {
    return this.#directory.list();
  }

  /**
   * Makes sure `cli-default` exists with its default scopes and a token file (04 §4.2
   * rule 3). A revoked `cli-default` stays revoked.
   */
  async ensureDefault(): Promise<AgentPrincipal> {
    const existing = await this.#directory.get(CLI_DEFAULT);
    if (existing !== undefined) {
      if (existing.revokedAt === undefined && !tokenExists(this.#userData, CLI_DEFAULT)) {
        writeToken(this.#userData, CLI_DEFAULT);
      }
      return existing;
    }
    const principal = this.#record(
      { name: CLI_DEFAULT, kind: 'cli', scopes: CLI_DEFAULT_SCOPES },
      INSTALL_ACTOR,
    );
    if (!tokenExists(this.#userData, CLI_DEFAULT)) writeToken(this.#userData, CLI_DEFAULT);
    await this.#directory.save(principal, { verb: 'created', actor: INSTALL_ACTOR });
    return principal;
  }

  /** Settings → Agent access → Add (human-only, 07 §5 rule 1). Writes a new token file. */
  async create(actor: Actor, input: NewPrincipal): Promise<AgentPrincipal> {
    requireUser(actor, 'principals.create', input.name);
    const existing = await this.#directory.get(input.name);
    if (existing !== undefined && existing.revokedAt === undefined) {
      throw new CoreError('E_CONFLICT', `principal ${input.name} already exists`, [
        AGENT_ACCESS_HELP,
      ]);
    }
    // A revoked name is given out again on the same record: names are unique (03 §12).
    const fresh = this.#record(input, actor);
    const principal: AgentPrincipal =
      existing === undefined
        ? fresh
        : {
            ...fresh,
            id: existing.id,
            createdAt: existing.createdAt,
            createdBy: existing.createdBy,
            version: existing.version + 1,
          };
    writeToken(this.#userData, input.name);
    await this.#directory.save(principal, {
      verb: 'created',
      actor,
      ...(existing === undefined ? {} : { before: existing }),
    });
    return principal;
  }

  /** Grants or revokes scopes, or changes the workstream filter (human-only). */
  async update(actor: Actor, name: string, change: PrincipalChange): Promise<AgentPrincipal> {
    requireUser(actor, 'principals.update', name);
    const existing = await this.#require(name);
    const updated: AgentPrincipal = {
      ...existing,
      ...(change.scopes === undefined ? {} : { scopes: [...new Set(change.scopes)] }),
      ...(change.workstreamFilter === undefined
        ? {}
        : { workstreamFilter: change.workstreamFilter }),
      ...(change.sensitiveAccess === undefined ? {} : { sensitiveAccess: change.sensitiveAccess }),
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor,
      version: existing.version + 1,
    };
    await this.#directory.save(updated, { verb: 'updated', actor, before: existing });
    return updated;
  }

  /** Revokes a principal and deletes its token file (human-only, 04 §4.2 rule 2). */
  async revoke(actor: Actor, name: string): Promise<AgentPrincipal> {
    requireUser(actor, 'principals.revoke', name);
    const existing = await this.#require(name);
    deleteToken(this.#userData, name);
    if (existing.revokedAt !== undefined) return existing;
    const now = this.#clock.now().toISOString();
    const revoked: AgentPrincipal = {
      ...existing,
      revokedAt: now,
      updatedAt: now,
      updatedBy: actor,
      version: existing.version + 1,
    };
    await this.#directory.save(revoked, { verb: 'revoked', actor, before: existing });
    return revoked;
  }

  /**
   * The principal and its token for `auth.hello`, or `undefined` when the principal is
   * unknown, revoked or has no token file.
   */
  async credentials(
    name: string,
  ): Promise<{ principal: AgentPrincipal; token: string } | undefined> {
    const principal = await this.#directory.get(name);
    if (principal === undefined || principal.revokedAt !== undefined) return undefined;
    const token = readToken(this.#userData, name);
    return token === undefined ? undefined : { principal, token };
  }

  /**
   * Records a successful authentication (`lastUsedAt`), at most once per
   * `LAST_USED_RESOLUTION_MS`: every CLI command opens a connection, and each write is a
   * durable transaction with an event.
   */
  async touch(name: string): Promise<void> {
    const existing = await this.#directory.get(name);
    if (existing === undefined) return;
    const now = this.#clock.now();
    if (
      existing.lastUsedAt !== undefined &&
      now.getTime() - Date.parse(existing.lastUsedAt) < LAST_USED_RESOLUTION_MS
    ) {
      return;
    }
    await this.#directory.save(
      { ...existing, lastUsedAt: now.toISOString(), version: existing.version + 1 },
      { verb: 'used', actor: { kind: 'agent', principalId: existing.id }, before: existing },
    );
  }

  async #require(name: string): Promise<AgentPrincipal> {
    const existing = await this.#directory.get(name);
    if (existing === undefined) {
      throw new CoreError('E_NOT_FOUND', `no principal named ${name}`, [AGENT_ACCESS_HELP]);
    }
    return existing;
  }

  #record(input: NewPrincipal, actor: Actor): AgentPrincipal {
    const now = this.#clock.now().toISOString();
    return {
      id: newId('agt', this.#clock),
      name: input.name,
      kind: input.kind,
      scopes: [...new Set(input.scopes)],
      workstreamFilter: input.workstreamFilter ?? 'all',
      sensitiveAccess: input.sensitiveAccess ?? false,
      tokenPath: tokenPathOf(this.#userData, input.name),
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
      version: 1,
    };
  }
}
