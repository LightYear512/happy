import { describe, expect, it } from 'vitest';
import { createSystemMessage } from './systemMessage';

describe('createSystemMessage', () => {
    it('adapts a server fallback to the existing gray agent-event reducer path', () => {
        expect(createSystemMessage({ eventId: 'event-1', timestamp: 123, message: 'visible error' }))
            .toEqual({ id: 'event-1', localId: null, createdAt: 123, role: 'event',
                content: { type: 'message', message: 'visible error' }, isSidechain: false });
    });
});
