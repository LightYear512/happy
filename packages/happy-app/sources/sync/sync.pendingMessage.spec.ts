import { describe, expect, it, vi } from 'vitest';
import {
    submitPendingSessionMessageAttempt,
} from './pendingSessionMessage';

const pending = {
    localId: 'local-1',
    encryptedRecord: 'ciphertext',
    createdAt: 1_000,
};

describe('pending session message submission', () => {
    it('reuses the exact durable localId and enforces the five-second ACK budget', async () => {
        const emit = vi.fn().mockResolvedValue({
            ok: true,
            id: 'server-1',
            seq: 7,
            localId: 'local-1',
            createdAt: 2_000,
        });

        await expect(submitPendingSessionMessageAttempt('session-1', pending, emit))
            .resolves.toMatchObject({ id: 'server-1', localId: 'local-1' });
        expect(emit).toHaveBeenCalledWith('message', {
            sid: 'session-1',
            message: 'ciphertext',
            localId: 'local-1',
        }, 5_000);
    });

    it('rejects a mismatched or malformed receipt without changing the pending identity', async () => {
        const mismatch = vi.fn().mockResolvedValue({
            ok: true,
            id: 'server-1',
            seq: 7,
            localId: 'other',
            createdAt: 2_000,
        });

        await expect(submitPendingSessionMessageAttempt('session-1', pending, mismatch))
            .rejects.toThrow('confirmation is unknown');
        expect(pending.localId).toBe('local-1');
    });

});
