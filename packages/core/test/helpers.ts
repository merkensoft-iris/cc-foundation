/**
 * Helpers for the core's tests: a core per test in its own profile directory (08 §8 item 6),
 * raw JSON-RPC lines over the socket, and the synthetic fixtures seeded into that profile's
 * workspace store for the domain-backed handlers.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ActionItem, DomainEvent, Scope } from '@cc/schemas';
import type { Store, TableName } from '@cc/store';
import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { connectLocalApi, type LocalApiClient } from '../src/client.js';
import type { InstalledActions } from '../src/store-records.js';
import { startCore, type CoreOptions, type CoreService } from '../src/service.js';

export const ALL_SCOPES: readonly Scope[] = [
  'read',
  'items:write',
  'items:claim',
  'decisions:propose',
  'meetings:capture',
  'measures:write',
  'connectors:read',
  'connectors:invoke',
  'sessions:read',
  'discovery:request',
  'requests:propose',
  'onboarding:apply',
];

export interface TestCore {
  readonly profile: ProfileDir;
  readonly core: CoreService;
  connect(principal?: string): Promise<LocalApiClient>;
  /** The action-item and evidence events written after the seed, oldest first. */
  itemEvents(): DomainEvent[];
  /** Stops the core and removes the profile directory. */
  dispose(): Promise<void>;
}

/**
 * The installed actions of the gmail-alderwick binding, standing in for the installed
 * manifest the Connector Host (P2) reads (INV-03-08).
 */
export const GMAIL_ACTIONS: InstalledActions = (binding) =>
  binding.connectorId === 'gmail' ? ['search_messages', 'create_draft', 'send_draft'] : [];

export interface TestCoreOptions extends Omit<CoreOptions, 'userData'> {
  readonly subdir?: string;
  /** Seeds the fixtures into the workspace store; a function adjusts A-0142 first. */
  readonly seed?: boolean | ((item: ActionItem) => ActionItem);
}

/** Starts a core in a fresh profile directory (`/tmp/cc-test-<random>`). */
export async function startTestCore(options: TestCoreOptions = {}): Promise<TestCore> {
  const profile = createProfileDir();
  const { subdir, seed, ...rest } = options;
  const userData = subdir === undefined ? profile.path : path.join(profile.path, subdir);
  const core = await startCore({
    validateResults: true,
    installedActions: GMAIL_ACTIONS,
    env: {},
    ...rest,
    userData,
  });
  if (seed !== undefined && seed !== false) {
    seedWorkspace(core.store, seed === true ? undefined : seed);
  }
  const clients: LocalApiClient[] = [];
  return {
    profile,
    core,
    itemEvents: () =>
      core.store
        .read((tx) => tx.events())
        .filter(
          (event) =>
            event.correlationId !== SEED &&
            (event.entity.kind === 'action_item' || event.entity.kind === 'evidence'),
        ),
    async connect(principal = 'cli-default') {
      const client = await connectLocalApi({ userData: core.userData, principal });
      clients.push(client);
      return client;
    },
    async dispose() {
      for (const client of clients) client.close();
      await core.stop();
      profile.cleanup();
    },
  };
}

