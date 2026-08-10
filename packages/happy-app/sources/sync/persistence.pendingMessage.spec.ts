import { beforeEach, describe, expect, it, vi } from 'vitest';

const { values } = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string): string | undefined {
            return values.get(key);
        }

        set(key: string, value: string): void {
            values.set(key, value);
        }

        delete(key: string): void {
            values.delete(key);
        }
    },
}));

import {
    clearPendingSessionMessage,
    loadPendingSessionMessages,
    savePendingSessionMessage,
} from './persistence';

describe('pending session message persistence', () => {
    beforeEach(() => values.clear());

    it('stores encrypted submissions per session without plaintext', () => {
        savePendingSessionMessage('session-1', {
            localId: 'local-1',
            encryptedRecord: 'ciphertext',
            createdAt: 1_000,
        });

        expect(loadPendingSessionMessages()).toEqual({
            'session-1': [{ localId: 'local-1', encryptedRecord: 'ciphertext', createdAt: 1_000 }],
        });
        expect(values.get('pending-session-messages-v1')).not.toContain('plain text');
    });

    it('keeps concurrent submissions and clears only the confirmed localId', () => {
        savePendingSessionMessage('session-1', {
            localId: 'local-1', encryptedRecord: 'ciphertext-1', createdAt: 1_000,
        });
        savePendingSessionMessage('session-2', {
            localId: 'local-2', encryptedRecord: 'ciphertext-2', createdAt: 2_000,
        });
        savePendingSessionMessage('session-1', {
            localId: 'local-3', encryptedRecord: 'ciphertext-3', createdAt: 3_000,
        });
        clearPendingSessionMessage('session-1', 'local-3');

        expect(loadPendingSessionMessages()).toEqual({
            'session-1': [{ localId: 'local-1', encryptedRecord: 'ciphertext-1', createdAt: 1_000 }],
            'session-2': [{ localId: 'local-2', encryptedRecord: 'ciphertext-2', createdAt: 2_000 }],
        });
    });

    it('upgrades the original one-object format without losing the pending input', () => {
        values.set('pending-session-messages-v1', JSON.stringify({
            'session-1': { localId: 'local-1', encryptedRecord: 'ciphertext', createdAt: 1_000 },
        }));

        expect(loadPendingSessionMessages()).toEqual({
            'session-1': [{ localId: 'local-1', encryptedRecord: 'ciphertext', createdAt: 1_000 }],
        });
    });

    it('rejects malformed stored state instead of returning forged submissions', () => {
        values.set('pending-session-messages-v1', JSON.stringify({
            'session-1': { localId: '', encryptedRecord: 12, createdAt: -1 },
        }));

        expect(loadPendingSessionMessages()).toEqual({});
    });
});
