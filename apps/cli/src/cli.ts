/**
 * `cc-axi`: the AXI command line of Command Center (07 §4), on axi-sdk-js `runAxiCli()`.
 * Loaded by bin.ts only when the `--version` fast path did not answer.
 */
import os from 'node:os';

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
import { search } from './commands/search.js';
import type { Handler, Session } from './commands/common.js';
import { usageError } from './errors.js';
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
  update,
};

export interface RunOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdout?: { write(chunk: string): unknown };
  /** The `bin:` path of the home header; defaults to the running script. */
  readonly bin?: string;
}

function collapseHome(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function createSession(
  globals: Globals,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Session & { close(): void } {
  let client: Promise<LocalApiClient> | undefined;
  return {
    globals,
    cwd,
    api() {
      client ??= connectLocalApi({
        userData: env['CC_PROFILE_DIR'] || defaultUserData(process.platform, env),
        principal: globals.principal ?? (env['CC_PRINCIPAL'] || 'cli-default'),
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
  const bin = collapseHome(options.bin ?? process.argv[1] ?? 'cc-axi');

  const run = async (path: string, argv: readonly string[]): Promise<Output | string> => {
    const command = findCommand(path);
    if (command === undefined) throw usageError(`unknown command ${path}`);
    const parsed = parseArgs(command, argv);
    if (parsed.help) return emit(commandHelp(command), parsed.globals);
    const session = createSession(parsed.globals, env, cwd);
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
        const session = createSession({ format: 'toon' }, env, cwd);
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
