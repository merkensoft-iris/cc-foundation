/**
 * The P1-07 acceptance criteria (09 §6.1) on the in-memory fake of the store
 * (acceptance-suite.ts), and the materialisation write check.
 */
import { expect, it } from 'vitest';

import { materialise } from '@cc/rhythm';

import { describeAcceptance } from './acceptance-suite.ts';
import {
  checkChanges,
  harness,
  memoryStore,
  rhythm,
  scenarioPlacement,
  scenarioSeries,
} from './harness.ts';

describeAcceptance(memoryStore);

it('AC-02-01 materialisation writes valid records with one event each', () => {
  const { ctx } = harness('2026-11-04T04:10:00Z');
  const result = materialise(ctx, rhythm, {
    series: scenarioSeries(),
    instances: [],
    placement: scenarioPlacement(),
  });
  checkChanges(result.changes);
  expect(result.changes).toHaveLength(result.instances.length);
  expect(new Set(result.instances.map((i) => i.ref)).size).toBe(result.instances.length);
});
