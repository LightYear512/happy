import type { NormalizedMessage } from './typesRaw';

export interface SystemMessageEvent {
    eventId: string;
    timestamp: number;
    message: string;
}

export function createSystemMessage(event: SystemMessageEvent): NormalizedMessage {
    return {
        id: event.eventId,
        localId: null,
        createdAt: event.timestamp,
        role: 'event',
        content: { type: 'message', message: event.message },
        isSidechain: false,
    };
}
