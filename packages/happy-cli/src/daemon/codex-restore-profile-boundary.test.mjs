import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('codex_restore_profile_boundary', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { buildRestoreProfileEnvironment, parseRestoreFileData } from './src/daemon/run.ts';
    import { startDaemonControlServer } from './src/daemon/controlServer.ts';

    const record = parseRestoreFileData({ directory: '/workspace', agent: 'codex', codexProfile: 'eliasi' });
    assert.match(buildRestoreProfileEnvironment(record).CODEX_HOME, /\/auth\/codex\/instances\/eliasi$/u);
    assert.throws(() => parseRestoreFileData({ directory: '/workspace', agent: 'claude', codexProfile: 'eliasi' }));
    assert.throws(() => parseRestoreFileData({ directory: '/workspace', agent: 'codex', codexProfile: '../eliasi' }));

    const updates = [];
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: async () => ({ accepted: true }),
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
      onCodexProfile: async (sessionId, profileName) => {
        updates.push({ sessionId, profileName });
        return sessionId === 'happy-session';
      },
    });
    try {
      const accepted = await fetch('http://127.0.0.1:' + server.port + '/session-codex-profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'happy-session', profileName: 'eliasi' }),
      });
      assert.equal(accepted.status, 200);
      const rejected = await fetch('http://127.0.0.1:' + server.port + '/session-codex-profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'happy-session', profileName: '../eliasi' }),
      });
      assert.equal(rejected.status, 400);
      assert.deepEqual(updates, [{ sessionId: 'happy-session', profileName: 'eliasi' }]);
    } finally {
      await server.stop();
    }
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
