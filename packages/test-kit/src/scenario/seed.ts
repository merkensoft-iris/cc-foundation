/**
 * The scenario seeder (08 §6 `cc:seed`, §8 item 3): the reference scenario of 01 §7, 02 §8 and
 * 03 §13 in a headless core on a fake clock, seeded through the local API the way a user and an
 * agent would build it, never by writing the store directly:
 *
 * 1. the core starts headless in the profile directory, its clock at `today` (2026-11-04) 09:40
 *    in the scenario's time zone;
 * 2. the user commits onboarding with the scenario's answers, `fixtures/onboarding/sample-profile.json`
 *    (01 §7.1 with the S5 tailoring that `scenario.json` abbreviates, 01 §3.2), through
 *    `onboarding.apply` in one transaction (C-01-01): workspace, workstreams, framework
 *    instances, the scorecard lines of 02 §8.2, the priorities, the six series of 02 §8.1 and
 *    their materialised instances;
 * 3. the user adds the scenario's agent principal (Settings → Agent access, 07 §5);
 * 4. the calls of `fixtures/scenario/reference.json` add the worked-example records, as the
 *    user or as that agent. A step's `plays` names the 03 §13 record it stands for; the core
 *    gives it the next free ref, and later steps name it as `{{A-0142}}`.
 *
 * A-0152 is left out: its owner is the client contact, and P1 has no API that adds a person.
 * The scenario's clock is a `FakeTimerClock`; `Scenario.advanceTo` moves it, and the core's
 * scheduler runs the rhythm jobs that fall due on the way (`RhythmJobs` keeps their reports).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { silentLogger, type CoreService, type Logger } from '@cc/core';
import { connectLocalApi, type LocalApiClient } from '@cc/core/client';
import { startHeadless } from '@cc/core/headless';
import { localDateTime, wallClockInstantCompatible } from '@cc/rhythm';
import { OnboardingProfile, type Scope } from '@cc/schemas';

import { FakeTimerClock } from '../fake-timer-clock.js';
import { RhythmJobs, type JobRun } from './rhythm-jobs.js';

/** The scenarios `cc:seed --scenario` knows, by name, with their fixture files. */
export const SCENARIOS = { reference: 'fixtures/scenario/reference.json' } as const;
export type ScenarioName = keyof typeof SCENARIOS;

export interface ScenarioStep {
  /** The 03 §13 record this step's result stands for, such as `A-0142`. */
  readonly plays?: string;
  readonly as: 'user' | 'agent';
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface ScenarioFixture {
  readonly version: 1;
  readonly scenario: string;
  readonly description: string;
  /** The local date the scenario is seeded on. */
  readonly today: string;
  /** The local time of day it is seeded at. */
  readonly seededAt: string;
  /** The onboarding answers the user commits, relative to the repository root. */
  readonly onboarding: string;
  readonly agent: {
    readonly name: string;
    readonly kind: 'cli' | 'mcp_client';
    readonly scopes: readonly Scope[];
  };
  readonly steps: readonly ScenarioStep[];
}

/** The repository root, from this module (src/scenario or dist/scenario of packages/test-kit). */
export function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export function readScenario(name: ScenarioName = 'reference'): ScenarioFixture {
  const file = path.join(repositoryRoot(), SCENARIOS[name]);
  return JSON.parse(readFileSync(file, 'utf8')) as ScenarioFixture;
}

export function readOnboardingProfile(fixture: ScenarioFixture): OnboardingProfile {
  const file = path.join(repositoryRoot(), fixture.onboarding);
  return OnboardingProfile.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface SeedOptions {
  /** The profile directory; it plays the part of `<userData>`. */
  readonly profileDir: string;
  readonly scenario?: ScenarioName;
  /** The local date to seed on, `YYYY-MM-DD`; the fixture's `today` (2026-11-04) by default. */
  readonly today?: string;
  /** The environment for the store's synced-folder check (04 §9 rule 5); empty by default. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

/** A seeded scenario: its core, fake clock and rhythm jobs, and the refs its records got. */
export class Scenario {
  readonly fixture: ScenarioFixture;
  readonly profileDir: string;
  readonly core: CoreService;
  readonly clock: FakeTimerClock;
  readonly jobs: RhythmJobs;
  /** The scenario's time zone (the workspace's). */
  readonly timeZone: string;
  /** The ref each `plays` got, such as `A-0142 → A-0001`. */
  readonly refs = new Map<string, string>();
  readonly #clients: LocalApiClient[] = [];
  #agent: LocalApiClient | undefined;

  constructor(
    fixture: ScenarioFixture,
    profileDir: string,
    core: CoreService,
    clock: FakeTimerClock,
    timeZone: string,
    runs: JobRun[],
  ) {
    this.fixture = fixture;
    this.profileDir = profileDir;
    this.core = core;
    this.clock = clock;
    this.timeZone = timeZone;
    this.jobs = new RhythmJobs(core, clock, runs);
  }

  /** One local API call as the user, as the app's UI path makes it (04 §4.3 rule 1). */
  async user<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.core.callAsUser(method, params)) as T;
  }

  /** One local API call as an agent principal over the socket, `scenario-agent` by default. */
  async agent<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.#agent ??= await this.connect(this.fixture.agent.name);
    return this.#agent.call<T>(method, params);
  }

