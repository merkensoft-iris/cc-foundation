/**
 * The real core service (P1-04) in headless mode, for `cc-axi`'s tests and
 * `pnpm cc:axi-conformance` (04 §3 rule 2, 08 §8 item 6): one core per profile directory,
 * listening on the real endpoint with the real record, tokens, mutual-proof handshake and
 * dispatcher (human-only first, then method, scope, params, handler, and every result checked
 * against @cc/schemas), serving every method `cc-axi` calls with its own store-backed
 * handlers. The dataset of fixture-api.ts is written into the profile's workspace store
 * before the first call.
 */
import { systemClock, type Clock, type CoreService } from '@cc/core';
import { startHeadless } from '@cc/core/headless';
import type { Actor, DomainEvent, Scope, Workspace } from '@cc/schemas';

import { NOW_UTC, readFixtures, referenceData, type FixtureData } from './fixture-api.ts';

/** The principals besides `cli-default`, with their 07 §5 default scopes. */
const EXTRA_PRINCIPALS: Readonly<
  Record<string, { kind: 'cli' | 'mcp_client'; scopes: readonly Scope[] }>
> = {
  'claude-code': {
    kind: 'mcp_client',
    scopes: [
      'read',
      'items:write',
      'items:claim',
      'decisions:propose',
      'meetings:capture',
      'connectors:read',
    ],
  },
  'read-only': { kind: 'cli', scopes: ['read'] },
};

/** Every principal the tests use; `cli-default` is the core's own (04 §4.2 rule 3). */
export const PRINCIPALS: readonly string[] = ['cli-default', ...Object.keys(EXTRA_PRINCIPALS)];

/** The connector bindings the fixture records name (05 §9; 07 §4.2 `record:` evidence). */
const BINDINGS = [
  { id: 'bnd_gmail_ald', label: 'gmail-alderwick', connectorId: 'gmail', actions: ['send_draft'] },
  { id: 'bnd_linkedin_self', label: 'linkedin-self', connectorId: 'linkedin', actions: [] },
] as const;

/** "Now" is fixed at the 07 §4.3 example; timers are real. */
const FIXED_CLOCK: Clock = {
  now: () => new Date(NOW_UTC),
  setTimeout: (callback, ms) => systemClock.setTimeout(callback, ms),
  clearTimeout: (handle) => systemClock.clearTimeout(handle),
};

const SEEDER: Actor = { kind: 'user' };

/**
 * Writes the dataset into the core's workspace store as one import command with a single
 * `workspace.imported` event, so the items start with no history of their own: the
 * reference workspace and persons, the dataset's records, and the two connector bindings.
 */
function seed(core: CoreService, data: FixtureData): void {
  const at = NOW_UTC;
  core.store.command({ actor: SEEDER, correlationId: 'seed' }, (tx) => {
    const [workspace] = readFixtures<Workspace>('workspace@1');
    if (workspace === undefined) throw new Error('fixtures/records/workspace@1 is empty');
    tx.insert('workspace', workspace);
    tx.event({ type: 'workspace.imported', entity: { kind: 'workspace', id: workspace.id } });
    for (const person of readFixtures<Parameters<typeof tx.insert<'persons'>>[1]>('person@1')) {
      tx.insert('persons', person);
    }
    for (const record of data.workstreams) tx.insert('workstreams', record);
    for (const record of data.goals) tx.insert('goals', record);
    for (const record of data.measures) tx.insert('measures', record);
    for (const record of data.values) {
      tx.insert('measure_values', { version: 1, ...record });
    }
    for (const record of data.decisions) tx.insert('decisions', record);
    for (const record of data.issues) tx.insert('issues', record);
    for (const record of data.items) tx.insert('action_items', record);
    for (const record of data.evidence) {
      tx.insert('evidence', { version: 1, ...record });
    }
    if (data.onboarding !== undefined) {
      // The reference workspace was set up by onboarding (01 §9.1): its answers, committed.
      tx.insert('onboarding', {
        id: 'onb_main',
        profile: {
          ...data.onboarding,
          completedSteps: [...data.onboarding.completedSteps, 'commit'],
        },
        committedAt: at,
        createdAt: at,
        createdBy: SEEDER,
        updatedAt: at,
        updatedBy: SEEDER,
        version: 1,
      });
    }
    for (const binding of BINDINGS) {
      tx.insert('connector_bindings', {
        id: binding.id,
        doc: { label: binding.label, connectorId: binding.connectorId },
        createdAt: at,
        createdBy: SEEDER,
        updatedAt: at,
        updatedBy: SEEDER,
        version: 1,
      });
    }
  });
}

export interface TestCoreOptions {
  /** The profile directory (`<userData>`); one per test, from createProfileDir(). */
  readonly profileDir: string;
  /** The records to start with; the reference dataset by default; null for a fresh profile. */
  readonly data?: FixtureData | null;
  /** Principals to create besides `cli-default`; default all of PRINCIPALS. */
  readonly principals?: readonly string[];
}

export interface TestCore {
  readonly core: CoreService;
  /** The endpoint path from the record. */
  readonly socketPath: string;
  /** Every method dispatched, in order, the handshake excluded. */
  readonly calls: string[];
  /** Every successful result, in order, so a check can compare the CLI's output with it. */
  readonly results: { method: string; result: unknown }[];
  /** The domain events written since the seed, oldest first. */
  events(): DomainEvent[];
  close(): Promise<void>;
}

/** Starts the headless core over the dataset in its own store, with the test principals. */
export async function startTestCore(options: TestCoreOptions): Promise<TestCore> {
  const data = options.data === undefined ? referenceData() : options.data;
  const core = await startHeadless({
    profileDir: options.profileDir,
    env: {},
    clock: FIXED_CLOCK,
    validateResults: true,
    installedActions: (binding) => BINDINGS.find((known) => known.id === binding.id)?.actions ?? [],
  });
  if (data !== null) seed(core, data);
  for (const name of options.principals ?? PRINCIPALS) {
    const extra = EXTRA_PRINCIPALS[name];
    if (extra === undefined) continue;
    await core.principals.create({ kind: 'user' }, { name, ...extra });
  }

  const calls: string[] = [];
  const results: { method: string; result: unknown }[] = [];
  const dispatch = core.dispatcher.call.bind(core.dispatcher);
  core.dispatcher.call = async (caller, method, params) => {
    calls.push(method);
    const result = await dispatch(caller, method, params);
    results.push({ method, result });
    return result;
  };

  return {
    core,
    socketPath: core.endpoint.path,
    calls,
    results,
    events: () =>
      core.store.read((tx) => tx.events()).filter((event) => event.correlationId !== 'seed'),
    close: () => core.stop(),
  };
}

/** The environment `cc-axi` runs with against a test core: its profile, no inherited principal. */
export function testEnv(profileDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CC_PROFILE_DIR: profileDir, ...extra };
  if (!('CC_PRINCIPAL' in extra)) delete env['CC_PRINCIPAL'];
  return env;
}
