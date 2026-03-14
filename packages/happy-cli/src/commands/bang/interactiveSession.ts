import { logger } from '@/ui/logger';

/**
 * Lightweight interactive session manager.
 *
 * When a bang command needs multi-turn interaction (e.g., !auth create login flow),
 * it registers an input handler here. All subsequent user messages are routed to
 * this handler until the session completes, bypassing Claude and bang dispatch.
 */

type InputHandler = (text: string) => void;

let handler: InputHandler | null = null;

/** Check if there's an active interactive session capturing user input. */
export function hasActiveInteractiveSession(): boolean {
    return handler !== null;
}

/** Route user input to the active interactive session. */
export function handleInteractiveInput(text: string): void {
    if (handler) {
        logger.debug('[interactive] Routing input to active session');
        handler(text);
    }
}

/** Register an input handler for an interactive session. */
export function registerInteractiveSession(inputHandler: InputHandler): void {
    handler = inputHandler;
    logger.debug('[interactive] Session registered');
}

/** Unregister the current interactive session. */
export function unregisterInteractiveSession(): void {
    handler = null;
    logger.debug('[interactive] Session unregistered');
}
