import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { fetchAndInjectPendingMessages } from '@/utils/fetchPendingMessages';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { Credentials, readSettings } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { isBangCommand, executeBangCommand, hasActiveInteractiveSession, handleInteractiveInput, buildConsoleWelcome, buildSessionWelcome } from '@/commands/bang/dispatcher';
import { renderOptionsBlock } from '@/commands/bang/types';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { startOfflineReconnection, connectionState } from '@/utils/serverConnectionErrors';
import { readCcsProfiles, getInstancePath, getCurrentCcsProfile } from '@/commands/bang/ccsProfiles';
import { formatErrorForUser } from '@/claude/utils/errorFormatter';
import { queryRateLimitContext } from '@/commands/bang/usageCommand';
import { claudeLocal } from '@/claude/claudeLocal';
import { createSessionScanner, readSessionLog } from '@/claude/utils/sessionScanner';
import { getProjectPath } from '@/claude/utils/path';
import { Session } from './session';
import { applySandboxPermissionPolicy, resolveInitialClaudePermissionMode } from './utils/permissionMode';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

export interface StartOptions {
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    noSandbox?: boolean
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    /** CCS profile name to use at startup */
    profile?: string
    /** Session ID to restore (rejoin existing happy session instead of creating new) */
    restoreSessionId?: string
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);

    // Resolve CCS profile: --profile flag > CCS default > system default
    const resolvedProfile = resolveCcsProfile(options.profile);
    if (resolvedProfile.configDir) {
        process.env.CLAUDE_CONFIG_DIR = resolvedProfile.configDir;
        logger.debug(`[CLAUDE] Using CCS profile "${resolvedProfile.name}" → ${resolvedProfile.configDir}`);
    }
    // Print current account info
    console.log(`🔑 Account: ${resolvedProfile.name}${resolvedProfile.source !== 'default' ? ` (${resolvedProfile.source})` : ''}`);

    const workingDirectory = process.cwd();
    const isConsoleSession = process.env.HAPPY_CONSOLE_SESSION === '1';
    const sessionTag = randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Happy process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements - fail fast on invalid config
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        throw new Error('Daemon-spawned sessions cannot use local/interactive mode. Use --happy-starting-mode remote or spawn sessions directly from terminal.');
    }

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Claude');

    // Create session service
    const api = await ApiClient.create(credentials);

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    const sandboxConfig = options.noSandbox ? undefined : settings?.sandboxConfig;
    const sandboxEnabled = Boolean(sandboxConfig?.enabled);
    const initialPermissionMode = applySandboxPermissionPolicy(
        resolveInitialClaudePermissionMode(options.permissionMode, options.claudeArgs),
        sandboxEnabled,
    );
    const dangerouslySkipPermissions =
        initialPermissionMode === 'bypassPermissions' ||
        initialPermissionMode === 'yolo' ||
        sandboxEnabled ||
        Boolean(options.claudeArgs?.includes('--dangerously-skip-permissions'));
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let metadata: Metadata = {
        path: isConsoleSession ? os.homedir() : workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        sandbox: sandboxConfig?.enabled ? sandboxConfig : null,
        dangerouslySkipPermissions,
    };
    // Restore path: rejoin existing session by ID, fallback to creating new session
    let response;
    if (options.restoreSessionId) {
        response = await api.getSessionById(options.restoreSessionId);
        if (response) {
            logger.debug(`[CLAUDE] Restored session ${options.restoreSessionId}`);
        } else {
            logger.debug(`[CLAUDE] Failed to restore session ${options.restoreSessionId}, creating new session`);
            response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
        }
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - run Claude locally with hot reconnection
    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        let offlineSessionId: string | null = null;

        const reconnection = startOfflineReconnection({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                if (!resp) throw new Error('Server unavailable');
                const session = api.sessionSyncClient(resp);
                const scanner = await createSessionScanner({
                    sessionId: null,
                    workingDirectory,
                    onMessage: (msg) => session.sendClaudeSessionMessage(msg)
                });
                if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                return { session, scanner };
            },
            onNotify: console.log,
            onCleanup: () => {
                // Scanner cleanup handled automatically when process exits
            }
        });

        try {
            await claudeLocal({
                path: workingDirectory,
                sessionId: null,
                onSessionFound: (id) => { offlineSessionId = id; },
                onThinkingChange: () => {},
                abort: new AbortController().signal,
                claudeEnvVars: options.claudeEnvVars,
                claudeArgs: options.claudeArgs,
                mcpServers: {},
                allowedTools: [],
                sandboxConfig,
            });
        } finally {
            reconnection.cancel();
            stopCaffeinate();
        }
        process.exit(0);
    }

    logger.debug(`Session created: ${response.id}`);

    // Always report to daemon if it exists
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

    // Create realtime session BEFORE extractSDKMetadataAsync to avoid creating
    // a second session-scoped WebSocket that triggers stale-socket kicking
    const session = api.sessionSyncClient(response);

    // Extract SDK metadata in background and update session when ready
    // Skip for console sessions — they don't use Claude SDK and the SDK query
    // can call process.exit(1) when running in the console directory
    if (!isConsoleSession) {
        extractSDKMetadataAsync(async (sdkMetadata) => {
            logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
            try {
                // Reuse the existing session client — do NOT create a new one,
                // as that would open a second WebSocket and trigger stale-socket kicking
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    tools: sdkMetadata.tools,
                    slashCommands: sdkMetadata.slashCommands
                }));
                logger.debug('[start] Session metadata updated with SDK capabilities');
            } catch (error) {
                logger.debug('[start] Failed to update session metadata:', error);
            }
        });
    }

    // Console session: set title, send welcome message
    if (isConsoleSession) {
        logger.debug('[START] Console session detected');

        // Wait for socket connection, then send title and welcome
        session.waitForConnect().then(() => {
            // Set session title via summary message (same mechanism as change_title MCP tool)
            session.sendClaudeSessionMessage({
                type: 'summary',
                summary: `🖥️ 控制台 - ${os.hostname()}`,
                leafUuid: randomUUID(),
            });
            // Welcome message derived from command registry (SSoT: dispatcher.ts)
            const welcome = buildConsoleWelcome();
            const welcomeMessages = Array.isArray(welcome.message) ? welcome.message : [welcome.message];
            for (const msg of welcomeMessages) {
                session.sendSessionEvent({ type: 'message', message: msg });
            }
            if (welcome.suggestions && welcome.suggestions.length > 0) {
                session.sendCodexMessage({ type: 'message', message: renderOptionsBlock(welcome.suggestions) });
            }
            session.sendSessionEvent({ type: 'ready' });
        }).catch(error => {
            logger.debug('[START] Console session socket connect failed:', error);
        });
    }

    // Restore session title when resuming
    const resumeTitle = process.env.HAPPY_RESUME_TITLE;
    logger.debug(`[START] HAPPY_RESUME_TITLE=${resumeTitle || '(not set)'}`);
    if (resumeTitle) {
        session.waitForConnect().then(() => {
            session.sendClaudeSessionMessage({
                type: 'summary',
                summary: resumeTitle,
                leafUuid: randomUUID(),
            });
            logger.debug(`[START] Restored resume title: ${resumeTitle}`);
        }).catch(error => {
            logger.debug('[START] Failed to restore resume title:', error);
        });
    }

    // Startup usage warning: check quota levels and warn user before they start working.
    // Fire-and-forget — must not block session startup. Skip for console sessions.
    if (!isConsoleSession) {
        session.waitForConnect().then(async () => {
            try {
                const ctx = await queryRateLimitContext();
                if (!ctx || ctx.overLimitWindows.length === 0) return;

                const topWindow = ctx.overLimitWindows[0];
                const icon = topWindow.utilization >= 90 ? '🚨' : '⚠️';

                const lines: string[] = [
                    `${icon} 用量预警: ${topWindow.label}已达 ${topWindow.utilization.toFixed(0)}%`,
                    `⏰ 重置于 ${topWindow.resetsIn} 后`,
                ];

                // Show additional windows if any
                for (const w of ctx.overLimitWindows.slice(1)) {
                    lines.push(`  ${w.label}: ${w.utilization.toFixed(0)}% — ${w.resetsIn} 后重置`);
                }

                // Suggest switchable profile or !login
                if (ctx.switchableProfiles.length > 0) {
                    lines.push(`💡 建议: !auth ${ctx.switchableProfiles[0]} 切换账户`);
                } else {
                    lines.push('💡 建议: !login <名称> 登录新账户');
                }

                session.sendSessionEvent({ type: 'message', message: lines.join('\n') });
            } catch (e) {
                logger.debug('[START] Startup usage check failed:', e);
            }
        }).catch(e => {
            logger.debug('[START] Startup usage warning socket connect failed:', e);
        });
    }

    // Forward JSONL history to app when resuming in remote mode (new session only).
    // Skip when restoring — the app already has the old messages for the same happySessionId.
    if (options.startingMode === 'remote' && !options.restoreSessionId && options.claudeArgs) {
        let resumeSessionId: string | null = null;
        for (let i = 0; i < options.claudeArgs.length; i++) {
            if (options.claudeArgs[i] === '--resume' && i + 1 < options.claudeArgs.length) {
                const nextArg = options.claudeArgs[i + 1];
                if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                    resumeSessionId = nextArg;
                }
                break;
            }
        }

        if (resumeSessionId) {
            logger.debug(`[START] Remote resume detected, forwarding JSONL history for session ${resumeSessionId}`);
            try {
                const projectDir = getProjectPath(workingDirectory);
                const historyMessages = await readSessionLog(projectDir, resumeSessionId);
                logger.debug(`[START] Found ${historyMessages.length} historical messages to forward, waiting for socket`);
                await session.waitForConnect();
                logger.debug(`[START] Socket connected, sending historical messages`);
                for (const msg of historyMessages) {
                    session.sendClaudeSessionMessage(msg);
                }
                logger.debug(`[START] Historical messages forwarded to app`);
            } catch (error) {
                logger.debug(`[START] Failed to forward JSONL history:`, error);
            }
        }
    }

    // Start Happy MCP server
    const happyServer = await startHappyServer(session, {
        getSessionFilePath: () => {
            if (!currentSession?.sessionId) return null;
            const projDir = getProjectPath(currentSession.path);
            return join(projDir, `${currentSession.sessionId}.jsonl`);
        },
    });
    logger.debug(`[START] Happy MCP server started at ${happyServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    // Used by hook server to notify Session when Claude changes session ID
    let currentSession: Session | null = null;

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);
            
            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook settings file for Claude
    const hookSettingsPath = generateHookSettingsFile(hookServer.port);
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools
    }));

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    let currentModel = options.model; // Track current model state
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    session.onUserMessage((message) => {

        // Resolve permission mode from meta - pass through as-is, mapping happens at SDK boundary
        let messagePermissionMode: PermissionMode | undefined = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = applySandboxPermissionPolicy(message.meta.permissionMode, sandboxEnabled);
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Route input to active interactive session (e.g., !auth create login flow)
        if (hasActiveInteractiveSession()) {
            handleInteractiveInput(message.content.text);
            return;
        }

        // Check for bang commands (! full commands or @ short aliases) - handle without LLM
        if (isBangCommand(message.content.text)) {
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            executeBangCommand(message.content.text, {
                client: session,
                session: currentSession,
                messageQueue,
                currentEnhancedMode: enhancedMode,
                isConsoleSession,
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

                // Restart SDK session so new env vars (e.g. CLAUDE_CONFIG_DIR) take effect
                if (result.action === 'restart-session') {
                    logger.debug('[start] Bang command requested session restart');
                    if (currentSession) {
                        currentSession.pendingRestartConfirmation = true;
                    }
                    messageQueue.interrupt();
                }
            }).catch(async error => {
                logger.debug('[start] Bang command error:', error);
                // Same ordering delay as success path (see comment above)
                await new Promise(resolve => setTimeout(resolve, 100));
                const { display } = formatErrorForUser(String(error));
                session.sendSessionEvent({ type: 'message', message: `❌ 命令执行失败: ${display}` });
                session.sendSessionEvent({ type: 'ready' });
            });
            return;
        }

        // Console session: reject non-bang messages
        if (isConsoleSession) {
            session.sendSessionEvent({ type: 'message', message: '⚠️ 控制台仅支持 ! 命令或 @ 短指令，输入 !help 或 @h 查看可用命令' });
            session.sendSessionEvent({ type: 'ready' });
            return;
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools
        };
        messageQueue.push(message.content.text, enhancedMode);
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Setup signal handlers for graceful shutdown
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');

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
                
                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        cleanup();
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        cleanup();
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    // After restore, fetch pending user messages that arrived while CLI was offline.
    if (options.restoreSessionId) {
        try {
            await fetchAndInjectPendingMessages(
                api, session, options.restoreSessionId,
                response.encryptionKey, response.encryptionVariant,
                '[START]',
            );
        } catch (error) {
            logger.debug('[START] Failed to fetch pending messages after restore:', error);
        }
    }

    // Create claude loop
    const exitCode = await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: initialPermissionMode,
        startingMode: options.startingMode,
        messageQueue,
        api,
        allowedTools: happyServer.toolNames.map(toolName => `mcp__happy__${toolName}`),
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback
            currentSession = sessionInstance;
        },
        mcpServers: {
            'happy': {
                type: 'http' as const,
                url: happyServer.url,
            }
        },
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        sandboxConfig,
        hookSettingsPath,
        jsRuntime: options.jsRuntime
    });

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Happy MCP server
    happyServer.stop();
    logger.debug('Stopped Happy MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode);
}

/**
 * Resolve which CCS profile to use at startup.
 * Priority: --profile flag > CLAUDE_CONFIG_DIR env > CCS default profile > system default
 */
function resolveCcsProfile(profileFlag?: string): { name: string; configDir: string | null; source: string } {
    // 1. Explicit --profile flag
    if (profileFlag) {
        if (profileFlag === 'default') {
            return { name: 'default', configDir: null, source: '--profile' };
        }
        const instancePath = getInstancePath(profileFlag);
        if (!existsSync(instancePath)) {
            console.error(`❌ Profile "${profileFlag}" not found at ${instancePath}`);
            console.error(`   Run: ccs auth create ${profileFlag}`);
            process.exit(1);
        }
        return { name: profileFlag, configDir: instancePath, source: '--profile' };
    }

    // 2. Already set via CLAUDE_CONFIG_DIR (e.g. by shell/CCS)
    const currentProfile = getCurrentCcsProfile();
    if (currentProfile) {
        return { name: currentProfile, configDir: process.env.CLAUDE_CONFIG_DIR!, source: 'env' };
    }

    // 3. CCS default profile
    const { defaultProfile } = readCcsProfiles();
    if (defaultProfile) {
        const instancePath = getInstancePath(defaultProfile);
        if (existsSync(instancePath)) {
            return { name: defaultProfile, configDir: instancePath, source: 'ccs default' };
        }
        logger.debug(`[CLAUDE] CCS default profile "${defaultProfile}" instance not found, falling back to system default`);
    }

    // 4. System default
    return { name: 'default', configDir: null, source: 'default' };
}
