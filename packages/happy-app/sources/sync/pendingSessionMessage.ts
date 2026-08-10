import type { PendingSessionMessage } from './persistence';

export type MessagePersistenceAck =
    | { ok: true; id: string; seq: number; localId: string; createdAt: number }
    | { ok: false; code: 'invalid' | 'not_found' | 'internal' };
export type MessagePersistenceReceipt = Extract<MessagePersistenceAck, { ok: true }>;

export const TERMINAL_MESSAGE_PERSISTENCE_ERRORS = new Set(['invalid', 'not_found']);

export class MessagePersistenceError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
    }
}

export async function submitPendingSessionMessageAttempt(
    sessionId: string,
    pending: PendingSessionMessage,
    emit: (event: string, data: unknown, timeoutMs: number) => Promise<MessagePersistenceAck>,
): Promise<MessagePersistenceReceipt> {
    const receipt = await emit('message', {
        sid: sessionId,
        message: pending.encryptedRecord,
        localId: pending.localId,
    }, 5_000);
    if (!receipt || receipt.ok !== true || typeof receipt.id !== 'string'
        || !Number.isSafeInteger(receipt.seq) || receipt.localId !== pending.localId
        || typeof receipt.createdAt !== 'number') {
        throw new MessagePersistenceError(
            receipt && receipt.ok === false
                ? `Message persistence failed: ${receipt.code}`
                : 'Message persistence confirmation is unknown',
            receipt && receipt.ok === false ? receipt.code : undefined,
        );
    }
    return receipt;
}
