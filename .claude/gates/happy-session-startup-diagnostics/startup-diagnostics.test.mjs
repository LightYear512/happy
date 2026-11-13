import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/happy-cli');
const root = realpathSync(process.env.HAPPY_CLI_TEST_ROOT || source);
const tests = [
  'src/daemon/sessionStartupDeadline.test.ts',
  'src/daemon/sessionStartupGroup.real.test.ts',
  'src/daemon/sessionTermination.real.test.ts',
  'src/utils/processKill.test.ts',
  'src/codex/utils/redactSecrets.test.ts',
  'src/daemon/run.test.ts',
  'src/codex/utils/compactSeedBuilder.test.ts',
  'src/codex/utils/projectFallbackDocs.test.ts',
];

test('startup_failure_diagnostics_are_bounded_complete_and_redacted', () => {
  // Isolated dependency installations are allowed, but not stale test/producer
  // copies. The behavioral authority below is execution, not this byte check.
  for (const file of [...tests, 'src/daemon/run.ts', 'src/codex/utils/redactSecrets.ts',
    'src/utils/processKill.ts', 'src/utils/spawnHappyCLI.ts']) {
    assert.deepEqual(readFileSync(resolve(root, file)), readFileSync(resolve(source, file)), file);
  }
  const result = spawnSync(process.execPath, [
    resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--reporter=json',
  ], {
    cwd: root,
    env: { ...process.env, HAPPY_SKIP_TEST_BUILD: '1' },
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, tests.length);
  for (const file of tests) {
    const suite = report.testResults.find(item => item.name === resolve(root, file));
    assert.ok(suite?.assertionResults.length, `Missing executed tests: ${file}`);
    for (const assertion of suite.assertionResults) assert.equal(assertion.status, 'passed', assertion.fullName);
  }
});
