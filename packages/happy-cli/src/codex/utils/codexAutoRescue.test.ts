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
