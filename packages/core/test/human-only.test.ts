import { MessageChannel } from 'node:worker_threads';

import { apiMethods } from '@cc/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deepLink,
  HUMAN_ONLY_OPERATIONS,
  humanRequired,
  isHumanOnlyMethod,
} from '../src/human-only.js';
import type { UiResponse } from '../src/ui-port.js';
import { ALL_SCOPES, rejection, startTestCore, type TestCore } from './helpers.js';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

/** Params that name a target for each link kind. */
function paramsFor(link: string): Record<string, unknown> {
  if (link === 'confirmations') return { id: 'cfm_7q2' };
  if (link === 'requests') return { id: 'req_01' };
  if (link === 'meeting') return { ref: 'mtg_0001' };
  return { ref: 'A-0142' };
}

describe('the human-only catalogue (04 §4.3)', () => {
  it('names every operation of 04 §4.3 rule 3 once, as <namespace>.<verb>', () => {
    const names = HUMAN_ONLY_OPERATIONS.map((entry) => entry.method);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+\.[a-z]+$/);
    // 04 §4.3 rule 3, in order: confirmations; claims (confirm, attest, reject); decisions;
    // draft items and drops; meeting read-back; connector install, update, uninstall;
    // scopes; browser sessions; discovery start and path; lock activation and rollback;
    // the ticket-run standing approval; development requests; backups.
    expect(names).toEqual([
      'confirmations.approve',
      'confirmations.deny',
      'items.confirm',
      'items.attest',
      'items.reject',
      'decisions.decide',
      'items.accept',
      'items.drop',
      'meetings.confirm',
      'connectors.install',
      'connectors.update',
      'connectors.uninstall',
      'principals.create',
      'principals.update',
      'principals.revoke',
      'sessions.create',
      'sessions.delete',
      'discovery.start',
      'discovery.choose',
      'connectors.activate',
      'connectors.rollback',
      'approvals.grant',
      'approvals.revoke',
      'requests.approve',
      'requests.reject',
      'requests.defer',
      'backups.passphrase',
      'backups.destination',
      'backups.restore',
    ]);
  });

  it('covers every method whose schema is human-only', () => {
    for (const definition of apiMethods.filter((entry) => entry.humanOnly)) {
      expect(isHumanOnlyMethod(definition.method), definition.method).toBe(true);
    }
    // And no method the CLI and MCP may call is in it.
    for (const definition of apiMethods.filter((entry) => !entry.humanOnly)) {
      expect(isHumanOnlyMethod(definition.method), definition.method).toBe(false);
    }
  });

  it('builds the deep links of 04 §4.3 and never puts an unchecked value into one', () => {
    expect(deepLink('items', 'A-0142')).toBe('commandcenter://items/A-0142');
    expect(deepLink('confirmations', 'cfm_7q2')).toBe('commandcenter://confirmations/cfm_7q2');
    expect(deepLink('requests', 'req_01')).toBe('commandcenter://requests/req_01');
    expect(deepLink('items', '../../etc')).toBe('commandcenter://');
    expect(humanRequired('items.confirm', { ref: 'A-0142\nrm -rf' }).help.join('\n')).not.toMatch(
      /rm -rf/,
    );
  });
});

describe('E_HUMAN_REQUIRED for every human-only operation (04 §4.3, C-04-05, C-07-02)', () => {
  it('C-04-05 C-07-02 an agent with every scope gets E_HUMAN_REQUIRED and a deep link for each operation', async () => {
    const test = await startTestCore();
    open.push(test);
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'everything', kind: 'external_framework', scopes: ALL_SCOPES },
    );
    const client = await test.connect('everything');
    for (const entry of HUMAN_ONLY_OPERATIONS) {
      const params = paramsFor(entry.link);
      const error = await rejection(client.call(entry.method, params));
      expect(error.code, entry.method).toBe('E_HUMAN_REQUIRED');
      const help = error.help.join('\n');
      const target = (params['ref'] ?? params['id']) as string;
      if (entry.link === 'app') {
        expect(help, entry.method).toContain('commandcenter://');
      } else {
        expect(help, entry.method).toContain(`commandcenter://${entry.link}/${target}`);
        expect(help, entry.method).toContain(`cc-axi open ${target}`);
      }
    }
  });

  it('refuses before checking params: no params still gets E_HUMAN_REQUIRED, not E_USAGE', async () => {
    const test = await startTestCore();
    open.push(test);
    const client = await test.connect();
    const error = await rejection(client.call('confirmations.approve'));
    expect(error.code).toBe('E_HUMAN_REQUIRED');
    expect(error.help.join('\n')).toContain('commandcenter://');
  });

  it('the user reaches a human-only handler through the UI port; an agent never does', async () => {
    const test = await startTestCore({ seed: true });
    open.push(test);
    const client = await test.connect();
    const error = await rejection(client.call('items.drop', { ref: 'A-0142', reason: 'r' }));
    expect(error.code).toBe('E_HUMAN_REQUIRED');
    expect(error.help).toContain('Do this in the app: commandcenter://items/A-0142');
    expect(test.itemEvents()).toEqual([]);

    const { port1, port2 } = new MessageChannel();
    test.core.serveUi({
      postMessage: (message) => port1.postMessage(message),
      onMessage: (listener) => port1.on('message', listener),
    });
    const drop = () =>
      new Promise<UiResponse>((resolve) => {
        port2.once('message', resolve);
        port2.postMessage({
          id: 1,
          method: 'items.drop',
          params: { ref: 'A-0142', reason: 'The lead chose another firm' },
        });
      });
    // The handler runs as the user: the item is dropped, with the user as the event's actor.
    expect(await drop()).toMatchObject({
      id: 1,
      result: { status: 'ok', item: { lifecycle: 'dropped', closedBy: { kind: 'user' } } },
    });
    expect(test.itemEvents().map((event) => [event.type, event.actor])).toEqual([
      ['action_item.dropped', { kind: 'user' }],
    ]);
    // The same drop again is a no-op (07 §4.4).
    expect(await drop()).toMatchObject({ id: 1, result: { status: 'no-op' } });
    port1.close();
    port2.close();
  });

  it('a UI message cannot carry an actor', async () => {
    const test = await startTestCore({
      seed: true,
    });
    open.push(test);
    const { port1, port2 } = new MessageChannel();
    test.core.serveUi({
      postMessage: (message) => port1.postMessage(message),
      onMessage: (listener) => port1.on('message', listener),
    });
    const response = await new Promise<UiResponse>((resolve) => {
      port2.once('message', resolve);
      port2.postMessage({ id: 7, method: 'items.claim', params: {}, actor: { kind: 'system' } });
    });
    expect(response).toMatchObject({ id: 7, error: { code: 'E_USAGE' } });
    port1.close();
    port2.close();
  });
});
