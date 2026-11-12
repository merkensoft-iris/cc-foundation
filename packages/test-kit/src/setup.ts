/**
 * Vitest setup file for every test project in the workspace: blocks the network so tests
 * stay hermetic (C-08-05, AC-08-01).
 */
import { blockNetwork } from './network.js';

blockNetwork();
