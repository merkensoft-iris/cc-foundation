/**
 * `cc-axi setup hooks | status` (07 §4.2, §8 item 1): installs or repairs the SessionStart
 * hooks of Claude Code, Codex and OpenCode, and reports what is installed. They run only when
 * the user asks (AXI §7, explicit opt-in), need no app, and never prompt.
 */
import { single } from '../args.js';
import { CliError, usageError } from '../errors.js';
import {
  commandLine,
  HOOK_AGENTS,
  homeDirOf,
  hookStatus,
  installHooks,
  resolveHookCommand,
  type HookAgent,
  type HookScope,
} from '../hooks.js';
import { table } from '../render.js';
import type { Handler, Session } from './common.js';

/** Agents the full surface names that arrive in a later step (07 §4.2, 09 P7-02). */
const LATER_AGENTS: Readonly<Record<string, string>> = {
  grok: 'the Grok hook writer arrives in P7, once its hook format is verified (07 §6.4, OQ-07-01)',
};

function agentsOf(value: string | undefined): HookAgent[] {
  if (value === undefined) return [...HOOK_AGENTS];
  const named = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
  ];
  const later = named.find((entry) => LATER_AGENTS[entry] !== undefined);
  if (later !== undefined) {
    throw usageError(`--agents ${later} is not available yet`, [
      `${LATER_AGENTS[later] ?? ''}; --agents takes: ${HOOK_AGENTS.join(', ')}`,
    ]);
  }
  const known: readonly string[] = HOOK_AGENTS;
  if (named.length === 0 || named.some((entry) => !known.includes(entry))) {
    throw usageError(`invalid value "${value}" for --agents`, [
      `--agents takes a comma-separated list of: ${HOOK_AGENTS.join(', ')}`,
    ]);
  }
  return named as HookAgent[];
}

function context(session: Session): {
  home: string;
  projectDir: string;
  command: ReturnType<typeof resolveHookCommand>;
} {
  return {
    home: homeDirOf(session.env),
    projectDir: session.cwd,
    command: resolveHookCommand(session.execPath, session.env),
  };
}

export const setupHooks: Handler = async (parsed, session) => {
  const agents = agentsOf(single(parsed, '--agents'));
  const scope = (single(parsed, '--scope') ?? 'user') as HookScope;
  const { home, projectDir, command } = context(session);
  const result = installHooks({ agents, scope, home, projectDir, command });
  const changed = result.steps.filter((step) => step.result !== 'unchanged');
  if (result.failures.length > 0) {
    const [first] = result.failures;
    throw new CliError(
      'E_CONFLICT',
      `could not install the ${first?.agent ?? ''} hook: ${first?.file ?? ''} is ${first?.reason ?? ''}`,
      [
        ...result.failures.map(
          (failure) =>
            `Fix or move ${failure.file} (${failure.reason}), then run \`cc-axi setup hooks\` again`,
        ),
        ...(changed.length > 0
          ? [`Written meanwhile: ${changed.map((step) => step.file).join(', ')}`]
          : []),
      ],
    );
  }
  // A repeat install is a silent no-op (07 §8 item 1).
  if (changed.length === 0) return { status: 'no-op' };
  return {
    status: 'ok',
    scope,
    command: commandLine(command),
    hooks: table(
      result.steps.map((step) => ({ ...step })),
      ['agent', 'file', 'result'],
    ),
    help: [
      'New sessions of these agents start with `cc-axi hook session-start`; `cc-axi setup status` shows what is installed',
    ],
  };
};

export const setupStatus: Handler = async (_parsed, session) => {
  const { home, projectDir, command } = context(session);
  const status = hookStatus({ home, projectDir, command });
  const output: Record<string, unknown> = {
    command: commandLine(command),
    hooks: table(
      status.hooks.map((hook) => ({ ...hook })),
      ['agent', 'scope', 'state', 'file'],
    ),
    codex_hooks_feature: status.codexHooksFeature.enabled
      ? `enabled in ${status.codexHooksFeature.file}`
      : `not enabled in ${status.codexHooksFeature.file}`,
  };
  const broken = status.hooks.find(
    (hook) => hook.state === 'outdated' || hook.state === 'unreadable',
  );
  if (broken !== undefined) {
    output['help'] = [
      `Run \`cc-axi setup hooks${broken.scope === 'project' ? ' --scope project' : ''}\` to repair the ${broken.scope}-level hooks`,
    ];
  } else if (status.hooks.every((hook) => hook.state === 'missing')) {
    output['help'] = [
      'Run `cc-axi setup hooks` (or `--scope project` in a repository) to install the hooks',
    ];
  }
  return output;
};
