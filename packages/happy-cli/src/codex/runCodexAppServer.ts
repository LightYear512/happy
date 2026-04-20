/**
 * Codex App-Server Runtime
 *
 * Implements the codex app-server JSONRPC lifecycle as an alternative to the
 * MCP-based `runCodex`.  The app-server protocol gives us first-class support
 * for approval-request responses, unified diff streaming, and proper turn
 * management — none of which are available through the MCP transport.
 *
 * The public surface mirrors `runCodex` so that callers (daemon, terminal)
 * don't need to know which backend is in use.
 */

import { render } from 'ink';
import React from 'react';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import { projectPath } from '@/projectPath';
import { fetchAndInjectPendingMessages } from '@/utils/fetchPendingMessages';
import { registerShutdownHandlers } from '@/utils/shutdownHandlers';
import { createCodexAppServerClient, type CodexAppServerClient } from './codexAppServerClient';
import { createAppServerStreamBridge, type AppServerStreamUpdate } from './appServerStreamBridge';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { systemPrompt } from '@/claude/utils/systemPrompt';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { readCodexDefaultProfile, getCodexInstancePath, getCurrentCodexProfile } from '@/commands/bang/ccsProfiles';
import { watchCodexProfileFile } from '@/commands/bang/authCommand';
import type { FSWatcher } from 'node:fs';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { emitReadyIfIdle } from './runCodex';
import type { PermissionResult } from './utils/permissionHandler';
import type { ApiSessionClient } from '@/api/apiSession';
import type { EnhancedMode as ClaudeEnhancedMode } from '@/claude/loop';
import {
    isBangCommand,
    executeBangCommand,
    hasActiveInteractiveSession,
    handleInteractiveInput,
    buildSessionWelcome,
} from '@/commands/bang/dispatcher';

// ---------------------------------------------------------------------------
// Types (mirrors runCodex.ts)
// ---------------------------------------------------------------------------

type PermissionMode = import('@/api/types').PermissionMode;

interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
}

// ---------------------------------------------------------------------------
// Helpers – thread / turn id extraction (same pattern as happier runtime)
// ---------------------------------------------------------------------------

type ThreadLikeResponse = Readonly<{
    threadId?: unknown;
    id?: unknown;
    thread?: Readonly<{ id?: unknown; threadId?: unknown }> | null;
}>;

type TurnLikeResponse = Readonly<{
    turnId?: unknown;
    id?: unknown;
    turn?: Readonly<{ id?: unknown; turnId?: unknown }> | null;
}>;

function readThreadId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as ThreadLikeResponse;
    const candidates = [r.threadId, r.id, r.thread?.threadId, r.thread?.id];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    }
    return null;
}

function readTurnId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as TurnLikeResponse;
    const candidates = [r.turnId, r.id, r.turn?.turnId, r.turn?.id];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    }
    return null;
}

// ---------------------------------------------------------------------------
// Map PermissionResult → app-server decision payload
// ---------------------------------------------------------------------------

/**
 * Convert a sandbox mode string (used by MCP `codex` tool) into the
 * internally-tagged-enum `SandboxPolicy` object required by the app-server
 * `turn/start` RPC. See happier's `resolveCodexAppServerPolicyForPermissionMode`.
 */
function toSandboxPolicy(sandbox: string, directory: string): Record<string, unknown> {
    if (sandbox === 'workspace-write') {
        return {
            type: 'workspaceWrite',
            writableRoots: [directory],
            readOnlyAccess: { type: 'fullAccess' },
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        };
    }
    if (sandbox === 'danger-full-access') {
        return { type: 'dangerFullAccess' };
    }
    return { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: true };
}

/**
 * Convert an approval policy string into the app-server-native form.
 * `'never'` stays as a string; other policies become a `granular` object that
 * explicitly enables RPC-based approvals (so codex sends
 * `item/commandExecution/requestApproval` instead of waiting for TUI input).
 * See happier's `resolveCodexAppServerPolicyForPermissionMode`.
 */
function toApprovalPolicy(approvalPolicy: string): string | Record<string, unknown> {
    if (approvalPolicy === 'never') {
        return 'never';
    }
    return {
        granular: {
            mcp_elicitations: true,
            rules: true,
            sandbox_approval: true,
        },
    };
}

