import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupOfflineSession } from './setupOfflineSession';

describe('setupOfflineSession', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('uses a local stub after an unknown create result without scheduling work', () => {
        const api = { sessionSyncClient: vi.fn() } as any;

        const result = setupOfflineSession({ api, sessionTag: 'tag-1', response: null });

        expect(result.isOffline).toBe(true);
        expect(result.session.sessionId).toBe('offline-tag-1');
        expect(api.sessionSyncClient).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('wraps the one successful create result exactly once', () => {
        const session = { sessionId: 'session-1' };
        const response = { id: 'session-1' } as any;
        const api = { sessionSyncClient: vi.fn(() => session) } as any;

        const result = setupOfflineSession({ api, sessionTag: 'tag-1', response });

        expect(result).toEqual({ session, isOffline: false });
        expect(api.sessionSyncClient).toHaveBeenCalledOnce();
        expect(api.sessionSyncClient).toHaveBeenCalledWith(response);
    });
});
