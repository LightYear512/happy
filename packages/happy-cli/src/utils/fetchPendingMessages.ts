import { decrypt, decodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';

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
    for (const pm of pendingMessages) {
        logger.debug(`${logPrefix} Injecting pending message from restore: "${pm.message.content?.text?.substring(0, 50)}"`);
        session.injectPendingMessage(pm.message);
    }
    if (pendingMessages.length > 0) {
        logger.debug(`${logPrefix} Injected ${pendingMessages.length} pending message(s) from restore`);
    }
    return pendingMessages.length;
}
