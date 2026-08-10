import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage } from '@/api/types';

export interface CompleteProviderInputReadyOptions {
    session: ApiSessionClient;
    expectedHappySessionId: string;
    pendingWindow?: Promise<unknown> | (() => Promise<unknown>);
    providerSessionId?: string;
    expectedProviderSessionId?: string;
    onUserMessage: (message: UserMessage) => void;
}

/**
 * Merges the optional restore window before opening the input consumer. For a
 * fresh session the consumer is installed immediately; provider metadata and
 * daemon bookkeeping cannot delay acceptance of the first human input.
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

    const pendingWindow = typeof options.pendingWindow === 'function'
        ? options.pendingWindow()
        : options.pendingWindow;
    await (pendingWindow ?? Promise.resolve());
    options.session.onUserMessage(options.onUserMessage);
    if (options.providerSessionId) {
        await options.session.updateMetadata((metadata) => ({
            ...metadata,
            hostPid: process.pid,
            claudeSessionId: options.providerSessionId,
        }), { rejectOnServerError: true });
    }
    options.session.enableDaemonSessionTracking(options.providerSessionId);
}
