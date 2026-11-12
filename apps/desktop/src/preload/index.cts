/**
 * @cc/desktop preload (04 §3): exposes `window.cc` through `contextBridge`, and nothing
 * else. The renderer is sandboxed with context isolation, so this is its only path to main;
 * it carries a method name and params, never an actor (04 §4.3 rule 1).
 *
 * Sandboxed preloads run as CommonJS with a restricted `require` that offers only Electron's
 * renderer modules, so this file is `.cts` and imports nothing else at run time.
 */
import type { CcBridge, CcError, RebuildState, Route, ShellInfo } from '../renderer/bridge.js';

// A sandboxed preload can only `require` (eslint.config.js allows it in this directory).
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

/** Channel names: the same strings as `src/main/ipc.ts`. */
const INVOKE_CHANNEL = 'cc:invoke';
const SHELL_CHANNEL = 'cc:shell';
const NAVIGATE_CHANNEL = 'cc:navigate';
const REBUILD_CHANNEL = 'cc:rebuild';
const REBUILD_STATE_CHANNEL = 'cc:rebuild-state';

type InvokeAnswer =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: CcError };

const bridge: CcBridge = {
  async invoke(method, params) {
    const answer = (await ipcRenderer.invoke(INVOKE_CHANNEL, method, params)) as InvokeAnswer;
    if (answer.ok) return answer.result;
    throw { code: answer.error.code, message: answer.error.message, help: answer.error.help };
  },
  shell: () => ipcRenderer.invoke(SHELL_CHANNEL) as Promise<ShellInfo>,
  onNavigate(listener) {
    const handler = (_event: unknown, route: Route) => listener(route);
    ipcRenderer.on(NAVIGATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(NAVIGATE_CHANNEL, handler);
    };
  },
  rebuild: (action) => ipcRenderer.invoke(REBUILD_CHANNEL, action) as Promise<RebuildState>,
  onRebuildState(listener) {
    const handler = (_event: unknown, state: RebuildState) => listener(state);
    ipcRenderer.on(REBUILD_STATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(REBUILD_STATE_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld('cc', bridge);
