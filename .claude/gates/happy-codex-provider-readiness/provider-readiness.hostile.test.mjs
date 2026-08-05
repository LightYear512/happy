import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runVitest(files, pattern) {
  const script = [
    "import { startVitest } from './node_modules/vitest/dist/node.js';",
    "import { resolve } from 'node:path';",
    "const root = resolve('packages/happy-cli');",
    `const run = await startVitest('test', ${JSON.stringify(files)},`,
    `  { root, run: true, watch: false, globalSetup: [], testNamePattern: ${JSON.stringify(pattern)} },`,
    "  { resolve: { alias: { '@': resolve(root, 'src') } } });",
    "process.exit(run && run.state.getCountOfFailedTests() === 0 ? 0 : 1);",
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('existing_restore_identity_consumer_is_fail_closed', () => {
  const result = runVitest(
    ['src/daemon/controlServer.test.ts'],
    'restores by one Happy session ID without invoking the spawn boundary',
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
