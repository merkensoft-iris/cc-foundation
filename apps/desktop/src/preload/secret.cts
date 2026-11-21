/**
 * The secret prompt's preload (04 §9.1 rule 3; `src/main/shell-prompts.ts`): exposes
 * `window.ccSecret` with `submit(id, value)` and `cancel(id)`, and nothing else. The secret
 * goes from this window to main only: the app window never sees it. Main accepts it only from
 * the secret prompt it opened for that id.
 *
 * Sandboxed preloads run as CommonJS with a restricted `require`, so this file is `.cts` and
 * imports nothing else at run time.
 */
import type { CcSecretBridge } from '../prompt-page/bridge.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

/** The same string as `SECRET_ANSWER_CHANNEL` in `src/main/shell-prompts.ts`. */
const SECRET_ANSWER_CHANNEL = 'cc-secret:answer';

const bridge: CcSecretBridge = {
  submit: async (id, value) => {
    await ipcRenderer.invoke(SECRET_ANSWER_CHANNEL, id, value);
  },
  cancel: async (id) => {
    await ipcRenderer.invoke(SECRET_ANSWER_CHANNEL, id, null);
  },
};

contextBridge.exposeInMainWorld('ccSecret', bridge);
