/**
 * Starts and supervises the core service in a `utilityProcess` (04 §3). Main creates a
 * `MessageChannelMain`, keeps one end for UI calls and transfers the other to the core host
 * in `init`; calls on it run as the user (04 §4.3 rule 1).
 *
 * On a crash, main restarts the core with exponential backoff (04 §3 core row). Calls that
 * were in flight fail with `E_CRASH`; calls not yet sent wait for the restarted core. After
 * too many crashes in a row without a stable run, the supervisor gives up (`failed`) rather
 * than loop, and calls fail with `E_APP_NOT_RUNNING`.
 */
import type { ApiErrorData } from '@cc/schemas';

import {
  isUiResponse,
  parseHostMessage,
  type HostToMain,
  type MainToHost,
  type StartMode,
  type UiRequest,
} from '../shared/protocol.js';
import type { Clock, TimerHandle } from './clock.js';

/** The main end of a `MessageChannelMain` (Electron `MessagePortMain`). */
export interface MainPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
  close(): void;
}

/** A forked core host (Electron `UtilityProcess`). */
export interface CoreProcess {
  postMessage(message: MainToHost, transfer?: MainPort[]): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  kill(): boolean;
}

export interface CoreLauncher {
  fork(): CoreProcess;
  channel(): { readonly port1: MainPort; readonly port2: MainPort };
}

export type CoreState =
  'idle' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'stopped' | 'failed';

export interface SupervisorTiming {
  /** First restart delay; it doubles per consecutive crash. */
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Consecutive crashes after which the supervisor stops restarting. */
  readonly crashLimit: number;
  /** A run at least this long resets the crash count. */
  readonly stableMs: number;
  /** A core that has not said `ready` by then is killed, and that counts as a crash. */
  readonly startTimeoutMs: number;
  /** How long `stop()` waits for a graceful exit before killing. */
  readonly stopTimeoutMs: number;
  /** How long an `activity()` question waits for the core's answer. */
  readonly activityTimeoutMs: number;
}

export const DEFAULT_TIMING: SupervisorTiming = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  crashLimit: 5,
  stableMs: 60_000,
  startTimeoutMs: 30_000,
  stopTimeoutMs: 5_000,
  activityTimeoutMs: 5_000,
};

export interface SupervisorOptions {
  readonly launcher: CoreLauncher;
  readonly userData: string;
  readonly clock: Clock;
  readonly timing?: Partial<SupervisorTiming>;
  /** Every validated message from the host (`ready`, `notify`, `notification-policy`, …). */
  readonly onHostMessage?: (message: HostToMain) => void;
  readonly onStateChange?: (state: CoreState) => void;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** A failed UI call; `data` is the local API error (04 §4.1 rule 4). */
export class UiCallError extends Error {
  readonly data: ApiErrorData;
  constructor(data: ApiErrorData) {
    super(`${data.code}: ${data.message}`);
    this.name = 'UiCallError';
    this.data = data;
  }
}

const OPEN_APP_HELP = ['Quit and reopen Command Center'];

interface Pending {
  readonly request: UiRequest;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: UiCallError) => void;
}

