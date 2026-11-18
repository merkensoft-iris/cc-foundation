/**
 * `cc-axi`: the AXI command line of Command Center (07 §4), on axi-sdk-js `runAxiCli()`.
 * Loaded by bin.ts only when the `--version` fast path did not answer.
 */
import os from 'node:os';
import type { Readable } from 'node:stream';

import { encode } from '@toon-format/toon';
import { runAxiCli } from 'axi-sdk-js';

import { connectLocalApi, type LocalApiClient } from '@cc/core/client';

import { parseArgs, peekFormat, type Globals } from './args.js';
import { homeCommand, homeView } from './commands/home.js';
import {
  itemsAttach,
  itemsClaim,
  itemsCreate,
  itemsHistory,
  itemsList,
  itemsUpdate,
  itemsView,
} from './commands/items.js';
import {
  decisionsList,
  decisionsPropose,
  decisionsView,
  goalsList,
  issuesList,
  issuesRaise,
  issuesView,
  measuresList,
  measuresRecord,
  workstreamsList,
  workstreamsView,
} from './commands/records.js';
import {
  onboardingApply,
  onboardingExport,
  onboardingRecommend,
  onboardingStatus,
} from './commands/onboarding.js';
import { search } from './commands/search.js';
import { hookSessionStart } from './commands/hook.js';
import { setupHooks, setupStatus } from './commands/setup.js';
import { backupsStatus } from './commands/backups.js';
import type { Handler, Session } from './commands/common.js';
import { CliError, usageError } from './errors.js';
import { commandHelp, DESCRIPTION, groupHelp, HUMAN_ONLY_VERBS, topLevelHelp } from './help.js';
import { defaultUserData } from './profile.js';
import { emit, formatError, type Output } from './render.js';
import { COMMANDS, findCommand, groups, subcommandsOf } from './spec.js';
import { VERSION } from './version.js';

const update: Handler = async () => ({
  version: VERSION,
  status: 'cc-axi ships inside the Command Center app and updates with it',
  help: ['Update or rebuild Command Center to update cc-axi'],
});

/** `cc-axi mcp` runs before the SDK (runCli), since it serves stdio until the input ends. */
const mcp: Handler = async () => {
  throw new CliError('E_INTERNAL', 'cc-axi mcp is served by runCli, not as a command handler');
};

/** One handler per catalogue entry; a unit test checks the two match. */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  home: homeCommand,
  'items list': itemsList,
  'items view': itemsView,
  'items create': itemsCreate,
  'items update': itemsUpdate,
  'items claim': itemsClaim,
  'items attach': itemsAttach,
  'items history': itemsHistory,
  search,
  'decisions list': decisionsList,
  'decisions view': decisionsView,
  'decisions propose': decisionsPropose,
  'issues list': issuesList,
  'issues view': issuesView,
  'issues raise': issuesRaise,
  'measures list': measuresList,
  'measures record': measuresRecord,
  'goals list': goalsList,
  'workstreams list': workstreamsList,
  'workstreams view': workstreamsView,
  'onboarding status': onboardingStatus,
  'onboarding recommend': onboardingRecommend,
  'onboarding apply': onboardingApply,
  'onboarding export': onboardingExport,
  'setup hooks': setupHooks,
  'setup status': setupStatus,
  'hook session-start': hookSessionStart,
  mcp,
  'backups status': backupsStatus,
  update,
};

export interface RunOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdout?: { write(chunk: string): unknown };
  /** What `cc-axi mcp` reads its MCP messages from; defaults to process.stdin. */
  readonly stdin?: Readable;
  /** The `bin:` path of the home header; defaults to the running script. */
  readonly bin?: string;
}

