/**
 * SessionStart hooks for agents (07 §8 item 1, AXI principle 7): where each agent keeps them,
 * the portable command they run, and an idempotent install and a read-only status.
 *
 * The agents and their files follow axi-sdk-js `installSessionStartHooks()`: Claude Code
 * `.claude/settings.json`, Codex `.codex/hooks.json` plus `[features] hooks = true` in the
 * user's `~/.codex/config.toml`, and an OpenCode plugin in `.opencode/plugins/` (project) or
 * `~/.config/opencode/plugins/` (user). That function always installs all three and runs the
 * bare binary (the home view), so `cc-axi` uses the SDK's primitives (the portable command
 * rule, the npm shim reader and the Codex feature flag) with its own writer: the agents are
 * chosen with `--agents`, and every hook runs `cc-axi hook session-start` (07 §8 item 2).
 *
 * A hook is Command Center's when its command runs `cc-axi` (or the bin of @cc/cli) with
 * `hook session-start`; any other hook in the same file is left as it is. Nothing here
 * prompts, and a repeat install changes nothing (07 §8 item 1).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeCodexConfigUpdate,
  extractNpmShimScriptPath,
  resolvePortableHookCommand,
} from 'axi-sdk-js';

/** The agents P1 installs hooks for; Grok's writer arrives in P7 (07 §6.4, OQ-07-01). */
export const HOOK_AGENTS = ['claude-code', 'codex', 'opencode'] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export const HOOK_SCOPES = ['user', 'project'] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

/** The binary name the portable command rule looks for on PATH. */
export const BINARY_NAME = 'cc-axi';

/** Seconds an agent waits for the hook (the SDK's default). */
export const HOOK_TIMEOUT_SECONDS = 10;

/** The arguments every hook passes. */
export const HOOK_ARGS = ['hook', 'session-start'] as const;

/** The OpenCode plugin's file name and its first line, which marks it as ours. */
export const OPENCODE_PLUGIN_FILE = 'command-center.js';
export const OPENCODE_PLUGIN_MARKER =
  '// command-center managed opencode plugin: written by `cc-axi setup hooks`';

/** A command to run: the program and the arguments before `hook session-start`. */
export interface HookCommand {
  readonly program: string;
  readonly args: readonly string[];
}

/** The home directory: `$HOME`, or `%USERPROFILE%` on Windows. */
export function homeDirOf(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const fromEnv = platform === 'win32' ? (env['USERPROFILE'] ?? env['HOME']) : env['HOME'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : os.homedir();
}

function realFile(file: string): string | undefined {
  try {
    return statSync(file).isFile() ? realpathSync(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The portable command rule (07 §8 item 1): `cc-axi` when the `cc-axi` found on PATH is this
 * very binary, otherwise its absolute path. A `.js` entry is run through Node.js (by the same
 * rule: `node` when PATH finds this one), so the hook works where scripts are not executable
 * (Windows) and survives a Node.js upgrade.
 */
export function resolveHookCommand(
  execPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  node: string = process.execPath,
): HookCommand {
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  const context = {
    pathEntries: rawPath.split(path.delimiter).filter((entry) => entry !== ''),
    pathExtensions:
      platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''],
    resolveRealPath: realFile,
    resolveShimTarget: (shim: string) => {
      try {
        const relative = extractNpmShimScriptPath(readFileSync(shim, 'utf8'));
        return relative === undefined
          ? undefined
          : realpathSync(path.resolve(path.dirname(shim), relative));
      } catch {
        return undefined;
      }
    },
  };
  const resolved = resolvePortableHookCommand(
    path.resolve(execPath),
    [BINARY_NAME],
    BINARY_NAME,
    context,
  );
  if (resolved === BINARY_NAME) return { program: BINARY_NAME, args: [] };
  if (!/\.[cm]?js$/.test(resolved)) return { program: resolved, args: [] };
  return { program: resolvePortableHookCommand(node, ['node'], 'node', context), args: [resolved] };
}

function quote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
}

/** The command line a JSON hook runs: `cc-axi hook session-start`, quoted where needed. */
export function commandLine(command: HookCommand): string {
  return [command.program, ...command.args, ...HOOK_ARGS].map(quote).join(' ');
}

/** Whether a hook command is Command Center's (the module comment says how it is told). */
export function isCommandCenterHook(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    /(?:cc-axi(?:\.cmd|\.exe)?|[\\/]cli[\\/]dist[\\/]bin\.js)"?\s+hook\s+session-start\s*$/i.test(
      command.trim(),
    )
  );
}

