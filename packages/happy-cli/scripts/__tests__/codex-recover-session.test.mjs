import test from 'node:test';
import assert from 'node:assert/strict';
import { replacementMetadata, assertNoUnexpectedUsers, assertRecoveryInputWindow, validateSeed, isMissingRolloutError } from '../codex-recover-session.mjs';

const oldId = '019fa643-8838-7b90-ab0c-f0f7f6e0324b';
const newId = '01a05291-982a-7b91-9128-dad367e41495';

test('identity replacement preserves all unrelated metadata without mutating the source', () => {
    const before = Object.freeze({ flavor: 'codex', claudeSessionId: oldId,
        summary: { text: 'original title' }, futureField: [1, 2], machineId: 'same-machine' });
    assert.deepEqual(replacementMetadata(before, oldId, newId), { ...before, claudeSessionId: newId });
    assert.equal(before.claudeSessionId, oldId);
});

test('a concurrent identity replacement is rejected instead of overwritten by metadata retries', () => {
    const current = { flavor: 'codex', claudeSessionId: '019fa643-8838-7b90-ab0c-f0f7f6e0324c' };
    assert.throws(() => replacementMetadata(current, oldId, newId), /concurrently/);
    assert.equal(current.claudeSessionId, '019fa643-8838-7b90-ab0c-f0f7f6e0324c');
    assert.throws(() => replacementMetadata({ flavor: 'claude', claudeSessionId: oldId }, oldId, newId), /backend/);
});

test('retry after lost acknowledgement accepts only the exact prepared identity', () => {
    const current = { flavor: 'codex', claudeSessionId: newId, currentModelCode: 'unchanged' };
    assert.deepEqual(replacementMetadata(current, oldId, newId), current);
});

test('the recovery response may pause old inputs but never silently include a new concurrent input', () => {
    const rows = [{ seq: 10, role: 'user' }, { seq: 11, role: 'agent' }, { seq: 12, role: 'user' }];
    assert.throws(() => assertNoUnexpectedUsers(rows, 10, row => row), /New user input/);
    assert.throws(() => assertRecoveryInputWindow(rows, 10, row => row), /New user input/);
    assertNoUnexpectedUsers(rows, 12, row => row);
});

test('input arriving while the old wake settles blocks metadata commit', () => {
    const rows = [{ seq: 10, role: 'user' }, { seq: 11, role: 'agent' }];
    assertRecoveryInputWindow(rows, 10, row => row);
    // The notice at 11 is already persisted; the next input arrived during
    // awaitClosedAfterNotice, after the earlier window check succeeded.
    rows.push({ seq: 12, role: 'user' });
    assert.throws(() => assertRecoveryInputWindow(rows, 10, row => row), /New user input/);
});

test('a truncated recovery window cannot prove that no new user input arrived', () => {
    const rows = [{ seq: 20, role: 'agent' }, { seq: 21, role: 'agent' }];
    assert.throws(() => assertRecoveryInputWindow(rows, 10, row => row), /window was truncated/);
});

test('empty and oversized recovery summaries are rejected before any native/server writes', () => {
    assert.throws(() => validateSeed('  '));
    assert.throws(() => validateSeed('中'.repeat(7000)));
    assert.equal(validateSeed('保留任务，等待新指令'), '保留任务，等待新指令');
});

test('rebuild admits only a missing rollout for the exact old identity', () => {
    const err = message => new Error(JSON.stringify({ code: -32600, message }));
    assert(isMissingRolloutError(err(`no rollout found for thread id ${oldId}`), oldId));
    assert(isMissingRolloutError(err(`failed to resolve rollout path \`/sessions/rollout-date-${oldId}.jsonl\`: file does not exist`), oldId));
    assert(!isMissingRolloutError(err(`no rollout found for thread id ${newId}`), oldId));
    assert(!isMissingRolloutError(err(`failed to resolve rollout path \`/sessions/rollout-date-${oldId}.jsonl\`: permission denied`), oldId));
    assert(!isMissingRolloutError(err('authentication required'), oldId));
});
