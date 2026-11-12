import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createProfileDir, makeCanary } from '@cc/test-kit';

import { parseDenylist, scanFiles, scanText } from '../scan-canaries.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const denylist = parseDenylist(readFileSync(join(root, 'scripts', 'canary-denylist.txt'), 'utf8'));

describe('scan:canaries', () => {
  it('AC-08-07 a fixture containing a canary string fails the scan', () => {
    const dir = createProfileDir();
    try {
      mkdirSync(join(dir.path, 'fixtures', 'scenario'), { recursive: true });
      writeFileSync(
        join(dir.path, 'fixtures', 'scenario', 'clean.json'),
        '{"owner": "Example Person"}\n',
      );
      writeFileSync(
        join(dir.path, 'fixtures', 'scenario', 'leak.json'),
        `{\n  "owner": "${makeCanary('person')}"\n}\n`,
      );
      const findings = scanFiles(
        dir.path,
        ['fixtures/scenario/clean.json', 'fixtures/scenario/leak.json', 'fixtures/missing.json'],
        denylist,
      );
      expect(findings).toEqual([
        { file: 'fixtures/scenario/leak.json', line: 2, pattern: denylist[0]?.source },
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it('skips binary files and ignores denylist comments', () => {
    const dir = createProfileDir();
    try {
      writeFileSync(
        join(dir.path, 'image.bin'),
        Buffer.from([0, 1, 2, ...Buffer.from(makeCanary('bin'))]),
      );
      expect(scanFiles(dir.path, ['image.bin'], denylist)).toEqual([]);
      expect(parseDenylist('# comment\n\n  x+y  \n').map((pattern) => pattern.source)).toEqual([
        'x+y',
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it('the denylist does not match its own patterns or the canary prefix alone', () => {
    const text = readFileSync(join(root, 'scripts', 'canary-denylist.txt'), 'utf8');
    expect(scanText('scripts/canary-denylist.txt', text, denylist)).toEqual([]);
  });
});
