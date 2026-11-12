import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createProfileDir, startFixtureServer } from '@cc/test-kit';

/**
 * Smoke test for the e2e project until the headless core lands (P1): the shape every
 * scenario test follows, with its own profile directory and a loopback fixture server on
 * an OS-chosen port, so two worktrees can run `pnpm e2e` at once.
 */
describe('hermetic e2e run', () => {
  it('AC-08-04 runs in its own profile directory against a loopback fixture server', async () => {
    const profile = createProfileDir();
    const server = await startFixtureServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ path: request.url }));
    });
    try {
      const body = (await (await fetch(`${server.url}/calendar`)).json()) as { path: string };
      mkdirSync(join(profile.path, 'run'));
      writeFileSync(join(profile.path, 'run', 'endpoint'), body.path);
      expect(readFileSync(join(profile.path, 'run', 'endpoint'), 'utf8')).toBe('/calendar');
    } finally {
      await server.close();
      profile.cleanup();
    }
  });
});
