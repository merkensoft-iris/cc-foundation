import dns from 'node:dns';
import net from 'node:net';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/** Thrown when a test tries to reach anything other than a loopback address. */
export class NetworkBlockedError extends Error {
  readonly code = 'CC_NETWORK_BLOCKED';

  constructor(target: string) {
    super(
      `Network access to "${target}" is blocked in tests: tests are hermetic and may only ` +
        'reach loopback fixture servers (C-08-05, AC-08-01).',
    );
    this.name = 'NetworkBlockedError';
  }
}

/**
 * Returns the host a `Socket#connect` call targets, or `undefined` for an IPC path
 * (UNIX socket or Windows named pipe), which never leaves the machine.
 */
function connectHost(args: readonly unknown[]): string | undefined {
  // net.connect() passes Socket#connect one normalised [options, callback] array.
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === 'string' && options.path !== '') return undefined;
    return typeof options.host === 'string' ? options.host : 'localhost';
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  return undefined;
}

function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) throw new NetworkBlockedError(host);
}

let installed = false;

/**
 * Blocks every outbound connection and DNS lookup except loopback, for the whole test
 * process. Installed by the shared Vitest setup file, so no test can reach the network
 * after install (AC-08-01).
 */
export function blockNetwork(): void {
  if (installed) return;
  installed = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const host = connectHost(args);
    if (host !== undefined) assertLoopback(host);
    return Reflect.apply(connect, this, args) as net.Socket;
  } as typeof connect;

  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]): void {
    assertLoopback(hostname);
    Reflect.apply(lookup, dns, [hostname, ...rest]);
  } as typeof dns.lookup;

  const lookupAsync = dns.promises.lookup;
  dns.promises.lookup = function guardedLookupAsync(hostname: string, ...rest: unknown[]) {
    assertLoopback(hostname);
    return Reflect.apply(lookupAsync, dns.promises, [hostname, ...rest]) as ReturnType<
      typeof lookupAsync
    >;
  } as typeof dns.promises.lookup;
}
