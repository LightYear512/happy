import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { localCommandUserText, modelFacingUserText } from '@/api/types';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata, shouldRegisterMachineForSession } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { resolve, join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import fs from 'node:fs';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import { withCodexModelModeMetadata } from './modelMode';
import { resolveCodexModelModeOrDefault } from './defaultModelConfig';
import { readCodexDefaultProfile, getCodexInstancePath, getCurrentCodexProfile } from '@/commands/bang/ccsProfiles';
import {
    accountIntentIsNewer,
    readAccountIntent,
    readSessionAccountSelection,
    resolveStartupAccountSelection,
    writeSessionAccountSelection,
} from '@/commands/bang/accountIntent';
import { notifyDaemonCodexProfile } from "@/daemon/controlClient";
import { completeProviderInputReady } from '@/utils/completeProviderInputReady';
import { installHappySessionEnvironment } from '@/utils/projectSessionStartup';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { registerSessionTransportFatalHandler } from '@/api/registerSessionTransportFatalHandler';
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineSession } from '@/utils/setupOfflineSession';
import { registerShutdownHandlers } from '@/utils/shutdownHandlers';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy, resolveCodexSessionPermissionMode } from './executionPolicy';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';
import {
    isBangCommand,
    executeBangCommand,
    hasActiveInteractiveSession,
    handleInteractiveInput,
    buildSessionWelcome,
} from '@/commands/bang/dispatcher';
import { createHtaskReplyMonitorRuntime } from '@/commands/bang/replyMonitorRuntime';
import { renderOptionsBlock } from '@/commands/bang/types';
import type { EnhancedMode as ClaudeEnhancedMode } from '@/claude/loop';
import { performCodexMcpAccountRestart } from './codexAccountSwap';

// ---------------------------------------------------------------------------
// App-server mode detection
// ---------------------------------------------------------------------------

