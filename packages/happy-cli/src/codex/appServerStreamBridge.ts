/**
 * App-Server Stream Bridge
 *
 * Converts codex app-server notifications into session protocol envelopes
 * (the same format produced by `mapCodexMcpMessageToSessionEnvelopes`),
 * so that `runCodex.ts` can forward them via `session.sendSessionProtocolMessage()`
 * without any changes to the consumer side.
 */

import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type SessionEnvelope } from '@/sessionProtocol/types';
import { logger } from '@/ui/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RecordLike = Record<string, unknown>;

type ToolKind = 'command' | 'mcp' | 'file-change';

type ToolContext = Readonly<{
    toolKind: ToolKind;
    name: string;
    input: unknown;
}>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readText(record: RecordLike, keys: readonly string[]): string | null {
    for (const key of keys) {
        const text = readString(record[key]);
        if (text) return text;
    }
    return null;
}

function normalizeType(value: string | null): string | null {
    if (!value) return null;
    return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function readItem(params: unknown): RecordLike | null {
    const record = asRecord(params);
    if (!record) return null;
    return asRecord(record.item) ?? record;
}

function readItemId(value: RecordLike): string | null {
    return readString(value.itemId) ?? readString(value.id) ?? readString(value.callId) ?? readString(value.call_id);
}

function readItemType(value: RecordLike): string | null {
    return normalizeType(readString(value.type) ?? readString(value.itemType));
}

function omitKeys(value: RecordLike, keys: readonly string[]): RecordLike {
    const next: RecordLike = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!keys.includes(key)) next[key] = entry;
    }
    return next;
}

// ---------------------------------------------------------------------------
// Tool context detection
// ---------------------------------------------------------------------------

function summarizeCommand(command: unknown): string | null {
    if (typeof command === 'string' && command.trim().length > 0) return command;
    if (Array.isArray(command)) {
        const cmd = command.map(v => String(v)).join(' ').trim();
        return cmd.length > 0 ? cmd : null;
    }
    return null;
}

function commandToTitle(command: string | null): string {
    if (!command) return 'Run command';
    const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return `Run \`${short}\``;
}

function patchDescription(changes: unknown): string {
    if (!changes || typeof changes !== 'object') return 'Applying patch';
    const fileCount = Object.keys(changes as RecordLike).length;
    return fileCount === 1 ? 'Applying patch to 1 file' : `Applying patch to ${fileCount} files`;
}

