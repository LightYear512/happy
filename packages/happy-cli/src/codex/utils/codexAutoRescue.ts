/**
 * Recover unusable Codex context through the existing local compaction path.
 * A fresh thread must complete a turn before another automatic rescue is
 * allowed; elapsed time alone must never restart a persistent failure loop.
 */

import { extractCodexErrorDetail } from './codexErrorDetail';

const COMPACT_FAILURE_NEEDLE = 'error running remote compact task';

export function shouldAutoRescue(params: unknown): boolean {
    if (!params || typeof params !== 'object') return false;
    const record = params as Record<string, unknown>;
    if (record.willRetry === true) return false;

    const detail = extractCodexErrorDetail(params).toLowerCase();
    return detail.includes(COMPACT_FAILURE_NEEDLE) || hasInvalidEncryptedContent(record);
}

function hasInvalidEncryptedContent(value: unknown, depth = 0): boolean {
    if (depth > 6) return false;
    if (typeof value === 'string') {
        // Native Codex wraps the upstream API error JSON in error.message.
        try { return hasInvalidEncryptedContent(JSON.parse(value), depth + 1); }
        catch { return false; }
    }
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.code === 'invalid_encrypted_content'
        || ['error', 'turn', 'message'].some((key) => hasInvalidEncryptedContent(record[key], depth + 1));
}

export function createRescueGate(): { tryClaim(): boolean; resetAfterSuccess(): void } {
    let claimed = false;
    return {
        tryClaim(): boolean {
            if (claimed) return false;
            claimed = true;
            return true;
        },
        resetAfterSuccess(): void {
            claimed = false;
        },
    };
}
