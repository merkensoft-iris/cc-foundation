/**
 * The confirm window's preload (04 §4.3 rule 4, C-04-12; `src/main/shell-prompts.ts`): exposes
 * `window.ccConfirm` with `approve(id)` and `deny(id)`, and nothing else. Main accepts the
 * answer only from the confirm window it opened for that id, so this preload in any other
 * window could not approve anything; the app window does not load it.
 *
 * Sandboxed preloads run as CommonJS with a restricted `require`, so this file is `.cts` and
 * imports nothing else at run time.
 */
import type { CcConfirmBridge } from '../prompt-page/bridge.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

/** The same string as `CONFIRM_ANSWER_CHANNEL` in `src/main/shell-prompts.ts`. */
const CONFIRM_ANSWER_CHANNEL = 'cc-confirm:answer';

const bridge: CcConfirmBridge = {
  approve: async (id) => {
    await ipcRenderer.invoke(CONFIRM_ANSWER_CHANNEL, id, 'approve');
  },
  deny: async (id) => {
    await ipcRenderer.invoke(CONFIRM_ANSWER_CHANNEL, id, 'deny');
  },
};

contextBridge.exposeInMainWorld('ccConfirm', bridge);
