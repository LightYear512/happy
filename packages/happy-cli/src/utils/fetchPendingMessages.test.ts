import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import { fetchAndInjectPendingMessages } from './fetchPendingMessages';

const key = new Uint8Array(32);
const encrypted = (id: string, seq: number, body: unknown, createdAt = Date.now() - 10_000) => ({
    id,
    seq,
    localId: null,
    createdAt,
    content: { t: 'encrypted', c: encodeBase64(encrypt(key, 'legacy', body)) },
});

describe('fetchAndInjectPendingMessages', () => {
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
            markRestoreRecoveryFailed: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .resolves.toBe(2);
        expect(injected).toEqual([11, 12]);
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
            markRestoreRecoveryFailed: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
        expect(session.injectPendingPersistedUserMessage).not.toHaveBeenCalled();
        expect(session.markRestoreRecoveryFailed).toHaveBeenCalledOnce();
    });

    it('HSR rejects conflicting persisted message identities during restore', async () => {
        const first = encrypted('same', 11, { role: 'user', content: { type: 'text', text: 'first' }, meta: { sentFrom: 'app' } });
        const second = encrypted('same', 12, { role: 'user', content: { type: 'text', text: 'second' }, meta: { sentFrom: 'app' } });
        const api = { getSessionMessages: vi.fn().mockResolvedValue([first, second]) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn(),
            markRestoreRecoveryFailed: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
        expect(session.markRestoreRecoveryFailed).toHaveBeenCalledOnce();
    });

    it('HSR makes a restore query failure terminal and observable without injecting partial work', async () => {
        const api = { getSessionMessages: vi.fn().mockRejectedValue(new Error('session_message_lookup_failed')) } as any;
        const session = {
            waitForConnect: vi.fn().mockResolvedValue(undefined),
            injectPendingPersistedUserMessage: vi.fn(),
            markRestoreRecoveryFailed: vi.fn(),
        } as any;

        await expect(fetchAndInjectPendingMessages(api, session, 'session-1', key, 'legacy', '[test]'))
            .rejects.toThrow(/recovery_incomplete/);
        expect(session.injectPendingPersistedUserMessage).not.toHaveBeenCalled();
        expect(session.markRestoreRecoveryFailed).toHaveBeenCalledOnce();
    });
});
