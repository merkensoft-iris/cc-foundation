#!/usr/bin/env node
import { ccEject, finish } from '../cli.js';

finish(ccEject(process.argv.slice(2), process.cwd()));
