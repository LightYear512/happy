import { decrypt, decodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';

const RESTORE_BANG_DUPLICATE_WINDOW_MS = 15_000;

function restoreBangDedupeKey(message: any): string {
    const text = message?.content?.type === 'text' && typeof message.content.text === 'string'
        ? message.content.text.trim()
        : '';
    if (!text || !/^[!@]/.test(text)) return '';
    return text;
}

export function dedupePendingRestoreMessages<T extends { message: any, createdAt: number }>(messages: T[]): T[] {
    const kept: T[] = [];
    const lastByKey = new Map<string, number>();
    for (const message of messages) {
        const key = restoreBangDedupeKey(message.message);
        if (key) {
            const lastAt = lastByKey.get(key);
            if (lastAt !== undefined && Math.abs(message.createdAt - lastAt) <= RESTORE_BANG_DUPLICATE_WINDOW_MS) {
                logger.debug(`[restore] Skipping duplicate pending bang message: "${key.substring(0, 50)}"`);
                continue;
            }
            lastByKey.set(key, message.createdAt);
        }
        kept.push(message);
    }
    return kept;
}

/**
 * After a session restore, fetch user messages that arrived while the CLI was offline
 * (between session close and this CLI reconnecting). These trigger messages are stored
 * in the DB but were broadcast before this CLI connected its socket.
 *
 * Messages are ordered by createdAt desc from the API. We scan from newest to oldest,
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
    const connectTime = Date.now();
    await session.waitForConnect();
    const rawMessages = await api.getSessionMessages(sessionId);
    const pendingMessages: { message: any, createdAt: number }[] = [];
    for (const rawMsg of rawMessages) {
        if (rawMsg.createdAt >= connectTime) continue; // Will arrive via real-time socket
        if (!(rawMsg.content && typeof rawMsg.content === 'object' && 'c' in rawMsg.content && rawMsg.content.t === 'encrypted')) continue;
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(rawMsg.content.c as string));
        if (!decrypted) continue;
        // Stop at first AI reply — everything before was already handled.
        // Skip event messages (ready/switch/message) as they don't indicate a processed user message.
        if (decrypted.role === 'agent' && decrypted.content?.type !== 'event') break;
        if (decrypted.role === 'user' && decrypted.meta?.sentFrom !== 'cli') {
            pendingMessages.push({ message: decrypted, createdAt: rawMsg.createdAt });
        }
    }
    // Inject in chronological order (API returns desc, we need asc)
    pendingMessages.reverse();
    const dedupedMessages = dedupePendingRestoreMessages(pendingMessages);
    for (const pm of dedupedMessages) {
        logger.debug(`${logPrefix} Injecting pending message from restore: "${pm.message.content?.text?.substring(0, 50)}"`);
        session.injectPendingMessage(pm.message);
    }
    if (dedupedMessages.length > 0) {
        logger.debug(`${logPrefix} Injected ${dedupedMessages.length} pending message(s) from restore`);
    }
    return dedupedMessages.length;
}