interface HookEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

type Settings = Record<string, unknown>;

function hooksOf(settings: Settings): Record<string, unknown> | undefined {
  const hooks = settings['hooks'];
  return typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : undefined;
}

function groupsOf(settings: Settings): HookGroup[] {
  const groups = hooksOf(settings)?.['SessionStart'];
  return Array.isArray(groups)
    ? groups.filter((group): group is HookGroup => typeof group === 'object' && group !== null)
    : [];
}

function entriesOf(group: HookGroup): HookEntry[] {
  return Array.isArray(group.hooks)
    ? group.hooks.filter((hook): hook is HookEntry => typeof hook === 'object' && hook !== null)
    : [];
}

/** The commands of Command Center's SessionStart hooks in a settings object. */
export function commandCenterHooks(settings: Settings): string[] {
  return groupsOf(settings)
    .flatMap(entriesOf)
    .filter((hook) => isCommandCenterHook(hook.command))
    .map((hook) => String(hook.command));
}

/**
 * Puts exactly one Command Center SessionStart hook in a Claude Code or Codex settings
 * object: the first one found is brought up to date and any others removed; with none, a
 * group with an empty matcher (every session start) is added. Other hooks and keys stay.
 * Returns the new settings and whether anything changed.
 */
export function upsertSessionStartHook(settings: Settings, command: string): [Settings, boolean] {
  const updated = structuredClone(settings);
  let changed = false;
  let hooks = hooksOf(updated);
  if (hooks === undefined) {
    hooks = {};
    updated['hooks'] = hooks;
    changed = true;
  }
  if (!Array.isArray(hooks['SessionStart'])) {
    hooks['SessionStart'] = [];
    changed = true;
  }
  const groups = hooks['SessionStart'] as unknown[];
  let found = false;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || !Array.isArray((group as HookGroup).hooks)) {
      kept.push(group);
      continue;
    }
    const entries = (group as HookGroup).hooks as unknown[];
    const remaining = entries.filter((entry) => {
      const hook = entry as HookEntry;
      if (typeof entry !== 'object' || entry === null || !isCommandCenterHook(hook.command)) {
        return true;
      }
      if (found) return false;
      found = true;
      if (
        hook.type !== 'command' ||
        hook.command !== command ||
        hook.timeout !== HOOK_TIMEOUT_SECONDS
      ) {
        hook.type = 'command';
        hook.command = command;
        hook.timeout = HOOK_TIMEOUT_SECONDS;
        changed = true;
      }
      return true;
    });
    if (remaining.length !== entries.length) {
      changed = true;
      if (remaining.length === 0) continue;
      (group as HookGroup).hooks = remaining;
    }
    kept.push(group);
  }
  if (!found) {
    kept.push({
      matcher: '',
      hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    changed = true;
  }
  hooks['SessionStart'] = kept;
  return changed ? [updated, true] : [settings, false];
}

/**
 * The OpenCode plugin (OpenCode 1 and 2, as the SDK's plugin): it runs the hook once per
 * session in the session's directory and adds the output to the system prompt.
 */
export function openCodePluginSource(command: HookCommand): string {
  const args = [...command.args, ...HOOK_ARGS];
  return `${OPENCODE_PLUGIN_MARKER}
// It runs Command Center's SessionStart hook once per session and adds its output to the
// system prompt. Remove the line above before editing it, or \`cc-axi setup hooks\` replaces it.
import { spawn } from "node:child_process";

const program = ${JSON.stringify(command.program)};
const args = ${JSON.stringify(args)};
const timeoutMs = ${String(HOOK_TIMEOUT_SECONDS * 1000)};

function run(directory) {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    // Windows runs the cc-axi.cmd shim through the shell, so words with spaces are quoted.
    const word = (text) => (windows && /[\\s"]/.test(text) ? JSON.stringify(text) : text);
    const child = spawn(word(program), args.map(word), {
      cwd: typeof directory === "string" && directory.length > 0 ? directory : process.cwd(),
      env: process.env,
      shell: windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
  });
}

function contextFor(directory) {
  const sessions = new Map();
  return async (sessionID) => {
    const key = sessionID ?? "";
    if (!sessions.has(key)) sessions.set(key, await run(directory));
    const text = sessions.get(key);
    return text.length === 0 ? "" : "## Command Center\\n" + text;
  };
}

export default {
  id: "command-center",
  // OpenCode 2.
  async setup(ctx) {
    const context = contextFor(ctx.location.directory);
    await ctx.session.hook("context", async (event) => {
      const text = await context(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });
  },
  // OpenCode 1.
  async server({ directory }) {
    const context = contextFor(directory);
    return {
      "experimental.chat.system.transform": async (input, output) => {
        const text = await context(input.sessionID);
        if (text) output.system.push(text);
      },
    };
  },
};
`;
}

/** The files one agent's hook lives in, for a scope. */
export interface HookTarget {
  readonly agent: HookAgent;
  readonly scope: HookScope;
  /** The settings file or plugin file. */
  readonly file: string;
  /** Codex only: the user-level config.toml whose `[features] hooks` must be true. */
  readonly featureFile?: string;
}

/** Where each agent keeps its SessionStart hook (the SDK's layout). */
export function hookTarget(
  agent: HookAgent,
  scope: HookScope,
  home: string,
  projectDir: string,
): HookTarget {
  const root = scope === 'project' ? path.resolve(projectDir) : home;
  switch (agent) {
    case 'claude-code':
      return { agent, scope, file: path.join(root, '.claude', 'settings.json') };
    case 'codex':
      return {
        agent,
        scope,
        file: path.join(root, '.codex', 'hooks.json'),
        featureFile: path.join(home, '.codex', 'config.toml'),
      };
    case 'opencode':
      return {
        agent,
        scope,
        file:
          scope === 'project'
            ? path.join(root, '.opencode', 'plugins', OPENCODE_PLUGIN_FILE)
            : path.join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE),
      };
  }
}

