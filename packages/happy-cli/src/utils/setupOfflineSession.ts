import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Session } from '@/api/types';
import { createOfflineSessionStub } from '@/utils/offlineSessionStub';

export interface SetupOfflineSessionOptions {
    api: ApiClient;
    sessionTag: string;
    response: Session | null;
}

export interface SetupOfflineSessionResult {
    session: ApiSessionClient;
    isOffline: boolean;
}

/**
 * Uses the one initial session-creation result. An unknown or failed POST is
 * never replayed in the background because the Server cannot deduplicate a
 * concurrent create atomically.
 */
export function setupOfflineSession(opts: SetupOfflineSessionOptions): SetupOfflineSessionResult {
    if (!opts.response) {
        return {
            session: createOfflineSessionStub(opts.sessionTag),
            isOffline: true,
        };
    }
    return {
        session: opts.api.sessionSyncClient(opts.response),
        isOffline: false,
    };
}
