/**
 * Help text (07 §4.1 rule 10): the top-level `--help`, each group's subcommands, and each
 * command's `--help` with its flags, defaults and 2 or 3 examples. All of it comes from the
 * catalogue in spec.ts, as does the generated CLI reference.
 */
import type { Output } from './render.js';
import {
  COMMANDS,
  flagsOf,
  GLOBAL_FLAGS,
  groups,
  subcommandsOf,
  usageOf,
  type CommandSpec,
} from './spec.js';

export const DESCRIPTION =
  'Command Center - decisions, action items and meeting rhythm across your workstreams';

/** Operations the user does in the app; the CLI has no command for them (04 §4.3, C-07-02). */
export const HUMAN_ONLY_VERBS = new Set([
  'accept',
  'approve',
  'attest',
  'confirm',
  'decide',
  'deny',
  'drop',
  'reject',
]);

export function commandHelp(command: CommandSpec): Output {
  const output: Output = {
    command: command.path,
    description: command.summary,
    usage: usageOf(command),
  };
  if (command.args.length > 0) {
    output['arguments'] = command.args.map((arg) => ({
      name: arg.placeholder,
      description: arg.description,
    }));
  }
  output['flags'] = flagsOf(command).map((flag) => ({
    flag: flag.value === undefined ? flag.name : `${flag.name} ${flag.value}`,
    description: `${flag.description}${flag.required === true ? ' (required)' : ''}${flag.repeat === true ? ' (repeatable)' : ''}`,
    default: flag.default ?? 'none',
  }));
  output['examples'] = [...command.examples];
  return output;
}

export function groupHelp(group: string): Output {
  return {
    command: group,
    subcommands: COMMANDS.filter((command) => command.path.startsWith(`${group} `)).map(
      (command) => ({
        command: command.path,
        summary: command.summary,
      }),
    ),
    help: [`Run \`cc-axi ${group} <subcommand> --help\` for its flags and examples`],
  };
}

export function topLevelHelp(): Output {
  const entries = groups().flatMap((group) => {
    const subs = subcommandsOf(group);
    return subs.length === 0
      ? COMMANDS.filter((command) => command.path === group)
      : COMMANDS.filter((command) => command.path.startsWith(`${group} `));
  });
  return {
    description: DESCRIPTION,
    usage: 'cc-axi <command> [args] [flags]',
    commands: entries.map((command) => ({ command: command.path, summary: command.summary })),
    global_flags: GLOBAL_FLAGS.map((flag) => `${flag.name} ${flag.value ?? ''}`.trim()),
    help: [
      'Run `cc-axi` with no arguments for the home view',
      'Run `cc-axi <command> --help` for its flags and examples',
      'Confirming, accepting, dropping, deciding and approving are done by the user in the app',
    ],
  };
}