/** What an install did to one file. */
export interface InstallStep {
  readonly agent: HookAgent;
  readonly file: string;
  readonly result: 'installed' | 'updated' | 'unchanged' | 'enabled hooks feature';
}

/** A file the install would not change because it is not Command Center's to change. */
export interface InstallFailure {
  readonly agent: HookAgent;
  readonly file: string;
  readonly reason: string;
}

function readText(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

function installJsonHook(
  target: HookTarget,
  command: string,
  steps: InstallStep[],
  failures: InstallFailure[],
): void {
  const current = readText(target.file);
  let settings: Settings = {};
  if (current !== undefined && current.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch (error) {
      failures.push({
        agent: target.agent,
        file: target.file,
        reason: `not JSON (${(error as Error).message})`,
      });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      failures.push({ agent: target.agent, file: target.file, reason: 'not a JSON object' });
      return;
    }
    settings = parsed as Settings;
  }
  const had = commandCenterHooks(settings).length > 0;
  const [updated, changed] = upsertSessionStartHook(settings, command);
  if (changed) writeText(target.file, `${JSON.stringify(updated, null, 2)}\n`);
  steps.push({
    agent: target.agent,
    file: target.file,
    result: !changed ? 'unchanged' : had ? 'updated' : 'installed',
  });
}

function installOpenCodePlugin(
  target: HookTarget,
  source: string,
  steps: InstallStep[],
  failures: InstallFailure[],
): void {
  const current = readText(target.file);
  if (current !== undefined && !current.startsWith(OPENCODE_PLUGIN_MARKER)) {
    failures.push({
      agent: target.agent,
      file: target.file,
      reason: 'an OpenCode plugin that cc-axi did not write is already there',
    });
    return;
  }
  if (current !== source) writeText(target.file, source);
  steps.push({
    agent: target.agent,
    file: target.file,
    result: current === source ? 'unchanged' : current === undefined ? 'installed' : 'updated',
  });
}

function enableCodexHooks(target: HookTarget, steps: InstallStep[]): void {
  if (target.featureFile === undefined) return;
  const [updated, changed] = computeCodexConfigUpdate(readText(target.featureFile) ?? '');
  if (!changed) return;
  writeText(target.featureFile, updated);
  steps.push({ agent: target.agent, file: target.featureFile, result: 'enabled hooks feature' });
}

export interface InstallOptions {
  readonly agents: readonly HookAgent[];
  readonly scope: HookScope;
  readonly home: string;
  readonly projectDir: string;
  readonly command: HookCommand;
}

export interface InstallResult {
  readonly steps: readonly InstallStep[];
  readonly failures: readonly InstallFailure[];
}

/** Installs or repairs the hooks of the chosen agents; a repeat changes nothing. */
export function installHooks(options: InstallOptions): InstallResult {
  const steps: InstallStep[] = [];
  const failures: InstallFailure[] = [];
  const line = commandLine(options.command);
  for (const agent of options.agents) {
    const target = hookTarget(agent, options.scope, options.home, options.projectDir);
    if (agent === 'opencode') {
      installOpenCodePlugin(target, openCodePluginSource(options.command), steps, failures);
    } else {
      installJsonHook(target, line, steps, failures);
      if (agent === 'codex') enableCodexHooks(target, steps);
    }
  }
  return { steps, failures };
}

/** One agent's hook at one scope: there and current, there but stale, or not there. */
export interface HookState {
  readonly agent: HookAgent;
  readonly scope: HookScope;
  readonly state: 'installed' | 'outdated' | 'missing' | 'unreadable';
  readonly file: string;
}

function jsonHookState(target: HookTarget, command: string): HookState['state'] {
  const text = readText(target.file);
  if (text === undefined) return 'missing';
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  if (typeof settings !== 'object' || settings === null) return 'unreadable';
  const commands = commandCenterHooks(settings as Settings);
  if (commands.length === 0) return 'missing';
  return commands.length === 1 && commands[0] === command ? 'installed' : 'outdated';
}

function pluginState(target: HookTarget, source: string): HookState['state'] {
  const text = readText(target.file);
  if (text === undefined || !text.startsWith(OPENCODE_PLUGIN_MARKER)) return 'missing';
  return text === source ? 'installed' : 'outdated';
}

/** Every agent at both scopes; reads only. */
export function hookStatus(options: Omit<InstallOptions, 'agents' | 'scope'>): {
  hooks: HookState[];
  codexHooksFeature: { enabled: boolean; file: string };
} {
  const line = commandLine(options.command);
  const source = openCodePluginSource(options.command);
  const hooks: HookState[] = [];
  for (const scope of HOOK_SCOPES) {
    for (const agent of HOOK_AGENTS) {
      const target = hookTarget(agent, scope, options.home, options.projectDir);
      const state =
        agent === 'opencode' ? pluginState(target, source) : jsonHookState(target, line);
      hooks.push({ agent, scope, state, file: target.file });
    }
  }
  const featureFile = path.join(options.home, '.codex', 'config.toml');
  const config = readText(featureFile);
  return {
    hooks,
    codexHooksFeature: {
      enabled: config !== undefined && !computeCodexConfigUpdate(config)[1],
      file: featureFile,
    },
  };
}