export class CoreSupervisor {
  readonly #options: SupervisorOptions;
  readonly #timing: SupervisorTiming;
  #state: CoreState = 'idle';
  #mode: StartMode | undefined;
  #process: CoreProcess | undefined;
  #port: MainPort | undefined;
  #nextId = 1;
  /** Sent to the current core, waiting for an answer. */
  readonly #inFlight = new Map<number, Pending>();
  /** Not sent yet: waiting for a ready core. */
  #queue: Pending[] = [];
  #consecutiveCrashes = 0;
  #startedAt = 0;
  #timer: TimerHandle | undefined;
  #stopped: Promise<void> | undefined;
  #onExit: (() => void) | undefined;
  /** `activity()` questions waiting for the core's answer. */
  readonly #activity = new Map<number, (busy: readonly string[]) => void>();

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
  }

  get state(): CoreState {
    return this.#state;
  }

  /** Starts the core in `mode`. The mode is known before the core runs (ADR 0004). */
  start(mode: StartMode): void {
    if (this.#state !== 'idle') throw new Error(`core already ${this.#state}`);
    this.#mode = mode;
    this.#launch();
  }

  /** One UI call, as the user. Resolves with the result or rejects with `UiCallError`. */
  call(method: string, params?: unknown): Promise<unknown> {
    if (this.#state === 'stopping' || this.#state === 'stopped' || this.#state === 'failed') {
      return Promise.reject(this.#notRunning());
    }
    return new Promise((resolve, reject) => {
      const request: UiRequest =
        params === undefined
          ? { id: this.#nextId++, method }
          : { id: this.#nextId++, method, params };
      const pending: Pending = { request, resolve, reject };
      if (this.#state === 'ready') this.#send(pending);
      else this.#queue.push(pending);
    });
  }

  /**
   * Why the app is not idle; empty when it is (04 §10 rule 2: no meeting `in_progress`, no
   * run in flight). A core that is not running has nothing in flight; one that is starting,
   * restarting or does not answer in time counts as busy, so a restart never cuts it off.
   */
  activity(): Promise<readonly string[]> {
    const child = this.#process;
    if (this.#state === 'starting' || this.#state === 'restarting') {
      return Promise.resolve([`the core is ${this.#state}`]);
    }
    if (this.#state !== 'ready' || child === undefined) return Promise.resolve([]);
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = this.#options.clock.setTimeout(() => {
        this.#activity.delete(id);
        resolve(['the core did not answer']);
      }, this.#timing.activityTimeoutMs);
      this.#activity.set(id, (busy) => {
        this.#options.clock.clearTimeout(timer);
        this.#activity.delete(id);
        resolve(busy);
      });
      child.postMessage({ type: 'activity', id });
    });
  }

  /** Stops the core gracefully (killing it after the timeout). Idempotent. */
  stop(): Promise<void> {
    if (this.#stopped !== undefined) return this.#stopped;
    this.#stopped = new Promise<void>((resolve) => {
      this.#clearTimer();
      const child = this.#process;
      this.#setState('stopping');
      this.#failAll(this.#notRunning());
      if (child === undefined) {
        this.#setState('stopped');
        resolve();
        return;
      }
      const killTimer = this.#options.clock.setTimeout(() => {
        this.#options.log?.('core.stop_timeout');
        child.kill();
      }, this.#timing.stopTimeoutMs);
      this.#onExit = () => {
        this.#options.clock.clearTimeout(killTimer);
        this.#setState('stopped');
        resolve();
      };
      child.postMessage({ type: 'stop' });
    });
    return this.#stopped;
  }

  #setState(state: CoreState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }

  #notRunning(): UiCallError {
    return new UiCallError({
      code: 'E_APP_NOT_RUNNING',
      message:
        this.#state === 'failed'
          ? 'the core service stopped after repeated crashes'
          : 'the core service is not running',
      help: OPEN_APP_HELP,
    });
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#options.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #launch(): void {
    const mode = this.#mode;
    if (mode === undefined) return;
    this.#setState('starting');
    const { launcher, clock } = this.#options;
    const child = launcher.fork();
    const { port1, port2 } = launcher.channel();
    this.#process = child;
    this.#port = port1;
    this.#startedAt = clock.now().getTime();

    port1.on('message', ({ data }) => this.#onResponse(data));
    port1.start();

    child.on('message', (raw) => {
      if (child !== this.#process) return;
      const message = parseHostMessage(raw);
      if (message === undefined) {
        this.#options.log?.('core.bad_message');
        return;
      }
      if (message.type === 'ready') this.#onReady();
      if (message.type === 'activity') {
        this.#activity.get(message.id)?.(message.busy);
        return;
      }
      if (message.type === 'fatal') this.#options.log?.('core.fatal', { message: message.message });
      this.#options.onHostMessage?.(message);
    });
    child.on('exit', (code) => {
      if (child === this.#process) this.#onProcessExit(code);
    });

    this.#timer = clock.setTimeout(() => {
      this.#timer = undefined;
      if (this.#state === 'starting' && child === this.#process) {
        this.#options.log?.('core.start_timeout');
        child.kill();
      }
    }, this.#timing.startTimeoutMs);

    child.postMessage({ type: 'init', userData: this.#options.userData, mode }, [port2]);
  }

  #onReady(): void {
    if (this.#state !== 'starting') return;
    this.#clearTimer();
    this.#setState('ready');
    const queued = this.#queue;
    this.#queue = [];
    for (const pending of queued) this.#send(pending);
  }

  #send(pending: Pending): void {
    this.#inFlight.set(pending.request.id, pending);
    this.#port?.postMessage(pending.request);
  }

  #onResponse(data: unknown): void {
    if (!isUiResponse(data) || typeof data.id !== 'number') return;
    const pending = this.#inFlight.get(data.id);
    if (pending === undefined) return;
    this.#inFlight.delete(data.id);
    if ('error' in data) pending.reject(new UiCallError(data.error));
    else pending.resolve(data.result);
  }

  #failAll(error: UiCallError): void {
    for (const pending of [...this.#inFlight.values(), ...this.#queue]) pending.reject(error);
    this.#inFlight.clear();
    this.#queue = [];
  }

  #onProcessExit(code: number): void {
    this.#clearTimer();
    for (const answer of [...this.#activity.values()]) answer(['the core stopped']);
    this.#port?.close();
    this.#port = undefined;
    this.#process = undefined;
    if (this.#state === 'stopping') {
      this.#onExit?.();
      return;
    }
    // A crash: the core never exits on its own while main is running.
    const ranFor = this.#options.clock.now().getTime() - this.#startedAt;
    this.#consecutiveCrashes = ranFor >= this.#timing.stableMs ? 1 : this.#consecutiveCrashes + 1;
    this.#options.log?.('core.crashed', { code, ranFor, crashes: this.#consecutiveCrashes });
    for (const pending of this.#inFlight.values()) {
      pending.reject(
        new UiCallError({
          code: 'E_CRASH',
          message: `the core service stopped while handling ${pending.request.method}`,
          help: ['The core is restarting; retry the action'],
        }),
      );
    }
    this.#inFlight.clear();
    if (this.#consecutiveCrashes > this.#timing.crashLimit) {
      this.#setState('failed');
      this.#failAll(this.#notRunning());
      return;
    }
    this.#setState('restarting');
    const delay = Math.min(
      this.#timing.initialBackoffMs * 2 ** (this.#consecutiveCrashes - 1),
      this.#timing.maxBackoffMs,
    );
    this.#timer = this.#options.clock.setTimeout(() => {
      this.#timer = undefined;
      if (this.#state === 'restarting') this.#launch();
    }, delay);
  }
}
