import { render } from "ink";
import { existsSync } from "node:fs";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { formatErrorForUser } from "@/claude/utils/errorFormatter";
import {
    applyProfileSwitch,
    getCurrentCcsProfile,
    readCcsProfiles,
} from "@/commands/bang/ccsProfiles";
import {
    accountIntentIsNewer,
    readAccountIntent,
    readSessionAccountSelection,
    resolveStartupAccountSelection,
    writeSessionAccountSelection,
} from "@/commands/bang/accountIntent";
import { queryRateLimitContext } from "@/commands/bang/usageCommand";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
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

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    // Handle messages
    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();

    function onMessage(message: SDKMessage) {

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        // Detect plan mode tool call
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                    }
                }
            }
        }

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                if (c.content === PLAN_FAKE_REJECT) {
                                    logger.debug('[remote]: hack plan mode exit');
                                    logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: {
            message: string;
            mode: EnhancedMode;
            isolate: boolean;
            hash: string;
        } | null = null;
        const savedAccount = readSessionAccountSelection(session.client.sessionId, 'claude');
        const startupAccount = resolveStartupAccountSelection(savedAccount, readAccountIntent('claude'));
        if (startupAccount && startupAccount.profileName !== getCurrentCcsProfile()) {
            const target = readCcsProfiles().profiles.find(profile => profile.name === startupAccount.profileName);
            if (!target || !existsSync(target.instancePath)) {
                throw new Error(`Selected Claude profile "${startupAccount.profileName}" is unavailable`);
            }
            applyProfileSwitch(startupAccount.profileName, 'claude', target.instancePath);
        }
        if (startupAccount?.source === 'global') {
            try {
                writeSessionAccountSelection(
                    session.client.sessionId,
                    'claude',
                    startupAccount.profileName,
                    startupAccount.seenGlobalSetAt,
                );
            } catch (error) {
                logger.warn('[remote]: Failed to persist startup account selection:', error);
            }
        }
        let lastSeenAccountIntent = startupAccount?.seenGlobalSetAt ?? 0;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            // Send restart confirmation if pending
            if (session.pendingRestartConfirmation) {
                session.pendingRestartConfirmation = false;
                const profile = getCurrentCcsProfile();
                const profileLabel = profile ? ` (${profile})` : '';
                session.client.sendSessionEvent({ type: 'message', message: `✅ 会话已重启${profileLabel}` });
                logger.debug(`[remote]: Restart confirmation sent${profileLabel}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        let msg = pending;
                        if (msg) {
                            pending = null;
                        } else {
                            msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);
                        }

                        // Check if mode has changed
                        if (msg) {
                            const intent = readAccountIntent('claude');
                            if (accountIntentIsNewer(intent, lastSeenAccountIntent)) {
                                if (intent.profileName !== getCurrentCcsProfile()) {
                                    const target = readCcsProfiles().profiles.find(profile => profile.name === intent.profileName);
                                    if (!target || !existsSync(target.instancePath)) {
                                        throw new Error(`Global Claude profile "${intent.profileName}" is unavailable`);
                                    }
                                    applyProfileSwitch(intent.profileName, 'claude', target.instancePath);
                                    pending = msg;
                                    session.client.sendSessionEvent({
                                        type: 'message',
                                        message: `🔄 Switched to "${intent.profileName}" (via !auth-all)`,
                                    });
                                }
                                lastSeenAccountIntent = intent.setAt;
                                try {
                                    writeSessionAccountSelection(
                                        session.client.sessionId,
                                        'claude',
                                        intent.profileName,
                                        intent.setAt,
                                    );
                                } catch (error) {
                                    logger.warn('[remote]: Failed to persist session account selection:', error);
                                }
                                if (pending) return null;
                            }
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            await session.client.beginDaemonSessionTurn();
                            return {
                                message: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: {
                        ...session.claudeEnvVars,
                        ...(process.env.CLAUDE_CONFIG_DIR
                            ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
                            : {}),
                    },
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onReady: () => {
                        session.client.closeClaudeSessionTurn('completed');
                        if (!pending && session.queue.size() === 0) {
                            session.api.push().sendToAllDevices(
                                '准备就绪',
                                `Claude 等待你的指令`,
                                { sessionId: session.client.sessionId }
                            );
                        }
                    },
                    onErrorResult: (message: string) => {
                        session.client.closeClaudeSessionTurn('failed');
                        const { display, raw, severity, recoverySteps } = formatErrorForUser(message);
                        logger.debug(`[remote] Error result (raw): ${raw} severity=${severity}`);
                        const profile = getCurrentCcsProfile();

                        // Build display message with recovery steps
                        const parts: string[] = [display];
                        if (profile) parts.push(`[account: ${profile}]`);

                        // Non-quota errors: show recovery steps immediately
                        if (severity !== 'quota') {
                            if (recoverySteps.length > 0) {
                                parts.push('');
                                for (const step of recoverySteps) {
                                    parts.push(`→ ${step}`);
                                }
                            }
                            session.client.sendSessionEvent({ type: 'message', message: parts.join('\n') });
                            return;
                        }

                        // Quota errors: fetch usage first, then build unified message
                        session.client.sendSessionEvent({ type: 'message', message: parts.join('\n') });

                        queryRateLimitContext().then(ctx => {
                            if (!ctx) return;

                            const lines: string[] = [];

                            // Show current usage data per window
                            if (ctx.overLimitWindows.length > 0) {
                                lines.push('📊 当前用量:');
                                for (const w of ctx.overLimitWindows) {
                                    lines.push(`  ${w.label}: ${w.utilization.toFixed(0)}% | 重置于 ${w.resetsIn} 后`);
                                }
                            }

                            // Recovery actions
                            lines.push('');
                            lines.push('可以尝试:');
                            lines.push('  → 查看用量: !usage');
                            lines.push('  → 切换账户: !auth');

                            // Show switchable profiles or suggest !login
                            if (ctx.switchableProfiles.length > 0) {
                                for (const name of ctx.switchableProfiles) {
                                    lines.push(`  → 切换到: !auth ${name}`);
                                }
                            } else if (ctx.allProfilesOverLimit) {
                                lines.push('  → 所有已登录账户均已超限，登录新账户: !login <名称>');
                            } else {
                                lines.push('  → 使用 !login <名称> 添加新账户');
                            }

                            if (lines.length > 0) {
                                session.client.sendSessionEvent({ type: 'message', message: lines.join('\n') });
                            }
                        }).catch(e => {
                            // Usage query failed — show basic recovery steps as fallback
                            logger.debug(`[remote] Rate limit context query failed: ${e}`);
                            const fallback = recoverySteps.map(s => `→ ${s}`).join('\n');
                            if (fallback) {
                                session.client.sendSessionEvent({ type: 'message', message: fallback });
                            }
                        });
                    },
                    onRateLimitEvent: (info) => {
                        // Fire-and-forget: query usage and send to mobile on rate limit
                        queryRateLimitContext().then(ctx => {
                            if (!ctx || ctx.overLimitWindows.length === 0) return;

                            const lines: string[] = ['⏳ 速率限制中...'];
                            lines.push('📊 当前用量:');
                            for (const w of ctx.overLimitWindows) {
                                lines.push(`  ${w.label}: ${w.utilization.toFixed(0)}% | 重置于 ${w.resetsIn} 后`);
                            }
                            session.client.sendSessionEvent({ type: 'message', message: lines.join('\n') });
                        }).catch(e => {
                            logger.debug(`[remote] Rate limit event usage query failed: ${e}`);
                        });
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                logger.debug('[remote]: launch error', e);
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('failed');
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;
            }
        }
    } finally {
        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        process.stdin.off('data', abort);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