function readToolContextFromItem(item: RecordLike): ToolContext | null {
    const itemType = readItemType(item);

    if (itemType === 'commandexecution') {
        const commandString = readString(item.command);
        const cwd = readString(item.cwd);
        if (!commandString && !cwd) return null;
        // CodexBashView reads `input.parsed_cmd[0]` for display; map codex's
        // `commandActions` into that shape. Also keep `command` as a string[]
        // since the view's fallback calls `command.join(' ')`.
        const commandActions = Array.isArray(item.commandActions) ? item.commandActions : [];
        const parsedCmd = commandActions.map((action) => {
            const actionRecord = asRecord(action);
            const cmd = actionRecord ? readString(actionRecord.command) ?? '' : '';
            const type = actionRecord ? readString(actionRecord.type) ?? 'unknown' : 'unknown';
            return { type, cmd };
        });
        const baseInput = omitKeys(item, ['id', 'itemId', 'type', 'itemType', 'stderr', 'stdout', 'exitCode', 'exit_code', 'status', 'success', 'error']);
        return {
            toolKind: 'command',
            name: 'CodexBash',
            input: {
                ...baseInput,
                command: commandString ? [commandString] : [],
                parsed_cmd: parsedCmd,
            },
        };
    }

    if (itemType === 'filechange') {
        if (!Object.prototype.hasOwnProperty.call(item, 'changes')) return null;
        return {
            toolKind: 'file-change',
            name: 'CodexPatch',
            input: omitKeys(item, ['id', 'itemId', 'type', 'itemType', 'stderr', 'stdout', 'exitCode', 'exit_code', 'status', 'success', 'error']),
        };
    }

    if (itemType === 'mcptoolcall') {
        const server = readString(item.server);
        const tool = readString(item.tool) ?? readString(item.name);
        const name = server && tool ? `mcp__${server}__${tool}` : tool;
        if (!name) return null;
        return {
            toolKind: 'mcp',
            name,
            input: item.arguments ?? item.input ?? {},
        };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AppServerStreamUpdate =
    | { type: 'envelope'; envelope: SessionEnvelope }
    | { type: 'agent-message'; message: string; id?: string }
    | { type: 'reasoning-delta'; delta: string }
    | { type: 'reasoning-final'; text: string }
    | { type: 'turn-diff'; unifiedDiff: string }
    | { type: 'task-started'; turnId: string; modelContextWindow?: number }
    | { type: 'task-complete'; lastAgentMessage?: string }
    | { type: 'turn-aborted' }
    | { type: 'approval-request'; callId: string; toolName: string; input: unknown };

// ---------------------------------------------------------------------------
// Turn-end status resolution
// ---------------------------------------------------------------------------

type TurnEndStatus = 'completed' | 'failed' | 'cancelled';

function pickTurnEndStatus(params: RecordLike, method: string): TurnEndStatus {
    const rawStatus = params.status;
    if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled') return rawStatus;
    if (rawStatus === 'canceled') return 'cancelled';

    if (method === 'turn/interrupted') return 'cancelled';

    if (params.error !== undefined && params.error !== null) return 'failed';
    return 'completed';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppServerStreamBridge(): {
    onNotification: (method: string, params: unknown) => AppServerStreamUpdate[];
    onServerRequest: (method: string, params: unknown) => AppServerStreamUpdate[];
} {
    const toolContextByCallId = new Map<string, ToolContext>();
    let currentTurnId: string | null = null;

    function opts(): { turn?: string } {
        return currentTurnId ? { turn: currentTurnId } : {};
    }

    function rememberToolContext(callId: string, ctx: ToolContext): void {
        toolContextByCallId.set(callId, ctx);
    }

    function resolveToolContext(params: unknown): { callId: string; toolContext: ToolContext } | null {
        const item = readItem(params);
        const record = asRecord(params);
        const callId = item ? readItemId(item) : record ? readItemId(record) : null;
        if (!callId) return null;

        const fromItem = item ? readToolContextFromItem(item) : null;
        if (fromItem) {
            rememberToolContext(callId, fromItem);
            return { callId, toolContext: fromItem };
        }

        const remembered = toolContextByCallId.get(callId);
        if (!remembered) return null;
        return { callId, toolContext: remembered };
    }

    // -------------------------------------------------------------------
    // Notification handler
    // -------------------------------------------------------------------

    function onNotification(method: string, params: unknown): AppServerStreamUpdate[] {
        const record = asRecord(params);
        if (!record) return [];

        // Diagnostic: trace every notification method + item type to verify codex is emitting them
        const itemForLog = asRecord(record.item);
        const itemTypeForLog = itemForLog ? readString(itemForLog.type) : null;
        logger.debug(`[appServerStreamBridge] notification: ${method} itemType=${itemTypeForLog ?? 'none'}`);

        // -- turn/started ------------------------------------------------
        if (method === 'turn/started') {
            const turnId = readString(record.turnId) ?? readString(record.id) ?? createId();
            currentTurnId = turnId;
            toolContextByCallId.clear();

            const envelope = createEnvelope('agent', { t: 'turn-start' }, { turn: turnId });
            const updates: AppServerStreamUpdate[] = [
                { type: 'task-started', turnId, modelContextWindow: typeof record.modelContextWindow === 'number' ? record.modelContextWindow : undefined },
                { type: 'envelope', envelope },
            ];
            return updates;
        }

        // -- turn/completed ----------------------------------------------
        if (method === 'turn/completed') {
            if (!currentTurnId) return [];
            const status = pickTurnEndStatus(record, method);
            const envelope = createEnvelope('agent', { t: 'turn-end', status }, { turn: currentTurnId });

            const lastText = readText(record, ['lastAgentMessage', 'message', 'text']);
            const updates: AppServerStreamUpdate[] = [
                { type: 'envelope', envelope },
                { type: 'task-complete', lastAgentMessage: lastText ?? undefined },
            ];
            currentTurnId = null;
            return updates;
        }

        // -- turn/interrupted --------------------------------------------
        if (method === 'turn/interrupted') {
            if (!currentTurnId) return [];
            const envelope = createEnvelope('agent', { t: 'turn-end', status: 'cancelled' }, { turn: currentTurnId });
            const updates: AppServerStreamUpdate[] = [
                { type: 'envelope', envelope },
                { type: 'turn-aborted' },
            ];
            currentTurnId = null;
            return updates;
        }

        // -- item/agentMessage/delta -------------------------------------
        if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
            const text = readText(record, ['delta', 'text', 'message']);
            const id = readItemId(record) ?? undefined;
            if (!text) return [];
            return [{ type: 'agent-message', message: text, id }];
        }

        // -- item/reasoning/summaryTextDelta -----------------------------
        if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
            const text = readText(record, ['delta', 'text']);
            if (!text) return [];
            return [{ type: 'reasoning-delta', delta: text }];
        }

        // -- turn/diff/updated -------------------------------------------
        if (method === 'turn/diff/updated') {
            const unifiedDiff = readText(record, ['unifiedDiff', 'unified_diff', 'diff']);
            if (!unifiedDiff) return [];
            return [{ type: 'turn-diff', unifiedDiff }];
        }

        // -- item/started ------------------------------------------------
        if (method === 'item/started') {
            const resolved = resolveToolContext(params);
            if (!resolved) return [];

            const { callId, toolContext } = resolved;
            const command = toolContext.toolKind === 'command'
                ? summarizeCommand((toolContext.input as RecordLike | null)?.command)
                : null;

            const title = toolContext.toolKind === 'command'
                ? commandToTitle(command)
                : toolContext.toolKind === 'file-change'
                    ? 'Apply patch'
                    : `${toolContext.name} call`;

            const description = toolContext.toolKind === 'file-change'
                ? patchDescription((toolContext.input as RecordLike | null)?.changes)
                : title;

            const envelope = createEnvelope('agent', {
                t: 'tool-call-start',
                call: callId,
                name: toolContext.name,
                title,
                description,
                args: (toolContext.input && typeof toolContext.input === 'object' && !Array.isArray(toolContext.input)
                    ? toolContext.input
                    : {}) as Record<string, unknown>,
            }, opts());

            return [{ type: 'envelope', envelope }];
        }

        // -- item/completed ----------------------------------------------
        if (method === 'item/completed') {
            const item = readItem(params);
            if (!item) return [];
            const itemId = readItemId(item);
            const itemType = readItemType(item);
            if (!itemId) return [];

            // Agent message completed — emit text envelope
            if (itemType === 'agentmessage' || itemType === 'plan') {
                const text = readText(item, ['text', 'message']);
                if (!text) return [];
                const envelope = createEnvelope('agent', { t: 'text', text }, opts());
                return [{ type: 'envelope', envelope }];
            }

            // Reasoning completed — emit final reasoning
            if (itemType === 'reasoning') {
                const content = Array.isArray(item.content)
                    ? (item.content as unknown[]).filter((e): e is string => typeof e === 'string' && e.length > 0)
                    : [];
                const summary = Array.isArray(item.summary)
                    ? (item.summary as unknown[]).filter((e): e is string => typeof e === 'string' && e.length > 0)
                    : [];
                const text = content.length > 0 ? content.join('\n\n') : (summary.length > 0 ? summary.join('\n\n') : null);
                if (!text) return [];
                return [{ type: 'reasoning-final', text }];
            }

            // Tool completed — emit tool-call-end (and maybe a synthesized tool-call-start if we missed item/started)
            const rememberedCtx = toolContextByCallId.get(itemId) ?? null;
            const synthesizedCtx = rememberedCtx ?? readToolContextFromItem(item);
            if (!synthesizedCtx) return [];
            toolContextByCallId.delete(itemId);

            const updates: AppServerStreamUpdate[] = [];

            // If we never saw item/started for this tool, emit a synthetic tool-call-start first
            if (!rememberedCtx) {
                const command = synthesizedCtx.toolKind === 'command'
                    ? summarizeCommand((synthesizedCtx.input as RecordLike | null)?.command)
                    : null;
                const title = synthesizedCtx.toolKind === 'command'
                    ? commandToTitle(command)
                    : synthesizedCtx.toolKind === 'file-change'
                        ? 'Apply patch'
                        : `${synthesizedCtx.name} call`;
                const description = synthesizedCtx.toolKind === 'file-change'
                    ? patchDescription((synthesizedCtx.input as RecordLike | null)?.changes)
                    : title;

                updates.push({
                    type: 'envelope',
                    envelope: createEnvelope('agent', {
                        t: 'tool-call-start',
                        call: itemId,
                        name: synthesizedCtx.name,
                        title,
                        description,
                        args: (synthesizedCtx.input && typeof synthesizedCtx.input === 'object' && !Array.isArray(synthesizedCtx.input)
                            ? synthesizedCtx.input
                            : {}) as Record<string, unknown>,
                    }, opts()),
                });
            }

            updates.push({
                type: 'envelope',
                envelope: createEnvelope('agent', { t: 'tool-call-end', call: itemId }, opts()),
            });

            return updates;
        }

        logger.debug(`[appServerStreamBridge] unhandled notification: ${method}`);
        return [];
    }

    // -------------------------------------------------------------------
    // Server request handler (approval flows)
    // -------------------------------------------------------------------

    function onServerRequest(method: string, params: unknown): AppServerStreamUpdate[] {
        const record = asRecord(params);
        if (!record) return [];

        const resolved = resolveToolContext(params);
        if (!resolved) return [];

        if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
            return [{
                type: 'approval-request',
                callId: resolved.callId,
                toolName: resolved.toolContext.name,
                input: resolved.toolContext.input,
            }];
        }

        logger.debug(`[appServerStreamBridge] unhandled server request: ${method}`);
        return [];
    }

    return { onNotification, onServerRequest };
}
