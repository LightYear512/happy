import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerSessionTransportFatalHandler } from './registerSessionTransportFatalHandler';
import type { SessionTransportSnapshot } from './apiSession';

const SNAPSHOT: SessionTransportSnapshot = {
    state: 'ownership_conflict',
    reconnectCount: 1,
    queueMessages: 0,
    queueBytes: 0,
    reason: 'io server disconnect',
};

describe('registerSessionTransportFatalHandler', () => {
    it('requests shutdown once and can be detached', async () => {
        const session = new EventEmitter();
        const shutdown = vi.fn(async () => {});
        const remove = registerSessionTransportFatalHandler(session, shutdown);

        session.emit('transport-fatal', SNAPSHOT);
        session.emit('transport-fatal', SNAPSHOT);
        await Promise.resolve();
        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(shutdown).toHaveBeenCalledWith(SNAPSHOT);

        remove();
        session.emit('transport-fatal', SNAPSHOT);
        await Promise.resolve();
        expect(shutdown).toHaveBeenCalledTimes(1);
    });
});
