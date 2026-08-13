import { describe, expect, it, vi } from 'vitest';

const traceMock = vi.hoisted(() => vi.fn());

vi.mock('@/ui/logger', () => ({
    diagnosticTrace: traceMock,
}));

import { createUserInputTrace, logUserInputStage } from './userInputTrace';

describe('userInputTrace', () => {
    it('writes one structured content record with stable local input identity', () => {
        const trace = createUserInputTrace('s1', {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            localKey: 'local-1',
        });

        logUserInputStage('persisted-received', trace, 'hello', { persistedSequence: 7 });

        expect(traceMock).toHaveBeenCalledOnce();
        const record = JSON.parse(traceMock.mock.calls[0][1]);
        expect(record).toMatchObject({
            stage: 'persisted-received',
            sessionId: 's1',
            inputId: 'local-1',
            content: 'hello',
            contentBytes: 5,
            contentTruncated: false,
            persistedSequence: 7,
        });
        expect(record.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('bounds large content while preserving its exact byte count and digest', () => {
        const content = '\u0000'.repeat(10_000);
        const trace = createUserInputTrace('s1', {
            role: 'user',
            content: { type: 'text', text: content },
        });

        logUserInputStage('persisted-received', trace, content);

        const record = JSON.parse(traceMock.mock.calls.at(-1)![1]);
        expect(record.contentBytes).toBe(10_000);
        expect(record.contentTruncated).toBe(true);
        expect(Buffer.byteLength(record.content, 'utf8')).toBe(8 * 1024);
        expect(JSON.stringify(record).length).toBeLessThan(64 * 1024);
    });

    it('references later stages by input identity without repeating content', () => {
        const trace = createUserInputTrace('s1', {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            localKey: 'local-1',
        });

        logUserInputStage('model-submit-accepted', trace, 'hello', { turnId: 'turn-1' });

        const record = JSON.parse(traceMock.mock.calls.at(-1)![1]);
        expect(record).toEqual({
            stage: 'model-submit-accepted',
            sessionId: 's1',
            inputId: 'local-1',
            turnId: 'turn-1',
        });
    });
});
