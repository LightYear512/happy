import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import { fetchAndInjectPendingMessages } from './fetchPendingMessages';

const key = new Uint8Array(32);
const encrypted = (id: string, seq: number, body: unknown, createdAt = Date.now() - 10_000,
    localId: string | null = null) => ({
    id,
    seq,
    localId,
    createdAt,
    content: { t: 'encrypted', c: encodeBase64(encrypt(key, 'legacy', body)) },
});

describe('fetchAndInjectPendingMessages', () => {
    it('returns immediately when there are no pending messages', async () => {
        const api = { getSessionMessages: vi.fn().mockResolvedValue([]) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .resolves.toBe(0);
    });

    it('can prefetch recovery rows without injecting before provider readiness', async () => {
        const rows = [
            encrypted('u-11', 11, { role: 'user', content: { type: 'text', text: 'pending' }, meta: { sentFrom: 'app' } }),
            encrypted('a-10', 10, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'old' } } }),
        ];
        const api = { getSessionMessages: vi.fn().mockResolvedValue(rows) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn().mockReturnValue(true),
            sendSessionEvent: vi.fn(),
        } as any;

        const prepared = await fetchAndInjectPendingMessages(
            api, session, 'session-1', key, 'legacy', '[test]', { deferInjection: true },
        );
        expect(api.getSessionMessages).toHaveBeenCalledOnce();
        expect(session.injectPendingPersistedUserMessage).not.toHaveBeenCalled();
        expect(typeof prepared).toBe('function');
        expect((prepared as () => number)()).toBe(1);
        expect(session.injectPendingPersistedUserMessage).toHaveBeenCalledOnce();
    });

    it('HSR restores distinct repeated user messages in authoritative sequence order', async () => {
        const rows = [
            encrypted('u-12', 12, { role: 'user', content: { type: 'text', text: '!usage' }, meta: { sentFrom: 'app' } }),
            encrypted('u-11', 11, { role: 'user', content: { type: 'text', text: '!usage' }, meta: { sentFrom: 'app' } }),
            encrypted('a-10', 10, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'old' } } }),
        ];
        const injected: number[] = [];
        const api = { getSessionMessages: vi.fn().mockResolvedValue(rows) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn((row) => { injected.push(row.seq); return true; }),
            sendSessionEvent: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .resolves.toBe(2);
        expect(injected).toEqual([11, 12]);
    });

    it('HSR restores a persisted CLI Mail command with its verified local identity', async () => {
        const localId = `xc-msg-v1-${'a'.repeat(64)}`;
        const rows = [
            encrypted('u-11', 11, { role: 'user', content: { type: 'text', text: 'Mail command' },
                meta: { sentFrom: 'cli', presentation: 'compact', modelText: 'verified command' } },
            Date.now() - 10_000, localId),
            encrypted('a-10', 10, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'old' } } }),
        ];
        const injected: string[] = [];
        const api = { getSessionMessages: vi.fn().mockResolvedValue(rows) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn((row) => { injected.push(row.localId); return true; }),
            sendSessionEvent: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .resolves.toBe(1);
        expect(injected).toEqual([localId]);
    });

    it('HSR ignores persisted agent events and restores only human input', async () => {
        const digest = 'd'.repeat(64);
        const terminalLocalId = `xc-msg-v1-${digest}`;
        const rows = [
            encrypted('terminal-12', 12, { role: 'agent', content: {
                id: `happy-input-rejected-v1-${digest}`,
                type: 'event',
                data: { type: 'message', message: 'XC v2 输入已拒绝：input-rejected' },
            } }, Date.now() - 9_000, terminalLocalId),
            encrypted('u-11', 11, { role: 'user', content: { type: 'text', text: 'rejected' },
                meta: { sentFrom: 'app' } }),
            encrypted('a-10', 10, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'old' } } }),
        ];
        const injected: string[] = [];
        const api = { getSessionMessages: vi.fn().mockResolvedValue(rows) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn((row) => { injected.push(`user:${row.seq}`); return true; }),
            sendSessionEvent: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .resolves.toBe(1);
        expect(injected).toEqual(['user:11']);
    });

    it('does not block restored input when the at-least-once notice cannot be sent', async () => {
        const rows = [
            encrypted('u-11', 11, { role: 'user', content: { type: 'text', text: 'restore me' },
                meta: { sentFrom: 'app' } }),
            encrypted('a-10', 10, { role: 'agent', content: { type: 'codex', data: { type: 'message' } } }),
        ];
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn().mockReturnValue(true),
            sendSessionEvent: vi.fn(() => { throw new Error('notice unavailable'); }),
        } as any;
        const api = { getSessionMessages: vi.fn().mockResolvedValue(rows) } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .resolves.toBe(1);
        expect(session.injectPendingPersistedUserMessage).toHaveBeenCalledOnce();
    });

    it('HSR fails closed when a full recent window contains no processed-response boundary', async () => {
        const rows = Array.from({ length: 150 }, (_, index) => encrypted(
            `u-${index + 1}`,
            index + 1,
            { role: 'user', content: { type: 'text', text: `message-${index + 1}` }, meta: { sentFrom: 'app' } },
        ));
        const api = { getSessionMessages: vi.fn().mockResolvedValue(rows) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
        expect(session.injectPendingPersistedUserMessage).not.toHaveBeenCalled();
    });

    it('HSR rejects conflicting persisted message identities during restore', async () => {
        const first = encrypted('same', 11, { role: 'user', content: { type: 'text', text: 'first' }, meta: { sentFrom: 'app' } });
        const second = encrypted('same', 12, { role: 'user', content: { type: 'text', text: 'second' }, meta: { sentFrom: 'app' } });
        const api = { getSessionMessages: vi.fn().mockResolvedValue([first, second]) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
    });

    it('HSR delegates its single query to the ApiClient retry boundary', async () => {
        const api = { getSessionMessages: vi.fn()
            .mockRejectedValueOnce(new Error('session_message_lookup_failed'))
            .mockResolvedValueOnce([]) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
        expect(api.getSessionMessages).toHaveBeenCalledOnce();
    });

    it('HSR fails closed after the bounded restore query attempts are exhausted', async () => {
        const api = { getSessionMessages: vi.fn().mockRejectedValue(new Error('session_message_lookup_failed')) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            getTransportSnapshot: vi.fn().mockReturnValue({ state: 'closed' }),
            injectPendingPersistedUserMessage: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
        expect(api.getSessionMessages).toHaveBeenCalledOnce();
    });
});
