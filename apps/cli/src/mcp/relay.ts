/**
 * `cc-axi mcp`: the stdio MCP relay of 04 §8 and 07 §7.
 *
 * - Transport: stdio, through `@modelcontextprotocol/sdk` (08 §3): its `Server` answers
 *   `initialize` (protocol version negotiation) and `ping`; the relay adds `tools/list` and
 *   `tools/call`. Tools only, no resources or prompts (04 §8 rule 4).
 * - Each tool call runs the `cc-axi` command it maps to (routes.ts) with the CLI's parser and
 *   handler, over the local API as the principal given with `--principal` (04 §8 rule 1). The
 *   result is the command's TOON text in one text block; an error sets `isError` and carries
 *   the same `error:`, `code:` and `help:` lines (07 §7).
 * - Not running (04 §8 rule 2): the relay starts nothing. `tools/list` works without the app,
 *   and every tool call answers `E_APP_NOT_RUNNING` until the app is up; the relay connects on
 *   the first tool call and again after the connection drops.
 * - It holds no state beyond that connection. The principal's scopes are checked by the core,
 *   which also refuses every human-only operation (04 §4.3): a call that tries one, by a tool
 *   name such as `cc_confirm_claim`, is passed to the core, which answers `E_HUMAN_REQUIRED`
 *   with the deep link (AC-07-03, AC-04-04).
 */
import { Writable, type Readable } from 'node:stream';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { encode } from '@toon-format/toon';

import { connectLocalApi, type LocalApiClient } from '@cc/core/client';
import { findMcpTool, MCP_SERVER_NAME, MCP_TOOLS, mcpToolList } from '@cc/schemas';

import { parseArgs } from '../args.js';
import type { Handler, Session } from '../commands/common.js';
import { CliError, describeError, usageError } from '../errors.js';
import { formatError } from '../render.js';
import { VERSION } from '../version.js';
import { RELAY_HANDLERS, routeOf } from './routes.js';

/** A short orientation for the client, sent with `initialize`. */
export const INSTRUCTIONS =
  'Command Center holds your action items, decisions, issues, meetings and scorecard. Start with cc_home. Items you create are drafts their owner accepts in the app; confirming claims, deciding decisions and approving confirmations happen only in the app.';

/**
 * Tool names that ask for a human-only operation (04 §4.3), with the method the core refuses.
 * They are not tools: the relay passes the attempt to the core so that the refusal, and its
 * deep link, come from the same gate as every other caller's (C-04-01).
 */
const HUMAN_ONLY_VERBS: readonly [RegExp, string][] = [
  [/^cc_confirm_(?:read_?back|meeting)/, 'meetings.confirm'],
  [/^cc_approve_(?:development_)?request/, 'requests.approve'],
  [/^cc_(?:deny|reject)_(?:development_)?request/, 'requests.reject'],
  [/^cc_defer(?:_|$)/, 'requests.defer'],
  [/^cc_confirm(?:_|$)/, 'items.confirm'],
  [/^cc_attest(?:_|$)/, 'items.attest'],
  [/^cc_reject(?:_|$)/, 'items.reject'],
  [/^cc_accept(?:_|$)/, 'items.accept'],
  [/^cc_drop(?:_|$)/, 'items.drop'],
  [/^cc_open_decision(?:_|$)/, 'decisions.open'],
  [/^cc_decide(?:_|$)/, 'decisions.decide'],
  [/^cc_approve(?:_|$)/, 'confirmations.approve'],
  [/^cc_deny(?:_|$)/, 'confirmations.deny'],
];

export function humanOnlyMethodOf(tool: string): string | undefined {
  return HUMAN_ONLY_VERBS.find(([pattern]) => pattern.test(tool))?.[1];
}

export interface RelayOptions {
  readonly input: Readable;
  readonly output: { write(chunk: string): unknown } | Writable;
  /** `<userData>`: where the endpoint record and the principal's token are. */
  readonly userData: string;
  readonly principal: string;
  /** For `file:` evidence paths. */
  readonly cwd: string;
  /** The environment and the running `cc-axi` entry, as every command session has them. */
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  /** The CLI's handlers, by command path (cli.ts `HANDLERS`). */
  readonly handlers: Readonly<Record<string, Handler>>;
}

export interface ToolResult {
  readonly content: { type: 'text'; text: string }[];
  readonly isError?: boolean;
  /** The SDK's result type is open; nothing else is set. */
  readonly [key: string]: unknown;
}

