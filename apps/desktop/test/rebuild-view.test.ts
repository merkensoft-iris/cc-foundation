/**
 * The window's Rebuild now strip (04 §10 rule 2): what it says in each state of main's offer.
 */
import { describe, expect, it } from 'vitest';

import { describeRebuild } from '../src/renderer/rebuild-view.js';
import { stampCheck, UNPACKAGED_REASON, unpackagedCheck } from '../src/main/start-mode.js';

describe('the Rebuild now strip', () => {
  it('offers Rebuild now and Later, hides after Later, and shows progress and failures', () => {
    expect(describeRebuild({ kind: 'none' })).toBeNull();
    expect(
      describeRebuild({ kind: 'offered', reason: 'build out of date: x', deferred: false }),
    ).toEqual({
      text: 'This app is older than its engine checkout (build out of date: x).',
      now: true,
      later: true,
    });
    expect(describeRebuild({ kind: 'offered', reason: 'r', deferred: true })).toBeNull();
    expect(describeRebuild({ kind: 'building' })).toMatchObject({ now: false, later: false });
    expect(
      describeRebuild({ kind: 'failed', reason: 'install failed', log: '/u/builds/b/build.log' }),
    ).toEqual({
      text: 'Rebuild failed: install failed. Nothing changed. Build log: /u/builds/b/build.log',
      now: true,
      later: true,
    });
    expect(
      describeRebuild({ kind: 'waiting-for-idle', busy: ['1 meeting in progress'] })?.text,
    ).toBe('Rebuilt. Restarting when idle (waiting: 1 meeting in progress).');
  });
});

describe('the start check the shell runs (ADR 0004)', () => {
  it('a packaged app without a readable build stamp, and an unpackaged run, are developer mode with no offer', async () => {
    expect(await stampCheck(null)()).toEqual({
      mode: { kind: 'developer', reasons: ['no build stamp: not a packaged build'] },
      offerRebuild: false,
    });
    expect(await unpackagedCheck()).toEqual({
      mode: { kind: 'developer', reasons: [UNPACKAGED_REASON] },
      offerRebuild: false,
    });
  });
});