  /** A client on the core's socket as `principal`, closed with the scenario. */
  async connect(principal: string): Promise<LocalApiClient> {
    const client = await connectLocalApi({ userData: this.core.userData, principal });
    this.#clients.push(client);
    return client;
  }

  /** The ref a worked-example record got, by the ref it plays (`A-0142`). */
  ref(plays: string): string {
    const ref = this.refs.get(plays);
    if (ref === undefined) throw new Error(`the scenario has no record playing ${plays}`);
    return ref;
  }

  /** A local date-time in the scenario's zone (`2026-11-13T15:00`) as a UTC instant. */
  instant(local: string): string {
    return wallClockInstantCompatible(local, this.timeZone);
  }

  /** The clock's time, local to the scenario (`2026-11-13T15:00`). */
  local(): string {
    return localDateTime(this.clock.now().toISOString(), this.timeZone).slice(0, 16);
  }

  /** Moves the clock to a local date-time; the core runs the rhythm jobs due on the way. */
  advanceTo(local: string): Promise<JobRun[]> {
    return this.jobs.advanceTo(this.instant(local));
  }

  /** Closes the clients and stops the core; the profile directory is left as it is. */
  async stop(): Promise<void> {
    for (const client of this.#clients.splice(0)) client.close();
    this.#agent = undefined;
    await this.core.stop();
  }

  /** Runs the fixture's steps in order. */
  async runSteps(steps: readonly ScenarioStep[]): Promise<void> {
    for (const step of steps) {
      const params = this.#fill(step.params) as Record<string, unknown>;
      const result =
        step.as === 'user'
          ? await this.user(step.method, params)
          : await this.agent(step.method, params);
      if (step.plays !== undefined) this.refs.set(step.plays, refOf(step, result));
    }
  }

  /** Replaces each `{{A-0142}}` in the params with the ref that record got. */
  #fill(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replace(/\{\{([A-Z]-\d{4,})\}\}/g, (_match, plays: string) => this.ref(plays));
    }
    if (Array.isArray(value)) return value.map((entry) => this.#fill(entry));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.#fill(entry)]),
      );
    }
    return value;
  }
}

function refOf(step: ScenarioStep, result: Record<string, unknown>): string {
  for (const key of ['item', 'decision', 'issue', 'risk', 'goal', 'value']) {
    const record = result[key] as { ref?: unknown } | undefined;
    if (typeof record?.ref === 'string') return record.ref;
  }
  throw new Error(`${step.method} for ${step.plays ?? '?'} returned no record with a ref`);
}

/**
 * Seeds a scenario into `profileDir` and returns it running. The caller stops it; `cc:seed`
 * stops it at once and leaves the seeded profile behind.
 */
export async function seedScenario(options: SeedOptions): Promise<Scenario> {
  const fixture = readScenario(options.scenario ?? 'reference');
  const profile = readOnboardingProfile(fixture);
  const timeZone = profile.workspace.timeZone;
  const today = options.today ?? fixture.today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
    throw new RangeError(`--today is a date (YYYY-MM-DD), not ${today}`);
  const clock = new FakeTimerClock(
    wallClockInstantCompatible(`${today}T${fixture.seededAt}`, timeZone),
  );
  const runs: JobRun[] = [];
  const core = await startHeadless({
    profileDir: options.profileDir,
    clock,
    onRhythmRun: (run) => void runs.push(run),
    logger: options.logger ?? silentLogger,
    env: options.env ?? {},
    validateResults: true,
  });
  const scenario = new Scenario(fixture, options.profileDir, core, clock, timeZone, runs);
  try {
    await scenario.user('onboarding.apply', { profile });
    await scenario.user('principals.create', {
      name: fixture.agent.name,
      kind: fixture.agent.kind,
      scopes: [...fixture.agent.scopes],
    });
    await scenario.runSteps(fixture.steps);
  } catch (error) {
    await scenario.stop();
    throw error;
  }
  return scenario;
}
