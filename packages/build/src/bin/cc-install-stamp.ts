#!/usr/bin/env node
import { ccInstallStamp, finish } from '../cli.js';

finish(ccInstallStamp(process.argv.slice(2), process.cwd()));
