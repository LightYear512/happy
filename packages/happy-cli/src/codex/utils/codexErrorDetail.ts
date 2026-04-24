/**
 * Extract a human-readable detail string from a Codex app-server `error`
 * notification payload. Codex wraps errors in nested shapes like
 * `{error: {message, additionalDetails, codexErrorInfo}}` or
 * `{turn: {error: {...}}}`, so naive string interpolation produces
 * `[object Object]` on the app side.
 *
 * Aligned with happier reference impl:
 * `apps/cli/src/backends/codex/appServer/runtime.ts::readCodexAppServerErrorMessage`.
 */

function readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function trimString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable error object]';
    }
}

/**
 * Format a detail string for user-visible UI, avoiding double "Error:" /
 * "Codex error:" prefixes when the detail already carries one. Aligned with
 * happier `runtime.ts::formatCodexAppServerErrorForUi` (apps/cli/src/backends/codex/appServer/).
 */
export function formatCodexErrorForUi(detail: string): string {
    const trimmed = detail.trim();
    if (!trimmed) return 'Codex error';
    return /^(codex\s+)?error[:\s]/i.test(trimmed) ? trimmed : `Codex error: ${trimmed}`;
}

export function extractCodexErrorDetail(params: unknown): string {
    const record = readRecord(params);
    if (!record) {
        if (typeof params === 'string' && params.trim().length > 0) return params.trim();
        return 'unknown';
    }

    const directError = readRecord(record.error);
    const turn = readRecord(record.turn);
    const turnError = readRecord(turn?.error);
    const error = directError ?? turnError;

    if (error) {
        const message = trimString(error.message);
        const additional = trimString(error.additionalDetails ?? error.additional_details);
        if (message && additional) return `${message}\n\n${additional}`;
        if (message) return message;
        if (additional) return additional;
        return safeStringify(error);
    }

    if (typeof record.error === 'string') {
        const s = record.error.trim();
        if (s.length > 0) return s;
    }

    const topMessage = trimString(record.message);
    if (topMessage) return topMessage;

    return 'unknown';
}
