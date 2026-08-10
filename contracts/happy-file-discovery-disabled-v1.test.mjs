import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'packages/happy-cli');
const vitest = join(root, 'node_modules/vitest/vitest.mjs');

test('happy_file_discovery_disabled_boundary', () => {
  const temporaryRoot = mkdtempSync('/private/tmp/xc-disposable/happy-file-discovery-contract-');
  try {
    const result = spawnSync(process.execPath, [
      vitest,
      'run',
      'src/modules/common/registerCommonHandlers.test.ts',
    ], {
      cwd: cli,
      encoding: 'utf8',
      env: {
        ...process.env,
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '',
        HAPPY_HOME_DIR: temporaryRoot,
        HAPPY_SKIP_TEST_BUILD: '1',
        TMPDIR: temporaryRoot,
      },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
