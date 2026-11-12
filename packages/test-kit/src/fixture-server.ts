import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  /** Base URL, always `http://127.0.0.1:<random port>`. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Starts an HTTP fixture server on 127.0.0.1 with a port chosen by the OS. Tests never use a
 * fixed port, and fixture servers are the only listening sockets a test may open (C-08-05).
 */
export async function startFixtureServer(handler: RequestListener): Promise<FixtureServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
