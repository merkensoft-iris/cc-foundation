#!/usr/bin/env node
import { ccUiUpdate, finish } from '../cli.js';

finish(ccUiUpdate(process.argv.slice(2), process.cwd()));
