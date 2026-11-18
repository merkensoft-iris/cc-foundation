/**
 * pnpm cc:seed --scenario reference --profile-dir <dir> [--today <date>]: seeds the reference
 * scenario into a headless core with a fake clock (08 §6; 01 §7, 02 §8, 03 §13; 09 P1-15).
 *
 * It starts the core headless in `<dir>` at `<date>` 09:40 in the scenario's time zone
 * (2026-11-04 by default), commits onboarding with the scenario's answers, adds the scenario's
 * agent principal, and makes the local API calls of `fixtures/scenario/reference.json` that add
 * the worked-example records, then stops the core and leaves the seeded profile in `<dir>`:
 * `pnpm dev`'s app, `cc-axi --profile-dir <dir>` and the app end-to-end tests open it. The
 * seeder itself is `seedScenario` of @cc/test-kit, which the scenario tests run with the fake
 * clock moving on.
 *
 * A profile that already holds a committed workspace is refused: seeding is never a merge.
 *
 * Exit codes follow 08 §6: 0 seeded, 1 seeding failed, 2 usage error.
 */
import path from 'node:path';

import { SCENARIOS, seedScenario, type ScenarioName } from '@cc/test-kit';

export const USAGE =
  'usage: pnpm cc:seed --scenario reference --profile-dir <dir> [--today <YYYY-MM-DD>]';

export interface SeedArgs {
  readonly scenario: ScenarioName;
  readonly profileDir: string;
  readonly today?: string;
}

/** Parses the arguments, or returns the usage error's text. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs | string {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    if (!['--scenario', '--profile-dir', '--today'].includes(flag ?? '')) {
      return `unknown argument ${arg}`;
    }
    const value = inline ?? argv[(index += 1)];
    if (value === undefined || value === '' || value.startsWith('--'))
      return `${flag} needs a value`;
    values.set(flag ?? '', value);
  }
  const scenario = values.get('--scenario');
  const profileDir = values.get('--profile-dir');
  const today = values.get('--today');
  if (scenario === undefined) return '--scenario is required';
  if (!(scenario in SCENARIOS)) {
    return `unknown scenario ${scenario}; known: ${Object.keys(SCENARIOS).join(', ')}`;
  }
  if (profileDir === undefined) return '--profile-dir is required';
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return `--today is a date, YYYY-MM-DD, not ${today}`;
  }
  return {
    scenario: scenario as ScenarioName,
    profileDir: path.resolve(profileDir),
    ...(today === undefined ? {} : { today }),
  };
}

/** `1 risk`, `2 risks`. */
function count(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

export interface SeedRun {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
}

/** Seeds the scenario and returns the summary lines; nothing is printed here. */
export async function runSeed(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<SeedRun> {
  const args = parseSeedArgs(argv);
  if (typeof args === 'string') return { exitCode: 2, lines: [`cc:seed: ${args}`, USAGE] };
  let scenario;
  try {
    scenario = await seedScenario({ ...args, env });
  } catch (error) {
    const { code, message, help } = error as { code?: string; message?: string; help?: string[] };
    return {
      exitCode: 1,
      lines: [
        `cc:seed: seeding ${args.scenario} into ${args.profileDir} failed: ${code === undefined ? '' : `${code}: `}${message ?? String(error)}`,
        ...(help ?? []).map((line) => `  ${line}`),
        ...(code === 'E_CONFLICT' ? ['  Seed into a new, empty profile directory'] : []),
      ],
    };
  }
  try {
    // Counted through the local API, as the user sees them.
    const total = async (method: string, params: Record<string, unknown> = {}) =>
      (await scenario.user<{ total: number }>(method, params)).total;
    const rows = {
      workstreams: await total('workstreams.list'),
      // No method lists series yet; the core's store holds them.
      series: scenario.core.store.read((tx) => tx.list('meeting_series').length),
      instances: await total('meetings.list', {
        from: args.today ?? scenario.fixture.today,
        to: '2099-12-31',
      }),
      measures: await total('measures.list'),
      goals: await total('goals.list'),
      items: await total('items.list'),
      decisions: await total('decisions.list'),
      risks: await total('risks.list'),
    };
    return {
      exitCode: 0,
      lines: [
        `cc:seed: the ${args.scenario} scenario is seeded in ${args.profileDir}, on ${scenario.local().replace('T', ' ')} ${scenario.timeZone}`,
        `  ${count(rows.workstreams, 'workstream')}, ${String(rows.series)} meeting series, ${count(rows.instances, 'meeting instance')}, ${count(rows.measures, 'measure')}, ${count(rows.goals, 'goal')}`,
        `  ${count(rows.items, 'action item')}, ${count(rows.decisions, 'decision')}, ${count(rows.risks, 'risk')}; agent principal ${scenario.fixture.agent.name}`,
        `  worked examples: ${[...scenario.refs].map(([plays, ref]) => `${plays} is ${ref}`).join(', ')}`,
      ],
    };
  } finally {
    await scenario.stop();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const result = await runSeed(argv, process.env);
  const write = result.exitCode === 0 ? console.log : console.error;
  for (const line of result.lines) write(line);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
