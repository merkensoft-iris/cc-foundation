/**
 * pnpm scan:canaries: the canary denylist scan (08 §9 ci.yml, AC-08-07). Fails when a file
 * tracked by git, or new and not ignored, contains a string matching a pattern in
 * scripts/canary-denylist.txt. Secret patterns are gitleaks' job in CI.
 *
 * Exit codes follow 08 §6: 0 clean, 1 a finding, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
}

/** Parses the denylist: one regular expression per line, `#` comments and blanks ignored. */
export function parseDenylist(text: string): RegExp[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => new RegExp(line));
}

/** Returns one finding per line of `text` that matches any pattern. */
export function scanText(file: string, text: string, patterns: readonly RegExp[]): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((content, index) => {
    for (const pattern of patterns) {
      if (pattern.test(content)) findings.push({ file, line: index + 1, pattern: pattern.source });
    }
  });
  return findings;
}

/** Scans files (paths relative to `root`), skipping binary files and files that are gone. */
export function scanFiles(
  root: string,
  files: readonly string[],
  patterns: readonly RegExp[],
): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, file));
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (bytes.includes(0)) continue; // binary
    findings.push(...scanText(file, bytes.toString('utf8'), patterns));
  }
  return findings;
}

/** Files git tracks, plus new files that are not ignored. */
export function listFiles(root: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return [...new Set(output.split('\0').filter((file) => file !== ''))];
}

function main(args: readonly string[]): number {
  if (args.length > 0) {
    console.error('usage: pnpm scan:canaries');
    return 2;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const patterns = parseDenylist(
    readFileSync(join(root, 'scripts', 'canary-denylist.txt'), 'utf8'),
  );
  const files = listFiles(root);
  const findings = scanFiles(root, files, patterns);
  for (const finding of findings) {
    console.error(
      `${finding.file}:${finding.line}: matches canary denylist pattern /${finding.pattern}/`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `scan:canaries: ${findings.length} finding(s). Fixtures are synthetic; canaries are made at run time (AC-08-07).`,
    );
    return 1;
  }
  console.log(`scan:canaries: ${files.length} files clean against ${patterns.length} pattern(s).`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
