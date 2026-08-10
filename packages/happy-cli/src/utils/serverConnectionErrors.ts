/** Shared classification and one-shot console warning for Server failures. */
import chalk from 'chalk';

// ============================================================================
// Connection State - Simple state machine for offline status with deduplication
// ============================================================================

/** All network error codes that trigger offline mode */
export const NETWORK_ERROR_CODES = [
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT',
    'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'
] as const;

/** Check if error code indicates server unreachable */
export function isNetworkError(code: string | undefined): boolean {
    return code !== undefined && (NETWORK_ERROR_CODES as readonly string[]).includes(code);
}

/** Maps error codes to human-readable descriptions - exported for discoverability */
export const ERROR_DESCRIPTIONS: Record<string, string> = {
    // Network errors (Node.js)
    ECONNREFUSED: 'server not accepting connections',
    ENOTFOUND: 'server hostname not found',
    ETIMEDOUT: 'connection timed out',
    ECONNRESET: 'connection reset by server',
    EHOSTUNREACH: 'server host unreachable',
    ENETUNREACH: 'network unreachable',
    // HTTP errors
    '401': 'authentication failed - run `happy auth`',
    '403': 'access forbidden',
    '404': 'endpoint not found, check server deployment',
    '500': 'server internal error',
    '502': 'bad gateway',
    '503': 'service unavailable',
};

/** Failure context for accumulating multiple failures into one warning */
export type OfflineFailure = {
    operation: string;
    caller?: string;
    errorCode?: string;
    url?: string;
    details?: string[];  // Additional context lines, each printed on new line with arrow
};

/**
 * Coordinates offline warnings across multiple API callers.
 *
 * When server goes down, session + machine API calls both fail. This class
 * consolidates those into one clear message with all failure details, then
 * suppresses duplicates until recovery. Call recover() when back online to
 * re-enable warnings for future disconnections.
 */
class OfflineState {
    private state: 'online' | 'offline' = 'online';
    private failures = new Map<string, OfflineFailure>(); // Dedupe by operation
    private backend = 'Claude';

    /** Report failure - accumulates context, prints once on first offline transition */
    fail(failure: OfflineFailure): void {
        this.failures.set(failure.operation, failure);
        if (this.state === 'online') {
            this.state = 'offline';
            this.print();
        }
    }

    /** Reset on reconnection */
    recover(): void {
        this.state = 'online';
        this.failures.clear();
    }

    /** Set backend name before API calls */
    setBackend(name: string): void { this.backend = name; }

    /** Check current state */
    isOffline(): boolean { return this.state === 'offline'; }

    /** Reset for testing - clears all state */
    reset(): void {
        this.state = 'online';
        this.failures.clear();
        this.backend = 'Claude';
    }

    private print(): void {
        const summary = [...this.failures.values()]
            .map(f => {
                const desc = f.errorCode
                    ? `${f.errorCode} - ${ERROR_DESCRIPTIONS[f.errorCode] || 'unknown error'}`
                    : 'unknown error';
                const url = f.url ? ` at ${f.url}` : '';
                return `${f.operation} failed: ${desc}${url}`;
            })
            .join('; ');
        console.log(`⚠️  Happy server unreachable; running locally without automatic session-create retry - error details: ${summary}`);

        // Print detail lines if present - consistent 3-space indent with arrow
        const allDetails = [...this.failures.values()]
            .flatMap(f => f.details || []);
        allDetails.forEach(line => console.log(chalk.yellow(`   → ${line}`)));
    }
}

/**
 * Shared singleton - call setBackend() before API calls, fail() on errors,
 * recover() on successful reconnection.
 */
export const connectionState = new OfflineState();

/**
 * @deprecated Use connectionState.fail() for deduplication and context tracking
 */
export function printOfflineWarning(backendName: string = 'Claude'): void {
    connectionState.setBackend(backendName);
    connectionState.fail({ operation: 'Server connection' });
}