async function shouldUseAppServer(): Promise<boolean> {
    const envMode = process.env.HAPPY_CODEX_BACKEND_MODE;
    if (envMode === 'mcp') return false;
    if (envMode === 'appServer' || envMode === 'app-server') return true;

    // Default: try app-server, fall back to mcp
    try {
        execSync('codex --version', { encoding: 'utf8', windowsHide: true }).trim();
        // codex app-server available since ~0.100.0
        return true;
    } catch {
        return false;
    }
}

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    restoreSessionId?: string;
    permissionMode?: import('@/api/types').PermissionMode;
    /** Codex session ID from previous run — used to find transcript file for experimental_resume */
    codexSessionId?: string;
}): Promise<void> {
    // Route to app-server backend when available
    const useAppServer = await shouldUseAppServer();
    if (useAppServer) {
        logger.debug('[codex] Using app-server backend');
        const { runCodexWithAppServer } = await import('./runCodexAppServer');
        return runCodexWithAppServer(opts);
    }
    logger.debug('[codex] Using MCP backend');

    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    //
    // Apply default codex profile if CODEX_HOME is not set
    //

    if (!process.env.CODEX_HOME) {
        const defaultProfile = readCodexDefaultProfile();
        if (defaultProfile) {
            process.env.CODEX_HOME = getCodexInstancePath(defaultProfile);
            logger.debug(`[codex] Applied default codex profile "${defaultProfile}": ${process.env.CODEX_HOME}`);
        }
    }
    let activeCodexProfile = getCurrentCodexProfile();
    let lastSeenAccountIntent = 0;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    if (shouldRegisterMachineForSession(opts.startedBy)) {
        await api.getOrCreateMachine({
            machineId,
            metadata: initialMachineMetadata
        });
    }

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        permissionMode: opts.permissionMode,
        dangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'yolo',
    });

    // Restore must rejoin the exact Happy session. Creating a replacement here
    // would split the conversation identity from its history and pending input.
    let response;
    if (opts.restoreSessionId) {
        response = await api.restoreSessionById(opts.restoreSessionId);
        logger.debug(`[Codex] Restored session ${opts.restoreSessionId}`);
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // A failed or unknown create stays local. Replaying POST /v1/sessions can
    // create duplicate remote sessions when the first response was lost.
    let session: ApiSessionClient;
    let permissionHandler: CodexPermissionHandler;
    let bindTransportFatalHandler: ((client: ApiSessionClient) => void) | null = null;
    const { session: initialSession } = setupOfflineSession({
        api,
        sessionTag,
        response,
    });
    session = initialSession;
    installHappySessionEnvironment(session.sessionId);
    const savedAccount = readSessionAccountSelection(session.sessionId, 'codex');
    const startupAccount = resolveStartupAccountSelection(savedAccount, readAccountIntent('codex'));
    if (startupAccount && startupAccount.profileName !== activeCodexProfile) {
        const savedHome = getCodexInstancePath(startupAccount.profileName);
        if (!fs.existsSync(join(savedHome, 'auth.json'))) {
            throw new Error(`Selected Codex profile "${startupAccount.profileName}" is unavailable`);
        }
        process.env.CODEX_HOME = savedHome;
        activeCodexProfile = startupAccount.profileName;
    }
    if (startupAccount?.source === 'global') {
        try {
            writeSessionAccountSelection(
                session.sessionId,
                'codex',
                startupAccount.profileName,
                startupAccount.seenGlobalSetAt,
            );
        } catch (error) {
            logger.warn('[Codex] Failed to persist startup account selection:', error);
        }
    }
    lastSeenAccountIntent = startupAccount?.seenGlobalSetAt ?? 0;
    const rememberAccountIntent = (profileName: string, setAt: number): void => {
        lastSeenAccountIntent = setAt;
        try {
            writeSessionAccountSelection(session.sessionId, 'codex', profileName, setAt);
        } catch (error) {
            logger.warn('[Codex] Failed to persist session account selection:', error);
        }
    };
    if (startupAccount && opts.startedBy === 'daemon' && response) {
        const profileRegistration = await notifyDaemonCodexProfile(response.id, startupAccount.profileName);
        if (profileRegistration.error) {
            logger.warn(`[Codex] Failed to report saved account to daemon: ${profileRegistration.error}`);
        }
    }
    session.updateMetadata((metadata) => withCodexModelModeMetadata(metadata));

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode = resolveCodexSessionPermissionMode(
        response?.metadata.permissionMode,
        opts.permissionMode,
        response?.metadata.dangerouslySkipPermissions === true,
    );
    if (response && response.metadata.permissionMode === undefined && opts.permissionMode) {
        session.updateMetadata((metadata) => ({
            ...metadata,
            permissionMode: currentPermissionMode,
            dangerouslySkipPermissions: currentPermissionMode === 'bypassPermissions' || currentPermissionMode === 'yolo',
        }));
    }
    let currentModel: string | undefined = undefined;
    const pendingMcpRestart: { current: {
        profile: string | null; seenSetAt?: number;
    } | null } = { current: null };
    const replyMonitor = createHtaskReplyMonitorRuntime(session, 'codex', undefined, undefined, (text) => {
        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode,
            model: currentModel,
        };
        logger.debug(`[Codex] Enqueueing delivered task message: "${text.substring(0, 80)}"`);
        messageQueue.push(text, enhancedMode);
    });

    const onUserMessage = (message: import('@/api/types').UserMessage): void => {
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        if (message.meta?.permissionMode) {
            currentPermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
            session.updateMetadata((metadata) => ({
                ...metadata,
                permissionMode: currentPermissionMode,
                dangerouslySkipPermissions: currentPermissionMode === 'bypassPermissions' || currentPermissionMode === 'yolo',
            }));
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        let messageModel = currentModel;
        if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
            messageModel = typeof message.meta.model === 'string' && message.meta.model.length > 0
                ? message.meta.model
                : undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model mode updated from user message to: ${currentModel || 'Codex config'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode,
            model: messageModel,
        };

        const rawText = localCommandUserText(message);

        // Route input to active interactive session (e.g., !login OAuth flow)
        if (hasActiveInteractiveSession()) {
            handleInteractiveInput(rawText);
            return;
        }

        // Check for bang commands (! full commands or @ short aliases) - handle without invoking Codex model
        if (isBangCommand(rawText)) {
            const claudeShapedMode: ClaudeEnhancedMode = {
                permissionMode: enhancedMode.permissionMode,
                model: enhancedMode.model,
            };
            executeBangCommand(rawText, {
                client: session,
                // Codex has no Claude Session wrapper; pass a minimal shape so handlers
                // that read `mode` (e.g., !restart) still work — codex is always remote.
                session: { mode: 'remote' },
                messageQueue: messageQueue as unknown as MessageQueue2<ClaudeEnhancedMode>,
                currentEnhancedMode: claudeShapedMode,
                isConsoleSession: false,
                flavor: 'codex',
                deferCodexProfileSwitch: true,
            }).then(async result => {
                // Delay ensures mobile client receives messages in correct order —
                // it sorts by createdAt timestamp, so rapid events can arrive out of order.
                await new Promise(resolve => setTimeout(resolve, 200));
                const messages = Array.isArray(result.message) ? result.message : [result.message];
                for (const msg of messages) {
                    session.sendSessionEvent({ type: 'message', message: msg });
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                if (result.suggestions && result.suggestions.length > 0) {
                    session.sendCodexMessage({ type: 'message', message: renderOptionsBlock(result.suggestions) });
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                if (result.afterSuggestionsMessage) {
                    const afterMessages = Array.isArray(result.afterSuggestionsMessage) ? result.afterSuggestionsMessage : [result.afterSuggestionsMessage];
                    for (const msg of afterMessages) {
                        session.sendSessionEvent({ type: 'message', message: msg });
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                }
                session.sendSessionEvent({ type: 'ready' });

                if (result.action === 'restart-session') {
                    pendingMcpRestart.current = {
                        profile: result.restartProfile ?? getCurrentCodexProfile(),
                        seenSetAt: result.restartSeenGlobalSetAt,
                    };
                    messageQueue.interrupt();
                }
            }).catch(error => {
                logger.warn('[Codex] Bang command failed:', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: `❌ 命令执行失败: ${(error as Error).message}`,
                });
                session.sendSessionEvent({ type: 'ready' });
            });
            return;
        }

        const text = modelFacingUserText(message);
        messageQueue.push(text, enhancedMode);
        replyMonitor.observeUserMessage();
    };
    let thinking = false;
    let codexSessionIdStored = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                '准备就绪',
                'Codex 等待你的指令',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;
    let storedSessionIdForResume: string | null = null;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }
            
            abortController.abort();
            reasoningProcessor.abort();
            replyMonitor.endActiveReply('abort');
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                replyMonitor.dispose();
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.forceCloseSession();
            } catch (e) {
                logger.debug('[Codex] Error while force closing Codex session during termination', e);
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    let removeTransportFatalHandler = () => {};
    bindTransportFatalHandler = (boundSession) => {
        removeTransportFatalHandler();
        removeTransportFatalHandler = registerSessionTransportFatalHandler(boundSession, async (snapshot) => {
            logger.warn(`[Codex] Happy transport became terminal (${snapshot.state}); shutting down the unreachable runtime`);
            shouldExit = true;
            messageQueue.close();
            const hardExit = setTimeout(() => process.exit(1), 5_000);
            hardExit.unref();
            await handleAbort();
        });
    };
    bindTransportFatalHandler(session);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const client = new CodexMcpClient(sandboxConfig);

    // Without this, SIGTERM has no path to reach forceCloseSession() and
    // codex.exe orphans. forceCloseSession()/disconnect() is idempotent, so
    // it's safe if the finally block runs it again.
    const removeShutdownHandlers = registerShutdownHandlers(async () => {
        logger.debug('[codex] Received shutdown signal, force-closing MCP client and flushing');
        try {
            await client.forceCloseSession();
        } catch (error) {
            logger.debug('[codex] Error force-closing client on signal:', error);
        }
        try {
            session.sendSessionDeath();
            await session.flush();
        } catch {}
    });

    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            // Recursively collect all files under the sessions directory
            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter(full => full.endsWith(`-${sessionId}.jsonl`))
                .filter(full => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa; // newest first
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }
    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        // Also send agent_message directly to server — the session protocol mapper doesn't
        // handle this type, so without this fallback the app never sees the AI response.
        if (msg.type === 'agent_message') {
            replyMonitor.observeReceiveActivity('agent-message');
            messageBuffer.addMessage(msg.message, 'assistant');
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        } else if (msg.type === 'agent_reasoning_delta') {
            replyMonitor.observeReceiveActivity('agent-reasoning-delta');
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            replyMonitor.observeReceiveActivity('agent-reasoning');
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            replyMonitor.observeReceiveActivity('exec-command-begin');
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            replyMonitor.observeReceiveActivity('exec-command-end');
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            replyMonitor.beginActiveReply('task-started');
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            replyMonitor.endActiveReply('task-complete');
            messageBuffer.addMessage('Task completed', 'status');
            // Auto-update session title on first task completion
            if (first && msg.last_agent_message) {
                const title = String(msg.last_agent_message).substring(0, 80).replace(/\n/g, ' ').trim();
                if (title) {
                    logger.debug(`[Codex] Auto-setting session title: ${title}`);
                    session.sendClaudeSessionMessage({
                        type: 'summary',
                        summary: title,
                        leafUuid: randomUUID(),
                    });
                }
            }
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            replyMonitor.endActiveReply('turn-aborted');
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
            // Store codex session ID in metadata.claudeSessionId (field is misnamed —
            // it holds the backend agent session ID for any agent type, not just Claude).
            // This lets the daemon pass it via --resume on restore.
            const codexSid = client.getSessionId();
            if (codexSid && !codexSessionIdStored) {
                codexSessionIdStored = true;
                session.updateMetadata((metadata) => ({
                    ...metadata,
                    claudeSessionId: codexSid,
                }));
                logger.debug(`[Codex] Stored codex session ID in metadata: ${codexSid}`);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }

        // Convert Codex MCP events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        // agent_message is excluded because it's already sent via sendCodexMessage above
        // (the protocol envelope path works but app can't render it; sendCodexMessage is the working path).
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff' && msg.type !== 'agent_message') {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    // Start Happy MCP server (HTTP) for bang command RPC, but do NOT inject into codex session.
    // Codex MCP mode sends elicitation_request for MCP tool calls via codex/event notification
    // which cannot be responded to programmatically. Codex app-server mode (used by happier)
    // supports mcpServer/elicitation/request with responses, but we use MCP mode.
    // TODO: Migrate to codex app-server protocol to enable MCP tool injection.
    const happyServer = await startHappyServer(session);
    const mcpServers = {} as const;
    // Restored sessions already have a title — skip auto-title on first task_complete
    let first = !opts.restoreSessionId;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        if (response) {
            await completeProviderInputReady({
                session,
                expectedHappySessionId: response.id,
                reconcilePersistedInputs: Boolean(opts.restoreSessionId),
                providerSessionId: opts.codexSessionId,
                expectedProviderSessionId: opts.codexSessionId,
                onUserMessage,
            });
        } else {
            session.onUserMessage(onUserMessage);
        }
        session.keepAlive(thinking, 'remote');
        keepAliveInterval = setInterval(() => {
            session.keepAlive(thinking, 'remote');
        }, 2000);

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        // If we restart (e.g., mode change), use this to carry a resume file
        let nextExperimentalResume: string | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            if (pendingMcpRestart.current) {
                const restart = pendingMcpRestart.current;
                pendingMcpRestart.current = null;
                const previousSessionId = client.getSessionId();
                const resumeFile = findCodexResumeFile(previousSessionId);
                if (wasCreated && (!previousSessionId || !resumeFile)) {
                    pending = null;
                    const status = '⚠ 无法安全定位当前 Codex 会话记录，账号和会话均未改变；本次输入未提交，请重试';
                    session.sendSessionEvent({ type: 'message', message: status });
                    messageQueue.clearInterrupt();
                    continue;
                }
                const restarted = await performCodexMcpAccountRestart(client,
                    restart.profile ? getCodexInstancePath(restart.profile) : process.env.CODEX_HOME);
                if (restarted.ok) {
                    client.clearSession();
                    wasCreated = false;
                    currentModeHash = null;
                    codexSessionIdStored = false;
                    nextExperimentalResume = resumeFile;
                    opts.codexSessionId = undefined;
                    activeCodexProfile = restart.profile ?? getCurrentCodexProfile();
                    if (activeCodexProfile && opts.startedBy === 'daemon' && response) {
                        const registration = await notifyDaemonCodexProfile(response.id, activeCodexProfile);
                        if (registration.error) {
                            logger.warn(`[Codex] Failed to persist MCP profile: ${registration.error}`);
                        }
                    }
                    if (restart.seenSetAt !== undefined) {
                        rememberAccountIntent(activeCodexProfile ?? restart.profile ?? '', restart.seenSetAt);
                    }
                    const target = restart.profile ? `"${restart.profile}"` : '当前账号';
                    session.sendSessionEvent({ type: 'message',
                        message: `🔄 已重启 Codex MCP 会话并切换到 ${target}` });
                } else {
                    // One failed target attempt must not spin on the same input
                    // or silently submit it under the restored old account.
                    // A later real input retries because the global timestamp
                    // remains unacknowledged.
                    pending = null;
                    const rollbackDetail = restarted.rollbackError
                        ? `；原账号恢复失败: ${restarted.rollbackError.message}`
                        : '；已恢复原账号';
                    session.sendSessionEvent({ type: 'message',
                        message: `⚠ Codex MCP 重启失败，本次输入未提交，请重试: ${restarted.error.message}${rollbackDetail}` });
                }
                messageQueue.clearInterrupt();
                continue;
            }

            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (pendingMcpRestart.current && !shouldExit) continue;
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            // Global account changes are sampled only when a real model input is
            // ready. The input remains pending while the existing restart path
            // reconnects, so no file watcher can wake, interrupt, or stop this process.
            const currentIntent = readAccountIntent('codex');
            if (accountIntentIsNewer(currentIntent, lastSeenAccountIntent)) {
                if (currentIntent.profileName === activeCodexProfile) {
                    if (opts.startedBy === 'daemon' && response) {
                        const registration = await notifyDaemonCodexProfile(response.id, currentIntent.profileName);
                        if (registration.error) {
                            logger.warn(`[Codex] Failed to report account to daemon: ${registration.error}`);
                        }
                    }
                    rememberAccountIntent(currentIntent.profileName, currentIntent.setAt);
                } else {
                    pending = message;
                    pendingMcpRestart.current = {
                        profile: currentIntent.profileName,
                        seenSetAt: currentIntent.setAt,
                    };
                    continue;
                }
            }

            // If a session exists and mode changed, restart on next iteration
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                // Capture previous sessionId and try to find its transcript to resume
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (e) {
                    logger.debug('[Codex] Error while searching resume file', e);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                // Reset processors/permissions like end-of-turn cleanup
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                continue;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;
            replyMonitor.beginActiveReply('turn-start');

            try {
                // Map permission mode to approval policy and sandbox for startSession
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );

                if (!wasCreated) {
                    const modelConfig = resolveCodexModelModeOrDefault(message.mode.model);
                    const startConfig: CodexSessionConfig = {
                        prompt: message.message,
                        sandbox: executionPolicy.sandbox,
                        'approval-policy': executionPolicy.approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };
                    if (modelConfig.model) {
                        startConfig.model = modelConfig.model;
                    }
                    if (modelConfig.reasoningEffort) {
                        startConfig.config = {
                            ...(startConfig.config ?? {}),
                            model_reasoning_effort: modelConfig.reasoningEffort,
                        };
                    }

                    // Check for resume file from multiple sources
                    let resumeFile: string | null = null;

                    // Priority 0: Resume from daemon restore (codex session ID passed via --resume)
                    if (!resumeFile && opts.codexSessionId) {
                        const restoreResumeFile = findCodexResumeFile(opts.codexSessionId);
                        if (restoreResumeFile) {
                            resumeFile = restoreResumeFile;
                            logger.debug('[Codex] Using resume file from session restore:', resumeFile);
                            messageBuffer.addMessage('Resuming previous conversation…', 'status');
                        } else {
                            logger.debug(`[Codex] No resume file found for restored session ${opts.codexSessionId}`);
                        }
                    }

                    // Priority 1: Explicit resume file from mode change
                    if (!resumeFile && nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null; // consume once
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    }
                    // Priority 2: Resume from stored abort session
                    else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null; // consume once
                    }
                    
                    // Apply resume file if found
                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }
                    
                    await client.startSession(
                        startConfig,
                        { signal: abortController.signal }
                    );
                    wasCreated = true;
                    first = false;
                } else {
                    const response = await client.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                    logger.debug('[Codex] continueSession response:', response);
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                
                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Abort cancels the current task/inference but keeps the Codex session alive.
                    // Do not clear session state here; the next user message should continue on the
                    // existing session if possible.
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    // For unexpected exits, try to store session for potential recovery
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                replyMonitor.endActiveReply('turn-finally');
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');
        replyMonitor.dispose();
        removeTransportFatalHandler();
        removeShutdownHandlers();
        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.forceCloseSession begin');
        await client.forceCloseSession();
        logger.debug('[codex]: client.forceCloseSession done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