/** Sends raw lines on a fresh connection and collects the response lines. */
export class RawConnection {
  readonly socket: net.Socket;
  readonly #lines: string[] = [];
  readonly #waiters: (() => void)[] = [];
  #buffer = '';
  closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      const parts = this.#buffer.split('\n');
      this.#buffer = parts.pop() ?? '';
      this.#lines.push(...parts.filter((line) => line.length > 0));
      this.#wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.#wake();
    });
    socket.on('error', () => undefined);
  }

  static open(socketPath: string): Promise<RawConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(new RawConnection(socket)));
      socket.once('error', reject);
    });
  }

  send(value: unknown): void {
    this.socket.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  }

  /** The next response line, parsed. */
  async next(): Promise<Record<string, unknown>> {
    while (this.#lines.length === 0) {
      if (this.closed) throw new Error('connection closed before a response');
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return JSON.parse(this.#lines.shift() ?? '') as Record<string, unknown>;
  }

  /** Resolves when the server closes the connection. */
  async waitClosed(): Promise<void> {
    while (!this.closed) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  /** Lines received so far and not yet read. */
  get unread(): number {
    return this.#lines.length;
  }

  close(): void {
    this.socket.destroy();
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

const SEED = 'seed';

/** Fixture type to table, in dependency order (the reference workspace of 03 §13). */
const SEED_TABLES: readonly { type: string; table: TableName }[] = [
  { type: 'workspace', table: 'workspace' },
  { type: 'person', table: 'persons' },
  { type: 'workstream', table: 'workstreams' },
  { type: 'framework_instance', table: 'framework_instances' },
  { type: 'goal', table: 'goals' },
  { type: 'measure', table: 'measures' },
  { type: 'measure_value', table: 'measure_values' },
  { type: 'decision', table: 'decisions' },
  { type: 'issue', table: 'issues' },
  { type: 'risk', table: 'risks' },
  { type: 'action_item', table: 'action_items' },
];

/**
 * The scenario has no sensitive workstream, so the privacy tests (C-03-03, 07 §5) get a synthetic
 * one: a confidential project under Alderwick. The seed files A-0152 (the confidential statement
 * of work, already `sensitive` itself) and G-0002 (its phase-one report) under it.
 */
const PRIVATE = 'ws_private';
const PRIVATE_REFS = new Set(['A-0152', 'G-0002']);

function insertPrivateWorkstream(tx: Parameters<Parameters<Store['command']>[1]>[0]): void {
  const alderwick = JSON.parse(
    fs.readFileSync(path.join(repoRoot(), 'fixtures/records/workstream@1/alderwick.json'), 'utf8'),
  ) as Record<string, unknown>;
  delete alderwick['frameworkInstanceId']; // an R5 child uses its parent's instance (01 §6.2)
  tx.insert('workstreams', {
    version: 1,
    ...alderwick,
    id: PRIVATE,
    slug: 'private-project',
    name: 'Private project',
    kind: 'project',
    parentId: 'ws_ald',
    privacy: 'sensitive',
    aiDataPolicy: 'redact_people',
  } as never);
  tx.event({ type: 'workstream.created', entity: { kind: 'workstream', id: PRIVATE } });
}

/**
 * Seeds the reference records of fixtures/records into a workspace store in one command, each
 * with its `<type>.created` event, plus the gmail-alderwick binding (05 §9) A-0142's check and
 * steps use. Left out: evidence (A-0142 starts without, so a claim adds it), runs and agent
 * principals (the core makes its own). `change` adjusts A-0142.
 */
export function seedWorkspace(
  store: Store,
  change: (item: ActionItem) => ActionItem = (item) => item,
): void {
  const user = { kind: 'user' } as const;
  const at = '2026-11-04T03:30:00Z';
  store.command({ actor: user, correlationId: SEED }, (tx) => {
    for (const { type, table } of SEED_TABLES) {
      const dir = path.join(repoRoot(), 'fixtures/records', `${type}@1`);
      for (const name of fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .sort()) {
        let record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<
          string,
          unknown
        >;
        if (record['ref'] === 'A-0142') record = change(record as ActionItem) as never;
        if (PRIVATE_REFS.has(String(record['ref']))) record = { ...record, workstreamId: PRIVATE };
        tx.insert(table, { version: 1, ...record } as never);
        tx.event({
          type: `${type}.created`,
          entity: {
            kind: type,
            id: String(record['id']),
            ...(typeof record['ref'] === 'string' ? { ref: record['ref'] } : {}),
          },
        });
      }
      if (type === 'workstream') insertPrivateWorkstream(tx);
    }
    // A-0144 is Quillmarsh's (03 §13.2); the fixtures have no record of that workstream.
    const alderwick = tx.get('workstreams', 'ws_ald');
    if (alderwick !== undefined) {
      tx.insert('workstreams', {
        ...alderwick,
        id: 'ws_qlm',
        slug: 'quillmarsh',
        name: 'Quillmarsh',
        repoPaths: [],
      });
      tx.event({ type: 'workstream.created', entity: { kind: 'workstream', id: 'ws_qlm' } });
    }
    tx.insert('connector_bindings', {
      id: 'bnd_gmail_ald',
      doc: { label: 'gmail-alderwick', connectorId: 'gmail' },
      createdAt: at,
      createdBy: user,
      updatedAt: at,
      updatedBy: user,
      version: 1,
    });
    tx.event({
      type: 'connector_binding.created',
      entity: { kind: 'connector_binding', id: 'bnd_gmail_ald' },
    });
  });
}

/** Evidence for A-0142's er1: the sent message, as `record:gmail-alderwick/message/<id>`. */
export function sentMessage(externalId = 'msg_18c2f0') {
  return {
    kind: 'connector_record' as const,
    binding: 'gmail-alderwick',
    recordType: 'message',
    externalId,
    requirementId: 'er1',
  };
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

/** The built headless runner; `pnpm test` builds every package first. */
export function headlessMainPath(): string {
  return path.join(repoRoot(), 'packages/core/dist/headless-main.js');
}

/**
 * Leaves a stale socket file at `socketPath`: a child process listens there and is killed
 * with SIGKILL, so nothing unlinks it (the crash case of ADR 0002).
 */
export function makeStaleSocket(socketPath: string): void {
  const script = [
    "const net = require('node:net');",
    'const server = net.createServer();',
    `server.listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'));`,
  ].join('\n');
  spawnSync(process.execPath, ['-e', script], { stdio: 'ignore' });
  if (!fs.lstatSync(socketPath).isSocket()) throw new Error('no stale socket was left');
}

/** Expects `promise` to reject with a CoreError of `code`; returns it. */
export async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; help: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; help: readonly string[] };
  }
  throw new Error('expected a rejection');
}
