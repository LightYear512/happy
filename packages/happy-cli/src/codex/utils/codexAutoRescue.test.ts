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
    // This was the original compact-failure capture present across all
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

describe('shouldAutoRescue — unrelated failures do not append the project doc', () => {
    // Auto-rescue is the ONLY automatic path into runManualCompact('compact'),
    // which is where .happy/on-fallback-compact.md is appended. So "could this
    // error append the project doc?" reduces to "does shouldAutoRescue return
    // true?". Every unrelated error below must return false → no append.
    it('does NOT trigger (→ never appends the doc) on non-compact errors', () => {
        const nonCompact: Array<{ label: string; params: unknown }> = [
            { label: 'rate limit', params: { error: { message: 'Rate limit exceeded, slow down' }, willRetry: false } },
            { label: '401 auth', params: { error: { message: 'unexpected status 401 Unauthorized' }, willRetry: false } },
            { label: 'context length exceeded', params: { error: { message: 'context_length_exceeded: maximum is 256000 tokens' }, willRetry: false } },
            { label: 'bare stream disconnect (not a compact task)', params: { error: { message: 'stream disconnected before completion' }, willRetry: false } },
            { label: 'generic turn error', params: { error: { message: 'Turn failed: internal server error' }, willRetry: false } },
            { label: 'request timeout', params: { error: { message: 'request timed out after 60s' }, willRetry: false } },
            { label: 'the word "compact" but not the needle', params: { error: { message: 'Compaction completed successfully' }, willRetry: false } },
            { label: 'real compact failure but codex WILL retry', params: { error: { message: 'Error running remote compact task: transient blip' }, willRetry: true } },
            { label: 'empty object', params: {} },
            { label: 'null', params: null },
            { label: 'string (non-object)', params: 'some error string' },
        ];
        for (const { label, params } of nonCompact) {
            expect(shouldAutoRescue(params), `"${label}" must NOT trigger auto-rescue (would wrongly append the doc)`).toBe(false);
        }
    });

    it('DOES trigger on a genuine server compact failure (willRetry:false + needle)', () => {
        expect(shouldAutoRescue({
            error: { message: 'Error running remote compact task: stream disconnected before completion' },
            willRetry: false,
        })).toBe(true);
    });
});

describe('encrypted context failures', () => {
    const upstream = { type: 'error', error: {
        type: 'invalid_request_error', code: 'invalid_encrypted_content',
        message: 'The encrypted content for item rs_example could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
        param: null,
    }, status: 400 };

    it.each([
        { error: upstream.error },
        { error: { message: JSON.stringify(upstream) }, willRetry: false },
        { turn: { status: 'failed', error: { message: JSON.stringify(upstream) } } },
    ])('recognizes the upstream code across native envelopes: %j', (params) => {
        expect(shouldAutoRescue(params)).toBe(true);
    });

    it('does not turn unrelated 400s, quoted text, or transient errors into context resets', () => {
        expect(shouldAutoRescue({ error: { code: 'invalid_request_error', message: 'bad request' }, status: 400 })).toBe(false);
        expect(shouldAutoRescue({ error: { message: 'example: invalid_encrypted_content' } })).toBe(false);
        expect(shouldAutoRescue({ error: upstream.error, willRetry: true })).toBe(false);
    });
});

describe('createRescueGate', () => {
    it('allows only one automatic recovery until an actual successful turn', () => {
        const gate = createRescueGate();
        expect(gate.tryClaim()).toBe(true);
        for (let i = 0; i < 10; i++) expect(gate.tryClaim()).toBe(false);
        gate.resetAfterSuccess();
        expect(gate.tryClaim()).toBe(true);
        expect(gate.tryClaim()).toBe(false);
    });
});
