/**
 * pnpm cc:axi-conformance [--runs <n>] [--skip-latency]: the AXI suite over every `cc-axi`
 * command (08 §6, C-07-01, AC-07-01, AC-07-02).
 *
 * It runs the built bin (apps/cli/dist/bin.js) as a user would, against the real core service
 * in headless mode (apps/cli/test/support/core.ts) over the reference fixtures (and one with no
 * records, for the empty states), and checks every command in the catalogue of
 * apps/cli/src/spec.ts. A command without a case here fails the run, so a new command cannot
 * skip the suite. AC-07-01 checks, per 07 §4.1 and §10:
 *
 * - output parses as TOON (and as JSON with `--format json`); nothing is written to stderr;
 * - an unknown flag exits 2 with `E_UNKNOWN_FLAG` and lists every valid flag of the command;
 * - every list has a definitive empty message (`<key>: 0 ...`) and a total count
 *   (`count: <shown> of <total> ...`) equal to the total the API returned, its default
 *   columns only, and next-step help;
 * - `--full` hints appear only on truncation; detail views carry no help otherwise;
 * - mutations print `status`; a repeat of an idempotent one is `no-op` and exits 0;
 * - the home view starts with `bin:` and `description:`; `-v`, `-V` and `--version` print the
 *   bare version; `--help` gives flags, defaults and 2 or 3 examples;
 * - the app not running is `E_APP_NOT_RUNNING`, exit 1.
 *
 * AC-07-02: `cc-axi --version` and `node -e "console.log(1)"` run interleaved, 5 warm-up runs
 * then `--runs` (at least 100) each; the median and p95 differences must both be at most
 * 50 ms (ADR 0002 follow-up 4). On Windows the `.cmd` shim users run is measured too.
 *
 * Exit codes follow 08 §6: 0 every check passed, 1 a check failed, 2 usage error.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode } from '@toon-format/toon';

import { COMMANDS, flagsOf, VERSION, type CommandSpec } from '@cc/cli';

import { startTestCore, testEnv, type TestCore } from '../apps/cli/test/support/core.ts';
import { emptyData } from '../apps/cli/test/support/fixture-api.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = join(ROOT, 'apps', 'cli', 'dist', 'bin.js');
export const BUDGET_MS = 50;

export interface CheckResult {
  readonly id: 'AC-07-01' | 'AC-07-02';
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** One command's conformance case: a valid run on the reference data, and how to make it empty. */
interface Case {
  readonly run: readonly string[];
  /** Arguments that give an empty list on the empty dataset (lists only). */
  readonly empty?: readonly string[];
  /** Run `empty` on the reference data instead (a record that exists but has no rows). */
  readonly emptyOnReference?: boolean;
  /** The method whose result holds the total, and where (lists and the home view). */
  readonly total?: (result: Record<string, unknown>) => number;
  /** Running it again changes nothing: the output is `status: no-op`. */
  readonly repeatNoop?: boolean;
  readonly principal?: string;
}

const total = (result: Record<string, unknown>): number => Number(result['total']);

