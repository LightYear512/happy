import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

test('happy_codex_raw_item_diagnostics_boundary', () => {
  const temporaryRoot = mkdtempSync('/private/tmp/xc-disposable/happy-raw-item-contract-');
  try {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'src/codex/utils/codexRawItemDiagnostics.test.ts', 'src/ui/logger.test.ts',
    ], {
      cwd: join(root, 'packages/happy-cli'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HAPPY_HOME_DIR: temporaryRoot, HAPPY_SKIP_TEST_BUILD: '1',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '', DEBUG: '', TMPDIR: temporaryRoot },
    });
    assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
