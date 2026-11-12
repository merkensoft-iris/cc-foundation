#!/usr/bin/env node
import { ccStart, finish } from '../cli.js';

finish(await ccStart(process.argv.slice(2), process.cwd()));
