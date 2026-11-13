import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/happy-cli');
const root = realpathSync(process.env.HAPPY_CLI_TEST_ROOT || source);

function runVitest(files, pattern) {
  for (const file of [...files, 'src/codex/runCodexAppServer.ts', 'src/codex/codexAccountSwap.ts',
    'src/codex/codexAppServerClient.ts', 'src/api/apiSession.ts', 'src/daemon/run.ts']) {
    assert.deepEqual(readFileSync(resolve(root, file)), readFileSync(resolve(source, file)), file);
  }
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run', ...files, '--maxWorkers=1', '--minWorkers=1', '--reporter=json', '--testNamePattern', pattern], {
    cwd: root, env: { ...process.env, HAPPY_SKIP_TEST_BUILD: '1' },
    encoding: 'utf8',
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, true);
  for (const file of files) {
    const matched = report.testResults.find(suite => suite.name === resolve(root, file))
      ?.assertionResults.filter(row => new RegExp(pattern).test(row.fullName));
    assert.ok(matched?.length, `No matching tests executed: ${file}`);
    for (const row of matched) assert.equal(row.status, 'passed', row.fullName);
  }
  return result;
}

test('failed_recovery_accepts_new_input_without_duplicate_submission_or_false_delivery_receipt', () => {
  runVitest(['src/codex/__tests__/codexRecovery.real.test.ts',
    'src/codex/__tests__/runCodexAppServerE2E.test.ts', 'src/api/apiSession.test.ts'],
    'recovers the exact persisted thread after two timed-out clients|waits beyond the ordinary RPC cap during account recovery|bounds each new-input recovery|emits one deterministic visible receipt after synchronous provider acceptance');
});

test('existing_restore_identity_consumer_is_fail_closed', () => {
  const result = runVitest(
    ['src/daemon/controlServer.test.ts'],
    'restores by one Happy session ID without invoking the spawn boundary',
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('startup_deadline_preserves_primary_error_and_cleans_only_owned_processes', () => {
  runVitest(['src/codex/__tests__/codexRecovery.real.test.ts',
    'src/codex/__tests__/runCodexAppServer.regression.test.ts', 'src/codex/codexAppServerProcess.test.ts',
    'src/daemon/sessionStartupDeadline.test.ts'],
    'preserves the original startup resume timeout|honors one expired startup deadline|does not cold-retry a resume|keeps cleanup fatal|kills a TERM-resistant grandchild|initializes with the remaining recovery budget|gives live account recovery one absolute restore budget|expires queued restores|rejects a deadline exhausted by preflight|leaves a started operation in charge');
});

test('daemon_codex_provider_identity_is_ready_before_spawn_receipt', () => {
  const result = runVitest(
    ['src/daemon/run.test.ts', 'src/codex/__tests__/runCodexAppServerE2E.test.ts'],
    'daemon registration requires a durable provider id for fresh Codex children|prepares a daemon Codex provider identity before the first turn',
  );
  assert.equal(
    result.status,
    0,
    `PF4_CONTRACT_UNSATISFIED[provider-identity-not-ready]\n${result.stdout}\n${result.stderr}`,
  );
});
