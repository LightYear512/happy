import { describe, it, expect } from 'vitest';
import { shouldAutoRescue, createRescueGate } from './codexAutoRescue';

describe('shouldAutoRescue', () => {
    it('matches real codex compact-failure error notification', () => {
        const params = {
            error: {
                message: 'Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)',
                codexErrorInfo: 'other',
                additionalDetails: null,
            },
            willRetry: false,
            threadId: '019dbd63-50f0-74d2-bffc-dec119b3371b',
            turnId: '019dbdb1-25a6-7e71-9b8e-ef50e8e22e66',
        };
        expect(shouldAutoRescue(params)).toBe(true);
    });

    it('matches when error nested inside turn.error', () => {
        const params = {
            turn: {
                error: { message: 'Error running remote compact task: connection closed' },
            },
            willRetry: false,
        };
        expect(shouldAutoRescue(params)).toBe(true);
    });

    it('is case-insensitive on the failure needle', () => {
        const params = {
            error: { message: 'ERROR RUNNING REMOTE COMPACT TASK: timeout' },
            willRetry: false,
        };
        expect(shouldAutoRescue(params)).toBe(true);
    });

    it('skips when willRetry is true (codex will retry on its own)', () => {
        const params = {
            error: { message: 'Error running remote compact task: transient' },
            willRetry: true,
        };
        expect(shouldAutoRescue(params)).toBe(false);
    });

    it('skips on unrelated errors', () => {
        const params = {
            error: { message: 'Rate limit exceeded' },
            willRetry: false,
        };
        expect(shouldAutoRescue(params)).toBe(false);
    });

    it('skips on empty / non-object params', () => {
        expect(shouldAutoRescue(null)).toBe(false);
        expect(shouldAutoRescue(undefined)).toBe(false);
        expect(shouldAutoRescue('string error')).toBe(false);
        expect(shouldAutoRescue({})).toBe(false);
    });

    it('handles snake_case additional_details combined into detail string', () => {
        const params = {
            error: {
                message: 'Error running remote compact task',
                additional_details: 'extra context here',
            },
            willRetry: false,
        };
        expect(shouldAutoRescue(params)).toBe(true);
    });
});

describe('shouldAutoRescue — real-world param shapes', () => {
    // Captured verbatim from ~/.happy/logs/2026-04-27-20-27-34-pid-31752.log:772
    // emitted by the now-removed `!simcompact` dev bang command, which
    // synthesised what was believed to be the wire shape of a real codex
    // compact failure (also matches the happier-reference fake-codex shape).
    // This is the ONLY real-world fallback params capture present across all
    // ~/.happy/logs/ on this machine — older logs (5944, 2516, 2568) either
    // predate the auto-rescue log line or only logged a side-channel message
    // without dumping the params object.
    it('rescues on captured !simcompact-injected codex error notification', () => {
        const captured = {
            error: {
                message:
                    'Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)',
                codexErrorInfo: 'other',
                additionalDetails: null,
            },
            willRetry: false,
            threadId: 'simcompact-fake-thread',
            turnId: 'simcompact-fake-turn',
        };
        expect(shouldAutoRescue(captured)).toBe(true);
    });

    // Mirrors the wire shape emitted by happier's fake codex in
    // E:/happy-claude/workspace/happier/apps/cli/src/backends/codex/appServer/runtime.test.ts:241
    // — the reference shape for a real codex network failure. The original
    // fixture's message ("unexpected status 401 …") would NOT trigger rescue
    // by design (different class of error), so this case substitutes the
    // compact-task needle in the same envelope to assert the wrapper shape
    // itself doesn't break extraction.
    it('rescues on happier-style real-codex error envelope (camelCase fields)', () => {
        const reference = {
            threadId: '019dbd63-50f0-74d2-bffc-dec119b3371b',
            turnId: '019dbdb1-25a6-7e71-9b8e-ef50e8e22e66',
            willRetry: false,
            error: {
                message: 'Error running remote compact task: upstream returned 502',
                codexErrorInfo: 'other',
                additionalDetails: null,
            },
        };
        expect(shouldAutoRescue(reference)).toBe(true);
    });

    // Negative-control: same envelope shape as the happier reference, but
    // with the original (non-compact-task) error message verbatim. Documents
    // that unrelated codex errors do NOT trigger rescue — only the specific
    // compact-task failure does. If a future codex protocol change makes
    // ordinary 401s look like compact-task errors, this test should still
    // hold (the needle is the contract, not the envelope).
    it('does not rescue on real codex 401 — out of scope for compact rescue', () => {
        const realCodex401 = {
            threadId: '019dbd63-50f0-74d2-bffc-dec119b3371b',
            turnId: '019dbdb1-25a6-7e71-9b8e-ef50e8e22e66',
            willRetry: false,
            error: {
                message: 'unexpected status 401 Unauthorized: ...',
                codexErrorInfo: 'other',
                additionalDetails: null,
            },
        };
        expect(shouldAutoRescue(realCodex401)).toBe(false);
    });
});

describe('createRescueGate', () => {
    it('first call always succeeds', () => {
        const gate = createRescueGate(30_000);
        expect(gate.tryClaim(0)).toBe(true);
    });

    it('second call within cooldown is rejected', () => {
        const gate = createRescueGate(30_000);
        expect(gate.tryClaim(1000)).toBe(true);
        expect(gate.tryClaim(15_000)).toBe(false);
        expect(gate.tryClaim(30_999)).toBe(false);
    });

    it('call after cooldown succeeds', () => {
        const gate = createRescueGate(30_000);
        expect(gate.tryClaim(1000)).toBe(true);
        expect(gate.tryClaim(31_001)).toBe(true);
    });

    it('subsequent claims reset the cooldown anchor', () => {
        const gate = createRescueGate(30_000);
        expect(gate.tryClaim(1000)).toBe(true);
        expect(gate.tryClaim(31_001)).toBe(true);
        expect(gate.tryClaim(45_000)).toBe(false);
        expect(gate.tryClaim(61_002)).toBe(true);
    });

    it('rejects burst of failures from same compact storm', () => {
        const gate = createRescueGate(30_000);
        expect(gate.tryClaim(0)).toBe(true);
        // 10 retries within 5 seconds — only first should win
        for (let t = 100; t <= 5000; t += 500) {
            expect(gate.tryClaim(t)).toBe(false);
        }
    });

    it('release rolls back the most recent claim so the next call wins', () => {
        // Real scenario: tryClaim succeeds → kick off rescue → rescue throws
        // (rollout missing, build error). The next genuine compact failure
        // within 30s must still be rescuable, otherwise the user gets a raw
        // codex error after a silent failed rescue.
        const gate = createRescueGate(30_000);
        expect(gate.tryClaim(1000)).toBe(true);
        // Without release: would be rejected as cooldown-blocked
        gate.release();
        expect(gate.tryClaim(2000)).toBe(true);
    });

    it('release before any claim is a safe no-op', () => {
        const gate = createRescueGate(30_000);
        expect(() => gate.release()).not.toThrow();
        // Subsequent tryClaim still works
        expect(gate.tryClaim(0)).toBe(true);
    });
});
