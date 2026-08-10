import { decrypt, decodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { UserMessageSchema, modelFacingUserText, type UserMessage } from '@/api/types';
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
    options?: { deferInjection?: boolean },
): Promise<number | (() => number)> {
    let rawMessages: Awaited<ReturnType<ApiClient['getSessionMessages']>>;
    try {
        await session.waitForConnect();
        rawMessages = await api.getSessionMessages(sessionId);
    } catch {
        throw new SessionRecoveryError('pending-message restore query failed');
    }

    const inject = (): number => {
      try {
        const fullWindow = Array.isArray(rawMessages) && rawMessages.length === RECENT_MESSAGE_WINDOW;
        const rows = validateRecentMessageWindow(rawMessages);
        const pendingRows: Array<{
            message: UserMessage;
            seq: number;
            row: typeof rows[number];
        }> = [];
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
            pendingRows.push({ message: parsed.data, seq: row.seq, row });
        }

        if (fullWindow && !processedResponseBoundaryFound) {
            throw new SessionRecoveryError('full recent message window contains no processed-response boundary');
        }

        pendingRows.sort((left, right) => left.seq - right.seq);
        let injectedCount = 0;
        for (const pending of pendingRows) {
            logger.debug(`${logPrefix} Injecting pending message from restore: "${modelFacingUserText(pending.message).substring(0, 50)}"`);
            if (session.injectPendingPersistedUserMessage(pending.row)) injectedCount += 1;
        }
        if (injectedCount > 0) {
            logger.debug(`${logPrefix} Injected ${injectedCount} pending message(s) from restore`);
            try {
                session.sendSessionEvent({
                    type: 'message',
                    message: '⚠️ 正在恢复进程异常退出前未确认完成的输入；该输入可能已部分执行，本次按 at-least-once 语义重新提交。',
                });
            } catch (noticeError) {
                logger.debug(`${logPrefix} Restore notice could not be sent`, noticeError);
            }
        }
        return injectedCount;
      } catch (error) {
        const recoveryError = error instanceof SessionRecoveryError
            ? error
            : new SessionRecoveryError('pending-message restore query failed');
        throw recoveryError;
      }
    };
    return options?.deferInjection ? inject : inject();
}
