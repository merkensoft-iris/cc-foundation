/**
 * pnpm cc:trace [--phase <P>] [--repo <dir>]...: traceability from the design to the tests
 * (08 §6, C-08-07, AC-08-06).
 *
 * It extracts every acceptance (AC-) and contract (C-) ID from docs/design/*.md and the test
 * names that cite them (08 §8 item 8: a test name starts with the IDs it proves), and lists
 * every ID with its covering tests. Phase gates and connector-track items come from
 * docs/design/09-build-plan.md; one marked done (`**Gate P0 (done).**`, or `(done)` after a
 * track item's ID, 09 §2 rule 8) fails the run while any of its criteria has no test.
 * `--phase <P>` checks one gate (or track item) as C-09-03 requires, whether or not it is
 * marked done; criteria marked `manual:` are listed but not required.
 *
 * Tests are found in this repository: `it`, `test` and `describe` names in *.test.* and
 * *.spec.* files outside node_modules, dist and fixtures, and step names in
 * .github/workflows/*.yml (CI steps that prove a criterion, such as AC-08-02). Hook for the
 * other repositories: `--repo <dir>` (repeatable) adds the tests of a cc-engine or
 * cc-connectors checkout, whose tests cite the same design IDs.
 *
 * A test is counted when it exists and is not skipped; `pnpm test` in the same CI run is what
 * makes it a passing test.
 *
 * Exit codes follow 08 §6: 0 no done phase uncovered, 1 a done phase (or the --phase gate)
 * has an uncovered criterion, 2 usage error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID_PATTERN = /\b(?:AC|C)-\d{2}-\d{2}\b/g;
const LEADING_IDS = /^(?:(?:AC|C)-\d{2}-\d{2}\b[\s,]*)+/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'fixtures', '.git']);

export interface Citation {
  /** Path relative to the root it was found under, with `/` separators. */
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly ids: readonly string[];
}

export interface Gate {
  /** A phase (`P0`) or a connector-track item (`P2-08`). */
  readonly id: string;
  readonly kind: 'phase' | 'track';
  readonly done: boolean;
  readonly acceptance: readonly string[];
  readonly manual: readonly string[];
}

/** Sorts IDs by kind (AC before C), then file number, then item number. */
export function compareIds(a: string, b: string): number {
  const [ka = '', fa = '', na = ''] = a.split('-');
  const [kb = '', fb = '', nb = ''] = b.split('-');
  if (ka !== kb) return ka === 'AC' ? -1 : 1;
  return Number(fa) - Number(fb) || Number(na) - Number(nb);
}

/** Every AC- and C- ID mentioned in the given markdown texts. */
export function extractDesignIds(texts: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(ID_PATTERN)) ids.add(match[0]);
  return [...ids].sort(compareIds);
}

/** Expands `AC-01-01 to AC-01-06` and plain IDs; `manual:` IDs are returned separately. */
export function parseAcceptance(text: string): { acceptance: string[]; manual: string[] } {
  const acceptance: string[] = [];
  const manual: string[] = [];
  const pattern = /(manual:)?AC-(\d{2})-(\d{2})(?:\s+to\s+AC-(\d{2})-(\d{2}))?/g;
  for (const match of text.matchAll(pattern)) {
    const [, isManual, file = '', from = '', toFile, to] = match;
    const target = isManual === undefined ? acceptance : manual;
    const last = toFile === file && to !== undefined ? Number(to) : Number(from);
    for (let n = Number(from); n <= last; n++) {
      target.push(`AC-${file}-${String(n).padStart(2, '0')}`);
    }
  }
  return { acceptance, manual };
}

/**
 * Phase gates (`**Gate P0.** Acceptance: ... .`) and connector-track items (the table under
 * the "Track items" heading) of 09-build-plan.md, with their done marks.
 */
