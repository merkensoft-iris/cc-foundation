#!/usr/bin/env node
import { ccUpgrade, finish } from '../cli.js';

finish(await ccUpgrade(process.argv.slice(2), process.cwd()));
