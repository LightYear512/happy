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
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '@/api/api';
import { localCommandUserText, modelFacingUserText } from '@/api/types';
import { projectPath } from '@/projectPath';
import { registerShutdownHandlers } from '@/utils/shutdownHandlers';
import { createCodexAppServerClient, type CodexAppServerClient } from './codexAppServerClient';
import {
    performCodexAccountSwap,
    CodexAccountSwapCancelled,
    requireExactCodexThreadResume,
    type AccountSwapResult,
} from './codexAccountSwap';
import { buildCodexChildEnv } from './codexEnvBuilder';
import { CodexProcessCleanupError } from './codexAppServerProcess';
import { createAppServerStreamBridge, pickTurnEndStatus, type AppServerStreamUpdate } from './appServerStreamBridge';
import { withCodexModelModeMetadata } from './modelMode';
import { resolveCodexModelModeOrDefault, readCodexModelFamily } from './defaultModelConfig';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { extractCodexErrorDetail, formatCodexErrorForUi, isCodexCapacityError } from './utils/codexErrorDetail';
import { randomUUID } from 'node:crypto';
import { diagnosticTrace, logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata, RESTORE_SESSION_STARTUP_TIMEOUT_MS, shouldRegisterMachineForSession } from '@/daemon/run';
import { MessageQueue2, type MessageQueueBatch } from '@/utils/MessageQueue2';
import { createUserInputTrace, logUserInputStage } from '@/utils/userInputTrace';
import { hashObject } from '@/utils/deterministicJson';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { systemPrompt } from '@/claude/utils/systemPrompt';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { readCodexDefaultProfile, getCodexInstancePath, getCurrentCodexProfile } from '@/commands/bang/ccsProfiles';
import {
    accountIntentIsNewer,
    readAccountIntent,
    readSessionAccountSelection,
    resolveStartupAccountSelection,
    writeSessionAccountSelection,
} from '@/commands/bang/accountIntent';
import { notifyDaemonCodexProfile } from '@/daemon/controlClient';
import { completeProviderInputReady } from '@/utils/completeProviderInputReady';
import { installHappySessionEnvironment } from '@/utils/projectSessionStartup';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerSessionTransportFatalHandler } from '@/api/registerSessionTransportFatalHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineSession } from '@/utils/setupOfflineSession';
import { resolveCodexExecutionPolicy, resolveCodexSessionPermissionMode } from './executionPolicy';
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
import { renderOptionsBlock } from '@/commands/bang/types';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { findRolloutByConversationId, getDefaultCodexSessionsRoot } from './utils/rolloutDiscovery';
import { buildHeuristicSeed } from './utils/compactSeedBuilder';
import { compactViaCodexExec, wrapL2SeedAsHeuristicSeed } from './utils/codexExecCompact';
import { loadFallbackCompactDocs } from './utils/projectFallbackDocs';
import { shouldAutoRescue, createRescueGate } from './utils/codexAutoRescue';
import { createTurnLifecycle } from './utils/turnLifecycle';
import { createRecentUserBuffer } from './utils/recentUserBuffer';
import { createCodexRawItemDiagnostics } from './utils/codexRawItemDiagnostics';
import { createHtaskReplyMonitorRuntime } from '@/commands/bang/replyMonitorRuntime';

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
    thread_id?: unknown;
    id?: unknown;
    thread?: Readonly<{ id?: unknown; threadId?: unknown; thread_id?: unknown }> | null;
}>;

type TurnLikeResponse = Readonly<{
    turnId?: unknown;
    turn_id?: unknown;
    id?: unknown;
    turn?: Readonly<{ id?: unknown; turnId?: unknown; turn_id?: unknown }> | null;
}>;

// Exported for unit tests so future protocol drift is caught at the reader
// boundary (every notification handler in this file routes through here).
export function readThreadId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as ThreadLikeResponse;
    const candidates = [
        r.threadId, r.thread_id, r.id,
        r.thread?.threadId, r.thread?.thread_id, r.thread?.id,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    }
    return null;
}

/** Publish only a durable thread: persist Happy's real bootstrap instructions first. */
export async function startCodexThread(
    client: CodexAppServerClient,
    params: Readonly<Record<string, unknown>>,
    deadlineAt?: number,
): Promise<string> {
    const response = await client.request('thread/start', params, { deadlineAt });
    const id = readThreadId(response);
    if (!id) throw new Error('Codex app-server thread/start returned no thread id');
    // An untouched thread/start is only live state in Codex. This replaces the
    // bootstrap previously prepended to the first user turn; no invented user
    // message, model turn, or hand-written rollout is needed to make it durable.
    await client.request('thread/inject_items', {
        threadId: id,
        items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: systemPrompt }] }],
    }, { deadlineAt });
    return id;
}

