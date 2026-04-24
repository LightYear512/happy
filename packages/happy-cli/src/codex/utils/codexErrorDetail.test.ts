import { describe, expect, it } from 'vitest';
import { extractCodexErrorDetail, formatCodexErrorForUi } from './codexErrorDetail';

describe('extractCodexErrorDetail', () => {
    it('extracts message from nested error object (real codex payload)', () => {
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
        expect(extractCodexErrorDetail(params)).toBe(params.error.message);
    });

    it('concatenates message and additionalDetails with blank line', () => {
        const params = {
            error: {
                message: 'Rate limit exceeded',
                additionalDetails: 'Retry after 60s',
            },
        };
        expect(extractCodexErrorDetail(params)).toBe('Rate limit exceeded\n\nRetry after 60s');
    });

    it('accepts snake_case additional_details', () => {
        const params = {
            error: {
                message: 'Quota exceeded',
                additional_details: 'billing ticket #123',
            },
        };
        expect(extractCodexErrorDetail(params)).toBe('Quota exceeded\n\nbilling ticket #123');
    });

    it('reads error from turn.error when direct error is absent', () => {
        const params = {
            turn: {
                error: { message: 'turn failed: model overloaded' },
            },
        };
        expect(extractCodexErrorDetail(params)).toBe('turn failed: model overloaded');
    });

    it('unwraps plain string error', () => {
        expect(extractCodexErrorDetail({ error: 'boom' })).toBe('boom');
    });

    it('falls back to top-level message', () => {
        expect(extractCodexErrorDetail({ message: 'top-level' })).toBe('top-level');
    });

    it('returns unknown for empty object', () => {
        expect(extractCodexErrorDetail({})).toBe('unknown');
    });

    it('returns unknown for null', () => {
        expect(extractCodexErrorDetail(null)).toBe('unknown');
    });

    it('returns unknown for undefined', () => {
        expect(extractCodexErrorDetail(undefined)).toBe('unknown');
    });

    it('unwraps bare string param', () => {
        expect(extractCodexErrorDetail('something broke')).toBe('something broke');
    });

    it('JSON-stringifies error object missing both message and additionalDetails', () => {
        const out = extractCodexErrorDetail({ error: { codexErrorInfo: 'other', code: 42 } });
        expect(out).toContain('codexErrorInfo');
        expect(out).not.toContain('[object Object]');
    });

    it('does not throw on circular error objects', () => {
        const inner: Record<string, unknown> = { codexErrorInfo: 'other' };
        inner.self = inner;
        const params = { error: inner };
        const out = extractCodexErrorDetail(params);
        expect(typeof out).toBe('string');
        expect(out).not.toContain('[object Object]');
    });

    it('ignores array at root', () => {
        expect(extractCodexErrorDetail([1, 2, 3])).toBe('unknown');
    });

    it('prefers direct error over turn.error when both present', () => {
        const params = {
            error: { message: 'direct' },
            turn: { error: { message: 'nested' } },
        };
        expect(extractCodexErrorDetail(params)).toBe('direct');
    });

    it('trims whitespace around messages', () => {
        expect(extractCodexErrorDetail({ error: { message: '  spaced  ' } })).toBe('spaced');
    });

    it('treats empty string message as absent and falls back', () => {
        const out = extractCodexErrorDetail({ error: { message: '   ', codexErrorInfo: 'x' } });
        expect(out).toContain('codexErrorInfo');
    });

    it('handles a native Error instance via top-level message fallback', () => {
        expect(extractCodexErrorDetail(new Error('boom'))).toBe('boom');
    });
});

describe('formatCodexErrorForUi', () => {
    it('prepends "Codex error:" when detail has no error prefix', () => {
        expect(formatCodexErrorForUi('rate limit exceeded')).toBe('Codex error: rate limit exceeded');
    });

    it('preserves detail already starting with "Error:" (case-insensitive)', () => {
        expect(formatCodexErrorForUi('Error running remote compact task: stream disconnected'))
            .toBe('Error running remote compact task: stream disconnected');
        expect(formatCodexErrorForUi('error: something'))
            .toBe('error: something');
    });

    it('preserves detail already starting with "Codex error:"', () => {
        expect(formatCodexErrorForUi('Codex error: already prefixed'))
            .toBe('Codex error: already prefixed');
    });

    it('returns bare "Codex error" for empty/whitespace detail', () => {
        expect(formatCodexErrorForUi('')).toBe('Codex error');
        expect(formatCodexErrorForUi('   ')).toBe('Codex error');
    });

    it('trims surrounding whitespace before checking prefix', () => {
        expect(formatCodexErrorForUi('  Error: padded  ')).toBe('Error: padded');
    });

    it('end-to-end: real codex payload no longer double-prefixes', () => {
        const params = {
            error: {
                message: 'Error running remote compact task: stream disconnected before completion',
                codexErrorInfo: 'other',
                additionalDetails: null,
            },
            willRetry: false,
        };
        const out = formatCodexErrorForUi(extractCodexErrorDetail(params));
        expect(out).toBe('Error running remote compact task: stream disconnected before completion');
        expect(out.startsWith('Codex error: Error')).toBe(false);
    });
});