/** Every catalogue command needs one entry; the run fails on a missing one. */
export const CASES: Readonly<Record<string, Case>> = {
  home: {
    run: ['home'],
    total: (result) => Number((result['counts'] as { dueSoon: number }).dueSoon),
  },
  'items list': { run: ['items', 'list'], empty: ['items', 'list'], total },
  'items view': { run: ['items', 'view', 'A-0142'] },
  'items create': {
    run: [
      'items',
      'create',
      '--workstream',
      'alderwick',
      '--title',
      'Send the signed SOW',
      '--due',
      '2026-11-20',
      '--done-means',
      'The signed SOW is in the client folder',
    ],
  },
  'items update': {
    run: ['items', 'update', 'A-0150', '--health', 'at_risk', '--note', 'Two steps moved'],
    repeatNoop: true,
  },
  'items claim': {
    run: [
      'items',
      'claim',
      'A-0150',
      '--evidence',
      'https://example.com/notes/onboarding-checklist',
    ],
    repeatNoop: true,
  },
  'items attach': {
    run: [
      'items',
      'attach',
      'A-0142',
      '--evidence',
      'record:gmail-alderwick/message/m-1',
      '--requirement',
      'er1',
    ],
    repeatNoop: true,
  },
  'items history': {
    run: ['items', 'history', 'A-0142'],
    empty: ['items', 'history', 'A-0165'],
    emptyOnReference: true,
    total,
  },
  search: { run: ['search', 'proposal'], empty: ['search', 'proposal'], total },
  'decisions list': { run: ['decisions', 'list'], empty: ['decisions', 'list'], total },
  'decisions view': { run: ['decisions', 'view', 'D-0008'] },
  'decisions propose': {
    run: [
      'decisions',
      'propose',
      '--workstream',
      'alderwick',
      '--question',
      'Do we offer phased pricing?',
      '--option',
      'Yes',
      '--option',
      'No',
    ],
    principal: 'claude-code',
  },
  'issues list': { run: ['issues', 'list'], empty: ['issues', 'list'], total },
  'issues view': { run: ['issues', 'view', 'I-0012'] },
  'issues raise': {
    run: ['issues', 'raise', '--workstream', 'alderwick', '--title', 'The lead has not replied'],
    repeatNoop: true,
  },
  'measures list': { run: ['measures', 'list'], empty: ['measures', 'list'], total },
  'measures record': {
    run: ['measures', 'record', 'K-0003', '--value', '4', '--period', '2026-11-09'],
    repeatNoop: true,
  },
  'goals list': { run: ['goals', 'list'], empty: ['goals', 'list'], total },
  'workstreams list': { run: ['workstreams', 'list'], total },
  'workstreams view': { run: ['workstreams', 'view', 'alderwick'] },
  update: { run: ['update'] },
};

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runBin(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env, encoding: 'utf8', timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function toon(text: string): Record<string, unknown> {
  return decode(text) as Record<string, unknown>;
}

class Checks {
  readonly results: CheckResult[] = [];

  add(id: CheckResult['id'], name: string, ok: boolean, detail?: string): void {
    this.results.push(detail === undefined || ok ? { id, name, ok } : { id, name, ok, detail });
  }

  /** Runs `body`; a thrown error is a failed check with the error as its detail. */
  async check(
    id: CheckResult['id'],
    name: string,
    body: () => Promise<string | true> | string | true,
  ): Promise<void> {
    try {
      const outcome = await body();
      this.add(id, name, outcome === true, outcome === true ? undefined : outcome);
    } catch (error) {
      this.add(id, name, false, error instanceof Error ? error.message : String(error));
    }
  }
}

const COUNT = /^(\d+) of (\d+) /;

function showRun(args: readonly string[], run: Run): string {
  return `cc-axi ${args.join(' ')} -> exit ${run.code}\n${run.stdout}${run.stderr === '' ? '' : `stderr: ${run.stderr}`}`;
}

async function commandChecks(
  command: CommandSpec,
  checks: Checks,
  profiles: { reference: string; empty: string; core: TestCore },
): Promise<void> {
  const spec = CASES[command.path];
  const name = (what: string): string => `\`${command.path}\` ${what}`;
  if (spec === undefined) {
    checks.add(
      'AC-07-01',
      name('has a conformance case'),
      false,
      'add it to CASES in scripts/axi-conformance.ts',
    );
    return;
  }
  const env = testEnv(
    profiles.reference,
    spec.principal === undefined ? {} : { CC_PRINCIPAL: spec.principal },
  );
  const words = command.path.split(' ');

  await checks.check(
    'AC-07-01',
    name('--help gives flags, defaults and 2 or 3 examples'),
    async () => {
      const run = await runBin([...words, '--help'], env);
      const help = toon(run.stdout);
      const examples = help['examples'];
      const flags = help['flags'] as { flag: string; default: string }[] | undefined;
      if (run.code !== 0 || run.stderr !== '') return showRun([...words, '--help'], run);
      if (!Array.isArray(examples) || examples.length < 2 || examples.length > 3)
        return `examples: ${JSON.stringify(examples)}`;
      if (!Array.isArray(flags) || flags.some((flag) => typeof flag.default !== 'string'))
        return 'flags without defaults';
      return true;
    },
  );

  await checks.check(
    'AC-07-01',
    name('unknown flag exits 2 and lists the valid flags'),
    async () => {
      const args = [...words, '--no-such-flag'];
      const run = await runBin(args, env);
      const output = toon(run.stdout);
      const help = (output['help'] as string[] | undefined)?.join('\n') ?? '';
      const missing = flagsOf(command).filter((flag) => !help.includes(flag.name));
      if (
        run.code !== 2 ||
        output['code'] !== 'E_UNKNOWN_FLAG' ||
        missing.length > 0 ||
        run.stderr !== ''
      ) {
        return `${showRun(args, run)}missing: ${missing.map((flag) => flag.name).join(', ')}`;
      }
      return true;
    },
  );

  const before = profiles.core.results.length;
  const run = await runBin(spec.run, env);
  const after = profiles.core.results.slice(before);
  let output: Record<string, unknown> = {};
  await checks.check('AC-07-01', name('output parses as TOON, exit 0, nothing on stderr'), () => {
    if (run.code !== 0 || run.stderr !== '') return showRun(spec.run, run);
    output = toon(run.stdout);
    return typeof output === 'object' && output !== null ? true : 'not an object';
  });

  if (command.kind === 'list' || command.kind === 'home') {
    const key = command.listKey ?? 'items';
    const columns = command.columns ?? ['ref', 'title', 'due', 'state'];
    await checks.check('AC-07-01', name(`shows the ${columns.length} default fields`), () => {
      const rows = output[key];
      if (!Array.isArray(rows) || rows.length === 0) return `${key}: ${JSON.stringify(rows)}`;
      const bad = rows.find(
        (row) => JSON.stringify(Object.keys(row as object)) !== JSON.stringify(columns),
      );
      return bad === undefined ? true : `row fields ${JSON.stringify(Object.keys(bad as object))}`;
    });
    await checks.check('AC-07-01', name('carries a total count equal to the API total'), () => {
      const match = COUNT.exec(String(output['count']));
      const result = after.at(-1)?.result as Record<string, unknown> | undefined;
      if (match === null || result === undefined || spec.total === undefined)
        return `count: ${String(output['count'])}`;
      const rows = output[key] as unknown[];
      if (Number(match[1]) !== rows.length)
        return `count says ${match[1]} shown, ${rows.length} rows`;
      return Number(match[2]) === spec.total(result)
        ? true
        : `count says ${match[2]}, the API said ${spec.total(result)}`;
    });
    await checks.check('AC-07-01', name('suggests next steps'), () =>
      Array.isArray(output['help']) && (output['help'] as unknown[]).length > 0
        ? true
        : 'no help[]',
    );
  }
  if (spec.empty !== undefined) {
    const args = spec.empty;
    await checks.check('AC-07-01', name('has a definitive empty message'), async () => {
      const empty = await runBin(
        args,
        testEnv(spec.emptyOnReference === true ? profiles.reference : profiles.empty),
      );
      const parsed = toon(empty.stdout);
      const key = command.listKey ?? 'items';
      return empty.code === 0 &&
        typeof parsed[key] === 'string' &&
        /^0 \S/.test(String(parsed[key]))
        ? true
        : showRun(args, empty);
    });
  }
  if (command.kind === 'view') {
    await checks.check('AC-07-01', name('detail view has no help when nothing was cut'), () =>
      output['help'] === undefined ? true : `help: ${JSON.stringify(output['help'])}`,
    );
  }
  if (command.kind === 'mutation') {
    await checks.check('AC-07-01', name('prints status ok or no-op'), () =>
      output['status'] === 'ok' || output['status'] === 'no-op'
        ? true
        : `status: ${String(output['status'])}`,
    );
    if (spec.repeatNoop === true) {
      await checks.check('AC-07-01', name('repeat is a no-op, exit 0'), async () => {
        const again = await runBin(spec.run, env);
        return again.code === 0 && toon(again.stdout)['status'] === 'no-op'
          ? true
          : showRun(spec.run, again);
      });
    }
  }
  await checks.check('AC-07-01', name('--format json parses as JSON'), async () => {
    const args = [...spec.run, '--format', 'json'];
    const json = await runBin(args, env);
    JSON.parse(json.stdout);
    return json.code === 0 ? true : showRun(args, json);
  });
}

async function suiteChecks(checks: Checks, reference: string): Promise<void> {
  const env = testEnv(reference);
  await checks.check(
    'AC-07-01',
    'home view (no arguments) starts with bin: and description: and has live data',
    async () => {
      const run = await runBin([], env);
      const lines = run.stdout.split('\n');
      const output = toon(run.stdout);
      if (
        run.code !== 0 ||
        !lines[0]?.startsWith('bin: ') ||
        !lines[1]?.startsWith('description: ')
      )
        return showRun([], run);
      // Meetings are served once the rhythm engine's records exist (P1-07, P1-08); until then
      // `today` is the definitive empty message, and the items must be live.
      const today = output['today'];
      return Array.isArray(output['items']) &&
        output['items'].length > 0 &&
        (Array.isArray(today) || today === '0 meetings today')
        ? true
        : 'no live items, or no meetings line';
    },
  );
  for (const flag of ['-v', '-V', '--version']) {
    await checks.check('AC-07-01', `${flag} prints the bare version`, async () => {
      const run = await runBin([flag], process.env);
      return run.code === 0 && run.stdout === `${VERSION}\n` && run.stderr === ''
        ? true
        : showRun([flag], run);
    });
  }
  await checks.check('AC-07-01', '--help lists every command', async () => {
    const run = await runBin(['--help'], env);
    const listed = (toon(run.stdout)['commands'] as { command: string }[]).map(
      (entry) => entry.command,
    );
    const missing = COMMANDS.filter((command) => !listed.includes(command.path));
    return run.code === 0 && missing.length === 0
      ? true
      : `missing: ${missing.map((command) => command.path).join(', ')}`;
  });
  await checks.check('AC-07-01', '--full hint appears only on truncation', async () => {
    const cut = toon((await runBin(['items', 'view', 'A-0161'], env)).stdout);
    const full = toon((await runBin(['items', 'view', 'A-0161', '--full'], env)).stdout);
    const short = toon((await runBin(['items', 'view', 'A-0142'], env)).stdout);
    const hint = JSON.stringify(cut['help'] ?? []);
    const doneMeans = (item: Record<string, unknown>): string =>
      String((item['item'] as Record<string, unknown>)['done_means']);
    if (!hint.includes('--full') || !doneMeans(cut).includes('(truncated: 1000 of '))
      return `truncated view: ${hint}`;
    if (full['help'] !== undefined || doneMeans(full).includes('(truncated'))
      return 'the --full view is still cut or hinted';
    return short['help'] === undefined ? true : 'a short item carries a --full hint';
  });
  await checks.check('AC-07-01', 'unknown command and leading flags exit 2', async () => {
    const unknown = await runBin(['frobnicate'], env);
    const leading = await runBin(['--principal', 'cli-default'], env);
    return unknown.code === 2 && leading.code === 2
      ? true
      : `${showRun(['frobnicate'], unknown)}${showRun(['--principal', 'cli-default'], leading)}`;
  });
  await checks.check(
    'AC-07-01',
    'app not running is E_APP_NOT_RUNNING, exit 1, on stdout',
    async () => {
      const nowhere = mkdtempSync(
        join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cc-test-'),
      );
      try {
        const run = await runBin(['items', 'list'], testEnv(nowhere));
        return run.code === 1 &&
          toon(run.stdout)['code'] === 'E_APP_NOT_RUNNING' &&
          run.stderr === ''
          ? true
          : showRun(['items', 'list'], run);
      } finally {
        rmSync(nowhere, { recursive: true, force: true });
      }
    },
  );
}

export interface Latency {
  readonly d50: number;
  readonly d95: number;
  readonly cli50: number;
  readonly floor50: number;
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

function timed(command: string, args: readonly string[], shell: boolean): number {
  const start = performance.now();
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
  });
  const elapsed = performance.now() - start;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`);
  return elapsed;
}

/** Interleaved runs after 5 warm-ups (ADR 0002 follow-up 4). */
export function measureVersion(
  runs: number,
  cli: { command: string; args: readonly string[]; shell: boolean },
): Latency {
  const floor = { command: process.execPath, args: ['-e', 'console.log(1)'], shell: false };
  const cliTimes: number[] = [];
  const floorTimes: number[] = [];
  for (let index = 0; index < runs + 5; index += 1) {
    const a = timed(cli.command, cli.args, cli.shell);
    const b = timed(floor.command, floor.args, floor.shell);
    if (index >= 5) {
      cliTimes.push(a);
      floorTimes.push(b);
    }
  }
  return {
    d50: quantile(cliTimes, 0.5) - quantile(floorTimes, 0.5),
    d95: quantile(cliTimes, 0.95) - quantile(floorTimes, 0.95),
    cli50: quantile(cliTimes, 0.5),
    floor50: quantile(floorTimes, 0.5),
  };
}

function latencyChecks(checks: Checks, runs: number): void {
  const variants: { name: string; command: string; args: readonly string[]; shell: boolean }[] = [
    { name: 'cc-axi --version', command: process.execPath, args: [BIN, '--version'], shell: false },
  ];
  let shimDir: string | undefined;
  if (process.platform === 'win32') {
    // The .cmd shim Windows users run (ADR 0002 decision 5); its cost was unmeasured in S5.
    shimDir = mkdtempSync(join(tmpdir(), 'cc-shim-'));
    const shim = join(shimDir, 'cc-axi.cmd');
    writeFileSync(shim, `@"${process.execPath}" "${BIN}" %*\r\n`);
    variants.push({
      name: 'cc-axi.cmd --version (Windows shim)',
      command: `"${shim}"`,
      args: ['--version'],
      shell: true,
    });
  }
  try {
    for (const variant of variants) {
      try {
        const latency = measureVersion(runs, variant);
        const detail = `d50 ${latency.d50.toFixed(1)} ms, d95 ${latency.d95.toFixed(1)} ms (median ${latency.cli50.toFixed(1)} ms vs node floor ${latency.floor50.toFixed(1)} ms, n=${runs})`;
        checks.add(
          'AC-07-02',
          `${variant.name} within ${BUDGET_MS} ms of node -e: ${detail}`,
          latency.d50 <= BUDGET_MS && latency.d95 <= BUDGET_MS,
          detail,
        );
      } catch (error) {
        checks.add('AC-07-02', `${variant.name} runs`, false, (error as Error).message);
      }
    }
  } finally {
    if (shimDir !== undefined) rmSync(shimDir, { recursive: true, force: true });
  }
}

export async function runConformance(options: {
  runs: number;
  latency: boolean;
}): Promise<CheckResult[]> {
  const checks = new Checks();
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const reference = mkdtempSync(join(base, 'cc-test-'));
  const empty = mkdtempSync(join(base, 'cc-test-'));
  const core = await startTestCore({ profileDir: reference });
  const emptyCore = await startTestCore({ profileDir: empty, data: emptyData() });
  try {
    await suiteChecks(checks, reference);
    for (const command of COMMANDS)
      await commandChecks(command, checks, { reference, empty, core });
    for (const path of Object.keys(CASES)) {
      if (!COMMANDS.some((command) => command.path === path)) {
        checks.add(
          'AC-07-01',
          `case \`${path}\` names a catalogue command`,
          false,
          'remove it from CASES',
        );
      }
    }
  } finally {
    await core.close();
    await emptyCore.close();
    rmSync(reference, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
  if (options.latency) latencyChecks(checks, options.runs);
  return checks.results;
}

async function main(args: readonly string[]): Promise<number> {
  let runs = 100;
  let latency = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--skip-latency') latency = false;
    else if (arg === '--runs' && /^[1-9]\d*$/.test(args[index + 1] ?? '')) {
      runs = Number(args[index + 1]);
      index += 1;
    } else {
      console.error('usage: pnpm cc:axi-conformance [--runs <n>] [--skip-latency]');
      return 2;
    }
  }
  const results = await runConformance({ runs, latency });
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.name}`);
    if (!result.ok && result.detail !== undefined)
      console.log(`  ${result.detail.replaceAll('\n', '\n  ')}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(
    `cc:axi-conformance: ${results.length - failed.length} of ${results.length} checks passed over ${COMMANDS.length} commands${latency ? '' : ' (latency skipped)'}.`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
