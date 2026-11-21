/**
 * `window.cc`, the renderer's only way out (04 §3): the preload exposes it through
 * `contextBridge`. The types are the UI contract's (`@cc/ui-sdk/v1`, ADR 0008 decision 1);
 * main's side of it is `src/main/ipc.ts`.
 */
export type { CcBridge, CcError, RebuildState, Route, ShellInfo, StartMode } from '@cc/ui-sdk/v1';
