import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage } from '@/api/types';

export interface CompleteProviderInputReadyOptions {
    session: ApiSessionClient;
    expectedHappySessionId: string;
    reconcilePersistedInputs?: boolean;
    providerSessionId?: string;
    expectedProviderSessionId?: string;
    onUserMessage: (message: UserMessage) => void;
}

/**
 * Opens the provider input consumer as soon as the exact identities are known.
 * Historical-message recovery is best-effort follow-up work: a slow or failed
 * query must never make a live provider unavailable to new human input.
 */
export async function completeProviderInputReady(
    options: CompleteProviderInputReadyOptions,
): Promise<void> {
    if (options.session.sessionId !== options.expectedHappySessionId) {
        throw new Error('Happy session identity changed before provider readiness');
    }
    if (options.expectedProviderSessionId !== undefined &&
        options.providerSessionId !== options.expectedProviderSessionId) {
        throw new Error('Provider session identity changed before provider readiness');
    }

    options.session.onUserMessage(options.onUserMessage);
    if (options.reconcilePersistedInputs) {
        void options.session.reconcilePersistedInputs('restore');
    }
    // An exact restore identity is already persisted by the Server. Rewriting
    // it here adds an acknowledgement gate after provider resume and can kill
    // an otherwise usable restored process when that redundant ACK is lost.
    if (options.providerSessionId && options.expectedProviderSessionId === undefined) {
        await options.session.updateMetadata((metadata) => ({
            ...metadata,
            hostPid: process.pid,
            claudeSessionId: options.providerSessionId,
        }), { rejectOnServerError: true });
    }
    options.session.enableDaemonSessionTracking(options.providerSessionId);

}
