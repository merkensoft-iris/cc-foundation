import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createProfileDir, FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { connectLocalApi } from '../src/client.js';
import { clientProof, newNonce, serverProof } from '../src/handshake.js';
import { CLI_DEFAULT_SCOPES } from '../src/principals.js';
import { readToken, tokenPathOf, tokensDirOf } from '../src/tokens.js';
import { RawConnection, rejection, startTestCore, type TestCore } from './helpers.js';

const posix = process.platform !== 'win32';
const mode = (file: string) => fs.lstatSync(file).mode & 0o777;

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

/** Runs the handshake by hand on a raw connection; returns the proof it sent. */
async function handshake(
  raw: RawConnection,
  principal: string,
  token: string,
): Promise<{ response: Record<string, unknown>; proof: string }> {
  const nonce = newNonce();
  raw.send({ jsonrpc: '2.0', id: 1, method: 'auth.hello', params: { principal, nonce } });
  const hello = (await raw.next())['result'] as { serverNonce: string };
  const proof = clientProof(token, principal, nonce, hello.serverNonce);
  raw.send({ jsonrpc: '2.0', id: 2, method: 'auth.prove', params: { proof } });
  return { response: await raw.next(), proof };
}

describe('principals and tokens (04 §4.2, 07 §5)', () => {
  it('cli-default exists from install with its default scopes and a 256-bit 0600 token', async () => {
    const { core } = await start();
    const principal = await core.principals.get('cli-default');
    expect(principal).toMatchObject({
      name: 'cli-default',
      kind: 'cli',
      scopes: [...CLI_DEFAULT_SCOPES],
      workstreamFilter: 'all',
      sensitiveAccess: false,
      tokenPath: tokenPathOf(core.userData, 'cli-default'),
      createdBy: { kind: 'system', component: 'migration' },
    });
    expect(principal?.id).toMatch(/^agt_[0-9A-Z]{26}$/);
    // Nothing human-only, and none of the grant-only scopes of 07 §5 rule 3.
    expect(principal?.scopes).not.toContain('connectors:invoke');
    expect(principal?.scopes).not.toContain('onboarding:apply');
    const token = readToken(core.userData, 'cli-default');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    if (posix) {
      expect(mode(tokenPathOf(core.userData, 'cli-default'))).toBe(0o600);
      expect(mode(tokensDirOf(core.userData))).toBe(0o700);
    }
  });

  it('keeps an existing token across restarts', async () => {
    const profile = createProfileDir();
    try {
      const { startCore } = await import('../src/service.js');
      const first = await startCore({ userData: profile.path });
      const token = readToken(profile.path, 'cli-default');
      await first.stop();
      const second = await startCore({ userData: profile.path });
      expect(readToken(profile.path, 'cli-default')).toBe(token);
      await second.stop();
    } finally {
      profile.cleanup();
    }
  });

  it('only the user creates, changes or revokes a principal (07 §5 rule 1)', async () => {
    const { core } = await start();
    const agent = { kind: 'agent' as const, principalId: 'agt_other' as const };
    for (const attempt of [
      core.principals.create(agent, { name: 'claude-code', kind: 'mcp_client', scopes: ['read'] }),
      core.principals.update(agent, 'cli-default', { scopes: ['read', 'connectors:invoke'] }),
      core.principals.revoke(agent, 'cli-default'),
    ]) {
      const error = await rejection(attempt);
      expect(error.code).toBe('E_HUMAN_REQUIRED');
      expect(error.help.join('\n')).toContain('Settings → Agent access');
    }
    const created = await core.principals.create(
      { kind: 'user' },
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read', 'items:write'] },
    );
    expect(created.createdBy).toEqual({ kind: 'user' });
    expect(readToken(core.userData, 'claude-code')).toMatch(/^[0-9a-f]{64}$/);
    const duplicate = await rejection(
      core.principals.create({ kind: 'user' }, { name: 'claude-code', kind: 'cli', scopes: [] }),
    );
    expect(duplicate.code).toBe('E_CONFLICT');
  });

  it('refuses a token file that others can read', async () => {
    if (!posix) return;
    const { core } = await start();
    fs.chmodSync(tokenPathOf(core.userData, 'cli-default'), 0o644);
    expect(() => readToken(core.userData, 'cli-default')).toThrow(/mode 600/);
  });
});