function textResult(text: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError }
    : { content: [{ type: 'text', text }] };
}

function errorResult(error: unknown): ToolResult {
  return textResult(formatError(error, 'toon').output.trimEnd(), true);
}

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(arguments)'}: ${issue.message}`,
    )
    .join('; ');
}

/** One relay: the tools, and the connection to the app it opens when a tool is called. */
export class McpRelay {
  readonly #options: RelayOptions;
  #client: Promise<LocalApiClient> | undefined;

  constructor(options: RelayOptions) {
    this.#options = options;
  }

  /** The connection, opened on first use and again after it failed or dropped. */
  #api(): Promise<LocalApiClient> {
    if (this.#client !== undefined) return this.#client;
    const client = connectLocalApi({
      userData: this.#options.userData,
      principal: this.#options.principal,
    });
    this.#client = client;
    client.catch(() => {
      if (this.#client === client) this.#client = undefined;
    });
    return client;
  }

  #session(): Session {
    return {
      globals: { format: 'toon' },
      cwd: this.#options.cwd,
      env: this.#options.env,
      execPath: this.#options.execPath,
      api: () => this.#api(),
    };
  }

  /** Runs one tool call; failures come back as an error result, never as a thrown error. */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    try {
      const tool = findMcpTool(name);
      if (tool === undefined) return await this.#unknownTool(name, args);
      const checked = tool.input.safeParse(args ?? {});
      if (!checked.success) {
        throw usageError(`invalid arguments for ${name}: ${describeIssues(checked.error.issues)}`, [
          `See the inputSchema of ${name} in tools/list`,
        ]);
      }
      const route = routeOf(name, checked.data as Record<string, unknown>);
      const handler = RELAY_HANDLERS[route.path] ?? this.#options.handlers[route.path];
      if (handler === undefined) throw new CliError('E_INTERNAL', `no handler for ${route.path}`);
      const parsed = parseArgs(route.command, route.argv);
      const output = await handler(parsed, this.#session());
      return textResult(encode(output));
    } catch (error) {
      if (describeError(error).code === 'E_APP_NOT_RUNNING') this.#client = undefined;
      return errorResult(error);
    }
  }

  async #unknownTool(name: string, args: unknown): Promise<ToolResult> {
    const method = humanOnlyMethodOf(name);
    if (method === undefined) {
      throw usageError(`unknown tool ${name}`, [
        `The tools are ${MCP_TOOLS.map((tool) => tool.name).join(', ')}`,
      ]);
    }
    // The core's gate refuses it with E_HUMAN_REQUIRED and the deep link (04 §4.3 rule 3).
    const given =
      typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    const target = [given['ref'], given['id']].find((value) => typeof value === 'string');
    const api = await this.#api();
    await api.call(method, target === undefined ? {} : { ref: target, id: target });
    throw new CliError('E_INTERNAL', `${method} was not refused`, [
      'Report this: a human-only operation must be refused to every agent',
    ]);
  }

  close(): void {
    const client = this.#client;
    this.#client = undefined;
    void client?.then(
      (connected) => connected.close(),
      () => undefined,
    );
  }
}

/** A Writable over the output, which may be a plain `{ write }` in tests. */
function writableOf(output: RelayOptions['output']): Writable {
  if (output instanceof Writable) return output;
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      output.write(chunk.toString());
      callback();
    },
  });
}

/**
 * Serves MCP on `input` and `output` until the input ends, then waits for the calls in
 * flight, closes the server and the connection to the app.
 */
export async function runMcpRelay(options: RelayOptions): Promise<void> {
  const relay = new McpRelay(options);
  const server = new Server(
    { name: MCP_SERVER_NAME, version: VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  );
  const inFlight = new Set<Promise<ToolResult>>();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpToolList() }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const call = relay.callTool(request.params.name, request.params.arguments);
    inFlight.add(call);
    void call.finally(() => inFlight.delete(call));
    return call;
  });
  const ended = new Promise<void>((resolve) => {
    options.input.once('end', resolve);
    options.input.once('close', resolve);
  });
  await server.connect(new StdioServerTransport(options.input, writableOf(options.output)));
  try {
    await ended;
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    // The SDK writes each answer once its handler settles: let it finish before closing.
    await new Promise((resolve) => setImmediate(resolve));
    await server.close();
  } finally {
    relay.close();
  }
}
