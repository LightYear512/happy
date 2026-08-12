import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'packages/happy-cli');
const vitest = join(root, 'node_modules/vitest/vitest.mjs');

test('happy_cli_input_stability_boundary', () => {
  const temporaryRoot = mkdtempSync('/private/tmp/xc-disposable/happy-input-contract-');
  try {
    const result = spawnSync(process.execPath, [vitest, 'run',
      'src/api/apiSession.test.ts',
      'src/api/sessionMessageRecovery.test.ts',
      'src/utils/completeProviderInputReady.test.ts',
      'src/daemon/run.test.ts',
      'src/daemon/controlClient.test.ts',
      'src/daemon/controlServer.test.ts',
      'src/commands/bang/dispatcher.test.ts',
      'src/agent/acp/runAcp.test.ts',
      'src/codex/__tests__/runCodexAppServer.regression.test.ts',
    ], {
      cwd: cli,
      encoding: 'utf8',
      env: { ...process.env, HAPPY_SKIP_TEST_BUILD: '1', TMPDIR: temporaryRoot },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
