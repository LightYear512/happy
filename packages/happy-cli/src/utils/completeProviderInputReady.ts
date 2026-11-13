import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage } from '@/api/types';
import { logger } from '@/ui/logger';

export interface CompleteProviderInputReadyOptions {
    session: ApiSessionClient;
    expectedHappySessionId: string;
    reconcilePersistedInputs?: boolean;
    providerSessionId?: string;
    expectedProviderSessionId?: string;
    onUserMessage: (message: UserMessage) => void;
    isCancelled?: () => boolean;
}

/**
 * Opens the provider input consumer as soon as the exact identities are known.
 * Historical-message recovery is best-effort follow-up work: a slow or failed
 * query must never make a live provider unavailable to new human input.
 */
export async function completeProviderInputReady(
    options: CompleteProviderInputReadyOptions,
): Promise<void> {
    if (options.isCancelled?.()) throw new Error('Provider startup cancelled');
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
    if (options.isCancelled?.()) throw new Error('Provider startup cancelled');
    options.session.enableDaemonSessionTracking(options.providerSessionId);

    if (options.expectedProviderSessionId !== undefined) {
        // Restore preserves the provider identity, but not the old process's
        // archived lifecycle/PID. Refresh those projections after readiness;
        // a lost metadata ACK must never fail a usable restored provider.
        void options.session.updateMetadata((metadata) => {
            if (options.isCancelled?.() || metadata.claudeSessionId !== options.expectedProviderSessionId) {
                return metadata;
            }
            const { archivedBy: _archivedBy, archiveReason: _archiveReason, ...retained } = metadata;
            return {
                ...retained,
                hostPid: process.pid,
                lifecycleState: 'running',
                lifecycleStateSince: metadata.lifecycleState === 'running'
                    ? metadata.lifecycleStateSince : Date.now(),
            };
        }, { rejectOnServerError: true }).catch(() => {
            logger.debug('[ProviderReady] Restored lifecycle refresh failed; input remains ready');
        });
    }
}
