import { methods } from '@cc/schemas';
import { FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { Dispatcher } from '../src/dispatch.js';
import { readToken } from '../src/tokens.js';
import { clientProof, newNonce } from '../src/handshake.js';
import { RawConnection, rejection, sentMessage, startTestCore, type TestCore } from './helpers.js';
import { systemClock } from '../src/clock.js';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

async function start(options: Parameters<typeof startTestCore>[0] = {}): Promise<TestCore> {
  const test = await startTestCore(options);
  open.push(test);
  return test;
}

const CLAIM = { ref: 'A-0142', evidence: [sentMessage()] };

/** An authenticated raw connection, for checking wire-level responses. */
async function rawAuthenticated(test: TestCore): Promise<RawConnection> {
  const raw = await RawConnection.open(test.core.endpoint.path);
  const token = readToken(test.core.userData, 'cli-default') ?? '';
  const nonce = newNonce();
  raw.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'auth.hello',
    params: { principal: 'cli-default', nonce },
  });
  const { serverNonce } = (await raw.next())['result'] as { serverNonce: string };
  raw.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'auth.prove',
    params: { proof: clientProof(token, 'cli-default', nonce, serverNonce) },
  });
  await raw.next();
  return raw;
}

describe('one handler per method for every caller (C-04-01, C-07-03) and the actor rules (04 §4.3)', () => {
  it('C-04-01 the UI and an agent run the same handler; the transport sets the actor', async () => {
    const clock = new FakeTimerClock('2026-11-12T05:30:00Z');
    const test = await start({ seed: true, clock });
    const client = await test.connect();
    const agentResult = await client.call<{ status: string }>('items.claim', CLAIM);
    expect(agentResult.status).toBe('ok');
    // The user claims again with new evidence: a fresh claim (C-03-01).
    await clock.advance(60_000);
    const userResult = (await test.core.callAsUser('items.claim', {
      ref: 'A-0142',
      evidence: [sentMessage('msg_18c2f1')],
    })) as { status: string };
    expect(userResult.status).toBe('ok');
    const agent = { kind: 'agent', principalId: client.principal.id };
    expect(test.itemEvents().map((event) => [event.type, event.actor])).toEqual([
      ['evidence.added', agent],
      ['action_item.claimed', agent],
      ['evidence.added', { kind: 'user' }],
      ['action_item.claimed', { kind: 'user' }],
    ]);
  });

  it('an agent never sees or writes an item outside its workstream filter (07 §5)', async () => {
    const test = await start({ seed: true });
    await test.core.principals.create(
      { kind: 'user' },
      {
        name: 'search-helper',
        kind: 'mcp_client',
        scopes: ['read', 'items:claim'],
        workstreamFilter: ['ws_private'],
      },
    );
    const client = await test.connect('search-helper');
    const error = await rejection(client.call('items.claim', CLAIM));
    expect(error.code).toBe('E_NOT_FOUND');
    expect(error.message).toBe('no action item A-0142');
  });

  it('an agent without sensitiveAccess never reaches an item of a sensitive workstream (07 §5)', async () => {
    const test = await start({
      seed: (item) => ({ ...item, workstreamId: 'ws_private', privacy: 'sensitive' }),
    });
    const client = await test.connect();
    expect((await rejection(client.call('items.claim', CLAIM))).code).toBe('E_NOT_FOUND');
    expect(test.itemEvents()).toEqual([]);
  });

  it('a domain error keeps its code and its rule as the first help line (03 §6)', async () => {
    const test = await start({ seed: true });
    const client = await test.connect();
    const error = await rejection(
      client.call('items.claim', {
        ref: 'A-0142',
        evidence: [{ kind: 'url', url: 'https://example.com/sent', requirementId: 'er1' }],
      }),
    );
    expect(error.code).toBe('E_INVARIANT');
    expect(error.help[0]).toBe('03 §9.1');
    expect(error.message).toContain('er1 accepts connector_record, not url');
  });

  it('a socket request cannot name its own actor: extra members are refused', async () => {
    const test = await start({ seed: true });
    const raw = await rawAuthenticated(test);
    raw.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'items.claim',
      params: CLAIM,
      actor: { kind: 'user' },
    });
    expect(await raw.next()).toMatchObject({
      id: 3,
      error: { code: -32600, data: { code: 'E_USAGE' } },
    });
    raw.close();
  });

  it('a missing scope gets E_FORBIDDEN with the Agent access help (07 §5)', async () => {
    const test = await start({ seed: true });
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'grok-cc', kind: 'external_framework', scopes: ['read', 'items:write'] },
    );
    const client = await test.connect('grok-cc');
    const error = await rejection(client.call('items.claim', CLAIM));
    expect(error.code).toBe('E_FORBIDDEN');
    expect(error.message).toContain('items:claim');
    expect(error.help.join('\n')).toContain('Settings → Agent access');
  });

  it('a scope granted in the app applies to an open connection', async () => {
    const test = await start({ seed: true });
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'grok-cc', kind: 'external_framework', scopes: ['read'] },
    );
    const client = await test.connect('grok-cc');
    expect((await rejection(client.call('items.claim', CLAIM))).code).toBe('E_FORBIDDEN');
    await test.core.principals.update({ kind: 'user' }, 'grok-cc', {
      scopes: ['read', 'items:claim'],
    });
    expect((await client.call<{ status: string }>('items.claim', CLAIM)).status).toBe('ok');
  });
});

