import { apiMethods, pendingNamespaces } from '@cc/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { AUTH_METHODS } from '../src/dispatch.js';
import { startTestCore, type TestCore } from './helpers.js';

/** Schema methods the core does not serve yet, with the build step that brings each. */
const NOT_YET: Record<string, string> = {
  'items.handoff': 'P7-01 (07 §4.2: items handoff and items link arrive in P7)',
  'items.link': 'P7-01 (07 §4.2: items handoff and items link arrive in P7)',
};

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

describe('every API method of @cc/schemas has a handler (04 §4.1, C-07-03)', () => {
  it('serves each method except the connection’s own and the ones a later step brings', async () => {
    const test = await startTestCore();
    open.push(test);
    const served = new Set(test.core.dispatcher.methods());
    for (const { method } of apiMethods) {
      if (AUTH_METHODS.has(method)) continue;
      expect(served.has(method), method).toBe(!(method in NOT_YET));
    }
    // Nothing is served that the schemas do not define.
    expect([...served].filter((m) => !apiMethods.some((d) => d.method === m))).toEqual([]);
    // The namespaces still to come are named in @cc/schemas with their steps.
    expect(pendingNamespaces.map((p) => p.namespace)).toContain('connectors.*');
  });
});
