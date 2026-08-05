import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('account_intent_boundary', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import * as intent from './src/commands/bang/accountIntent.ts';

    mkdirSync('/private/tmp/xc-disposable', { recursive: true });
    const root = mkdtempSync('/private/tmp/xc-disposable/happy-account-intent-');
    try {
      const first = intent.publishAccountIntent('codex', 'work', 100, root);
      const second = intent.publishAccountIntent('codex', 'personal', 100, root);
      assert.deepEqual(first, { profileName: 'work', setAt: 100 });
      assert.deepEqual(second, { profileName: 'personal', setAt: 101 });
      assert.deepEqual(intent.readAccountIntent('codex', root), second);
      assert.equal(intent.readSessionAccountSelection('session-a', 'codex', root), null);
      intent.writeSessionAccountSelection('session-a', 'codex', 'manual', 100, root);
      assert.deepEqual(intent.readSessionAccountSelection('session-a', 'codex', root), {
        profileName: 'manual', seenGlobalSetAt: 100,
      });
      assert.throws(
        () => intent.writeSessionAccountSelection('session-a', 'codex', 'stale', 99, root),
        /backwards/u,
      );
      assert.equal(intent.readSessionAccountSelection('session-b', 'codex', root), null);
      assert.equal(intent.accountIntentIsNewer(second, 100), true);
      assert.equal(intent.accountIntentIsNewer(second, 101), false);
      assert.deepEqual(
        intent.resolveStartupAccountSelection(
          { profileName: 'deleted-manual', seenGlobalSetAt: 100 },
          second,
        ),
        { profileName: 'personal', seenGlobalSetAt: 101, source: 'global' },
      );
      assert.deepEqual(
        intent.resolveStartupAccountSelection(
          { profileName: 'manual', seenGlobalSetAt: 101 },
          second,
        ),
        { profileName: 'manual', seenGlobalSetAt: 101, source: 'session' },
      );
      assert.deepEqual(
        intent.resolveStartupAccountSelection(null, second),
        { profileName: 'personal', seenGlobalSetAt: 101, source: 'global' },
      );
      assert.throws(
        () => intent.publishAccountIntent('claude', 'invalid-time', Number.NaN, root),
        /timestamp is invalid/u,
      );
      intent.publishAccountIntent('claude', 'last', Number.MAX_SAFE_INTEGER, root);
      assert.throws(
        () => intent.publishAccountIntent('claude', 'overflow', Number.MAX_SAFE_INTEGER, root),
        /timestamp is exhausted/u,
      );
      assert.deepEqual(intent.readAccountIntent('claude', root), {
        profileName: 'last', setAt: Number.MAX_SAFE_INTEGER,
      });
      writeFileSync(join(root, 'account-intent.json'), JSON.stringify({
        schema: 'happy.account-intent/1', codex: second, unexpected: true,
      }));
      assert.throws(() => intent.readAccountIntent('codex', root), /invalid/u);
      writeFileSync(join(root, 'account-intent.json'), JSON.stringify({
        schema: 'happy.account-intent/1',
        codex: { ...second, unexpected: true },
      }));
      assert.throws(() => intent.readAccountIntent('codex', root), /invalid/u);
      writeFileSync(join(root, 'account-intent.json'), '{"schema":"wrong"}\n');
      assert.throws(() => intent.readAccountIntent('codex', root), /invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('../../..', import.meta.url),
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
