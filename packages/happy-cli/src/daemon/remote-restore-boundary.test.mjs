import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';

test('remote_restore_notifications_never_authorize_a_second_provider', () => {
  const directory = mkdtempSync('/private/tmp/xc-disposable/happy-remote-restore-test-');
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { randomUUID } from 'node:crypto';
    import { readFile, readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    import { configuration } from './src/configuration.ts';
    import { RemoteRestoreDelivery, NO_NEW_RESTORE_INPUT, restoreTransportNotice,
      validateRemoteRestoreState, withinRestoreNoticeBudget } from './src/daemon/remoteRestore.ts';
    import { writeRestoreFile, updateRestoreState, closeRestoreFile, reopenRestoreFile,
      parseRestoreFileData, runSerial } from './src/daemon/run.ts';
    import { selectInitialRestoreMessages, validateRecentMessageWindow } from './src/api/sessionMessageRecovery.ts';
    import { encrypt, decrypt, encodeBase64, decodeBase64 } from './src/api/encryption.ts';
    import { ApiSessionMessageClient } from './src/api/apiSessionMessage.ts';

    const sid = 'remote-restore-case';
    const base = { directory: '/workspace', agent: 'codex', codexProfile: 'jim' };
    await writeRestoreFile(sid, base);
    assert.deepEqual(parseRestoreFileData(base), base);
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.throws(() => parseRestoreFileData({ ...base, lastAttemptedUserSeq: value }));
    }
    assert.throws(() => validateRemoteRestoreState({ lastAttemptedUserSeq: 1,
      restoreNotices: [{ id: randomUUID(), inputSeq: 2, message: 'wrong sequence' }] }));

    // The same encrypted-message selector is used by provider replay and admission.
    const key = new Uint8Array(32).fill(7);
    const row = (seq, body) => ({ id: 'message-' + seq, seq, createdAt: 1000 + seq,
      localId: null, content: { t: 'encrypted', c: encodeBase64(encrypt(key, 'legacy', body)) } });
    const decode = item => decrypt(key, 'legacy', decodeBase64(item.content.c));
    const user = { role: 'user', content: { type: 'text', text: 'hello' } };
    const event = { role: 'agent', content: { type: 'event', data: { type: 'message', message: 'restore result' } } };
    const writer = new ApiSessionMessageClient('unused-local-test', { id: sid, encryptionKey: key, encryptionVariant: 'legacy' });
    const noticeInput = { messageRole: 'agent', messageType: 'event', message: 'restored', eventId: 'event-id',
      localId: 'xc-msg-v1-' + 'a'.repeat(64), timeoutMs: 1000 };
    const ciphertext = writer.prepareAgentEventOnce(noticeInput);
    assert.equal(writer.prepareAgentEventOnce({ ...noticeInput, encryptedRecord: ciphertext }), ciphertext);
    assert.throws(() => writer.prepareAgentEventOnce({ ...noticeInput, message: 'different', encryptedRecord: ciphertext }), /does not match/);
    assert.throws(() => writer.prepareAgentEventOnce({ ...noticeInput, eventId: 'other', encryptedRecord: ciphertext }), /does not match/);
    const response = { role: 'agent', content: { type: 'codex', data: {} } };
    const rows = validateRecentMessageWindow([row(1, response), row(2, user), row(3, event)]);
    assert.deepEqual(selectInitialRestoreMessages(rows, decode).map(item => item.seq), [2]);
    assert.deepEqual(selectInitialRestoreMessages(validateRecentMessageWindow([row(1, event)]), decode), []);
    assert.throws(() => selectInitialRestoreMessages(validateRecentMessageWindow(
      Array.from({ length: 150 }, (_, index) => row(index + 1, event))), decode), /boundary/);
    assert.throws(() => selectInitialRestoreMessages(validateRecentMessageWindow([
      row(1, { role: 'user', content: { type: 'text', text: 123 } })]), decode), /invalid/);

    let starts = 0;
    const failures = [];
    const lifecycle = new Map();
    const restore = async () => {
      starts += 1;
      const child = spawn(process.execPath, ['-e', 'process.exitCode = 7'], { stdio: 'ignore' });
      await once(child, 'exit');
      return { type: 'error', errorMessage: 'provider rejected history' };
    };
    const sent = [];
    const delivery = new RemoteRestoreDelivery(updateRestoreState, async (_id, notice) => {
      sent.push({ ...notice });
      // The unchanged Server can issue another RPC for the notification. It
      // must not start another provider, including after daemon reconstruction.
      await assert.rejects(runSerial(lifecycle, sid, () => delivery.run(sid, 2, restore)),
        error => error.message === NO_NEW_RESTORE_INPUT);
    }, error => failures.push(error));
    const first = await runSerial(lifecycle, sid, () => delivery.run(sid, 2, restore));
    assert.equal(first.type, 'error');
    assert.equal(starts, 1);
    await Promise.all([
      writeRestoreFile(sid, { ...base, codexProfile: 'jim' }),
      updateRestoreState(sid, state => ({ ...state })),
    ]);
    await closeRestoreFile(sid, true);
    let disk = JSON.parse(await readFile(join(configuration.happyHomeDir, 'restore', sid + '.closed'), 'utf8'));
    assert.equal(disk.lastAttemptedUserSeq, 2);
    assert.equal(disk.restoreNotices.length, 1);
    const originalNotice = disk.restoreNotices[0];
    assert.match(originalNotice.message, /失败/);
    await delivery.flush();
    assert.equal(starts, 1);
    assert.equal(sent.length, 1);
    assert.equal(failures.length, 0);
    await reopenRestoreFile(sid);
    disk = JSON.parse(await readFile(join(configuration.happyHomeDir, 'restore', sid + '.json'), 'utf8'));
    assert.equal(disk.lastAttemptedUserSeq, 2);
    assert.equal(disk.restoreNotices.length, 0);

    // Reconstructed daemon: same input cannot retry; a genuinely new input can.
    let online = false;
    const retried = [];
    const restarted = new RemoteRestoreDelivery(updateRestoreState, async (_sid, notice) => {
      if (!online) throw new Error('confirmation-unknown');
      retried.push({ ...notice });
    }, () => {});
    await assert.rejects(restarted.run(sid, 2, restore), /no new user input/);
    await restarted.run(sid, 4, restore);
    assert.equal(starts, 2);
    await restarted.flush();
    disk = JSON.parse(await readFile(join(configuration.happyHomeDir, 'restore', sid + '.json'), 'utf8'));
    assert.equal(disk.restoreNotices.length, 1);
    const failedSend = disk.restoreNotices[0];
    online = true;
    await restarted.flush();
    assert.deepEqual(retried, [failedSend]);
    assert.equal(starts, 2);

    // Crash between admission and completion never becomes a forged success.
    const interrupted = { id: randomUUID(), inputSeq: 5, message: null };
    await updateRestoreState(sid, state => ({ ...state, lastAttemptedUserSeq: 5, restoreNotices: [interrupted] }));
    const afterCrash = new RemoteRestoreDelivery(updateRestoreState, async (_sid, notice) => retried.push({ ...notice }), () => {});
    afterCrash.recover([sid]);
    await afterCrash.flush();
    assert.equal(retried.at(-1).id, interrupted.id);
    assert.match(retried.at(-1).message, /仍未确认/);
    assert.equal(starts, 2);

    // Backpressure is enforced before spawning, not just recorded in metadata.
    await updateRestoreState(sid, state => ({ ...state, restoreNotices: Array.from({ length: 16 }, () =>
      ({ id: randomUUID(), inputSeq: 5, message: 'unconfirmed result' })) }));
    await assert.rejects(afterCrash.run(sid, 6, restore), /backlog is full/);
    assert.equal(starts, 2);

    // An in-flight attempt is not an interrupted attempt, and a real readiness
    // result is returned independently of whether its notification can be sent.
    const readySid = 'ready-restore-case';
    await writeRestoreFile(readySid, base);
    let enter;
    let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const readiness = new Promise(resolve => { release = resolve; });
    const readyNotices = [];
    const readyDelivery = new RemoteRestoreDelivery(updateRestoreState,
      async (_sid, notice) => readyNotices.push({ ...notice }), error => { throw error; });
    const readyOperation = readyDelivery.run(readySid, 1, async () => {
      enter();
      await readiness;
      return { type: 'success', sessionId: readySid };
    });
    await entered;
    await readyDelivery.flush();
    assert.deepEqual(readyNotices, []);
    release();
    assert.equal((await readyOperation).sessionId, readySid);
    await readyDelivery.flush();
    assert.equal(readyNotices.length, 1);
    assert.match(readyNotices[0].message, /输入通道已就绪/);
    assert.match(readyNotices[0].message, /不代表模型已回复/);

    // A flush requested during another session's send must not disappear.
    // Cover both a session absent from the snapshot and one already visited
    // while its readiness was still pending, using the real restore files.
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    for (const kind of ['new', 'active']) {
      const firstSid = 'flush-first-' + kind;
      const nextSid = 'flush-next-' + kind;
      await writeRestoreFile(firstSid, base);
      await writeRestoreFile(nextSid, base);
      const publishing = deferred();
      const releasePublish = deferred();
      const restoring = deferred();
      const releaseRestore = deferred();
      const delivered = [];
      let sending = 0;
      const concurrent = new RemoteRestoreDelivery(updateRestoreState, async (id, notice) => {
        sending += 1;
        assert.equal(sending, 1, 'concurrent flush requests must retain one sender');
        try {
          if (id === firstSid) {
            publishing.resolve();
            await releasePublish.promise;
          }
          delivered.push({ id, message: notice.message });
        } finally { sending -= 1; }
      }, error => { throw error; });
      let nextOperation;
      if (kind === 'active') {
        nextOperation = concurrent.run(nextSid, 1, async () => {
          restoring.resolve();
          await releaseRestore.promise;
          return { type: 'success', sessionId: nextSid };
        });
        await restoring.promise;
      }
      await concurrent.run(firstSid, 1, async () => ({ type: 'success', sessionId: firstSid }));
      const draining = concurrent.flush();
      await publishing.promise;
      if (kind === 'new') {
        nextOperation = concurrent.run(nextSid, 1, async () => ({ type: 'success', sessionId: nextSid }));
      } else {
        releaseRestore.resolve();
      }
      await nextOperation;
      // This is the run.ts completion trigger, issued before the first send ends.
      await concurrent.flush();
      releasePublish.resolve();
      await draining;
      assert.deepEqual(delivered.map(item => item.id), [firstSid, nextSid]);
      assert.ok(delivered.every(item => item.message.includes('输入通道已就绪')));
      for (const id of [firstSid, nextSid]) {
        const stored = await updateRestoreState(id, state => state);
        assert.deepEqual(stored.restoreNotices, []);
      }
    }

    // Request timeouts never acquire the identity/outcome of a later attempt.
    assert.match(restoreTransportNotice('happy.restore', 'happy.restore.failed', 'operation has timed out'), /不代表/);
    assert.match(restoreTransportNotice('happy.restore', 'happy.restore.failed', NO_NEW_RESTORE_INPUT), /未重复启动/);
    assert.equal(restoreTransportNotice('happy.restore', 'happy.restore.failed', 'provider actually failed'), null);
    assert.equal(restoreTransportNotice('other', 'other', 'operation has timed out'), null);
    let lateSend = false;
    await assert.rejects(withinRestoreNoticeBudget(async remaining => {
      await new Promise(resolve => setTimeout(resolve, 50));
      remaining();
      lateSend = true;
    }, 10), /deadline/);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(lateSend, false);
    assert.equal(await withinRestoreNoticeBudget(async remaining => remaining() > 0), true);
    assert.equal((await readdir(join(configuration.happyHomeDir, 'restore'))).some(name => name.endsWith('.tmp')), false);
    console.log('real-file admission, encrypted selection, child lifecycle, restart/delivery and deadline boundaries passed');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HAPPY_HOME_DIR: directory, DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
