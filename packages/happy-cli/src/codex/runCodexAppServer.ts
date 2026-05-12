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
import { buildCodexChildEnv } from './codexEnvBuilder';
import { createAppServerStreamBridge, type AppServerStreamUpdate } from './appServerStreamBridge';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { extractCodexErrorDetail, formatCodexErrorForUi } from './utils/codexErrorDetail';
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
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { findRolloutByConversationId, getDefaultCodexSessionsRoot } from './utils/rolloutDiscovery';
import { buildHeuristicSeed } from './utils/compactSeedBuilder';
import { compactViaCodexExec, wrapL2SeedAsHeuristicSeed } from './utils/codexExecCompact';
import { shouldAutoRescue, createRescueGate } from './utils/codexAutoRescue';
import { createTurnLifecycle } from './utils/turnLifecycle';
import { createRecentUserBuffer } from './utils/recentUserBuffer';

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

    // Race-recovery mirror of user prompts; snapshot is consumed by
    // /compact's seed builder to cover prompts not yet flushed to
    // rollout.jsonl. See `utils/recentUserBuffer.ts` for the full rationale.
    const recentUserBuffer = createRecentUserBuffer();

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

        // /compact / /clear swap-race guard: while runManualCompact is between
        // `findRolloutByConversationId` / `buildHeuristicSeed` (both await) and
        // the threadId swap, the turn loop is parked on
        // `messageQueue.waitForMessagesAndGetAsString()`. If a new user message
        // lands here it would push into the queue, the turn loop would unblock
        // and dispatch with the OLD threadId (we haven't swapped yet), and the
        // pending heuristic seed would never be consumed.
        //
        // Reject + advise. The user re-sends after they see
        // `Compaction completed`. Cheaper than building a barrier between the
        // two coroutines and avoids state-machine surface area.
        if (compactInFlight) {
            session.sendSessionEvent({
                type: 'message',
                message: '⏳ 本地压缩进行中，请等待 "Compaction completed" 后再发送。',
            });
            session.sendSessionEvent({ type: 'ready' });
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
        const specialCommand = parseSpecialCommand(text);
        if (specialCommand.type === 'compact' || specialCommand.type === 'clear') {
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
                // Route a bang-requested session restart through the same
                // pendingAccountSwap path used by !auth-all --codex (broadcast
                // file watcher). Without this, !auth --codex only updates
                // process.env.CODEX_HOME in the parent — the running codex
                // app-server child still has the old auth in its frozen env,
                // so the success message ("✅ 已切换到 X") is a lie. The swap
                // path disposes the child and respawns it with the new env;
                // the savedThreadId hand-off keeps the conversation intact.
                if (result.action === 'restart-session') {
                    const target = getCurrentCodexProfile() || 'unknown';
                    logger.debug(`[CodexAppServer] Single-session swap requested → ${target}`);
                    pendingAccountSwap = { target, source: 'single-session' };
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

        // Must precede messageQueue.push: a synchronous push failure would
        // otherwise skip the record, leaving the prompt unrecoverable by the
        // seed builder. All non-prompt traffic has been early-returned above.
        recentUserBuffer.record(text);
        messageQueue.push(text, enhancedMode);
    });

    //
    // Runtime state
    //

    let thinking = false;
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    let threadIdStored = false;

    // /compact state. When the user runs /compact we read the current rollout
    // file, build a heuristic seed locally, allocate a fresh codex thread, and
    // stash the seed in `compactState.pendingSeedText` so the next turn
    // prepends it to the user's prompt. The holder object keeps the type as
    // `string | null` at the read site (a bare `let` would get narrowed to
    // `null` by TS control-flow analysis since the writer lives in a different
    // closure). `compactInFlight` guards against concurrent /compact
    // invocations while the swap is in progress.
    const compactState: { pendingSeedText: string | null } = { pendingSeedText: null };
    let compactInFlight = false;

    // Auto-rescue gate: when codex's auto pre-sampling compaction fails
    // (`willRetry: false`, message contains "Error running remote compact task")
    // we trigger /compact for the user automatically. The cooldown prevents a
    // failure storm (same turn retrying 5x in 2s) from spawning multiple
    // rescues.
    const autoRescueGate = createRescueGate(30_000);

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
    ): Promise<void> {
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
            return;
        }
        if (!client) {
            session.sendSessionEvent({
                type: 'message',
                message: `ℹ️ ${opLabel} 暂不可用`,
            });
            session.sendSessionEvent({ type: 'ready' });
            return;
        }
        const previousThreadId = threadId;
        if (!previousThreadId) {
            session.sendSessionEvent({
                type: 'message',
                message: `ℹ️ ${opLabel}：当前无对话`,
            });
            session.sendSessionEvent({ type: 'ready' });
            return;
        }

        compactInFlight = true;
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
                    return;
                }
                const built = await buildHeuristicSeed({
                    rolloutPath,
                    trailerNote: '请基于以上摘要继续。',
                    // Race-recovery snapshot: any prompt accepted into the
                    // queue but not yet flushed by codex into rollout.jsonl.
                    // `snapshot()` returns a copy, so even though
                    // compactInFlight gates onUserMessage during this await,
                    // we hold a frozen view rather than a live reference.
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
                    seedText = wrapL2SeedAsHeuristicSeed(l2.summary, '请基于以上摘要继续。');
                    logger.debug(
                        `[CodexAppServer] ${autoTriggered ? '[auto] ' : ''}/compact L2 succeeded: ${l2.elapsedMs}ms summary=${l2.summary.length} seed=${seedText.length}`,
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
        } finally {
            compactInFlight = false;
        }
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
                    }
                    break;
                }

                case 'agent-message':
                    // Buffer deltas only for the turn-aborted fallback below.
                    // The authoritative delivery happens on item/completed via
                    // the envelope t:'text' branch above.
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
                    // Per-segment delivery already happened via envelope t:'text' —
                    // no turn-end flush here, it would just reorder text to after
                    // tool calls and duplicate already-delivered content.
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
            // Stale notification guard: a delayed turn/completed for a turn we
            // already moved past (e.g. after /compact swap or auto-rescue
            // re-thread) must not settle the NEW turn's promise. The bridge
            // still gets the update for protocol bookkeeping; only the
            // lifecycle and activeTurnId are guarded.
            const notifTurnId = readTurnId(params);
            if (notifTurnId && activeTurnId && notifTurnId !== activeTurnId) {
                logger.debug(`[CodexAppServer] Ignoring stale turn/completed turnId=${notifTurnId} (active=${activeTurnId})`);
                return;
            }
            activeTurnId = null;
            turnLifecycle.finish();
        });

        c.registerNotificationHandler('turn/interrupted', (params) => {
            const updates = bridge.onNotification('turn/interrupted', params);
            processBridgeUpdates(updates);
            const notifTurnId = readTurnId(params);
            if (notifTurnId && activeTurnId && notifTurnId !== activeTurnId) {
                logger.debug(`[CodexAppServer] Ignoring stale turn/interrupted turnId=${notifTurnId} (active=${activeTurnId})`);
                return;
            }
            activeTurnId = null;
            turnLifecycle.finish();
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

            // Turn state-machine exit: a non-retryable error notification means
            // the current turn is dead. Settle the pending promise (resolve,
            // not reject — the error already flows through the session event
            // stream below; the promise channel only signals "settled"). This
            // closes the fourth state-machine exit so callers awaiting
            // `turnLifecycle.current` never hang.
            //
            // Stale notification guard (parity with turn/completed and
            // turn/interrupted handlers): if a delayed error for a turn we've
            // already moved past arrives after a new turn has begun, ignore
            // it — settling the new turn's promise on stale data would
            // unblock the turn loop prematurely.
            //
            // We do NOT clear `activeTurnId` here — codex may still emit a
            // `turn/interrupted` notification afterwards, and the existing
            // handler at the turn/interrupted registration is the right place
            // to clean that up. Clearing it eagerly would break the user's
            // Ctrl-C interrupt path, which checks `activeTurnId` before
            // sending the `turn/interrupt` RPC.
            const errorTurnId = readTurnId(params);
            if (errorTurnId && activeTurnId && errorTurnId !== activeTurnId) {
                logger.debug(`[CodexAppServer] Ignoring stale error turnId=${errorTurnId} (active=${activeTurnId})`);
                // Still surface the error message to the user below — the
                // stale guard only blocks lifecycle settling, not user-visible
                // error reporting.
            } else {
                turnLifecycle.finish();
            }

            // Auto-rescue: codex's server-side compact endpoint is unstable
            // (~25% failure rate on flaky proxies). When it fails the current
            // turn dies with `willRetry: false`. We detect that exact signature
            // and kick off our local heuristic /compact path so the user sees
            // the standard `Compaction started` / `Compaction completed` ack
            // pair (same UX as a manual /compact) instead of "Codex error:
            // stream disconnected".
            if (shouldAutoRescue(params) && autoRescueGate.tryClaim(Date.now())) {
                logger.warn('[CodexAppServer] Auto-rescue triggered for compact failure:', params);
                // No "auto-rescue" preamble — runManualCompact emits the
                // standard `Compaction started` / `Compaction completed`
                // protocol events. From the user's POV this is identical to
                // a manual /compact: same ack pair, same context-bar reset.
                void runManualCompact('compact', true).catch((err) => {
                    // Roll back the cooldown claim so the next genuine compact
                    // failure within 30s is still rescuable. Without this, a
                    // failed rescue silently disables auto-rescue for the
                    // cooldown window and the user gets a raw codex error
                    // after we've already eaten their one shot.
                    autoRescueGate.release();
                    logger.warn('[CodexAppServer] Auto-rescue /compact failed:', err);
                    session.sendSessionEvent({
                        type: 'message',
                        message: '⚠️ 本地压缩失败',
                    });
                    session.sendSessionEvent({ type: 'ready' });
                });
                return;
            }

            logger.warn('[CodexAppServer] Codex error notification:', params);
            session.sendSessionEvent({
                type: 'message',
                message: formatCodexErrorForUi(extractCodexErrorDetail(params)),
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

    // Set by both swap entry points: the codex profile watcher (broadcast from
    // !auth-all --codex) and the bang dispatcher (single-session !auth).
    // Consumed at top-of-loop: tears down the current app-server subprocess and
    // rebuilds with the new CODEX_HOME. The next iteration's thread/resume picks
    // up savedThreadId so the conversation continues transparently. `source`
    // drives the user-visible status message so the wording matches the path
    // that triggered it (mirrors claude-side `(via !auth-all)` for broadcast vs
    // a bare `(via !auth)` for the single-session swap).
    type AccountSwapSource = 'broadcast' | 'single-session';
    let pendingAccountSwap: { target: string; source: AccountSwapSource } | null = null;

    // Watch for !auth-all --codex. On a valid switch, tryGlobalProfileSwitch has
    // already updated process.env.CODEX_HOME — we just flag the loop. The current
    // turn (if any) finishes naturally; the swap is consumed at the next top-of-loop
    // check, mirroring the claude-side "wait for turn boundary" behavior. Forcibly
    // aborting an in-flight turn here would drop the model's partial work and
    // surprise the user — the broadcast is a "switch when convenient" intent, not
    // an emergency stop.
    const codexProfileWatcher: FSWatcher | null = watchCodexProfileFile(() => {
        const target = getCurrentCodexProfile() || 'unknown';
        logger.debug(`[CodexAppServer] Account swap signaled (broadcast): ${target}`);
        pendingAccountSwap = { target, source: 'broadcast' };
        // Wake the message-queue waiter so an idle session doesn't sit on the
        // swap until the next user message arrives. The loop handles a null
        // batch + non-null pendingAccountSwap as "consume the swap and keep
        // looping" (see below) rather than "exit the runtime".
        messageQueue.interrupt();
    });

    try {
        // Create app-server client. Build the child env via the shared helper so
        // codex sees the same proxy/dotenv treatment as `!login codex` — including
        // ~/.codex/.env inject and upper↔lower case mirroring (Reqwest only honors
        // the lowercase form). Without this, a daemon launched without proxy env
        // would spawn codex with no proxy and fail wss://chatgpt.com CONNECT. The
        // helper emits its own snapshot log line under the same tag.
        logger.debug('[CodexAppServer] Creating app-server client');
        const initialEnvBuild = buildCodexChildEnv({ logTag: 'CodexAppServer' });
        client = await createCodexAppServerClient({
            configOverrides: mcpServerConfigOverrides,
            processEnv: initialEnvBuild.env,
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
                const { target, source } = pendingAccountSwap;
                pendingAccountSwap = null;
                const savedThreadId = threadId;
                try {
                    if (client) {
                        await client.dispose();
                        client = null;
                    }
                    // Account swap: rebuild env so the new spawn picks up the just-
                    // updated process.env.CODEX_HOME (set by tryGlobalProfileSwitch).
                    const swapEnvBuild = buildCodexChildEnv({ logTag: 'CodexAppServer:swap' });
                    client = await createCodexAppServerClient({
                        configOverrides: mcpServerConfigOverrides,
                        processEnv: swapEnvBuild.env,
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
                    // Mirror the claude-side wording: `(via !auth-all)` is the
                    // broadcast path; the single-session path triggered locally
                    // by `!auth <profile>` reads as a bare `(via !auth)`.
                    const sourceTag = source === 'broadcast' ? '!auth-all --codex' : '!auth';
                    const msg = `🔄 Switched to "${target}" (via ${sourceTag})`;
                    messageBuffer.addMessage(msg, 'status');
                    session.sendSessionEvent({ type: 'message', message: msg });
                    logger.debug(`[CodexAppServer] Account swap complete → ${target} (source=${source})`);
                    // The watcher's messageQueue.interrupt() was meant to wake an idle
                    // waiter so the swap is consumed promptly. If the broadcast arrived
                    // mid-turn there was no live waiter, so the flag is still pending.
                    // We've now consumed the swap — drop the deferred flag so the next
                    // wait blocks for real input instead of returning null and breaking
                    // the loop into Final cleanup (which closes the socket → offline).
                    messageQueue.clearInterrupt();
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
                    // A null batch can mean three things: queue closed (shutdown),
                    // signal-driven interrupt (e.g. account-swap watcher woke us
                    // up while idle), or a regular interrupt with nothing pending.
                    // Only the swap case wants to keep looping — the swap is
                    // consumed at the top of the next iteration.
                    if (pendingAccountSwap && !shouldExit && !messageQueue.isClosed()) {
                        logger.debug('[CodexAppServer] Wait interrupted by account swap signal — re-entering loop');
                        continue;
                    }
                    logger.debug(`[CodexAppServer] batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) break;

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
                // The turn-lifecycle state machine guarantees this settles via
                // one of: turn/completed, turn/interrupted, error notification,
                // or this catch block on RPC failure. Error notifications
                // resolve (not reject), so this await only throws when the
                // surrounding RPC itself failed — the catch below handles it.
                const pending = turnLifecycle.current;
                if (pending) {
                    await pending;
                }
                logger.debug('[CodexAppServer] Turn fully completed');
            } catch (error) {
                logger.warn('[CodexAppServer] Error in app-server session:', error);
                // Settle the pending promise on RPC failure (the only path that
                // legitimately rejects). Idempotent if it was already settled
                // by an error notification handler that beat us here.
                turnLifecycle.finish(error instanceof Error ? error : new Error(String(error)));
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