function mapPermissionDecision(result: PermissionResult): Record<string, unknown> {
    switch (result.decision) {
        case 'approved':
            return { decision: 'accept' };
        case 'approved_for_session':
            return { decision: 'acceptForSession' };
        case 'denied':
            return { decision: 'decline' };
        case 'abort':
            return { decision: 'cancel' };
        default:
            return { decision: 'decline' };
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runCodexWithAppServer(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    restoreSessionId?: string;
    codexSessionId?: string;
}): Promise<void> {
    //
    // Apply default codex profile if CODEX_HOME is not set
    //

    if (!process.env.CODEX_HOME) {
        const defaultProfile = readCodexDefaultProfile();
        if (defaultProfile) {
            process.env.CODEX_HOME = getCodexInstancePath(defaultProfile);
            logger.debug(`[CodexAppServer] Applied default codex profile "${defaultProfile}": ${process.env.CODEX_HOME}`);
        }
    }

    //
    // Session setup (mirrors runCodex)
    //

    const sessionTag = randomUUID();
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);
    logger.debug(`[CodexAppServer] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
    });

    let response;
    if (opts.restoreSessionId) {
        response = await api.getSessionById(opts.restoreSessionId);
        if (response) {
            logger.debug(`[CodexAppServer] Restored session ${opts.restoreSessionId}`);
        } else {
            logger.debug(`[CodexAppServer] Failed to restore session ${opts.restoreSessionId}, creating new session`);
            response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
        }
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    let session: ApiSessionClient;
    let permissionHandler: CodexPermissionHandler;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        },
    });
    session = initialSession;

    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata);
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    //
    // Message queue (same as runCodex)
    //

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    let currentPermissionMode: PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as PermissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[CodexAppServer] Permission mode updated to: ${currentPermissionMode}`);
        }

        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[CodexAppServer] Model updated: ${messageModel || 'reset to default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };

        const text = message.content.text;

        if (hasActiveInteractiveSession()) {
            handleInteractiveInput(text);
            return;
        }

        if (isBangCommand(text)) {
            const claudeShapedMode: ClaudeEnhancedMode = {
                permissionMode: enhancedMode.permissionMode,
                model: enhancedMode.model,
            };
            executeBangCommand(text, {
                client: session,
                session: { mode: 'remote' },
                messageQueue: messageQueue as unknown as MessageQueue2<ClaudeEnhancedMode>,
                currentEnhancedMode: claudeShapedMode,
                isConsoleSession: false,
                flavor: 'codex',
                mode: 'remote',
            }).then(async result => {
                await new Promise(resolve => setTimeout(resolve, 200));
                const messages = Array.isArray(result.message) ? result.message : [result.message];
                for (const msg of messages) {
                    session.sendSessionEvent({ type: 'message', message: msg });
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                if (result.suggestions && result.suggestions.length > 0) {
                    const options = result.suggestions.map(s => `<option>${s}</option>`).join('\n');
                    session.sendCodexMessage({ type: 'message', message: `<options>\n${options}\n</options>` });
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                session.sendSessionEvent({ type: 'ready' });
            }).catch(error => {
                logger.warn('[CodexAppServer] Bang command failed:', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: `Command failed: ${(error as Error).message}`,
                });
                session.sendSessionEvent({ type: 'ready' });
            });
            return;
        }

        messageQueue.push(text, enhancedMode);
    });

    //
    // Runtime state
    //

    let thinking = false;
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    let threadIdStored = false;

    // Pending turn tracking — turn/start RPC returns immediately (non-blocking).
    // We await `pendingTurnPromise` which is resolved by the turn/completed /
    // turn/interrupted notification handlers.
    let pendingTurnPromise: Promise<void> | null = null;
    let resolvePendingTurn: (() => void) | null = null;
    let rejectPendingTurn: ((error: Error) => void) | null = null;

    function beginPendingTurn(): void {
        pendingTurnPromise = new Promise<void>((resolve, reject) => {
            resolvePendingTurn = resolve;
            rejectPendingTurn = reject;
        });
    }

    function finishPendingTurn(error?: Error): void {
        if (error && rejectPendingTurn) {
            rejectPendingTurn(error);
        } else if (resolvePendingTurn) {
            resolvePendingTurn();
        }
        resolvePendingTurn = null;
        rejectPendingTurn = null;
        pendingTurnPromise = null;
    }
    let shouldExit = false;

    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                '准备就绪',
                'Codex 等待你的指令',
                { sessionId: session.sessionId },
            );
        } catch (pushError) {
            logger.debug('[CodexAppServer] Failed to send ready push', pushError);
        }
    };

    //
    // Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: ReturnType<typeof render> | null = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                logger.debug('[CodexAppServer] Exiting agent via Ctrl-C');
                shouldExit = true;
                messageQueue.close();
            },
        }), {
            exitOnCtrlC: false,
            patchConsole: false,
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding('utf8');
    }

    //
    // Permission handler, processors
    //

    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Reasoning processor callback — not using session protocol envelopes
        // because the bridge handles envelope creation from notifications directly.
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Diff processor callback — same as above.
    });

    //
    // App-server client + stream bridge
    //

    let client: CodexAppServerClient | null = null;
    const bridge = createAppServerStreamBridge();

    // Without these, the main loop has no path to reach client.dispose() on
    // signal and codex.exe orphans. Nulling `client` first makes the finally
    // block's dispose a no-op so we don't double-dispose.
    const removeShutdownHandlers = registerShutdownHandlers(async () => {
        logger.debug('[CodexAppServer] Received shutdown signal, disposing client and flushing');
        const local = client;
        client = null;
        if (local) {
            try { await local.dispose(); } catch (error) {
                logger.debug('[CodexAppServer] Error disposing client on signal:', error);
            }
        }
        try {
            session.sendSessionDeath();
            await session.flush();
        } catch {}
    });

    // Happy MCP server (HTTP) — also injected into codex as an MCP server
    const happyServer = await startHappyServer(session);

    // Build config overrides to inject happy MCP server into codex app-server
    const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServerConfigOverrides: string[] = [];
    if (process.platform === 'win32') {
        mcpServerConfigOverrides.push(`mcp_servers.happy.command="node"`);
        mcpServerConfigOverrides.push(`mcp_servers.happy.args=["${bridgeCommand.replace(/\\/g, '\\\\')}","--url","${happyServer.url}"]`);
    } else {
        mcpServerConfigOverrides.push(`mcp_servers.happy.command="${bridgeCommand}"`);
        mcpServerConfigOverrides.push(`mcp_servers.happy.args=["--url","${happyServer.url}"]`);
    }
    mcpServerConfigOverrides.push(`mcp_servers.happy.enabled=true`);

    // Inject system prompt on the first turn of every fresh codex thread so
    // the model knows to call mcp__happy__change_title. Restored sessions
    // resume an existing thread that already had it. Reset to true whenever
    // a brand-new thread is started (e.g. mode change), and consume only
    // after a successful turn/start so transient RPC failures don't drop it.
    let needsSystemPromptInjection = !opts.restoreSessionId;

    // Accumulate streaming text deltas — send as one message on turn completion
    let pendingAgentText = '';

    //
    // Process bridge updates — maps AppServerStreamUpdate into session events
    //

    function processBridgeUpdates(updates: AppServerStreamUpdate[]): void {
        for (const update of updates) {
            switch (update.type) {
                case 'envelope': {
                    const envelope = update.envelope;
                    session.sendSessionProtocolMessage(envelope);
                    // Older happy-app builds render tool calls from the codex
                    // content path (content.type === 'codex'), not from session
                    // envelopes. Dual-send tool-call envelopes in the legacy
                    // shape for backwards compatibility.
                    if (envelope.ev.t === 'tool-call-start') {
                        session.sendCodexMessage({
                            type: 'tool-call',
                            callId: envelope.ev.call,
                            id: envelope.id,
                            name: envelope.ev.name,
                            input: envelope.ev.args,
                        });
                    } else if (envelope.ev.t === 'tool-call-end') {
                        session.sendCodexMessage({
                            type: 'tool-call-result',
                            callId: envelope.ev.call,
                            id: envelope.id,
                            output: null,
                        });
                    }
                    break;
                }

                case 'agent-message':
                    // Accumulate streaming deltas — will be sent as one message on task-complete
                    pendingAgentText += update.message;
                    break;

                case 'reasoning-delta':
                    reasoningProcessor.processDelta(update.delta);
                    break;

                case 'reasoning-final':
                    reasoningProcessor.complete(update.text);
                    break;

                case 'turn-diff':
                    diffProcessor.processDiff(update.unifiedDiff);
                    break;

                case 'task-started': {
                    activeTurnId = update.turnId;
                    if (!thinking) {
                        logger.debug('[CodexAppServer] thinking started');
                        thinking = true;
                        session.keepAlive(thinking, 'remote');
                    }
                    // Store threadId in happy session metadata
                    if (threadId && !threadIdStored) {
                        threadIdStored = true;
                        const storedId = threadId;
                        session.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            claudeSessionId: storedId,
                        }));
                        logger.debug(`[CodexAppServer] Stored threadId in metadata: ${storedId}`);
                    }
                    messageBuffer.addMessage('Starting task...', 'status');
                    break;
                }

                case 'task-complete': {
                    if (thinking) {
                        logger.debug('[CodexAppServer] thinking completed');
                        thinking = false;
                        session.keepAlive(thinking, 'remote');
                    }
                    // Flush accumulated agent text as a single message
                    const agentText = pendingAgentText.trim();
                    if (agentText) {
                        messageBuffer.addMessage(agentText, 'assistant');
                        session.sendCodexMessage({
                            type: 'message',
                            message: agentText,
                            id: randomUUID(),
                        });
                    }
                    pendingAgentText = '';
                    messageBuffer.addMessage('Task completed', 'status');
                    diffProcessor.reset();
                    activeTurnId = null;
                    break;
                }

                case 'turn-aborted': {
                    // Flush any partial agent text
                    const partialText = pendingAgentText.trim();
                    if (partialText) {
                        messageBuffer.addMessage(partialText, 'assistant');
                        session.sendCodexMessage({
                            type: 'message',
                            message: partialText,
                            id: randomUUID(),
                        });
                    }
                    pendingAgentText = '';
                    if (thinking) {
                        logger.debug('[CodexAppServer] thinking aborted');
                        thinking = false;
                        session.keepAlive(thinking, 'remote');
                    }
                    messageBuffer.addMessage('Turn aborted', 'status');
                    diffProcessor.reset();
                    activeTurnId = null;
                    break;
                }

                case 'approval-request':
                    // Handled via server request handlers registered on the client
                    break;
            }
        }
    }

    //
    // Abort / kill handlers
    //

    async function handleAbort() {
        logger.debug('[CodexAppServer] Abort requested');
        try {
            if (client && threadId && activeTurnId) {
                logger.debug(`[CodexAppServer] Interrupting turn ${activeTurnId} on thread ${threadId}`);
                await client.request('turn/interrupt', { threadId, turnId: activeTurnId });
            }
        } catch (error) {
            logger.debug('[CodexAppServer] Error during abort:', error);
        }
    }

    const handleKillSession = async () => {
        logger.debug('[CodexAppServer] Kill session requested - terminating process');
        await handleAbort();

        try {
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated',
                }));
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }
            if (client) {
                await client.dispose();
            }
            stopCaffeinate();
            happyServer.stop();

            logger.debug('[CodexAppServer] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[CodexAppServer] Error during session termination:', error);
            process.exit(1);
        }
    };

    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Main loop
    //

    // Attach all notification + request handlers to a codex app-server client.
    // Extracted so we can rebind the same callbacks onto a fresh client instance
    // after a !auth-all --codex swap. All captured vars (bridge, threadId, session,
    // permissionHandler, ...) are in the enclosing function's lexical scope, so
    // a swap is transparent — the new client's events route through the same
    // happy-session state as the old one.
    const registerClientHandlers = (c: CodexAppServerClient) => {
        c.registerNotificationHandler('turn/started', (params) => {
            const updates = bridge.onNotification('turn/started', params);
            // Extract turnId from notification
            const notifTurnId = readTurnId(params);
            if (notifTurnId) {
                activeTurnId = notifTurnId;
            }
            // Extract threadId if present
            const notifThreadId = readThreadId(params);
            if (notifThreadId && notifThreadId !== threadId) {
                threadId = notifThreadId;
            }
            processBridgeUpdates(updates);
        });

        c.registerNotificationHandler('turn/completed', (params) => {
            const updates = bridge.onNotification('turn/completed', params);
            processBridgeUpdates(updates);
            finishPendingTurn();
        });

        c.registerNotificationHandler('turn/interrupted', (params) => {
            const updates = bridge.onNotification('turn/interrupted', params);
            processBridgeUpdates(updates);
            finishPendingTurn();
        });

        c.registerNotificationHandler('item/agentMessage/delta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/agentMessage/delta', params));
        });

        c.registerNotificationHandler('item/plan/delta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/plan/delta', params));
        });

        c.registerNotificationHandler('item/reasoning/summaryTextDelta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/reasoning/summaryTextDelta', params));
        });

        c.registerNotificationHandler('item/reasoning/textDelta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/reasoning/textDelta', params));
        });

        c.registerNotificationHandler('turn/diff/updated', (params) => {
            processBridgeUpdates(bridge.onNotification('turn/diff/updated', params));
        });

        c.registerNotificationHandler('item/started', (params) => {
            processBridgeUpdates(bridge.onNotification('item/started', params));
        });

        c.registerNotificationHandler('item/completed', (params) => {
            processBridgeUpdates(bridge.onNotification('item/completed', params));
        });

        c.registerNotificationHandler('rawResponseItem/completed', (params) => {
            processBridgeUpdates(bridge.onNotification('rawResponseItem/completed', params));
        });

        c.registerNotificationHandler('error', (params) => {
            const record = params as Record<string, unknown> | null;
            if (record && record.willRetry === true) return; // transient, codex will retry
            logger.warn('[CodexAppServer] Codex error notification:', params);
            session.sendSessionEvent({
                type: 'message',
                message: `Codex error: ${record?.message || record?.error || 'unknown'}`,
            });
        });

        // Register server request handlers for approval flows
        c.registerRequestHandler('item/commandExecution/requestApproval', async (params) => {
            const updates = bridge.onServerRequest('item/commandExecution/requestApproval', params);
            processBridgeUpdates(updates);

            const approvalUpdate = updates.find((u): u is Extract<AppServerStreamUpdate, { type: 'approval-request' }> => u.type === 'approval-request');
            if (!approvalUpdate) {
                return { decision: 'accept' };
            }

            const result = await permissionHandler.handleToolCall(
                approvalUpdate.callId,
                approvalUpdate.toolName,
                approvalUpdate.input,
            );
            return mapPermissionDecision(result);
        });

        c.registerRequestHandler('item/fileChange/requestApproval', async (params) => {
            const updates = bridge.onServerRequest('item/fileChange/requestApproval', params);
            processBridgeUpdates(updates);

            const approvalUpdate = updates.find((u): u is Extract<AppServerStreamUpdate, { type: 'approval-request' }> => u.type === 'approval-request');
            if (!approvalUpdate) {
                return { decision: 'accept' };
            }

            const result = await permissionHandler.handleToolCall(
                approvalUpdate.callId,
                approvalUpdate.toolName,
                approvalUpdate.input,
            );
            return mapPermissionDecision(result);
        });

        // Auto-approve MCP server elicitation requests (our own happy MCP server tools)
        c.registerRequestHandler('mcpServer/elicitation/request', async (_params) => {
            logger.debug('[CodexAppServer] Auto-approving MCP elicitation request');
            return { action: 'accept', content: {} };
        });
    };

    // Set by the codex profile watcher when !auth-all --codex broadcasts a switch.
    // Consumed at top-of-loop: tears down the current app-server subprocess and
    // rebuilds with the new CODEX_HOME. The next iteration's thread/resume picks
    // up savedThreadId so the conversation continues transparently.
    let pendingAccountSwap: string | null = null;

    // Watch for !auth-all --codex. On a valid switch, tryGlobalProfileSwitch has
    // already updated process.env.CODEX_HOME — we just flag the loop and abort
    // any in-flight turn.
    const codexProfileWatcher: FSWatcher | null = watchCodexProfileFile(() => {
        const target = getCurrentCodexProfile() || 'unknown';
        logger.debug(`[CodexAppServer] Account swap signaled: ${target}`);
        pendingAccountSwap = target;
        if (client && threadId && activeTurnId) {
            void handleAbort();
        }
    });

    try {
        // Create app-server client
        logger.debug('[CodexAppServer] Creating app-server client');
        client = await createCodexAppServerClient({
            configOverrides: mcpServerConfigOverrides,
        });
        logger.debug('[CodexAppServer] App-server client created');

        // Register notification + request handlers BEFORE starting any thread
        registerClientHandlers(client);

        // Send welcome message
        {
            const welcome = buildSessionWelcome();
            const msgs = Array.isArray(welcome.message) ? welcome.message : [welcome.message];
            for (const msg of msgs) {
                session.sendSessionEvent({ type: 'message', message: msg });
            }
            if (welcome.suggestions && welcome.suggestions.length > 0) {
                const options = welcome.suggestions.map(s => `<option>${s}</option>`).join('\n');
                session.sendCodexMessage({ type: 'message', message: `<options>\n${options}\n</options>` });
            }
        }

        // After restore, fetch pending user messages
        if (opts.restoreSessionId && response) {
            try {
                await fetchAndInjectPendingMessages(
                    api, session, opts.restoreSessionId,
                    response.encryptionKey, response.encryptionVariant,
                    '[CodexAppServer]',
                );
            } catch (error) {
                logger.debug('[CodexAppServer] Failed to fetch pending messages after restore:', error);
            }
        }

        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

        while (!shouldExit) {
            // Consume pending !auth-all --codex account swap before anything else.
            // tryGlobalProfileSwitch already updated process.env.CODEX_HOME; we now
            // dispose the current app-server subprocess and spawn a new one that
            // inherits the new env. savedThreadId → opts.codexSessionId makes the
            // next iteration's thread/resume pick up the conversation via the
            // shared symlinked sessions/ directory.
            if (pendingAccountSwap) {
                const target = pendingAccountSwap;
                pendingAccountSwap = null;
                const savedThreadId = threadId;
                try {
                    if (client) {
                        await client.dispose();
                        client = null;
                    }
                    client = await createCodexAppServerClient({
                        configOverrides: mcpServerConfigOverrides,
                    });
                    registerClientHandlers(client);
                    threadId = null;
                    threadIdStored = false;
                    activeTurnId = null;
                    currentModeHash = null;
                    if (savedThreadId) {
                        opts.codexSessionId = savedThreadId;
                    }
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    const msg = `🔄 Switched to "${target}" (via !auth-all --codex)`;
                    messageBuffer.addMessage(msg, 'status');
                    session.sendSessionEvent({ type: 'message', message: msg });
                    logger.debug(`[CodexAppServer] Account swap complete → ${target}`);
                } catch (err) {
                    logger.warn('[CodexAppServer] Account swap failed:', err);
                    const errMsg = `⚠ 切换账号失败: ${(err as Error).message || 'unknown error'}`;
                    messageBuffer.addMessage(errMsg, 'status');
                    session.sendSessionEvent({ type: 'message', message: errMsg });
                    shouldExit = true;
                    break;
                }
                continue;
            }

            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const batch = await messageQueue.waitForMessagesAndGetAsString();
                if (!batch) {
                    logger.debug(`[CodexAppServer] batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) break;

            // Mode change: need a new thread
            if (threadId && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[CodexAppServer] Mode changed - starting new thread');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                threadId = null;
                threadIdStored = false;
                currentModeHash = null;
                needsSystemPromptInjection = true;
                pending = message;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                const sandboxManagedByHappy = !!sandboxConfig;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );

                // Start or resume thread if needed
                if (!threadId) {
                    if (opts.codexSessionId) {
                        // Resume existing thread
                        logger.debug(`[CodexAppServer] Resuming thread ${opts.codexSessionId}`);
                        const threadResponse = await client.request('thread/resume', {
                            threadId: opts.codexSessionId,
                            approvalPolicy: toApprovalPolicy(executionPolicy.approvalPolicy),
                            sandbox: executionPolicy.sandbox,
                            persistExtendedHistory: true,
                        });
                        threadId = readThreadId(threadResponse) ?? opts.codexSessionId;
                        logger.debug(`[CodexAppServer] Resumed thread: ${threadId}`);
                        messageBuffer.addMessage('Resuming previous conversation...', 'status');
                    } else {
                        // Start new thread
                        logger.debug('[CodexAppServer] Starting new thread');
                        const threadResponse = await client.request('thread/start', {
                            cwd: process.cwd(),
                            approvalPolicy: toApprovalPolicy(executionPolicy.approvalPolicy),
                            sandbox: executionPolicy.sandbox,
                            experimentalRawEvents: true,
                            persistExtendedHistory: true,
                        });
                        threadId = readThreadId(threadResponse);
                        if (!threadId) {
                            throw new Error('Codex app-server thread/start returned no thread id');
                        }
                        logger.debug(`[CodexAppServer] Started thread: ${threadId}`);
                    }
                    // Clear resume ID after first use so subsequent turns don't try to resume again
                    opts.codexSessionId = undefined;
                }

                logger.debug(`[CodexAppServer] Starting turn on thread ${threadId}`);

                // turn/start RPC returns immediately with turnId; the turn itself
                // completes asynchronously via turn/completed notification. Set up
                // the pending-turn promise BEFORE sending the RPC so we don't miss
                // notifications that arrive before the await.
                beginPendingTurn();
                const injectSystemPrompt = needsSystemPromptInjection;
                const turnInputText = injectSystemPrompt
                    ? `${systemPrompt}\n\n${message.message}`
                    : message.message;
                const turnResponse = await client.request('turn/start', {
                    threadId,
                    input: [{ type: 'text', text: turnInputText }],
                    approvalPolicy: toApprovalPolicy(executionPolicy.approvalPolicy),
                    sandboxPolicy: toSandboxPolicy(executionPolicy.sandbox, process.cwd()),
                    ...(message.mode.model ? { model: message.mode.model } : {}),
                });
                if (injectSystemPrompt) {
                    needsSystemPromptInjection = false;
                }
                logger.debug('[CodexAppServer] turn/start RPC returned:', JSON.stringify(turnResponse).substring(0, 200));

                // Wait for the real turn completion (turn/completed notification).
                if (pendingTurnPromise) {
                    await pendingTurnPromise;
                }
                logger.debug('[CodexAppServer] Turn fully completed');
            } catch (error) {
                logger.warn('[CodexAppServer] Error in app-server session:', error);
                // Clean up any pending turn promise to avoid leaks
                if (pendingTurnPromise) {
                    finishPendingTurn(error instanceof Error ? error : new Error(String(error)));
                }
                const errorMessage = error instanceof Error ? error.message : String(error);

                if (errorMessage.includes('disposed') || errorMessage.includes('exited')) {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                } else {
                    messageBuffer.addMessage(`Error: ${errorMessage.substring(0, 200)}`, 'status');
                    session.sendSessionEvent({ type: 'message', message: `Error: ${errorMessage}` });
                }
            } finally {
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
            }
        }
    } catch (error) {
        logger.warn('[CodexAppServer] Fatal error:', error);
        session.sendSessionEvent({
            type: 'message',
            message: `Codex app-server error: ${error instanceof Error ? error.message : String(error)}`,
        });
    } finally {
        // Clean up resources
        logger.debug('[CodexAppServer] Final cleanup start');

        removeShutdownHandlers();
        try { codexProfileWatcher?.close(); } catch { /* best effort */ }

        if (reconnectionHandle) {
            logger.debug('[CodexAppServer] Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (e) {
            logger.debug('[CodexAppServer] Error while closing session', e);
        }

        if (client) {
            logger.debug('[CodexAppServer] Disposing app-server client');
            await client.dispose();
        }

        happyServer.stop();

        if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch { /* ignore */ }
        }
        if (hasTTY) {
            try { process.stdin.pause(); } catch { /* ignore */ }
        }
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logger.debug('[CodexAppServer] Final cleanup completed');
    }
}
