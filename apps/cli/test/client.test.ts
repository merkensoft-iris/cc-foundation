/**
 * `cc-axi` reaching the real core service through `@cc/core/client` (ADR 0002 decisions 2 to 4
 * and 6, 04 §4.1 and §4.2): discovery from `CC_PROFILE_DIR`, the principal, and the API's own
 * refusals. The client's endpoint checks (`E_ENDPOINT_UNSAFE`, the impostor endpoint) are
 * tested with the core (packages/core/test).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { connectLocalApi } from '@cc/core/client';
import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { startTestCore, type TestCore } from './support/core.ts';
import { cli } from './support/run.ts';

const profiles: ProfileDir[] = [];
const cores: TestCore[] = [];
const unix = process.platform !== 'win32';

function profile(): ProfileDir {
  const created = createProfileDir();
  profiles.push(created);
  return created;
}

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const created of profiles.splice(0)) created.cleanup();
});

describe('cc-axi and the core service', () => {
  it('AC-07-01 E_APP_NOT_RUNNING (exit 1) when nothing serves the profile', async () => {
    const run = await cli(profile().path, ['items', 'list']);
    expect(run.code).toBe(1);
    expect(run.output).toMatchObject({
      code: 'E_APP_NOT_RUNNING',
      help: ['Open Command Center, then retry'],
    });
  });

  it.runIf(unix)(
    'finds a fallback socket under /tmp through the record when the profile path is too long',
    async () => {
      const dir = profile();
      const long = join(dir.path, 'a'.repeat(60), 'b'.repeat(40));
      mkdirSync(long, { recursive: true, mode: 0o700 });
      const core = await startTestCore({ profileDir: long });
      cores.push(core);
      expect(core.socketPath.startsWith('/tmp/')).toBe(true);
      const run = await cli(long, ['workstreams', 'list']);
      expect(run.code).toBe(0);
      // The client engagement is sensitive and cli-default has no sensitiveAccess (07 §5).
      expect(run.output['count']).toBe('3 of 3 workstreams');
    },
  );

  it('E_FORBIDDEN when the principal has no token file', async () => {
    const dir = profile();
    cores.push(await startTestCore({ profileDir: dir.path, principals: ['cli-default'] }));
    const run = await cli(dir.path, ['items', 'list', '--principal', 'claude-code']);
    expect(run.code).toBe(1);
    expect(run.output['code']).toBe('E_FORBIDDEN');
  });

  it('C-07-02 a human-only method returns E_HUMAN_REQUIRED with a deep link through the API', async () => {
    const dir = profile();
    const core = await startTestCore({ profileDir: dir.path });
    cores.push(core);
    const api = await connectLocalApi({ userData: dir.path, principal: 'cli-default' });
    try {
      await expect(
        api.call('items.drop', { ref: 'A-0142', reason: 'no longer needed' }),
      ).rejects.toMatchObject({
        code: 'E_HUMAN_REQUIRED',
        help: expect.arrayContaining([
          expect.stringContaining('commandcenter://items/A-0142'),
        ]) as unknown,
      });
      const stored = core.core.store.read((tx) => tx.get('action_items', 'act_a0142'));
      expect(stored?.lifecycle).toBe('waiting');
    } finally {
      api.close();
    }
  });

  it('AC-07-01 items claim runs the core’s own domain-backed handler and the views see it', async () => {
    const dir = profile();
    const core = await startTestCore({ profileDir: dir.path });
    cores.push(core);
    const run = await cli(dir.path, [
      'items',
      'claim',
      'A-0150',
      '--evidence',
      'https://example.com/notes/onboarding-checklist',
    ]);
    expect(run.code).toBe(0);
    expect(run.output['status']).toBe('ok');
    expect(core.core.dispatcher.has('items.claim')).toBe(true);
    const claimed = core.events().filter((event) => event.type === 'action_item.claimed');
    expect(claimed.at(-1)?.actor).toMatchObject({ kind: 'agent' });
    const view = await cli(dir.path, ['items', 'view', 'A-0150']);
    expect((view.output['item'] as Record<string, unknown>)['state']).toBe('claimed_done');
  });
});
