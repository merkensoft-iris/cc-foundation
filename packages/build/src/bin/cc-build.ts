#!/usr/bin/env node
import { ccBuild, finish } from '../cli.js';

finish(await ccBuild(process.argv.slice(2), process.cwd()));