// codex 0.130.0 emits the turn id under a nested `turn` object in
// `turn/started` (record keys observed in production: `["threadId","turn"]`),
// and uses `turn_id` snake_case in `turn/completed` / `turn/interrupted`. The
// `turn/start` RPC response also nests it under `turn.id`. Resolving every
// flat + nested + camel/snake variant is required — otherwise the real turn
// id is lost, a locally-fabricated CUID gets sent back as `turn/interrupt`'s
// `turnId`, and codex silently rejects the stop request.
export function readTurnId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as TurnLikeResponse;
    const candidates = [
        r.turnId, r.turn_id, r.id,
        r.turn?.turnId, r.turn?.turn_id, r.turn?.id,
    ];
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
export function toSandboxPolicy(sandbox: string, directory: string): Record<string, unknown> {
    if (sandbox === 'workspace-write') {
        return {
            type: 'workspaceWrite',
            writableRoots: [directory, join(homedir(), '.xcoding-v2')],
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
    permissionMode?: PermissionMode;
    /**
     * Test-only injection seam. Production callers pass nothing → the original
     * server-backed init path runs verbatim. `session` lets a test drive the
     * runtime fully offline with a SessionLike; `apiClient` skips
     * `ApiClient.create`; `onRuntimeReady` hands back a `requestExit` so the
     * test can unblock the main loop (production's exit is Ink Ctrl-C, which is
     * unreachable without a TTY).
     */
    deps?: {
        apiClient?: ApiClient;
        session?: ApiSessionClient;
        /** Override the session working dir (sandbox roots / .happy doc lookup). */
        cwd?: string;
        /** Shorten the bounded capacity backoff in offline runtime tests. */
        capacityRetryDelaysMs?: readonly number[];
        onRuntimeReady?: (handles: { requestExit: () => void }) => void;
    };
}): Promise<void> {
    // A new session's explicit CODEX_HOME is its local account choice. Restores
    // still use the saved/global selection rules and never repin on restart.
    const explicitCodexProfile = !opts.restoreSessionId && !opts.codexSessionId
        ? getCurrentCodexProfile() ?? undefined : undefined;
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
    let activeCodexProfile = getCurrentCodexProfile();
    const accountIntentFamily = readCodexModelFamily(process.env.CODEX_HOME || join(homedir(), '.codex'));
    const readGlobalAccountIntent = () => accountIntentFamily
        ? readAccountIntent('codex', undefined, accountIntentFamily) : null;

    //
    // Session setup (mirrors runCodex)
    //

    const sessionTag = randomUUID();
    connectionState.setBackend('Codex');

    const api = opts.deps?.apiClient ?? await ApiClient.create(opts.credentials);
    logger.debug(`[CodexAppServer] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    const settings = await readSettings();
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;

    // `session` is normally created by the server-backed init below. Tests may
    // inject a SessionLike via `opts.deps.session` to drive the runtime fully
    // offline. `response` is hoisted because the restore branch reads it later.
    let session: ApiSessionClient;
    let permissionHandler: CodexPermissionHandler;
    let bindTransportFatalHandler: ((client: ApiSessionClient) => void) | null = null;
    let response: Awaited<ReturnType<typeof api.getOrCreateSession>> | undefined;

    if (opts.deps?.session) {
        session = opts.deps.session;
        session.updateMetadata((metadata) => withCodexModelModeMetadata(metadata));
    } else {
        const machineId = settings?.machineId;
        if (!machineId) {
            console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
            process.exit(1);
        }
        logger.debug(`Using machineId: ${machineId}`);
        if (shouldRegisterMachineForSession(opts.startedBy)) {
            await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });
        }

        const { state, metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId,
            startedBy: opts.startedBy,
            sandbox: sandboxConfig,
            permissionMode: opts.permissionMode,
            dangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'yolo',
        });

        if (opts.restoreSessionId) {
            response = await api.restoreSessionById(opts.restoreSessionId);
            logger.debug(`[CodexAppServer] Restored session ${opts.restoreSessionId}`);
        } else {
            response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
        }

        session = setupOfflineSession({ api, sessionTag, response }).session;
        installHappySessionEnvironment(session.sessionId);
        session.updateMetadata((metadata) => withCodexModelModeMetadata(metadata));

    }

    //
    // Message queue (same as runCodex)
    //

    const observeRawItem = createCodexRawItemDiagnostics(session.sessionId);
    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Race-recovery mirror of user prompts; snapshot is consumed by
    // /compact's seed builder to cover prompts not yet flushed to
    // rollout.jsonl. See `utils/recentUserBuffer.ts` for the full rationale.
    const recentUserBuffer = createRecentUserBuffer();

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
    let thinking = false;
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    let threadIdStored = false;
    let client: CodexAppServerClient | null = null;
    let shouldExit = false;
    type AccountSwapSource = 'global' | 'single-session';
    type AccountSwapRequest = { target: string; source: AccountSwapSource; seenSetAt: number };
    let pendingAccountSwap: AccountSwapRequest | null = null;
    let failedAccountSwap: AccountSwapRequest | null = null;
    let accountRecovery: AbortController | null = null;
    let recoveryOperation: Promise<AccountSwapResult<CodexAppServerClient>> | null = null;
    let wakeRecovery: (() => void) | null = null;
    const capacityRetryDelays = opts.deps?.capacityRetryDelaysMs ?? [10_000, 30_000, 60_000];
    let capacityRecovery: { controller: AbortController; attempts: number; waiting: boolean; stopRequested: boolean } | null = null;
    const requestExit = (): void => {
        shouldExit = true;
        capacityRecovery?.controller.abort();
        messageQueue.close();
        accountRecovery?.abort();
        turnLifecycle.finish();
        wakeRecovery?.();
    };
    const stopRuntimeClients = async (): Promise<void> => {
        requestExit();
        const retiring = client;
        client = null;
        const results = await Promise.allSettled([
            retiring?.dispose(),
            recoveryOperation?.then(async (result) => {
                if (result.ok) await result.client.dispose();
                else if (result.cleanupFailed) throw result.error;
            }),
        ]);
        for (const result of results) {
            if (result.status === 'rejected') throw result.reason;
        }
    };
    const replyMonitor = createHtaskReplyMonitorRuntime(session, 'codex', undefined, undefined, (text) => {
        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode,
            model: currentModel,
        };
        logger.debug(`[CodexAppServer] Enqueueing delivered task message: "${text.substring(0, 80)}"`);
        messageQueue.push(text, enhancedMode);
    });

    const onUserMessage = (message: import('@/api/types').UserMessage): void => {
        if (shouldExit) throw new Error('Codex runtime is closing');
        if (message.meta?.permissionMode) {
            currentPermissionMode = message.meta.permissionMode as PermissionMode;
            session.updateMetadata((metadata) => ({
                ...metadata,
                permissionMode: currentPermissionMode,
                dangerouslySkipPermissions: currentPermissionMode === 'bypassPermissions' || currentPermissionMode === 'yolo',
            }));
            logger.debug(`[CodexAppServer] Permission mode updated to: ${currentPermissionMode}`);
        }

        let messageModel = currentModel;
        if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
            messageModel = typeof message.meta.model === 'string' && message.meta.model.length > 0
                ? message.meta.model
                : undefined;
            currentModel = messageModel;
            logger.debug(`[CodexAppServer] Model mode updated to: ${currentModel || 'Codex config'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode,
            model: messageModel,
        };

        const rawText = localCommandUserText(message);
        const inputTrace = createUserInputTrace(session.sessionId, message);
        logUserInputStage('provider-callback-received', inputTrace, rawText);

        if (hasActiveInteractiveSession()) {
            logUserInputStage('interactive-input-dispatched', inputTrace, rawText);
            handleInteractiveInput(rawText);
            return;
        }

        // Intercept /compact and /clear before they reach codex.
        //
        // Background: codex app-server's auto pre-sampling compaction posts the
        // entire conversation history (~800KB) to /backend-api/codex/responses/compact.
        // On unstable proxies this fails roughly 25% of the time, which kills
        // the current turn (`willRetry: false`). There is no manual-compact
        // RPC, and asking codex to "summarize" the conversation in-place would
        // re-trigger the same broken endpoint.
        //
        // /compact implementation: read the current thread's rollout file from
        // disk, build a heuristic seed locally (no network), allocate a fresh
        // codex thread, and stash the seed so the user's NEXT prompt is
        // prepended with it. This sidesteps the broken endpoint entirely.
        //
        // /clear: no truncation RPC exists — the closest analog is a fresh
        // thread with no seed. We expose this as the same orchestrator path
        // but skip the seed.
        const specialCommand = parseSpecialCommand(rawText);
        if (specialCommand.type === 'compact' || specialCommand.type === 'clear') {
            logUserInputStage('local-command-dispatched', inputTrace, rawText, {
                command: specialCommand.type,
            });
            const verb = specialCommand.type;
            void runManualCompact(verb).catch((err) => {
                logger.warn(`[CodexAppServer] /${verb} orchestrator failed:`, err);
                session.sendSessionEvent({
                    type: 'message',
                    message: `⚠️ /${verb} 失败`,
                });
                session.sendSessionEvent({ type: 'ready' });
            });
            return;
        }

        if (isBangCommand(rawText)) {
            logUserInputStage('local-command-dispatched', inputTrace, rawText, { command: 'bang' });
            const claudeShapedMode: ClaudeEnhancedMode = {
                permissionMode: enhancedMode.permissionMode,
                model: enhancedMode.model,
            };
            executeBangCommand(rawText, {
                client: session,
                session: { mode: 'remote' },
                messageQueue: messageQueue as unknown as MessageQueue2<ClaudeEnhancedMode>,
                currentEnhancedMode: claudeShapedMode,
                isConsoleSession: false,
                flavor: 'codex',
                deferCodexProfileSwitch: true,
                codexRuntimeReady: client !== null && failedAccountSwap === null && accountRecovery === null,
                codexRecoveryTarget: failedAccountSwap?.target,
            }).then(async result => {
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
                // Route a bang-requested session restart through the same
                // pendingAccountSwap path used by the input-boundary global
                // account check. Without this, !auth --codex only updates
                // process.env.CODEX_HOME in the parent — the running codex
                // app-server child still has the old auth in its frozen env,
                // so the success message ("✅ 已切换到 X") is a lie. The swap
                // path disposes the child and respawns it with the new env;
                // the savedThreadId hand-off keeps the conversation intact.
                if (result.action === 'restart-session') {
                    if (shouldExit) return;
                    const target = result.restartProfile || failedAccountSwap?.target || activeCodexProfile;
                    if (!target) throw new Error('No Codex profile selected for restart');
                    logger.debug(`[CodexAppServer] Single-session swap requested → ${target}`);
                    pendingAccountSwap = {
                        target,
                        source: 'single-session',
                        seenSetAt: result.restartSeenGlobalSetAt ?? readGlobalAccountIntent()?.setAt ?? 0,
                    };
                    accountRecovery?.abort();
                    capacityRecovery?.controller.abort();
                    wakeRecovery?.();
                    messageQueue.interrupt();
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

        // Synchronous ownership transfer: ApiSession advances its persisted
        // cursor only after this callback returns, so a closed queue must throw
        // here rather than acknowledge input that was not accepted.
        const text = modelFacingUserText(message);
        messageQueue.push(text, enhancedMode, inputTrace);
        if (capacityRecovery?.waiting) capacityRecovery.controller.abort();
        // A new input is also a bounded retry request. Claim the failed target
        // synchronously so a burst joins this recovery instead of cancelling or
        // spawning it repeatedly. Existing pending input keeps its original owner.
        if (failedAccountSwap && !pendingAccountSwap) {
            pendingAccountSwap = failedAccountSwap;
            failedAccountSwap = null;
        }
        wakeRecovery?.();
        logUserInputStage('provider-queue-enqueued', inputTrace, text, {
            queueDepth: messageQueue.size(),
        });
        replyMonitor.observeUserMessage();
    };

    const restoreSessionId = opts.restoreSessionId;

    //
    // Runtime state
    //

    // /compact state. When the user runs /compact we read the current rollout
    // file, build a heuristic seed locally, allocate a fresh codex thread, and
    // stash the seed in `compactState.pendingSeedText` so the next turn
    // prepends it to the user's prompt. The holder object keeps the type as
    // `string | null` at the read site (a bare `let` would get narrowed to
    // `null` by TS control-flow analysis since the writer lives in a different
    // closure). `compactInFlight` is the one swap barrier shared by concurrent
    // /compact calls and the turn consumer. User input is still accepted into
    // MessageQueue2 immediately; only consumption waits for the thread swap.
    const compactState: { pendingSeedText: string | null } = { pendingSeedText: null };
    let compactInFlight: Promise<void> | null = null;

    // SSoT for the codex session working directory — the same value used for
    // sandbox writableRoots and the turn-message cwd. Project-level fallback
    // docs (.happy/on-fallback-compact.md) are resolved relative to it.
    const sessionCwd = opts.deps?.cwd ?? process.cwd();
    const startFreshThread = async (
        requestClient: CodexAppServerClient,
        permissionMode: PermissionMode,
        model: string | undefined,
        deadlineAt?: number,
    ): Promise<string> => {
        const executionPolicy = resolveCodexExecutionPolicy(permissionMode, !!sandboxConfig);
        const modelConfig = resolveCodexModelModeOrDefault(model);
        const freshThreadId = await startCodexThread(requestClient, {
            cwd: sessionCwd,
            approvalPolicy: toApprovalPolicy(executionPolicy.approvalPolicy),
            sandbox: executionPolicy.sandbox,
            ...(modelConfig.model ? { model: modelConfig.model } : {}),
            ...(modelConfig.reasoningEffort ? { config: { model_reasoning_effort: modelConfig.reasoningEffort } } : {}),
            experimentalRawEvents: true,
            persistExtendedHistory: true,
        }, deadlineAt);
        needsSystemPromptInjection = false;
        logger.debug(`[CodexAppServer] Started thread: ${freshThreadId}`);
        return freshThreadId;
    };

    // One recovery per consecutive failure streak. Only a completed model
    // turn rearms this gate; ready events and timer ticks cannot do so.
    const autoRescueGate = createRescueGate();
    const turnOutcome: { status: 'completed' | 'failed' | 'cancelled'; detail?: string; capacity?: boolean } = { status: 'cancelled' };
    let lastTerminalTurnId: string | null = null;

    // Pending turn tracking — turn/start RPC returns immediately (non-blocking).
    // We await `turnLifecycle.current` which is settled by the turn/completed,
    // turn/interrupted, error notification handlers, or the turn-loop catch
    // block on RPC failure.
    //
    // Protocol invariant: `turnLifecycle.finish` is the SINGLE EXIT for the
    // pending state. Every transition (success, interrupt, error notification,
    // RPC failure) must go through it. See `utils/turnLifecycle.ts` for the
    // state-machine contract; covered by `turnLifecycle.test.ts`.
    const turnLifecycle = createTurnLifecycle();

    // /compact + /clear orchestrator. Reads the rollout for the current thread,
    // builds a local heuristic seed (compact mode only), then resets thread
    // state so the next turn allocates a fresh codex conversation. The seed is
    // stashed in `compactState.pendingSeedText` and prepended at the next `turn/start`.
    async function runManualCompact(
        mode: 'compact' | 'clear',
        autoTriggered: boolean = false,
    ): Promise<boolean> {
        // User-facing label for /compact: "本地压缩" when triggered by us
        // (auto-rescue or unknown), "/compact" when typed by the user. Avoid
        // surfacing "auto-rescue" — it's an internal abstraction.
        const compactLabel = autoTriggered ? '本地压缩' : '/compact';
        const opLabel = mode === 'compact' ? compactLabel : '/clear';

        if (compactInFlight) {
            session.sendSessionEvent({
                type: 'message',
                message: `⚠️ ${opLabel} 进行中`,
            });
            session.sendSessionEvent({ type: 'ready' });
            return false;
        }
        if (!client || accountRecovery || failedAccountSwap || shouldExit) {
            session.sendSessionEvent({
                type: 'message',
                message: `ℹ️ ${opLabel} 暂不可用`,
            });
            session.sendSessionEvent({ type: 'ready' });
            return false;
        }
        const previousThreadId = threadId;
        if (!previousThreadId) {
            session.sendSessionEvent({
                type: 'message',
                message: `ℹ️ ${opLabel}：当前无对话`,
            });
            session.sendSessionEvent({ type: 'ready' });
            return false;
        }

        capacityRecovery?.controller.abort();

        let finishCompact!: () => void;
        compactInFlight = new Promise<void>((resolve) => { finishCompact = resolve; });
        try {
            // If a turn is in flight, wait for it to settle before swapping
            // threads — interrupting mid-stream loses partial output, while
            // waiting yields a clean handoff.
            //
            // No timeout here: the turn-lifecycle state machine guarantees
            // every terminal signal (turn/completed, turn/interrupted, error
            // notification, RPC failure) routes through `turnLifecycle.finish`,
            // so the promise can never hang. `.catch` swallows reject because
            // we only need the "settled" signal — the actual error has already
            // been surfaced via the session event stream.
            const pending = turnLifecycle.current;
            if (pending) {
                await pending.catch(() => {});
            }

            let seedText: string | null = null;
            let seedStats: Awaited<ReturnType<typeof buildHeuristicSeed>>['stats'] | null = null;

            if (mode === 'compact') {
                // Emit the protocol-level "Compaction started" string. happy-app
                // renders this verbatim and it's the standard ack contract used
                // by Claude (`claudeRemote.ts:118`).
                session.sendSessionEvent({ type: 'message', message: 'Compaction started' });

                const sessionsRoot = getDefaultCodexSessionsRoot();
                const rolloutPath = await findRolloutByConversationId(sessionsRoot, previousThreadId);
                if (!rolloutPath) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: `⚠️ ${compactLabel} 失败：会话历史不存在`,
                    });
                    session.sendSessionEvent({ type: 'ready' });
                    return false;
                }
                const built = await buildHeuristicSeed({
                    rolloutPath,
                    trailerNote: '请基于以上摘要继续。',
                    // Race-recovery snapshot: any prompt accepted into the
                    // queue but not yet flushed by codex into rollout.jsonl.
                    // `snapshot()` returns a copy, so user input accepted into
                    // MessageQueue2 during this await cannot mutate the seed's
                    // frozen recovery view.
                    extraUserTexts: recentUserBuffer.snapshot(),
                });
                seedText = built.seedText;
                seedStats = built.stats;
                logger.debug(`[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact heuristic seed: rollout=${rolloutPath} stats=${JSON.stringify(seedStats)} chars=${seedText.length}`);

                // Step 2: try LLM-driven compaction in a fresh `codex exec`
                // process, using the heuristic seed as input. The fresh
                // process has its own clean context, so it works even when
                // the live thread has overflowed (which is exactly when the
                // user hits /compact). On any failure — timeout, network,
                // auth, missing binary — we transparently keep the heuristic
                // seed as fallback. See codexExecCompact.ts for empirical
                // tuning and full pipeline rationale.
                const l2 = await compactViaCodexExec({
                    heuristicSeed: built.seedText,
                    codexHome: process.env.CODEX_HOME,
                });

                // Always: update seedText based on L2 result. This is what
                // gets injected into the next thread's first user message,
                // and applies regardless of auto-trigger.
                if (l2.summary) {
                    // Re-append the heuristic's verbatim recent-turns block
                    // after the L2 narrative. L2 sees the recent block as
                    // input (so its narrative is shaped by current focus),
                    // but its ≤1500 字 叙事 prompt is allowed to compress
                    // user/assistant content; without this re-splice, the
                    // "recent K turns kept verbatim" contract that
                    // `composeSeed` enforces in the heuristic would silently
                    // die at the L2 boundary. The verbatim guarantee is now
                    // code-enforced, not model-dependent.
                    const body = built.recentBlock
                        ? `${l2.summary}\n${built.recentBlock}`
                        : l2.summary;
                    seedText = wrapL2SeedAsHeuristicSeed(body, '请基于以上摘要继续。');
                    logger.debug(
                        `[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact L2 succeeded: ${l2.elapsedMs}ms summary=${l2.summary.length} recentBlock=${built.recentBlock.length} seed=${seedText.length}`,
                    );
                } else if (l2.skipped === 'short_circuit') {
                    logger.debug(
                        `[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact L2 skipped (heuristic short enough): ${l2.error}`,
                    );
                } else {
                    logger.debug(
                        `[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact L2 fallback to heuristic: ${l2.elapsedMs}ms error=${l2.error}`,
                    );
                }

                // No visible summary surfaced to the chat. Tried several
                // envelopes (sendSessionEvent / sendCodexMessage /
                // sendClaudeSessionMessage with type:'summary') — each had
                // either wrong styling or a metadata side effect that
                // contaminated the session title. Until happy-app exposes
                // a codex-specific visible-summary block, we keep the
                // legacy behavior: the protocol-level "Compaction started"
                // / "Compaction completed" banners are enough signalling.
                // The seed itself is still injected on the next turn.

                // Append project-level fallback docs (.happy/on-fallback-compact.md),
                // read fresh from disk every compaction so the user's authoritative
                // project context survives the compaction. Wrapped in PROJECT_DOCS
                // sentinels so the next compaction's seed builder strips them rather
                // than accumulating them into the compacted bucket.
                if (seedText) {
                    const projectDocs = await loadFallbackCompactDocs(sessionCwd);
                    if (projectDocs) {
                        seedText += projectDocs;
                        logger.debug(`[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact appended .happy docs (${projectDocs.length} chars)`);
                    }
                }
            }

            // Reset thread state. The turn loop's `if (!threadId)` branch will
            // call `thread/start` next iteration, allocating a fresh codex
            // conversation. Clearing `threadIdStored` lets the notification
            // handler refresh happy session metadata with the new threadId.
            threadId = null;
            threadIdStored = false;
            opts.codexSessionId = undefined;
            compactState.pendingSeedText = seedText;

            // Reset the race-recovery buffer in lock-step with the thread
            // swap. Without this, prompts from the *prior* thread would be
            // injected as `extraUserTexts` on the NEXT /compact, defeating
            // SEED_SENTINEL's discard-older invariant (they'd reappear
            // alongside the prior seed's compacted bucket → reverse the
            // compaction work). The newly-started thread begins with an
            // empty rollout AND an empty buffer; prompts that arrive after
            // this point will populate both in sync.
            recentUserBuffer.clear();
            logger.debug(`[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/${mode} completed`);

            // Protocol-level completion event. happy-app reducer matches these
            // exact strings (`Compaction completed` / `Context was reset`) to
            // reset contextSize → the in-app context-usage bar drops to zero,
            // matching the Claude /compact UX.
            const completionMessage = mode === 'compact' ? 'Compaction completed' : 'Context was reset';
            session.sendSessionEvent({ type: 'message', message: completionMessage });
            session.sendSessionEvent({ type: 'ready' });

            // Auto-rescue resume: push a synthetic "继续" so the turn loop
            // re-enters with the freshly stashed seed. Without this, the user
            // would have to manually type something (log analysis: 54.6% of
            // users type exactly "继续"; another ~25% type a near-equivalent
            // catch-up phrase; total replay rate ~80%). M1 is NOT re-pushed —
            // it already lives in the seed's recent block, so re-injecting it
            // would duplicate the user turn and confuse referential phrases
            // like "开始吧". "继续" mirrors what users do today, byte-for-byte.
            // Manual /compact stays user-driven (no auto-replay).
            if (mode === 'compact' && autoTriggered) {
                const replayText = '继续';
                const replayMode: EnhancedMode = {
                    permissionMode: currentPermissionMode,
                    model: currentModel,
                };
                messageQueue.push(replayText, replayMode);
                logger.debug(`[CodexAppServer] [auto] /compact resume: pushed '${replayText}' to queue`);
            }
            return true;
        } finally {
            finishCompact();
            compactInFlight = null;
        }
    }


    let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

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
                requestExit();
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

    const bridge = createAppServerStreamBridge();

    // Without these, the main loop has no path to reach client.dispose() on
    // signal and codex.exe orphans. Nulling `client` first makes the finally
    // block's dispose a no-op so we don't double-dispose.
    const removeShutdownHandlers = registerShutdownHandlers(async () => {
        logger.debug('[CodexAppServer] Received shutdown signal, disposing client and flushing');
        try { await stopRuntimeClients(); } catch (error) {
            diagnosticTrace('[CODEX] Shutdown cleanup failed', String(error));
        }
        try {
            replyMonitor.dispose();
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

    // Fresh threads persist these instructions during creation. Keep the
    // existing first-turn injection for an explicit resume of an outside
    // Codex thread; a restored Happy session already has its bootstrap.
    let needsSystemPromptInjection = !opts.restoreSessionId;

    // Accumulate streaming text deltas — send as one message on turn completion
    let pendingAgentText = '';
    let lastDeliveredAgentText: string | null = null;

    //
    // Process bridge updates — maps AppServerStreamUpdate into session events
    //

    function processBridgeUpdates(updates: AppServerStreamUpdate[]): void {
        for (const update of updates) {
            switch (update.type) {
                case 'envelope': {
                    const envelope = update.envelope;
                    replyMonitor.observeReceiveActivity(`envelope:${envelope.ev.t}`);
                    logger.debug(`[CodexAppServer] DISPATCH envelope t=${envelope.ev.t} id=${envelope.id} turn=${envelope.turn ?? 'none'} time=${envelope.time}`);
                    session.sendSessionProtocolMessage(envelope);
                    // Older happy-app builds render codex content, not session
                    // envelopes. Dual-send in the legacy shape per-segment so
                    // text and tool-calls stay in the order codex emitted them.
                    if (envelope.ev.t === 'tool-call-start') {
                        logger.debug(`[CodexAppServer] DISPATCH codex-legacy tool-call callId=${envelope.ev.call} name=${envelope.ev.name}`);
                        session.sendCodexMessage({
                            type: 'tool-call',
                            callId: envelope.ev.call,
                            id: envelope.id,
                            name: envelope.ev.name,
                            input: envelope.ev.args,
                        });
                    } else if (envelope.ev.t === 'tool-call-end') {
                        logger.debug(`[CodexAppServer] DISPATCH codex-legacy tool-call-result callId=${envelope.ev.call}`);
                        session.sendCodexMessage({
                            type: 'tool-call-result',
                            callId: envelope.ev.call,
                            id: envelope.id,
                            output: null,
                        });
                    } else if (envelope.ev.t === 'text') {
                        const text = envelope.ev.text;
                        logger.debug(`[CodexAppServer] DISPATCH codex-legacy message id=${envelope.id} len=${text.length}`);
                        messageBuffer.addMessage(text, 'assistant');
                        session.sendCodexMessage({
                            type: 'message',
                            message: text,
                            id: envelope.id,
                        });
                        // Segment finalized — drop any accumulated deltas so
                        // turn-aborted fallback doesn't replay delivered text.
                        pendingAgentText = '';
                        lastDeliveredAgentText = text.trim();
                    }
                    break;
                }

                case 'receive-activity':
                    replyMonitor.observeReceiveActivity(update.reason);
                    break;

                case 'agent-message':
                    replyMonitor.observeReceiveActivity('agent-message');
                    // Buffer deltas only for the turn-aborted fallback below.
                    // The authoritative delivery happens on item/completed via
                    // the envelope t:'text' branch above.
                    pendingAgentText += update.message;
                    break;

                case 'reasoning-delta':
                    replyMonitor.observeReceiveActivity('reasoning-delta');
                    reasoningProcessor.processDelta(update.delta);
                    break;

                case 'reasoning-final':
                    replyMonitor.observeReceiveActivity('reasoning-final');
                    reasoningProcessor.complete(update.text);
                    break;

                case 'turn-diff':
                    replyMonitor.observeReceiveActivity('turn-diff');
                    diffProcessor.processDiff(update.unifiedDiff);
                    break;

                case 'task-started': {
                    replyMonitor.beginActiveReply('task-started');
                    activeTurnId = update.turnId;
                    pendingAgentText = '';
                    lastDeliveredAgentText = null;
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
                    replyMonitor.endActiveReply('task-complete');
                    if (thinking) {
                        logger.debug('[CodexAppServer] thinking completed');
                        thinking = false;
                        session.keepAlive(thinking, 'remote');
                    }
                    // Codex normally finalizes each message through
                    // item/completed. Some protocol shapes only provide deltas
                    // (or only lastAgentMessage on turn/completed), so preserve
                    // the final answer here when no equivalent segment was sent.
                    const completedText = update.lastAgentMessage?.trim() ?? '';
                    const bufferedText = pendingAgentText.trim();
                    const fallbackText = completedText && completedText !== lastDeliveredAgentText
                        ? completedText
                        : bufferedText;
                    if (fallbackText && fallbackText !== lastDeliveredAgentText) {
                        messageBuffer.addMessage(fallbackText, 'assistant');
                        session.sendCodexMessage({
                            type: 'message',
                            message: fallbackText,
                            id: randomUUID(),
                        });
                    }
                    pendingAgentText = '';
                    lastDeliveredAgentText = null;
                    messageBuffer.addMessage('Task completed', 'status');
                    diffProcessor.reset();
                    activeTurnId = null;
                    break;
                }

                case 'turn-aborted': {
                    replyMonitor.endActiveReply('turn-aborted');
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
                    lastDeliveredAgentText = null;
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
        if (capacityRecovery) capacityRecovery.stopRequested = true;
        capacityRecovery?.controller.abort();
        try {
            if (client && threadId && activeTurnId) {
                logger.debug(`[CodexAppServer] Interrupting turn ${activeTurnId} on thread ${threadId}`);
                await client.request('turn/interrupt', { threadId, turnId: activeTurnId });
            }
        } catch (error) {
            // logToFile uses JSON.stringify which swallows Error.message
            // (non-enumerable); stringify the message explicitly so future
            // protocol regressions surface in logs instead of showing `{}`.
            const detail = error instanceof Error ? error.message : String(error);
            logger.debug(`[CodexAppServer] Error during abort: ${detail}`);
        } finally {
            replyMonitor.endActiveReply('abort');
        }
    }

    const handleKillSession = async () => {
        logger.debug('[CodexAppServer] Kill session requested - terminating process');
        requestExit();

        try {
            await stopRuntimeClients();
            if (session) {
                replyMonitor.dispose();
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

    let removeTransportFatalHandler = () => {};
    bindTransportFatalHandler = (boundSession) => {
        removeTransportFatalHandler();
        removeTransportFatalHandler = registerSessionTransportFatalHandler(boundSession, async (snapshot) => {
            logger.warn(`[CodexAppServer] Happy transport became terminal (${snapshot.state}); shutting down the unreachable runtime`);
            requestExit();
            const hardExit = setTimeout(() => process.exit(1), 5_000);
            hardExit.unref();
            await stopRuntimeClients();
        });
    };
    bindTransportFatalHandler(session);

    //
    // Main loop
    //

    const stopFailedRecovery = (detail: string): void => {
        logger.warn('[CodexAppServer] Automatic context recovery stopped:', detail);
        session.sendSessionEvent({
            type: 'message',
            message: `⚠️ 上下文自动恢复未成功，已停止本会话进程以避免反复请求。历史已保留；修复账号或服务后可重新打开会话。\n${detail}`,
        });
        requestExit();
    };

    const handleTurnFailure = (params: unknown): void => {
        turnOutcome.status = 'failed';
        turnOutcome.detail = extractCodexErrorDetail(params);
        turnOutcome.capacity = isCodexCapacityError(params);
        lastTerminalTurnId = readTurnId(params) ?? activeTurnId;
        processBridgeUpdates(bridge.onNotification('error', params));
        activeTurnId = null;
        turnLifecycle.finish();
        replyMonitor.endActiveReply('error');
        // The turn consumer continues the existing thread after a bounded
        // backoff. Never replay the accepted user input or switch its model.
        if (turnOutcome.capacity && capacityRecovery
            && !capacityRecovery.controller.signal.aborted
            && capacityRecovery.attempts < capacityRetryDelays.length) return;
        if (shouldAutoRescue(params)) {
            if (compactInFlight) return; // A user-requested compaction already owns the handoff.
            if (!autoRescueGate.tryClaim()) {
                stopFailedRecovery(turnOutcome.detail);
                return;
            }
            logger.warn('[CodexAppServer] Auto-rescue triggered for unusable context:', params);
            void runManualCompact('compact', true).then((recovered) => {
                if (!recovered) stopFailedRecovery('本地压缩无法完成');
            }).catch((error) => {
                stopFailedRecovery(error instanceof Error ? error.message : String(error));
            });
            return;
        }
        logger.warn('[CodexAppServer] Codex error notification:', params);
        session.sendSessionEvent({ type: 'message', message: formatCodexErrorForUi(turnOutcome.detail) });
    };

    // Attach all notification + request handlers to a codex app-server client.
    // Extracted so we can rebind the same callbacks onto a fresh client instance
    // after a !auth-all --codex swap. All captured vars (bridge, threadId, session,
    // permissionHandler, ...) are in the enclosing function's lexical scope, so
    // a swap is transparent — the new client's events route through the same
    // happy-session state as the old one.
    const registerClientHandlers = (c: CodexAppServerClient) => {
        lastTerminalTurnId = null; // The retired client's callbacks are fenced by client identity.
        const registerNotification: CodexAppServerClient['registerNotificationHandler'] = (method, handler) =>
            c.registerNotificationHandler(method, (params) => {
                if (c === client && !shouldExit) return handler(params);
            });
        const registerRequest: CodexAppServerClient['registerRequestHandler'] = (method, handler) =>
            c.registerRequestHandler(method, (params, message) => {
                if (c !== client || shouldExit) throw new Error('Codex client is not the active session owner');
                return handler(params, message);
            });
        const isRootThreadNotification = (method: string, params: unknown): boolean => {
            const notificationThreadId = readThreadId(params);
            if (threadId && notificationThreadId && notificationThreadId !== threadId) {
                logger.debug(
                    `[CodexAppServer] Ignoring child-thread ${method} threadId=${notificationThreadId} (root=${threadId})`,
                );
                return false;
            }
            return true;
        };

        registerNotification('turn/started', (params) => {
            if (!isRootThreadNotification('turn/started', params)) return;
            const updates = bridge.onNotification('turn/started', params);
            // Extract turnId from notification
            const notifTurnId = readTurnId(params);
            if (notifTurnId) {
                activeTurnId = notifTurnId;
            }
            processBridgeUpdates(updates);
        });

        const acceptsTerminalNotification = (method: string, params: unknown): boolean => {
            if (!isRootThreadNotification(method, params) || !turnLifecycle.current) return false;
            const id = readTurnId(params);
            if (id && (id === lastTerminalTurnId || (activeTurnId && id !== activeTurnId))) {
                logger.debug(`[CodexAppServer] Ignoring stale ${method} turnId=${id} (active=${activeTurnId})`);
                return false;
            }
            return true;
        };

        registerNotification('turn/completed', (params) => {
            if (!acceptsTerminalNotification('turn/completed', params)) return;
            const status = pickTurnEndStatus(params, 'turn/completed');
            if (status === 'failed') {
                handleTurnFailure(params);
                return;
            }
            turnOutcome.status = status;
            lastTerminalTurnId = readTurnId(params) ?? activeTurnId;
            processBridgeUpdates(bridge.onNotification('turn/completed', params));
            activeTurnId = null;
            turnLifecycle.finish();
            if (status === 'completed') autoRescueGate.resetAfterSuccess();
        });

        registerNotification('turn/interrupted', (params) => {
            if (!acceptsTerminalNotification('turn/interrupted', params)) return;
            turnOutcome.status = 'cancelled';
            lastTerminalTurnId = readTurnId(params) ?? activeTurnId;
            processBridgeUpdates(bridge.onNotification('turn/interrupted', params));
            activeTurnId = null;
            turnLifecycle.finish();
        });

        registerNotification('item/agentMessage/delta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/agentMessage/delta', params));
        });

        registerNotification('item/plan/delta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/plan/delta', params));
        });

        registerNotification('item/reasoning/summaryTextDelta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/reasoning/summaryTextDelta', params));
        });

        registerNotification('item/reasoning/textDelta', (params) => {
            processBridgeUpdates(bridge.onNotification('item/reasoning/textDelta', params));
        });

        registerNotification('turn/diff/updated', (params) => {
            processBridgeUpdates(bridge.onNotification('turn/diff/updated', params));
        });

        registerNotification('item/started', (params) => {
            processBridgeUpdates(bridge.onNotification('item/started', params));
        });

        registerNotification('item/completed', (params) => {
            processBridgeUpdates(bridge.onNotification('item/completed', params));
        });

        registerNotification('rawResponseItem/completed', (params) => {
            observeRawItem(params);
            processBridgeUpdates(bridge.onNotification('rawResponseItem/completed', params));
        });

        registerNotification('error', (params) => {
            const record = params as Record<string, unknown> | null;
            if (record?.willRetry === true) return;
            if (!acceptsTerminalNotification('error', params)) return;
            handleTurnFailure(params);
        });

        // Register server request handlers for approval flows
        registerRequest('item/commandExecution/requestApproval', async (params) => {
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

        registerRequest('item/fileChange/requestApproval', async (params) => {
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
        registerRequest('mcpServer/elicitation/request', async (_params) => {
            logger.debug('[CodexAppServer] Auto-approving MCP elicitation request');
            return { action: 'accept', content: {} };
        });
    };

    // Set by both swap entry points: a global target discovered immediately
    // before real model input and the bang dispatcher (single-session !auth).
    // Consumed at top-of-loop: builds a candidate with the target CODEX_HOME,
    // resumes the exact current thread, then replaces the old client. `source`
    // drives the user-visible status message so the wording matches the path
    // that triggered it (mirrors claude-side `(via !auth-all)` for global vs
    // a bare `(via !auth)` for the single-session swap).
    const savedAccount = readSessionAccountSelection(session.sessionId, 'codex');
    let lastSeenAccountIntent = savedAccount?.seenGlobalSetAt ?? 0;
    const rememberAccountIntent = (profileName: string, setAt: number): void => {
        lastSeenAccountIntent = setAt;
        try {
            writeSessionAccountSelection(session.sessionId, 'codex', profileName, setAt);
        } catch (error) {
            // The in-process scalar is sufficient until restart. On restart the
            // same global target is sampled again and the marker write retries.
            logger.warn('[CodexAppServer] Failed to persist session account selection:', error);
        }
    };
    const expectedProviderSessionId = opts.codexSessionId;

    const selectionIsCurrent = (selection: { seenSetAt: number }): boolean =>
        !shouldExit && !pendingAccountSwap
        && !accountIntentIsNewer(readGlobalAccountIntent(), selection.seenSetAt);

    const sampleAccountIntent = (): boolean => {
        const intent = readGlobalAccountIntent();
        if (accountIntentIsNewer(intent, pendingAccountSwap?.seenSetAt ?? lastSeenAccountIntent)) {
            if (!pendingAccountSwap && !failedAccountSwap && client && intent.profileName === activeCodexProfile) {
                rememberAccountIntent(intent.profileName, intent.setAt);
            } else {
                pendingAccountSwap = { target: intent.profileName, source: 'global', seenSetAt: intent.setAt };
            }
        }
        return pendingAccountSwap !== null;
    };

    // Both startup and live account handoff own one bounded recovery operation.
    // Startup inherits the daemon deadline; live recovery gets one new budget.
    // A ready client's later model turns never inherit the recovery deadline.
    const openAccountClient = async (
        selection: { target: string | null; seenSetAt: number },
        exactThreadId: string | null,
        deadlineAt?: number,
    ): Promise<AccountSwapResult<CodexAppServerClient>> => {
        const controller = new AbortController();
        accountRecovery = controller;
        const previous = client;
        const modelConfig = resolveCodexModelModeOrDefault(currentModel);
        const executionPolicy = resolveCodexExecutionPolicy(currentPermissionMode, !!sandboxConfig);
        const operation = performCodexAccountSwap({
            currentClient: previous,
            threadId: exactThreadId,
            isCurrent: () => !controller.signal.aborted && selectionIsCurrent(selection),
            onCurrentRetired: () => { if (client === previous) client = null; },
            retireBeforeResume: previous !== null && selection.target === activeCodexProfile,
            // A resume consumes its recovery budget once; cold retry would
            // discard progress and cannot fix an exhausted history-read budget.
            recoverResumeTimeout: false,
            createCandidate: async () => {
                const targetHome = selection.target ? getCodexInstancePath(selection.target) : process.env.CODEX_HOME;
                if (selection.target && (!targetHome || !existsSync(join(targetHome, 'auth.json')))) {
                    throw new Error(`Selected Codex profile "${selection.target}" is unavailable`);
                }
                const envBuild = buildCodexChildEnv({
                    baseEnv: { ...process.env, ...(targetHome ? { CODEX_HOME: targetHome } : {}) },
                    logTag: 'CodexAppServer:restore',
                });
                return createCodexAppServerClient({
                    configOverrides: mcpServerConfigOverrides, processEnv: envBuild.env,
                    signal: controller.signal, deadlineAt,
                });
            },
            prepareCandidate: registerClientHandlers,
            resumeCandidate: async (candidate, id) => {
                const response = await candidate.request('thread/resume', {
                    threadId: id,
                    approvalPolicy: toApprovalPolicy(executionPolicy.approvalPolicy),
                    sandbox: executionPolicy.sandbox,
                    ...(modelConfig.model ? { model: modelConfig.model } : {}),
                    ...(modelConfig.reasoningEffort ? { config: { model_reasoning_effort: modelConfig.reasoningEffort } } : {}),
                    excludeTurns: true,
                }, {
                    deadlineAt,
                    // Cold history reconstruction may exceed the ordinary RPC timeout.
                    // Use the remaining startup budget instead of discarding its progress
                    // after 30 seconds; the same absolute deadline still bounds recovery.
                    ...(deadlineAt === undefined ? {} : { timeoutMs: deadlineAt - Date.now() }),
                });
                return requireExactCodexThreadResume(readThreadId(response), id);
            },
        });
        recoveryOperation = operation;
        try { return await operation; }
        finally {
            if (accountRecovery === controller) accountRecovery = null;
        }
    };

    try {
        // Create app-server client. Build the child env via the shared helper so
        // codex sees the same proxy/dotenv treatment as `!login codex` — including
        // ~/.codex/.env inject and upper↔lower case mirroring (Reqwest only honors
        // the lowercase form). Without this, a daemon launched without proxy env
        // would spawn codex with no proxy and fail wss://chatgpt.com CONNECT. The
        // helper emits its own snapshot log line under the same tag.
        const rawDeadline = opts.startedBy === 'daemon' ? process.env.HAPPY_SESSION_STARTUP_DEADLINE_MS : undefined;
        if (rawDeadline !== undefined && (!Number.isSafeInteger(Number(rawDeadline)) || Number(rawDeadline) <= 0)) {
            throw new Error('Invalid daemon session startup deadline');
        }
        // Reserve two seconds inside the parent budget for readiness publication.
        // The daemon leaves another six seconds before the 30-second relay for cleanup.
        // Never give a second resume a fresh budget.
        const startupDeadlineAt = rawDeadline === undefined
            ? (expectedProviderSessionId ? Date.now() + RESTORE_SESSION_STARTUP_TIMEOUT_MS : undefined)
            : Number(rawDeadline) - 2_000;
        let startupSeenSetAt = 0;
        while (!shouldExit) {
            const startupAccount = resolveStartupAccountSelection(savedAccount, readGlobalAccountIntent(), explicitCodexProfile);
            const selection = {
                target: startupAccount?.profileName ?? activeCodexProfile,
                seenSetAt: startupAccount?.seenGlobalSetAt ?? 0,
            };
            const result = await openAccountClient(selection, expectedProviderSessionId ?? null, startupDeadlineAt);
            if (!result.ok) {
                recoveryOperation = null;
                if (result.cleanupFailed) throw result.error;
                if (!shouldExit && !selectionIsCurrent(selection)) continue;
                throw result.error;
            }
            if (!selectionIsCurrent(selection)) {
                await result.client.dispose();
                recoveryOperation = null;
                continue;
            }
            client = result.client;
            recoveryOperation = null;
            threadId = result.threadId;
            if (selection.target) {
                activeCodexProfile = selection.target;
                process.env.CODEX_HOME = getCodexInstancePath(selection.target);
                startupSeenSetAt = selection.seenSetAt;
            }
            if (expectedProviderSessionId) {
                threadIdStored = true;
                opts.codexSessionId = undefined;
            }
            break;
        }
        if (shouldExit || !client) throw new CodexAccountSwapCancelled();

        // A daemon spawn is not ready until it owns a restorable provider
        // identity. Allocate the Codex thread without starting a model turn,
        // persist it, then publish the daemon webhook that resolves spawnSession.
        if (!threadId && opts.startedBy === 'daemon' && !opts.restoreSessionId && !opts.codexSessionId) {
            threadId = await startFreshThread(client, currentPermissionMode, currentModel, startupDeadlineAt);
            // completeProviderInputReady persists the identity once, before
            // the daemon can acknowledge readiness. Do not spend the startup
            // budget on a duplicate metadata round trip here.
        }

        if (shouldExit || !client) throw new CodexAccountSwapCancelled();
        if (activeCodexProfile) rememberAccountIntent(activeCodexProfile, startupSeenSetAt);
        if (response) {
            await completeProviderInputReady({
                session,
                expectedHappySessionId: response.id,
                reconcilePersistedInputs: Boolean(restoreSessionId),
                providerSessionId: threadId ?? undefined,
                expectedProviderSessionId,
                onUserMessage,
                isCancelled: () => shouldExit,
            });
            if (threadId) threadIdStored = true;
            if (shouldExit) throw new CodexAccountSwapCancelled();
            if (opts.startedBy === 'daemon' && activeCodexProfile) {
                const profileRegistration = await notifyDaemonCodexProfile(response.id, activeCodexProfile);
                if (profileRegistration.error) {
                    throw new Error(`Daemon Codex profile registration failed: ${profileRegistration.error}`);
                }
            }
        } else {
            if (threadId && !threadIdStored) {
                await session.updateMetadata(metadata => ({ ...metadata, claudeSessionId: threadId! }),
                    { rejectOnServerError: true });
                threadIdStored = true;
            }
            session.onUserMessage(onUserMessage);
        }
        session.keepAlive(thinking, 'remote');
        keepAliveInterval = setInterval(() => {
            session.keepAlive(thinking, 'remote');
        }, 2000);

        let currentModeHash: string | null = null;
        let pending: MessageQueueBatch<EnhancedMode> | null = null;

        // Test seam: hand the test a way to unblock the main loop (production
        // exits via the Ink Ctrl-C handler, which needs a TTY). No-op in
        // production (deps.onRuntimeReady absent).
        opts.deps?.onRuntimeReady?.({
            requestExit,
        });

        while (!shouldExit) {
            if (failedAccountSwap && !pendingAccountSwap) {
                const intent = readGlobalAccountIntent();
                if (accountIntentIsNewer(intent, failedAccountSwap.seenSetAt)) {
                    pendingAccountSwap = { target: intent.profileName, source: 'global', seenSetAt: intent.setAt };
                } else {
                    // Keep both the retained batch and new input in their
                    // existing owners. New input, !restart, or a newer target
                    // can request one new bounded operation; no timer retries
                    // a failed target forever while the user is idle.
                    await new Promise<void>((resolve) => { wakeRecovery = resolve; });
                    wakeRecovery = null;
                    continue;
                }
            }
            // Consume pending !auth-all --codex account swap before anything else.
            // Build and resume the candidate against the exact current thread first.
            // Only a ready candidate may replace and dispose the current client.
            if (pendingAccountSwap) {
                const selection: AccountSwapRequest = pendingAccountSwap;
                const { target, source, seenSetAt } = selection;
                pendingAccountSwap = null;
                failedAccountSwap = null;
                let swapCommitted = false;
                try {
                    session.sendSessionEvent({ type: 'message',
                        message: `🔄 正在恢复账号 "${target}" 的原会话，输入已保留，无需重发。` });
                } catch (statusError) {
                    logger.warn('[CodexAppServer] Failed to publish account recovery status:', statusError);
                }
                try {
                    if (compactInFlight) await compactInFlight;
                    const targetHome = getCodexInstancePath(target);
                    const result = await openAccountClient(selection, threadId,
                        Date.now() + RESTORE_SESSION_STARTUP_TIMEOUT_MS);
                    if (!result.ok) {
                        recoveryOperation = null;
                        if (!shouldExit) client = result.client;
                        if (result.cleanupFailed) throw result.error;
                        if (!selectionIsCurrent(selection)) {
                            if (!shouldExit) sampleAccountIntent();
                            continue;
                        }
                        throw result.error;
                    }
                    if (!selectionIsCurrent(selection)) {
                        await result.client.dispose();
                        recoveryOperation = null;
                        if (!shouldExit) sampleAccountIntent();
                        continue;
                    }
                    // performCodexAccountSwap has now disposed the old client.
                    // From here onward this is committed and must never be
                    // reported as a rollback-capable switch failure.
                    swapCommitted = true;
                    client = result.client;
                    recoveryOperation = null;
                    threadId = result.threadId;
                    process.env.CODEX_HOME = targetHome;
                    activeCodexProfile = target;
                    rememberAccountIntent(target, seenSetAt);
                    if (opts.startedBy === 'daemon' && response) {
                        const profileRegistration = await notifyDaemonCodexProfile(response.id, target);
                        if (profileRegistration.error) {
                            logger.warn(`[CodexAppServer] Failed to report account to daemon: ${profileRegistration.error}`);
                        }
                    }
                    activeTurnId = null;
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    // Mirror the claude-side wording: `(via !auth-all)` is the
                    // global path; the single-session path triggered locally
                    // by `!auth <profile>` reads as a bare `(via !auth)`.
                    const sourceTag = source === 'global' ? '!auth-all --codex' : '!auth';
                    const msg = `🔄 Switched to "${target}" (via ${sourceTag})`;
                    messageBuffer.addMessage(msg, 'status');
                    session.sendSessionEvent({ type: 'message', message: msg });
                    logger.debug(`[CodexAppServer] Account swap complete → ${target} (source=${source})`);
                    // A single-session command may wake the idle queue so the explicit
                    // request is consumed promptly. Global account targets never wake or
                    // interrupt a session; they are discovered only with real input.
                    messageQueue.clearInterrupt();
                } catch (err) {
                    if (err instanceof CodexProcessCleanupError) throw err;
                    if (shouldExit) break;
                    const detail = (err as Error).message || 'unknown error';
                    const errMsg = swapCommitted
                        ? `⚠ 账号已切换，但会话状态刷新失败: ${detail}`
                        : `⚠ 会话恢复失败，未提交的输入已保留，尚未交给模型。发送新消息或 !restart 可重试 "${target}"，也可用 !auth 选择账号。${detail}`;
                    if (!swapCommitted) {
                        failedAccountSwap = selection;
                    }
                    diagnosticTrace('[CODEX] Account recovery failed', {
                        target, threadId, seenSetAt, swapCommitted, error: detail,
                    });
                    logger.warn(
                        swapCommitted
                            ? '[CodexAppServer] Account swap post-commit finalization failed:'
                            : '[CodexAppServer] Account swap failed:',
                        err,
                    );
                    try {
                        messageBuffer.addMessage(errMsg, 'status');
                    } catch (statusError) {
                        logger.warn('[CodexAppServer] Failed to buffer account swap status:', statusError);
                    }
                    try {
                        session.sendSessionEvent({ type: 'message', message: errMsg });
                    } catch (statusError) {
                        logger.warn('[CodexAppServer] Failed to publish account swap status:', statusError);
                    }
                } finally {
                    messageQueue.clearInterrupt();
                }
                continue;
            }

            let message: MessageQueueBatch<EnhancedMode> | null = pending;
            pending = null;
            if (!message) {
                const batch = await messageQueue.waitForMessagesAndGetAsString();
                if (!batch) {
                    // A null batch means shutdown or an explicit local interrupt.
                    if (pendingAccountSwap && !shouldExit && !messageQueue.isClosed()) {
                        logger.debug('[CodexAppServer] Wait interrupted by local account switch — re-entering loop');
                        continue;
                    }
                    logger.debug(`[CodexAppServer] batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) break;
            for (const input of message.userInputs) {
                logUserInputStage('provider-queue-dequeued', input, input.content);
            }

            // The global target is sampled only after real input exists and before
            // that input reaches Codex. Keep the batch pending while the existing
            // transactional swap resumes the exact thread. An idle session therefore
            // performs no work, and an active turn is never interrupted by a file event.
            if (sampleAccountIntent()) {
                pending = message;
                continue;
            }

            // Input ownership transfers synchronously to MessageQueue2. Check
            // the one local thread-swap barrier only after other awaited
            // preparation and immediately before the synchronous turn-start
            // setup. An accepted batch therefore starts on either the old
            // thread before compaction begins or the new thread after it ends;
            // it is never rejected with a "please resend" response.
            const compactBarrier = compactInFlight;
            if (compactBarrier) await compactBarrier;

            // Mode change: keep the same Codex thread.
            //
            // The `mode hash` is only a MessageQueue2 batching boundary (it prevents
            // mixing prompts with different permissionMode/model into the same turn).
            // It must NOT drive thread lifecycle — Codex `turn/start` already accepts
            // per-turn `approvalPolicy`/`sandboxPolicy`/`model` (see below), so a mode
            // switch takes effect on the next turn without losing conversation history.
            //
            // Previously we tore down the thread here, which created a brand-new Codex
            // conversation (and a new rollout .jsonl) every time the user toggled the
            // permission mode in the app. That silently lost all prior context.
            if (threadId && currentModeHash && message.hash !== currentModeHash) {
                logger.debug(`[CodexAppServer] Mode hash changed (${currentModeHash} -> ${message.hash}); reusing thread ${threadId}`);
                messageBuffer.addMessage(`Permission mode: ${message.mode.permissionMode} (continuing session)`, 'status');
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;
            let tracedTurnId: string | null = null;
            turnOutcome.status = 'cancelled';
            turnOutcome.detail = undefined;
            turnOutcome.capacity = false;
            const recovery = { controller: new AbortController(), attempts: 0, waiting: false, stopRequested: false };
            capacityRecovery = recovery;

            try {
                const requestClient = client;
                if (!requestClient) {
                    throw new Error('Codex app-server client is not initialized');
                }
                const sandboxManagedByHappy = !!sandboxConfig;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );
                const modelConfig = resolveCodexModelModeOrDefault(message.mode.model);

                // Start a new thread if needed. Existing threads were resumed
                // before runtime readiness, so queued input cannot be the
                // operation that discovers a missing rollout.
                if (!threadId) {
                    logger.debug('[CodexAppServer] Starting new thread');
                    threadId = await startFreshThread(
                        requestClient,
                        message.mode.permissionMode,
                        message.mode.model,
                    );
                }

                logger.debug(`[CodexAppServer] Starting turn on thread ${threadId}`);
                for (const input of message.userInputs) {
                    logUserInputStage('model-submit-start', input, input.content, { threadId });
                }
                await session.beginDaemonSessionTurn();
                if (compactInFlight) await compactInFlight;
                // No turn/start has been dispatched yet: it is still safe to
                // retain this batch if a local/global account choice changed
                // during awaited setup. After dispatch we never auto-replay.
                if (shouldExit || requestClient !== client || sampleAccountIntent()) {
                    pending = message;
                    turnOutcome.status = 'cancelled';
                    session.closeDaemonSessionTurn('cancelled');
                    continue;
                }
                // Record only at the final dispatch boundary so a deferred
                // input cannot appear both in a compact seed and its next turn.
                recentUserBuffer.record(message.message);
                replyMonitor.beginActiveReply('turn-start');

                // turn/start RPC returns immediately with turnId; the turn itself
                // completes asynchronously via turn/completed notification. Set up
                // the pending-turn promise BEFORE sending the RPC so we don't miss
                // notifications that arrive before the await.
                turnLifecycle.begin();
                const injectSystemPrompt = needsSystemPromptInjection;
                // /compact stashes a heuristic seed in compactState after
                // allocating a fresh thread. Prepend it to the user's prompt
                // exactly once, then clear so subsequent turns are unaffected.
                let turnInputText = message.message;
                if (injectSystemPrompt) {
                    turnInputText = `${systemPrompt}\n\n${turnInputText}`;
                }
                const seed = compactState.pendingSeedText;
                if (seed !== null && seed.length > 0) {
                    turnInputText = `${seed}\n\n${turnInputText}`;
                    compactState.pendingSeedText = null;
                    logger.debug(`[CodexAppServer] Injecting compact seed (${seed.length} chars) into next turn`);
                }
                const requestThreadId = threadId;
                while (true) {
                    const turnResponse = await requestClient.request('turn/start', {
                        threadId: requestThreadId,
                        input: recovery.attempts === 0 ? [{ type: 'text', text: turnInputText }] : [],
                        approvalPolicy: toApprovalPolicy(executionPolicy.approvalPolicy),
                        sandboxPolicy: toSandboxPolicy(executionPolicy.sandbox, sessionCwd),
                        ...(modelConfig.model ? { model: modelConfig.model } : {}),
                        ...(modelConfig.reasoningEffort ? { effort: modelConfig.reasoningEffort } : {}),
                    });
                    const responseTurnId = readTurnId(turnResponse);
                    tracedTurnId = responseTurnId;
                    if (responseTurnId && turnLifecycle.current) {
                        activeTurnId = responseTurnId;
                        if (recovery.stopRequested) {
                            await requestClient.request('turn/interrupt', { threadId: requestThreadId, turnId: responseTurnId });
                        }
                    }
                    for (const input of recovery.attempts === 0 ? message.userInputs : []) {
                        logUserInputStage('model-submit-accepted', input, input.content, {
                            threadId,
                            turnId: responseTurnId ?? null,
                        });
                    }
                    if (injectSystemPrompt) {
                        needsSystemPromptInjection = false;
                    }
                    logger.debug('[CodexAppServer] turn/start RPC returned:', JSON.stringify(turnResponse).substring(0, 200));

                    // Wait for the real turn completion (turn/completed notification).
                    // The turn-lifecycle state machine guarantees this settles via
                    // one of: turn/completed, turn/interrupted, error notification,
                    // or this catch block on RPC failure. Error notifications
                    // resolve (not reject), so this await only throws when the
                    // surrounding RPC itself failed — the catch below handles it.
                    const turnCompletion = turnLifecycle.current;
                    if (turnCompletion) {
                        await turnCompletion;
                    }
                    if (!turnOutcome.capacity || recovery.attempts >= capacityRetryDelays.length) break;
                    const backoffMs = capacityRetryDelays[recovery.attempts++];
                    if (!recovery.controller.signal.aborted && !shouldExit && !compactInFlight && messageQueue.size() === 0) {
                        recovery.waiting = true;
                        thinking = true;
                        session.keepAlive(thinking, 'remote');
                        session.sendSessionEvent({ type: 'message', message:
                            `模型服务暂时繁忙，${Math.ceil(backoffMs / 1000)} 秒后使用原模型继续（${recovery.attempts}/${capacityRetryDelays.length}）。可点击停止取消。` });
                        try {
                            await delay(backoffMs, undefined, { signal: recovery.controller.signal });
                        } catch (error) {
                            if (!recovery.controller.signal.aborted) throw error;
                        } finally {
                            recovery.waiting = false;
                        }
                    }
                    if (recovery.controller.signal.aborted || shouldExit || compactInFlight || messageQueue.size() > 0
                        || requestClient !== client || threadId !== requestThreadId || sampleAccountIntent()) {
                        turnOutcome.status = 'cancelled';
                        break;
                    }
                    turnOutcome.status = 'cancelled';
                    turnOutcome.detail = undefined;
                    turnOutcome.capacity = false;
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    replyMonitor.beginActiveReply('capacity-retry');
                    turnLifecycle.begin();
                }
                // Notification callbacks mutate this while the turn is awaited.
                const settledStatus = turnOutcome.status as ReturnType<typeof pickTurnEndStatus>;
                logger.debug(`[CodexAppServer] Turn settled: ${settledStatus}`);
                for (const input of message.userInputs) {
                    logUserInputStage(settledStatus === 'completed' ? 'model-turn-completed' : 'model-submit-or-turn-failed', input, input.content, {
                        reason: turnOutcome.detail ?? turnOutcome.status,
                        threadId,
                        turnId: tracedTurnId,
                    });
                }
            } catch (error) {
                turnOutcome.status = 'failed';
                for (const input of message.userInputs) {
                    logUserInputStage('model-submit-or-turn-failed', input, input.content, {
                        threadId,
                        turnId: tracedTurnId,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
                logger.warn('[CodexAppServer] Error in app-server session:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                messageBuffer.addMessage(`Error: ${errorMessage.substring(0, 200)}`, 'status');
                // The shared terminal path also covers a rejected turn/start RPC.
                handleTurnFailure({ error: { message: errorMessage } });
            } finally {
                recovery.controller.abort();
                if (capacityRecovery === recovery) capacityRecovery = null;
                session.closeDaemonSessionTurn(turnOutcome.status);
                replyMonitor.endActiveReply('turn-finally');
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
        const fatalDetail = error instanceof Error
            ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
            : String(error);
        logger.warn(`[CodexAppServer] Fatal error: ${fatalDetail}`);
        session.sendSessionEvent({
            type: 'message',
            message: `Codex app-server error: ${error instanceof Error ? error.message : String(error)}`,
        });
    } finally {
        // Clean up resources
        logger.debug('[CodexAppServer] Final cleanup start');
        try { await stopRuntimeClients(); } catch (error) {
            diagnosticTrace('[CODEX] Final cleanup failed', String(error));
        }
        replyMonitor.dispose();
        removeTransportFatalHandler();

        removeShutdownHandlers();
        try {
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (e) {
            logger.debug('[CodexAppServer] Error while closing session', e);
        }
        happyServer.stop();

        if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch { /* ignore */ }
        }
        if (hasTTY) {
            try { process.stdin.pause(); } catch { /* ignore */ }
        }
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logger.debug('[CodexAppServer] Final cleanup completed');
    }
}
