/**
 * An MCP client for the relay's tests, speaking the stdio transport the way an MCP client
 * such as Claude Code does: it starts `cc-axi mcp --principal <name>`, sends `initialize` and
 * `notifications/initialized`, then lists and calls tools, one JSON-RPC message per line.
 *
 * `spawnRelay` runs the built bin as a separate process (what a registered client starts);
 * `startRelay` runs the same `runCli` in-process, for fast tests.
 */
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { decode } from '@toon-format/toon';

import { runCli } from '../../src/cli.ts';
import { testEnv } from './core.ts';

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));

export interface JsonRpcResponse {
  readonly id: number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

export interface ToolCall {
  readonly text: string;
  readonly isError: boolean;
  /** The text decoded from TOON. */
  readonly output: Record<string, unknown>;
}

export interface McpClient {
  /** Sends a request and waits for its response. */
  request(method: string, params?: unknown): Promise<JsonRpcResponse>;
  /** Sends a raw line, for malformed input. */
  send(line: string): void;
  /** The next response with `id`, for raw lines. */
  response(id: number | null): Promise<JsonRpcResponse>;
  initialize(): Promise<JsonRpcResponse>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  /** Ends stdin and waits for the relay to finish; resolves to its exit code. */
  close(): Promise<number>;
}

function client(
  write: (line: string) => void,
  end: () => Promise<number>,
): McpClient & {
  receive(chunk: string): void;
} {
  let buffer = '';
  let nextId = 1;
  const waiting = new Map<number | null, (response: JsonRpcResponse) => void>();
  const early = new Map<number | null, JsonRpcResponse>();
  const response = (id: number | null): Promise<JsonRpcResponse> =>
    new Promise((resolve) => {
      const ready = early.get(id);
      if (ready !== undefined) {
        early.delete(id);
        resolve(ready);
      } else {
        waiting.set(id, resolve);
      }
    });
  const self = {
    receive(chunk: string) {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line) as JsonRpcResponse;
        const resolve = waiting.get(message.id);
        if (resolve === undefined) early.set(message.id, message);
        else {
          waiting.delete(message.id);
          resolve(message);
        }
      }
    },
    send: write,
    response,
    request(method: string, params?: unknown) {
      const id = nextId++;
      write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
      );
      return response(id);
    },
    async initialize() {
      const answer = await self.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });
      write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      return answer;
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const answer = await self.request('tools/call', { name, arguments: args });
      const result = answer.result as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };
      const text = result.content[0]?.text ?? '';
      let output: Record<string, unknown> = {};
      try {
        output = decode(text) as Record<string, unknown>;
      } catch {
        // Left empty: a test that needs TOON fails on its own assertion.
      }
      return { text, isError: result.isError === true, output };
    },
    close: end,
  };
  return self;
}

/** The relay as a separate process, started the way a registered MCP client starts it. */
export function spawnRelay(profileDir: string, principal: string): McpClient {
  const child = spawn(process.execPath, [BIN, 'mcp', '--principal', principal], {
    env: testEnv(profileDir),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  const self = client(
    (line) => child.stdin.write(`${line}\n`),
    async () => {
      child.stdin.end();
      return exited;
    },
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => self.receive(chunk));
  return self;
}

/** The relay in-process, through `runCli` with in-memory stdin and stdout. */
export function startRelay(
  profileDir: string,
  principal: string,
  extraEnv: NodeJS.ProcessEnv = {},
): McpClient {
  const stdin = new PassThrough();
  const holder: { done?: Promise<number> } = {};
  const self = client(
    (line) => stdin.write(`${line}\n`),
    async () => {
      stdin.end();
      return holder.done ?? 0;
    },
  );
  holder.done = runCli({
    argv: ['mcp', '--principal', principal],
    env: testEnv(profileDir, extraEnv),
    cwd: profileDir,
    stdin,
    stdout: { write: (chunk: string) => self.receive(chunk) },
  });
  return self;
}