describe('auth.hello and auth.prove: the mutual-proof handshake (04 §4.2 rule 1, ADR 0002 decision 6)', () => {
  it('authenticates a principal and records lastUsedAt', async () => {
    const clock = new FakeTimerClock('2026-11-11T10:00:00Z');
    const test = await start({ clock });
    const client = await test.connect();
    expect(client.principal).toEqual({
      id: (await test.core.principals.get('cli-default'))?.id,
      name: 'cli-default',
      kind: 'cli',
      scopes: [...CLI_DEFAULT_SCOPES],
      workstreamFilter: 'all',
      sensitiveAccess: false,
    });
    expect((await test.core.principals.get('cli-default'))?.lastUsedAt).toBe(
      '2026-11-11T10:00:00.000Z',
    );
  });

  it('any call before the handshake gets E_FORBIDDEN', async () => {
    const { core } = await start();
    const raw = await RawConnection.open(core.endpoint.path);
    raw.send({ jsonrpc: '2.0', id: 1, method: 'items.list', params: {} });
    const response = await raw.next();
    expect(response['error']).toMatchObject({ data: { code: 'E_FORBIDDEN' } });
    raw.send({ jsonrpc: '2.0', id: 2, method: 'auth.prove', params: { proof: 'x'.repeat(43) } });
    expect((await raw.next())['error']).toMatchObject({ data: { code: 'E_FORBIDDEN' } });
    await raw.waitClosed();
  });

  it('a wrong token gets E_FORBIDDEN and the connection is closed', async () => {
    const { core } = await start();
    const error = await rejection(
      connectLocalApi({ userData: core.userData, principal: 'cli-default', token: 'f'.repeat(64) }),
    );
    // The server's proof does not match a wrong token, so the client stops first.
    expect(error.code).toBe('E_ENDPOINT_UNSAFE');

    const raw = await RawConnection.open(core.endpoint.path);
    const { response } = await handshake(raw, 'cli-default', 'f'.repeat(64));
    expect(response['error']).toMatchObject({ data: { code: 'E_FORBIDDEN' } });
    await raw.waitClosed();
  });

  it('an unknown or revoked principal gets E_FORBIDDEN', async () => {
    const { core } = await start();
    const raw = await RawConnection.open(core.endpoint.path);
    raw.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'auth.hello',
      params: { principal: 'nobody', nonce: newNonce() },
    });
    expect((await raw.next())['error']).toMatchObject({ data: { code: 'E_FORBIDDEN' } });
    await raw.waitClosed();

    const token = readToken(core.userData, 'cli-default') ?? '';
    await core.principals.revoke({ kind: 'user' }, 'cli-default');
    expect(fs.existsSync(tokenPathOf(core.userData, 'cli-default'))).toBe(false);
    const error = await rejection(
      connectLocalApi({ userData: core.userData, principal: 'cli-default', token }),
    );
    expect(error.code).toBe('E_FORBIDDEN');
  });

  it('a revocation applies to connections that are already open', async () => {
    const test = await start();
    const client = await test.connect();
    expect(await client.call('items.list', {})).toEqual({ items: [], total: 0 });
    await test.core.principals.revoke({ kind: 'user' }, 'cli-default');
    expect((await rejection(client.call('items.list', {}))).code).toBe('E_FORBIDDEN');
  });

  it('a proof from one connection is useless on another (fresh server nonce)', async () => {
    const { core } = await start();
    const token = readToken(core.userData, 'cli-default') ?? '';
    const first = await RawConnection.open(core.endpoint.path);
    const { response, proof } = await handshake(first, 'cli-default', token);
    expect(response['result']).toMatchObject({ principal: { name: 'cli-default' } });

    const second = await RawConnection.open(core.endpoint.path);
    second.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'auth.hello',
      params: { principal: 'cli-default', nonce: newNonce() },
    });
    await second.next();
    second.send({ jsonrpc: '2.0', id: 2, method: 'auth.prove', params: { proof } });
    expect((await second.next())['error']).toMatchObject({ data: { code: 'E_FORBIDDEN' } });
    first.close();
  });

  it('a server proof never passes as a client proof', () => {
    const token = 'a'.repeat(64);
    expect(serverProof(token, 'cli-default', 'n1', 'n2')).not.toBe(
      clientProof(token, 'cli-default', 'n1', 'n2'),
    );
  });

  it('a second auth.hello on a connection is refused', async () => {
    const { core } = await start();
    const token = readToken(core.userData, 'cli-default') ?? '';
    const raw = await RawConnection.open(core.endpoint.path);
    await handshake(raw, 'cli-default', token);
    raw.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'auth.hello',
      params: { principal: 'cli-default', nonce: newNonce() },
    });
    expect((await raw.next())['error']).toMatchObject({ data: { code: 'E_FORBIDDEN' } });
    await raw.waitClosed();
  });

  it('closes a connection that does not authenticate within the timeout', async () => {
    const clock = new FakeTimerClock('2026-11-11T10:00:00Z');
    const { core } = await start({ clock, authTimeoutMs: 10_000 });
    const raw = await RawConnection.open(core.endpoint.path);
    await clock.advance(9_999);
    expect(raw.closed).toBe(false);
    await clock.advance(1);
    await raw.waitClosed();
  });

  it.runIf(posix)(
    'the client sends nothing derived from the token to an endpoint that cannot prove it knows it',
    async () => {
      const profile = createProfileDir();
      const received: string[] = [];
      const impostorPath = path.join(profile.path, 'impostor.sock');
      const impostor = net.createServer((socket) => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          for (const line of chunk.split('\n').filter(Boolean)) {
            received.push(line);
            const request = JSON.parse(line) as { id: number };
            socket.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { serverNonce: newNonce(), serverProof: 'A'.repeat(43) } })}\n`,
            );
          }
        });
      });
      await new Promise<void>((resolve) => impostor.listen(impostorPath, resolve));
      try {
        const token = 'c'.repeat(64);
        const error = await rejection(
          connectLocalApi({
            userData: profile.path,
            principal: 'cli-default',
            token,
            path: impostorPath,
          }),
        );
        expect(error.code).toBe('E_ENDPOINT_UNSAFE');
        expect(received).toHaveLength(1);
        expect(JSON.parse(received[0] ?? '{}')).toMatchObject({ method: 'auth.hello' });
        expect(received.join('\n')).not.toContain(token);
      } finally {
        await new Promise<void>((resolve) => impostor.close(() => resolve()));
        profile.cleanup();
      }
    },
  );
});
