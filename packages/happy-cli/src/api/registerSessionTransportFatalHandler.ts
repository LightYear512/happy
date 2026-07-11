import type { SessionTransportSnapshot } from './apiSession';
import { logger } from '@/ui/logger';

interface FatalTransportSource {
    on(event: 'transport-fatal', listener: (snapshot: SessionTransportSnapshot) => void): unknown;
    off(event: 'transport-fatal', listener: (snapshot: SessionTransportSnapshot) => void): unknown;
}

/** Converts a terminal transport into one idempotent provider shutdown. */
export function registerSessionTransportFatalHandler(
    session: FatalTransportSource,
    shutdown: (snapshot: SessionTransportSnapshot) => Promise<void> | void,
): () => void {
    let shutdownStarted = false;
    const listener = (snapshot: SessionTransportSnapshot) => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        void Promise.resolve(shutdown(snapshot)).catch((error) => {
            logger.debug('[API] Fatal transport shutdown failed', error);
        });
    };

    session.on('transport-fatal', listener);
    return () => session.off('transport-fatal', listener);
}
