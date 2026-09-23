#!/usr/bin/env node
// npm creates native .cmd/.ps1 shims for this Node entry on Windows.
// Installed packages always use the committed distribution; the POSIX bin/moyu
// remains the source-checkout launcher used by contributors.
import { fileURLToPath } from 'node:url';
import { runSupervisor } from '../dist/app/supervisor.js';

runSupervisor(fileURLToPath(new URL('../dist/app/main.js', import.meta.url)), process.argv.slice(2));
