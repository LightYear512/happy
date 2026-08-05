import { describe, expect, it, vi } from 'vitest';

import {
    performCodexAccountSwap,
    performCodexMcpAccountRestart,
    requireExactCodexThreadResume,
    type AccountSwapClient,
} from '../codexAccountSwap';

function client(name: string, events: string[]): AccountSwapClient {
    return {
        dispose: vi.fn(async () => {
            events.push(`${name}:dispose`);
        }),
    };
}

describe('performCodexAccountSwap', () => {
    it('keeps the old client when candidate initialization fails', async () => {
        const events: string[] = [];
        const oldClient = client('old', events);
        const result = await performCodexAccountSwap({
            currentClient: oldClient,
            threadId: 'thread-1',
            createCandidate: async () => {
                events.push('candidate:create');
                throw new Error('initialize timeout');
            },
            resumeCandidate: async () => 'thread-1',
        });

        expect(result.ok).toBe(false);
        expect(result.client).toBe(oldClient);
        expect(events).toEqual(['candidate:create']);
    });

    it('disposes only the candidate when candidate resume fails', async () => {
        const events: string[] = [];
        const oldClient = client('old', events);
        const candidate = client('candidate', events);
        const result = await performCodexAccountSwap({
            currentClient: oldClient,
            threadId: 'thread-1',
            createCandidate: async () => {
                events.push('candidate:create');
                return candidate;
            },
            resumeCandidate: async () => {
                events.push('candidate:resume');
                throw new Error('resume rejected');
            },
        });

        expect(result.ok).toBe(false);
        expect(result.client).toBe(oldClient);
        expect(events).toEqual([
            'candidate:create',
            'candidate:resume',
            'candidate:dispose',
        ]);
    });

    it('replaces the old client only after the candidate resumes the same thread', async () => {
        const events: string[] = [];
        const oldClient = client('old', events);
        const candidate = client('candidate', events);
        const result = await performCodexAccountSwap({
            currentClient: oldClient,
            threadId: 'thread-1',
            createCandidate: async () => {
                events.push('candidate:create');
                return candidate;
            },
            resumeCandidate: async (_client, threadId) => {
                events.push(`candidate:resume:${threadId}`);
                return threadId;
            },
        });

        expect(result).toEqual({ ok: true, client: candidate, threadId: 'thread-1' });
        expect(events).toEqual([
            'candidate:create',
            'candidate:resume:thread-1',
            'old:dispose',
        ]);
    });
});

describe('requireExactCodexThreadResume', () => {
    it('rejects a resume response without a thread id', () => {
        expect(() => requireExactCodexThreadResume(null, 'thread-1'))
            .toThrow('thread/resume returned no thread id');
    });

    it('rejects a different resumed thread', () => {
        expect(() => requireExactCodexThreadResume('thread-2', 'thread-1'))
            .toThrow('thread/resume identity mismatch');
    });

    it('accepts only the exact resumed thread', () => {
        expect(requireExactCodexThreadResume('thread-1', 'thread-1')).toBe('thread-1');
    });
});

describe('performCodexMcpAccountRestart', () => {
    it('reconnects under the target account environment', async () => {
        const previous = process.env.CODEX_HOME;
        process.env.CODEX_HOME = '/accounts/old';
        const observed: Array<string | undefined> = [];
        try {
            const result = await performCodexMcpAccountRestart({
                reconnect: async () => { observed.push(process.env.CODEX_HOME); },
            }, '/accounts/new');
            expect(result).toEqual({ ok: true });
            expect(observed).toEqual(['/accounts/new']);
            expect(process.env.CODEX_HOME).toBe('/accounts/new');
        } finally {
            if (previous === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previous;
        }
    });

    it('restores the old account when target reconnect fails', async () => {
        const previous = process.env.CODEX_HOME;
        process.env.CODEX_HOME = '/accounts/old';
        const observed: Array<string | undefined> = [];
        try {
            const result = await performCodexMcpAccountRestart({
                reconnect: vi.fn(async () => {
                    observed.push(process.env.CODEX_HOME);
                    if (observed.length === 1) throw new Error('target rejected');
                }),
            }, '/accounts/new');
            expect(result).toEqual({ ok: false, error: new Error('target rejected'), rollbackError: null });
            expect(observed).toEqual(['/accounts/new', '/accounts/old']);
            expect(process.env.CODEX_HOME).toBe('/accounts/old');
        } finally {
            if (previous === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previous;
        }
    });

    it('reports rollback failure without leaving the target account selected', async () => {
        const previous = process.env.CODEX_HOME;
        process.env.CODEX_HOME = '/accounts/old';
        try {
            const result = await performCodexMcpAccountRestart({
                reconnect: async () => { throw new Error(
                    process.env.CODEX_HOME === '/accounts/new' ? 'target rejected' : 'rollback rejected'); },
            }, '/accounts/new');
            expect(result).toEqual({
                ok: false,
                error: new Error('target rejected'),
                rollbackError: new Error('rollback rejected'),
            });
            expect(process.env.CODEX_HOME).toBe('/accounts/old');
        } finally {
            if (previous === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previous;
        }
    });
});
