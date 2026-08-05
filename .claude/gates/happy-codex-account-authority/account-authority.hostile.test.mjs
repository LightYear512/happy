import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runVitest(pattern) {
  const script = [
    "import { startVitest } from './node_modules/vitest/dist/node.js';",
    "import { resolve } from 'node:path';",
    "const root = resolve('packages/happy-cli');",
    "const run = await startVitest('test', ['src/daemon/run.test.ts'],",
    "  { root, run: true, watch: false, globalSetup: [],",
    `    testNamePattern: ${JSON.stringify(pattern)} },`,
    "  { resolve: { alias: { '@': resolve(root, 'src') } } });",
    "process.exit(run && run.state.getCountOfFailedTests() === 0 ? 0 : 1);",
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('explicit_codex_account_overrides_daemon_snapshot', () => {
  const result = runVitest(
    'preserves explicit account and title inputs while removing the inherited thread',
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('restored_codex_uses_current_committed_account_not_daemon_snapshot', () => {
  const result = runVitest(
    'removes daemon Codex identity from a resumed session so the current default is authoritative',
  );
  assert.equal(
    result.status,
    0,
    `PF4_CONTRACT_UNSATISFIED[daemon-snapshot-leaked]\n${result.stdout}\n${result.stderr}`,
  );
});
