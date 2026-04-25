/**
 * Turn lifecycle for codex app-server runtime.
 *
 * `finish()` is the single exit for a pending turn — every terminal signal
 * (turn/completed, turn/interrupted, error notification, turn/start RPC
 * failure) must route through it so awaiters never hang. Repeated calls
 * are no-ops.
 *
 * Error notifications resolve (not reject): the error has already been
 * surfaced via the session event stream, so the promise channel only needs
 * to express "settled". Only `turn/start` RPC failure rejects, so the
 * turn-loop catch block can build a user-visible error message.
 */

export interface TurnLifecycle {
    readonly current: Promise<void> | null;
    begin(): void;
    finish(error?: Error): void;
}

export function createTurnLifecycle(): TurnLifecycle {
    let promise: Promise<void> | null = null;
    let resolveFn: (() => void) | null = null;
    let rejectFn: ((error: Error) => void) | null = null;

    return {
        get current() {
            return promise;
        },
        begin(): void {
            promise = new Promise<void>((resolve, reject) => {
                resolveFn = resolve;
                rejectFn = reject;
            });
        },
        finish(error?: Error): void {
            if (error && rejectFn) {
                rejectFn(error);
            } else if (resolveFn) {
                resolveFn();
            }
            resolveFn = null;
            rejectFn = null;
            promise = null;
        },
    };
}
