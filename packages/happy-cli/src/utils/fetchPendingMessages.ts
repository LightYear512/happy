import { decrypt, decodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { UserMessageSchema, type UserMessage } from '@/api/types';
import {
    RECENT_MESSAGE_WINDOW,
    SessionRecoveryError,
    validateRecentMessageWindow,
} from '@/api/sessionMessageRecovery';

/**
 * After a session restore, fetch user messages that arrived while the CLI was offline
 * (between session close and this CLI reconnecting). These trigger messages are stored
 * in the DB but were broadcast before this CLI connected its socket.
 *
 * Messages are validated and ordered by authoritative server sequence. We scan newest to oldest,
 * stopping at the first non-event agent message (everything before it was already processed).
 * Pending user messages are then injected in chronological order.
 */
export async function fetchAndInjectPendingMessages(
    api: ApiClient,
    session: ApiSessionClient,
    sessionId: string,
    encryptionKey: Uint8Array,
    encryptionVariant: 'legacy' | 'dataKey',
    logPrefix: string,
): Promise<number> {
    try {
        await session.waitForConnect();
        const rawMessages = await api.getSessionMessages(sessionId);
        const fullWindow = Array.isArray(rawMessages) && rawMessages.length === RECENT_MESSAGE_WINDOW;
        const rows = validateRecentMessageWindow(rawMessages);
        const pendingMessages: Array<{ message: UserMessage; seq: number; row: typeof rows[number] }> = [];
        let processedResponseBoundaryFound = false;

        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            let decrypted: unknown;
            try {
                decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(row.content.c));
            } catch {
                throw new SessionRecoveryError('persisted restore message cannot be decrypted');
            }
            if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
                throw new SessionRecoveryError('persisted restore message body is invalid');
            }
            const body = decrypted as Record<string, unknown>;
            if (body.role === 'agent') {
                const content = body.content;
                if (!content || typeof content !== 'object' || Array.isArray(content) ||
                    typeof (content as Record<string, unknown>).type !== 'string') {
                    throw new SessionRecoveryError('persisted agent restore message is invalid');
                }
                if ((content as Record<string, unknown>).type !== 'event') {
                    processedResponseBoundaryFound = true;
                    break;
                }
                continue;
            }
            if (body.role !== 'user') {
                throw new SessionRecoveryError('persisted restore message role is invalid');
            }
            const parsed = UserMessageSchema.safeParse(body);
            if (!parsed.success) {
                throw new SessionRecoveryError('persisted user restore message is invalid');
            }
            if (parsed.data.meta?.sentFrom !== 'cli') {
                pendingMessages.push({ message: parsed.data, seq: row.seq, row });
            }
        }

        if (fullWindow && !processedResponseBoundaryFound) {
            throw new SessionRecoveryError('full recent message window contains no processed-response boundary');
        }

        pendingMessages.sort((left, right) => left.seq - right.seq);
        let injectedCount = 0;
        for (const pending of pendingMessages) {
            logger.debug(`${logPrefix} Injecting pending message from restore: "${pending.message.content.text.substring(0, 50)}"`);
            if (session.injectPendingPersistedUserMessage(pending.row)) injectedCount += 1;
        }
        if (injectedCount > 0) {
            logger.debug(`${logPrefix} Injected ${injectedCount} pending message(s) from restore`);
        }
        return injectedCount;
    } catch (error) {
        const recoveryError = error instanceof SessionRecoveryError
            ? error
            : new SessionRecoveryError('pending-message restore query failed');
        session.markRestoreRecoveryFailed(recoveryError);
        throw recoveryError;
    }
}