function collapseHome(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function userDataOf(env: NodeJS.ProcessEnv): string {
  return env['CC_PROFILE_DIR'] || defaultUserData(process.platform, env);
}

function principalOf(globals: Globals, env: NodeJS.ProcessEnv): string {
  return globals.principal ?? (env['CC_PRINCIPAL'] || 'cli-default');
}

/**
 * `cc-axi mcp` (04 §8): parses its flags like any command, then serves MCP on stdin and stdout
 * until stdin ends. `--help` and flag errors go through the SDK as for every command.
 */
async function serveMcp(
  options: RunOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
  execPath: string,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const command = findCommand('mcp')!;
  let globals: Globals;
  try {
    globals = parseArgs(command, options.argv.slice(1)).globals;
  } catch (error) {
    const formatted = formatError(error, peekFormat(options.argv));
    stdout.write(formatted.output);
    return formatted.exitCode;
  }
  // Loaded here, so other commands never load the tool schemas (zod) at start.
  const { runMcpRelay } = await import('./mcp/relay.js');
  await runMcpRelay({
    input: options.stdin ?? process.stdin,
    output: stdout,
    userData: userDataOf(env),
    principal: principalOf(globals, env),
    cwd,
    env,
    execPath,
    handlers: HANDLERS,
  });
  return 0;
}

function createSession(
  globals: Globals,
  env: NodeJS.ProcessEnv,
  cwd: string,
  execPath: string,
): Session & { close(): void } {
  let client: Promise<LocalApiClient> | undefined;
  return {
    globals,
    cwd,
    env,
    execPath,
    api() {
      client ??= connectLocalApi({
        userData: userDataOf(env),
        principal: principalOf(globals, env),
      });
      return client;
    },
    close() {
      void client?.then(
        (connected) => connected.close(),
        () => undefined,
      );
    },
  };
}

/** Runs one `cc-axi` invocation and returns its exit code (0, 1 or 2; 07 §4.4). */
export async function runCli(options: RunOptions): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const format = peekFormat(options.argv);
  const execPath = options.bin ?? process.argv[1] ?? 'cc-axi';
  const bin = collapseHome(execPath);
  if (
    options.argv[0] === 'mcp' &&
    !options.argv.slice(1).some((arg) => arg === '--help' || arg === '-h')
  ) {
    return serveMcp(options, env, cwd, execPath);
  }

  const run = async (path: string, argv: readonly string[]): Promise<Output | string> => {
    const command = findCommand(path);
    if (command === undefined) throw usageError(`unknown command ${path}`);
    const parsed = parseArgs(command, argv);
    if (parsed.help) return emit(commandHelp(command), parsed.globals);
    const session = createSession(parsed.globals, env, cwd, execPath);
    try {
      const output = await HANDLERS[path]!(parsed, session);
      return emit(
        path === 'home' ? { bin, description: DESCRIPTION, ...output } : output,
        parsed.globals,
      );
    } finally {
      session.close();
    }
  };

  const commands: Record<string, (args: string[]) => Promise<Output | string>> = {};
  for (const group of groups()) {
    const subcommands = subcommandsOf(group);
    commands[group] =
      subcommands.length === 0
        ? (args) => run(group, args)
        : async (args) => {
            const [sub, ...rest] = args;
            if (sub === undefined || sub === '--help' || sub === '-h') {
              return emit(groupHelp(group), { format });
            }
            if (subcommands.includes(sub)) return run(`${group} ${sub}`, rest);
            const help = [`valid subcommands for \`${group}\`: ${subcommands.join(', ')}`];
            if (HUMAN_ONLY_VERBS.has(sub)) {
              help.push(`${sub} is done by the user in the app; open it there (04 §4.3)`);
            }
            throw usageError(`unknown subcommand "${sub}" for \`${group}\``, help);
          };
  }

  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    await runAxiCli({
      description: DESCRIPTION,
      version: VERSION,
      argv: [...options.argv],
      topLevelHelp: `${encode(topLevelHelp())}\n`,
      commands,
      home: async () => {
        const session = createSession({ format: 'toon' }, env, cwd, execPath);
        try {
          return await homeView(session);
        } finally {
          session.close();
        }
      },
      renderUnknownCommand: (command) =>
        formatError(
          usageError(`unknown command ${command}`, [
            `valid commands: ${groups().join(', ')}`,
            'Run `cc-axi --help` for every command',
          ]),
          format,
        ).output,
      formatError: (error) => formatError(error, format),
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    });
    const code = process.exitCode;
    return typeof code === 'number' ? code : Number(code ?? 0);
  } finally {
    process.exitCode = saved;
  }
}

export async function main(): Promise<void> {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
}

export { COMMANDS };
