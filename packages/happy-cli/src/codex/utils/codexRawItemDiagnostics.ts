/** Opt-in observation at the native app-server boundary; never repairs or replays history. */
import { createHash } from 'node:crypto';
import { diagnosticTrace } from '@/ui/logger';

const NORMAL_SAMPLE_LIMIT = 16;
const GENERIC_ID_SAMPLE_LIMIT = 128;
const MAX_IDENTIFIER_LENGTH = 256;
const ITEM_TYPES = new Set([
    'message', 'agent_message', 'reasoning', 'function_call', 'function_call_output',
    'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'tool_search_call',
    'tool_search_output', 'web_search_call', 'image_generation_call', 'compaction',
    'configuration_update', 'compaction_trigger', 'context_compaction',
]);
const ID_PREFIXES = ['item_', 'fc_', 'rs_', 'msg_', 'ctc_', 'fco_', 'ctco_'];
const TOOL_NAMES = new Set([
    'send_message', 'list_agents', 'wait_agent', 'followup_task', 'spawn_agent',
    'wait', 'sleep', 'request_user_input_async',
]);

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): { prefix: string; length: number; sha256: string | null } {
    if (typeof value !== 'string') return { prefix: 'absent', length: 0, sha256: null };
    return {
        prefix: ID_PREFIXES.find((prefix) => value.startsWith(prefix)) ?? 'other',
        length: value.length,
        // Do not hash arbitrarily large provider fields or retain their contents.
        sha256: value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
            ? createHash('sha256').update(value).digest('hex') : null,
    };
}

/**
 * Selection is fixed for this Happy runtime, including account swaps. The flag
 * must equal its exact Happy session ID, not "1" or a native thread ID.
 * Separate finite budgets reserve evidence for item_* after normal samples fill.
 * These categories describe observed strings, not a Responses schema validator.
 */
export function createCodexRawItemDiagnostics(sessionId: string): (params: unknown) => void {
    let enabled = !!sessionId && process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION === sessionId;
    let normalSamples = 0;
    let genericSamples = 0;

    return (params: unknown): void => {
        if (!enabled || (normalSamples >= NORMAL_SAMPLE_LIMIT && genericSamples >= GENERIC_ID_SAMPLE_LIMIT)) return;
        try {
            const notification = record(params);
            const item = record(notification?.item);
            if (!item) return;
            const rawId = item.id;
            const genericId = typeof rawId === 'string' && rawId.startsWith('item_');
            // Admission happens before formatting, hashing or scheduling any I/O.
            if (genericId) {
                if (genericSamples >= GENERIC_ID_SAMPLE_LIMIT) return;
                genericSamples += 1;
            } else {
                if (normalSamples >= NORMAL_SAMPLE_LIMIT) return;
                normalSamples += 1;
            }
            const type = item.type;
            const name = item.name;
            const namespace = item.namespace;
            diagnosticTrace('[CODEX_RAW_ITEM]', {
                sessionSha256: identifier(sessionId).sha256,
                threadSha256: identifier(notification?.threadId).sha256,
                turnSha256: identifier(notification?.turnId).sha256,
                sequence: normalSamples + genericSamples,
                itemType: typeof type === 'string' && type.length <= 64 && ITEM_TYPES.has(type) ? type : 'other',
                id: identifier(rawId),
                callSha256: identifier(item.call_id).sha256,
                namespace: namespace === 'collaboration' || namespace === 'functions' || namespace === 'clock'
                    ? namespace : 'other',
                tool: typeof name === 'string' && name.length <= 64 && TOOL_NAMES.has(name) ? name : 'other',
                encryptedContentPresent: typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0,
            });
        } catch {
            // Even extraction failure must not reach app-server's failWith path.
            // Disable only this observer; preserve the original event and handler.
            enabled = false;
        }
    };
}
