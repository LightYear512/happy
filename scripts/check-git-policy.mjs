#!/usr/bin/env node
// Delegate to the host's single source-only policy; it reads this repository's
// actual candidate index through sg, including Git's temporary commit index.
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const checker = path.join(os.homedir(), 'xiework/jsbrowser/tools/check-git-policy.mjs');
const result = spawnSync(process.execPath, [checker, ...process.argv.slice(2)], {
  cwd: process.cwd(), stdio: 'inherit',
});
if (result.error) console.error(`Git policy could not start: ${result.error.message}`);
process.exitCode = result.status ?? 2;