export function parseBuildPlan(text: string): Gate[] {
  const gates: Gate[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const gate = /^\*\*Gate (P\d)( \(done\))?\.\*\*(.*)$/.exec(line);
    if (gate === null) continue;
    const [, id = '', done, rest = ''] = gate;
    const start = rest.indexOf('Acceptance:');
    let section = start < 0 ? '' : rest.slice(start + 'Acceptance:'.length);
    const end = /\.\s+(?=[A-Z])/.exec(section);
    if (end !== null) section = section.slice(0, end.index);
    gates.push({ id, kind: 'phase', done: done !== undefined, ...parseAcceptance(section) });
  }
  const heading = lines.findIndex((line) => /^#{2,4} .*Track items/.test(line));
  if (heading >= 0) {
    let columns: string[] | undefined;
    for (const line of lines.slice(heading + 1)) {
      if (line.startsWith('#')) break;
      if (!line.startsWith('|')) continue;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (columns === undefined) {
        columns = cells;
        continue;
      }
      const item = /^(P\d-\d{2})( \(done\))?$/.exec(cells[columns.indexOf('ID')] ?? '');
      if (item === null) continue; // the separator row
      const [, id = '', done] = item;
      const acceptance = cells[columns.indexOf('Acceptance')] ?? '';
      gates.push({ id, kind: 'track', done: done !== undefined, ...parseAcceptance(acceptance) });
    }
  }
  return gates;
}

/** Test names (and CI step names) that start with design IDs, from one file's text. */
export function extractCitations(file: string, text: string): Citation[] {
  const citations: Citation[] = [];
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;
  const add = (name: string, index: number) => {
    const leading = LEADING_IDS.exec(name);
    if (leading === null) return;
    const ids = [...leading[0].matchAll(ID_PATTERN)].map((match) => match[0]);
    citations.push({ file, line: lineOf(index), name, ids });
  };
  if (/\.ya?ml$/.test(file)) {
    for (const match of text.matchAll(/^[ \t]*(?:-[ \t]+)?name:[ \t]*(.+)$/gm)) {
      add((match[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2'), match.index);
    }
    return citations;
  }
  const call =
    /\b(?:it|test|describe)((?:\.(?:only|skip|todo|fails|concurrent|sequential))*)\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
  for (const match of text.matchAll(call)) {
    const [, modifiers = '', , name = ''] = match;
    if (/\.(?:skip|todo)\b/.test(modifiers)) continue;
    add(name, match.index);
  }
  return citations;
}

function walk(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(root, path, out);
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      out.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
}

/** Every citation in the test files and CI workflows under `root`. */
export function collectCitations(root: string): Citation[] {
  const files: string[] = [];
  walk(root, root, files);
  const workflows = join(root, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows).sort()) {
      if (/\.ya?ml$/.test(name)) files.push(`.github/workflows/${name}`);
    }
  }
  return files
    .sort()
    .flatMap((file) => extractCitations(file, readFileSync(join(root, file), 'utf8')));
}

export interface TraceOptions {
  readonly phase?: string;
  /** Other repositories whose tests also count (the cc-engine and cc-connectors hook). */
  readonly repos?: readonly string[];
}

export interface TraceResult {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: string[];
}

export function runTrace(root: string, options: TraceOptions = {}): TraceResult {
  const docsDir = join(root, 'docs', 'design');
  const docNames = readdirSync(docsDir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const ids = extractDesignIds(docNames.map((name) => readFileSync(join(docsDir, name), 'utf8')));
  const planPath = join(docsDir, '09-build-plan.md');
  const gates = existsSync(planPath) ? parseBuildPlan(readFileSync(planPath, 'utf8')) : [];

  const coverage = new Map<string, string[]>();
  const roots = [
    { dir: root, prefix: '' },
    ...(options.repos ?? []).map((dir) => ({ dir, prefix: `${dir}:` })),
  ];
  for (const { dir, prefix } of roots) {
    for (const citation of collectCitations(dir)) {
      for (const id of citation.ids) {
        const list = coverage.get(id) ?? [];
        list.push(`${prefix}${citation.file}:${citation.line}`);
        coverage.set(id, list);
      }
    }
  }
  const covered = (id: string) => (coverage.get(id) ?? []).length > 0;
  const describe = (id: string) => (coverage.get(id) ?? ['uncovered']).join(', ');
  const lines: string[] = [];

  if (options.phase !== undefined) {
    const gate = gates.find((candidate) => candidate.id === options.phase);
    if (gate === undefined) {
      return {
        exitCode: 2,
        lines: [`cc:trace: no gate or track item ${options.phase} in docs/design/09-build-plan.md`],
      };
    }
    for (const id of gate.acceptance) lines.push(`${id.padEnd(9)} ${describe(id)}`);
    for (const id of gate.manual) lines.push(`${id.padEnd(9)} manual, ${describe(id)}`);
    const missing = gate.acceptance.filter((id) => !covered(id));
    lines.push(
      missing.length === 0
        ? `cc:trace --phase ${gate.id}: all ${gate.acceptance.length} criteria covered${gate.manual.length > 0 ? `, ${gate.manual.length} manual` : ''}.`
        : `cc:trace --phase ${gate.id}: ${missing.length} of ${gate.acceptance.length} criteria uncovered: ${missing.join(', ')}.`,
    );
    return { exitCode: missing.length === 0 ? 0 : 1, lines };
  }

  const owners = new Map<string, string[]>();
  for (const gate of gates) {
    for (const id of [...gate.acceptance, ...gate.manual]) {
      const list = owners.get(id) ?? [];
      if (!list.includes(gate.id)) list.push(gate.id);
      owners.set(id, list);
    }
  }
  for (const id of ids) {
    const owner = (owners.get(id) ?? ['-']).join(',');
    lines.push(`${id.padEnd(9)} ${owner.padEnd(9)} ${describe(id)}`);
  }
  const done = gates.filter((gate) => gate.done);
  const failures: string[] = [];
  for (const gate of done) {
    const missing = gate.acceptance.filter((id) => !covered(id));
    if (missing.length > 0) {
      failures.push(`FAIL ${gate.id} is marked done but has no test for ${missing.join(', ')}`);
    }
  }
  lines.push(...failures);
  const acceptance = ids.filter((id) => id.startsWith('AC-'));
  const contracts = ids.filter((id) => id.startsWith('C-'));
  lines.push(
    `cc:trace: ${acceptance.filter(covered).length} of ${acceptance.length} acceptance IDs covered, ` +
      `${contracts.filter(covered).length} of ${contracts.length} contract IDs cited; ` +
      `done: ${done.length === 0 ? 'none' : done.map((gate) => gate.id).join(', ')}` +
      `${failures.length === 0 ? '' : `; ${failures.length} done gate(s) uncovered`}.`,
  );
  return { exitCode: failures.length === 0 ? 0 : 1, lines };
}

const USAGE = 'usage: pnpm cc:trace [--phase <P>] [--repo <dir>]...';

export function parseArgs(args: readonly string[]): TraceOptions | undefined {
  let phase: string | undefined;
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--phase' && value !== undefined && phase === undefined) phase = value;
    else if (args[i] === '--repo' && value !== undefined) repos.push(value);
    else return undefined;
    i++;
  }
  if (phase !== undefined && !/^P\d(?:-\d{2})?$/.test(phase)) return undefined;
  return phase === undefined ? { repos } : { phase, repos };
}

function main(args: readonly string[]): number {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error(USAGE);
    return 2;
  }
  for (const repo of options.repos ?? []) {
    if (!existsSync(repo) || !statSync(repo).isDirectory()) {
      console.error(`cc:trace: --repo ${repo} is not a directory`);
      return 2;
    }
  }
  const result = runTrace(fileURLToPath(new URL('..', import.meta.url)), options);
  for (const line of result.lines) (result.exitCode === 2 ? console.error : console.log)(line);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