describe('JSON-RPC 2.0 lines (04 §4.1 rules 2 and 4)', () => {
  it('maps failures to JSON-RPC error objects whose data is { code, message, help }', async () => {
    const test = await start({
      seed: true,
      register: (dispatcher) => {
        // A method of its own, so the failure is the handler's and not a real method's.
        dispatcher.register({ ...methods.itemsGet, method: 'test.fail' }, () => {
          throw new Error('disk on fire');
        });
      },
    });
    const raw = await rawAuthenticated(test);

    raw.send('{not json');
    expect(await raw.next()).toMatchObject({
      id: null,
      error: { code: -32700, data: { code: 'E_USAGE' } },
    });

    raw.send({ jsonrpc: '2.0', id: 'u', method: 'items.nothing', params: {} });
    expect(await raw.next()).toMatchObject({
      id: 'u',
      error: { code: -32601, data: { code: 'E_USAGE' } },
    });

    raw.send({ jsonrpc: '2.0', id: 4, method: 'items.claim', params: { ref: 'not a ref' } });
    const invalid = await raw.next();
    expect(invalid).toMatchObject({ id: 4, error: { code: -32602, data: { code: 'E_USAGE' } } });
    expect((invalid['error'] as { data: { message: string } }).data.message).toMatch(/ref/);

    raw.send({ jsonrpc: '2.0', id: 5, method: 'items.claim', params: [1, 2] });
    expect(await raw.next()).toMatchObject({ id: 5, error: { code: -32602 } });

    raw.send({ jsonrpc: '2.0', id: 6, method: 'test.fail', params: { ref: 'A-0142' } });
    const internal = await raw.next();
    expect(internal).toMatchObject({
      id: 6,
      error: { code: -32603, data: { code: 'E_INTERNAL' } },
    });
    expect(JSON.stringify(internal)).not.toContain('disk on fire');

    raw.send({ jsonrpc: '1.0', id: 7, method: 'items.claim' });
    expect(await raw.next()).toMatchObject({ id: 7, error: { code: -32600 } });

    raw.send([{ jsonrpc: '2.0', id: 8, method: 'items.claim' }]);
    expect(await raw.next()).toMatchObject({ id: null, error: { code: -32600 } });

    // Requests on one connection are answered in order.
    for (const id of [10, 11, 12])
      raw.send({ jsonrpc: '2.0', id, method: 'items.claim', params: CLAIM });
    const ids = [(await raw.next())['id'], (await raw.next())['id'], (await raw.next())['id']];
    expect(ids).toEqual([10, 11, 12]);
    raw.close();
  });

  it('answers no notification, and closes a connection that sends an over-long line', async () => {
    const test = await start({ seed: true });
    const raw = await rawAuthenticated(test);
    raw.send({ jsonrpc: '2.0', method: 'items.claim', params: CLAIM });
    raw.send({ jsonrpc: '2.0', id: 20, method: 'items.claim', params: CLAIM });
    expect((await raw.next())['id']).toBe(20);
    expect(raw.unread).toBe(0);

    // A complete line over 1 MiB is refused as well as an unfinished one.
    raw.socket.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
    expect(await raw.next()).toMatchObject({ error: { code: -32600 } });
    await raw.waitClosed();
  });

  it('validates results against their schemas when asked (tests and headless mode)', async () => {
    const dispatcher = new Dispatcher({ clock: systemClock, validateResults: true });
    dispatcher.register(methods.itemsGet, () => ({ item: { nope: true } }) as never);
    const error = await rejection(
      dispatcher.call({ kind: 'user' }, 'items.get', { ref: 'A-0142' }),
    );
    expect(error.code).toBe('E_INTERNAL');
    expect(() => dispatcher.register(methods.authHello, () => ({}) as never)).toThrow(/connection/);
    dispatcher.register(methods.itemsList, () => ({ items: [], total: 0 }));
    expect(() => dispatcher.register(methods.itemsList, () => ({ items: [], total: 0 }))).toThrow(
      /already/,
    );
  });
});
