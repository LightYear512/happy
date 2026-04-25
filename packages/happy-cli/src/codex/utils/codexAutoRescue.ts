/**
 * Auto-rescue for codex's server-side compaction failures.
 *
 * Codex's `/backend-api/codex/responses/compact` endpoint is unstable on flaky
 * proxies — it emits an `error` notification with `willRetry: false` and a
 * message containing "Error running remote compact task". When we see that
 * signature we trigger our local heuristic /compact so the user doesn't have
 * to retry by hand. The cooldown gate stops failure storms (multiple retries
 * within the same turn) from spawning duplicate rescues.
 */

import { extractCodexErrorDetail } from './codexErrorDetail';

const COMPACT_FAILURE_NEEDLE = 'error running remote compact task';

export function shouldAutoRescue(params: unknown): boolean {
    if (!params || typeof params !== 'object') return false;
    const record = params as Record<string, unknown>;
    if (record.willRetry === true) return false;

    const detail = extractCodexErrorDetail(params).toLowerCase();
    return detail.includes(COMPACT_FAILURE_NEEDLE);
}

export interface RescueGate {
    tryClaim(now: number): boolean;
    /**
     * Roll back the most recent successful claim. Used when the operation that
     * follows tryClaim() fails — we must NOT eat the cooldown for an attempt
     * that never produced any user-visible action, otherwise the next genuine
     * failure within the cooldown window goes un-rescued and the user sees a
     * raw "Codex error: stream disconnected".
     */
    release(): void;
}

export function createRescueGate(cooldownMs: number): RescueGate {
    let lastAt: number | null = null;
    return {
        tryClaim(now: number): boolean {
            if (lastAt !== null && now - lastAt < cooldownMs) return false;
            lastAt = now;
            return true;
        },
        release(): void {
            lastAt = null;
        },
    };
}
