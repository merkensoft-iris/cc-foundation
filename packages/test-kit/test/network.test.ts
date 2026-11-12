import net from 'node:net';
import { describe, expect, it } from 'vitest';

import { NetworkBlockedError, startFixtureServer } from '@cc/test-kit';

describe('network guard', () => {
  it('AC-08-01 tests make no network calls: a connection to a public address is refused', () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so nothing is reached even unguarded.
    expect(() => net.connect({ host: '192.0.2.1', port: 80 })).toThrow(NetworkBlockedError);
  });

  it('AC-08-01 tests make no network calls: fetch to a public host fails before DNS', async () => {
    const error: unknown = await fetch('http://example.com/').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeInstanceOf(NetworkBlockedError);
  });

  it('AC-08-01 allows a loopback fixture server inside the test', async () => {
    const server = await startFixtureServer((_request, response) => {
      response.end('ok');
    });
    try {
      const response = await fetch(`${server.url}/`);
      expect(await response.text()).toBe('ok');
    } finally {
      await server.close();
    }
  });
});
