import { diagnosticTrace, logger } from '@/ui/logger'
import axios from 'axios';
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage, modelFacingUserText } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import type { SessionEnvelope } from '@/sessionProtocol/types';
import type { SessionTurnEndStatus } from '@/sessionProtocol/types';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import {
    MAX_RECOVERY_COLLECTION_BYTES,
    MAX_RECOVERY_RESPONSE_BYTES,
    RECENT_MESSAGE_WINDOW,
    SessionRecoveryError,
    recoveryRowBytes,
    sameRecoveryRow,
    selectRecoveryMessages,
    validateRecentMessageWindow,
    type SessionRecoveryAnchor,
    type SessionRecoveryRow,
} from './sessionMessageRecovery';
import { runProjectSessionClose, runProjectSessionStartup, runProjectSessionStop } from '@/utils/projectSessionStartup';
import { notifyDaemonSessionStarted, notifyDaemonSessionTurn } from '@/daemon/controlClient';
import type { SessionTurnReport, SessionTurnState } from '@/daemon/types';
import { inputAcceptedEventId } from './inputAcceptanceReceipt';
import { createUserInputTrace, logUserInputStage } from '@/utils/userInputTrace';
import { traceHappyServerSocket } from './serverOperationTrace';

const MAX_OUTBOUND_QUEUE_MESSAGES = 256;
const MAX_OUTBOUND_QUEUE_BYTES = 1_048_576;
const MAX_RECOVERY_BUFFER_ROWS = 512;
const MAX_RECENT_DELIVERED_MESSAGES = 512;
const RECONNECT_RECOVERY_TIMEOUT_MS = 10_000;
const METADATA_UPDATE_TIMEOUT_MS = 15_000;
const METADATA_UPDATE_ATTEMPTS = 4;
const DAEMON_REGISTRATION_INTERVAL_MS = 30_000;
const RESTORE_REPLAY_NOTICE = '正在恢复进程异常退出前未确认完成的输入；该输入可能已部分执行，本次按 at-least-once 语义重新提交。';

type SessionTransportHealthState =
    | 'connecting'
    | 'connected'
    | 'recovering'
    | 'ownership_conflict'
    | 'failed'
    | 'closed';

type ReconciliationOutcome = 'complete' | 'retryable' | 'rejected' | 'stopped';

export interface SessionTransportSnapshot {
    state: SessionTransportHealthState;
    reconnectCount: number;
    queueMessages: number;
    queueBytes: number;
    reason: string | null;
}

interface QueuedPersistentMessage {
    encrypted: string;
    localId: string;
    bytes: number;
    kind: string;
}

interface PendingPersistedInput {
    row: SessionRecoveryRow;
    message: UserMessage;
    bytes: number;
}

interface DeliveredPersistedIdentity {
    seq: number;
    localId: string | null;
    createdAt: number;
    cipherDigest: string;
}

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private transportState: SessionTransportHealthState = 'connecting';
    private transportReason: string | null = null;
    private daemonTrackingEnabled = false;
    private daemonRegistration: Promise<void> | null = null;
    private nextDaemonRegistrationAt = 0;
    private daemonProviderSessionId: string | undefined;
    private readonly daemonTurnSourceId = randomUUID();
    private daemonTurnSequence = 0;
    private daemonTurnState: SessionTurnState = 'idle';
    private daemonTurnToken: string | null = null;
    private daemonTurnUpdate: Promise<void> = Promise.resolve();
    private hasConnected = false;
    private closing = false;
    private serverEvictionRecoveries = 0;
    private lastObservedMessage: SessionRecoveryAnchor;
    private pendingPersistedInputs: PendingPersistedInput[] = [];
    private pendingPersistedBytes = 0;
    private inputDrainRunning = false;
    private recentDeliveredMessages = new Map<string, DeliveredPersistedIdentity>();
    private persistedInputReconciliation: AbortController | null = null;
    private restoreReconciliationPending = false;
    private outboundQueue: QueuedPersistentMessage[] = [];
    private outboundQueueBytes = 0;
    private projectStartup: Promise<boolean> | null = null;
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.lastObservedMessage = { id: null, seq: Number.isSafeInteger(session.seq) && session.seq >= 0 ? session.seq : 0 };

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });
        traceHappyServerSocket(this.socket, `session:${this.sessionId}`);

        //
        // Handlers
        //

        this.socket.on('connect', () => this.handleSocketConnect())

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
            this.handleSocketDisconnect(reason);
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', boundedTransportReason(error));
            this.rpcHandlerManager.onSocketDisconnect();
            if (!this.closing && this.transportState !== 'ownership_conflict' && this.transportState !== 'failed') {
                this.publishTransportState('recovering', `connect_error: ${boundedTransportReason(error)}`);
            }
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            const isPersistedMessageUpdate = data?.body?.t === 'new-message';
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    if (data.body.sid !== this.sessionId) return;
                    if (data.body.message?.content?.t !== 'encrypted') {
                        throw new Error('recovery_incomplete: persisted update encryption envelope is invalid');
                    }
                    this.enqueuePersistedMessage(data.body.message as SessionRecoveryRow);
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', boundedTransportReason(error));
                if (isPersistedMessageUpdate) {
                    diagnosticTrace('[INPUT] persisted row rejected', this.sessionId,
                        recoveryFailureReason(error));
                }
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', boundedTransportReason(error));
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();

        // A newly persisted Happy session is enough for the daemon to finish
        // the mobile create RPC. Final provider identity is reported later by
        // enableDaemonSessionTracking; both signals use the same endpoint and
        // no second lifecycle authority is introduced.
        void this.announceDaemonSessionCandidate();
    }

    private async announceDaemonSessionCandidate(): Promise<void> {
        if (!this.metadata || this.closing) return;
        try {
            const result = await notifyDaemonSessionStarted(
                this.sessionId,
                { ...this.metadata, hostPid: process.pid },
            );
            if (result?.error) {
                logger.debug('[API] Failed to announce daemon session candidate:',
                    boundedTransportReason(result.error));
            }
        } catch (error) {
            logger.debug('[API] Failed to announce daemon session candidate:', boundedTransportReason(error));
        }
    }

    /** Wait for socket to connect. Resolves immediately if already connected. */
    waitForConnect(timeoutMs: number = 10_000): Promise<void> {
        if (this.socket.connected && this.transportState === 'connected') return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off('transport-state', onState);
                reject(new Error('Socket connect timeout'));
            }, timeoutMs);
            const onState = (snapshot: SessionTransportSnapshot) => {
                if (snapshot.state === 'connected') {
                    clearTimeout(timer);
                    this.off('transport-state', onState);
                    resolve();
                } else if (snapshot.state === 'failed' || snapshot.state === 'ownership_conflict' || snapshot.state === 'closed') {
                    clearTimeout(timer);
                    this.off('transport-state', onState);
                    reject(new Error(`Socket transport unavailable: ${snapshot.state}`));
                }
            };
            this.on('transport-state', onState);
        });
    }

    getTransportSnapshot(): SessionTransportSnapshot {
        return {
            state: this.transportState,
            reconnectCount: this.serverEvictionRecoveries,
            queueMessages: this.outboundQueue.length,
            queueBytes: this.outboundQueueBytes,
            reason: this.transportReason,
        };
    }

    onTransportState(callback: (snapshot: SessionTransportSnapshot) => void): () => void {
        this.on('transport-state', callback);
        callback(this.getTransportSnapshot());
        return () => this.off('transport-state', callback);
    }

    private handleSocketConnect(): void {
        logger.debug('Socket connected successfully');
        if (this.closing) {
            this.socket.disconnect();
            return;
        }
        if (this.transportState === 'ownership_conflict' || this.transportState === 'failed') {
            this.socket.disconnect();
            return;
        }
        this.rpcHandlerManager.onSocketConnect(this.socket);
        this.publishTransportState('connected', null);
        this.flushOutboundQueue();
        if (!this.hasConnected) {
            this.hasConnected = true;
            if (this.restoreReconciliationPending) {
                void this.startPersistedInputReconciliation('restore');
            }
            return;
        }
        void this.startPersistedInputReconciliation(
            this.restoreReconciliationPending ? 'restore' : 'reconnect');
    }

    private ensureProjectSessionStartup(): Promise<boolean> {
        if (this.projectStartup) return this.projectStartup;
        const workspace = this.metadata?.path;
        if (typeof workspace !== 'string' || !workspace) return Promise.resolve(true);
        this.projectStartup = runProjectSessionStartup({ workspace, nativeSessionId: this.sessionId,
            notify: (message) => this.sendSessionEvent({ type: 'message', message }) });
        void this.projectStartup.then((success) => {
            if (!success) this.projectStartup = null;
        }, () => {
            this.projectStartup = null;
        });
        return this.projectStartup;
    }

    private handleSocketDisconnect(reason: string): void {
        this.stopPersistedInputReconciliation();
        if (this.closing) {
            if (this.transportState !== 'closed') this.publishTransportState('closed', null);
            return;
        }
        if (this.isTerminalTransport()) return;
        if (reason !== 'io server disconnect') {
            this.publishTransportState('recovering', reason);
            return;
        }
        if (this.serverEvictionRecoveries >= 1) {
            this.publishTransportState('ownership_conflict', reason);
            this.emit('transport-fatal', this.getTransportSnapshot());
            return;
        }
        this.serverEvictionRecoveries += 1;
        this.publishTransportState('recovering', reason);
        setTimeout(() => {
            if (!this.closing && this.transportState === 'recovering') this.socket.connect();
        }, 6_000).unref();
    }

    reconcilePersistedInputs(mode: 'restore' | 'reconnect'): Promise<ReconciliationOutcome> {
        if (mode === 'restore') {
            this.restoreReconciliationPending = true;
            if (!this.socket.connected) return Promise.resolve('stopped');
        }
        return this.startPersistedInputReconciliation(mode);
    }

    private startPersistedInputReconciliation(
        mode: 'restore' | 'reconnect',
    ): Promise<ReconciliationOutcome> {
        this.stopPersistedInputReconciliation();
        const controller = new AbortController();
        this.persistedInputReconciliation = controller;
        const operation = this.runPersistedInputReconciliation(mode, controller.signal);
        void operation.then((outcome) => {
            if (this.persistedInputReconciliation !== controller) return;
            this.persistedInputReconciliation = null;
            if (mode === 'restore' && outcome !== 'stopped' && outcome !== 'retryable') {
                this.restoreReconciliationPending = false;
            }
        }, () => {
            if (this.persistedInputReconciliation === controller) this.persistedInputReconciliation = null;
        });
        return operation;
    }

    private stopPersistedInputReconciliation(): void {
        this.persistedInputReconciliation?.abort();
        this.persistedInputReconciliation = null;
    }

    private async runPersistedInputReconciliation(
        mode: 'restore' | 'reconnect',
        signal?: AbortSignal,
    ): Promise<ReconciliationOutcome> {
        if (signal?.aborted || this.closing || this.isTerminalTransport()) return 'stopped';
        const anchor = { ...this.lastObservedMessage };
        let rawMessages: unknown;
        try {
            const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${this.sessionId}/messages`, {
                headers: { Authorization: `Bearer ${this.token}` },
                timeout: RECONNECT_RECOVERY_TIMEOUT_MS,
                maxContentLength: MAX_RECOVERY_RESPONSE_BYTES,
                signal,
            });
            rawMessages = response.data?.messages;
        } catch (error) {
            if (signal?.aborted) return 'stopped';
            diagnosticTrace('[INPUT] reconciliation skipped', this.sessionId, mode,
                recoveryFailureReason(error));
            return 'retryable';
        }
        if (signal?.aborted) return 'stopped';
        if (!this.socket.connected) return 'retryable';
        if (this.isTerminalTransport()) return 'stopped';
        try {
            const rows = validateRecentMessageWindow(rawMessages);
            const recovery = mode === 'restore'
                ? this.selectInitialRestoreMessages(rows)
                : selectRecoveryMessages(rows, anchor);
            let restoreNoticeSent = false;
            for (const message of recovery) {
                const accepted = this.enqueuePersistedMessage(message, { allowAcceptedReplay: true });
                if (mode === 'restore' && accepted && !restoreNoticeSent) {
                    this.sendNotice(RESTORE_REPLAY_NOTICE);
                    restoreNoticeSent = true;
                }
            }
            if (this.isTerminalTransport()) return 'stopped';
            this.drainPersistedInputs();
            if (this.isTerminalTransport()) return 'stopped';
            if (this.pendingPersistedInputs.length === 0) {
                const latest = rows.at(-1);
                if (latest && (latest.seq > this.lastObservedMessage.seq
                    || latest.seq === this.lastObservedMessage.seq && this.lastObservedMessage.id === null)) {
                    this.lastObservedMessage = { id: latest.id, seq: latest.seq };
                }
            }
            return 'complete';
        } catch (error) {
            diagnosticTrace('[INPUT] reconciliation rejected', this.sessionId, mode,
                recoveryFailureReason(error));
            return 'rejected';
        }
    }

    private selectInitialRestoreMessages(rows: SessionRecoveryRow[]): SessionRecoveryRow[] {
        const pending: SessionRecoveryRow[] = [];
        let processedResponseBoundaryFound = false;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index]!;
            const body = this.decryptPersistedMessage(row);
            if (body.role === 'agent') {
                const content = body.content;
                if (!content || typeof content !== 'object' || Array.isArray(content)
                    || typeof (content as Record<string, unknown>).type !== 'string') {
                    throw new SessionRecoveryError('persisted agent restore message is invalid');
                }
                if ((content as Record<string, unknown>).type !== 'event') {
                    processedResponseBoundaryFound = true;
                    break;
                }
                continue;
            }
            if (body.role !== 'user') throw new SessionRecoveryError('persisted restore message role is invalid');
            const parsed = UserMessageSchema.safeParse(body);
            if (!parsed.success) throw new SessionRecoveryError('persisted user restore message is invalid');
            pending.push(row);
        }
        if (rows.length === RECENT_MESSAGE_WINDOW && !processedResponseBoundaryFound) {
            throw new SessionRecoveryError('full recent message window contains no processed-response boundary');
        }
        return pending.reverse();
    }

    private enqueuePersistedMessage(rawMessage: unknown, options: { allowAcceptedReplay?: boolean } = {}): boolean {
        const message = validateRecentMessageWindow([rawMessage])[0]!;
        if (this.isAlreadyObservedMessage(message)) return false;
        if (message.seq <= this.lastObservedMessage.seq && options.allowAcceptedReplay !== true) {
            if (message.seq === this.lastObservedMessage.seq && this.lastObservedMessage.id !== null
                && message.id !== this.lastObservedMessage.id) {
                throw new Error('recovery_incomplete: accepted message sequence has conflicting ids');
            }
            return false;
        }
        const body = this.decryptPersistedMessage(message);
        if (message.localId) body.localKey = message.localId;
        logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body);
        const userResult = UserMessageSchema.safeParse(body);
        if (!userResult.success && (body as Record<string, unknown>).role === 'user') {
            throw new Error('recovery_incomplete: persisted user message body is invalid');
        }
        if (userResult.success) {
            const trace = createUserInputTrace(this.sessionId, userResult.data);
            logUserInputStage('persisted-received', trace, userResult.data.content.text, {
                persistedMessageId: message.id,
                persistedSequence: message.seq,
                sentFrom: userResult.data.meta?.sentFrom ?? null,
            });
            const bytes = recoveryRowBytes(message);
            if (this.pendingPersistedInputs.length >= MAX_RECOVERY_BUFFER_ROWS
                || this.pendingPersistedBytes + bytes > MAX_RECOVERY_COLLECTION_BYTES) {
                throw new Error('recovery_incomplete: pending persisted input queue exceeded budget');
            }
            const pending: PendingPersistedInput = {
                row: message,
                message: userResult.data,
                bytes,
            };
            const insertionIndex = this.pendingPersistedInputs.findIndex((input) => input.row.seq > message.seq);
            if (insertionIndex < 0) this.pendingPersistedInputs.push(pending);
            else this.pendingPersistedInputs.splice(insertionIndex, 0, pending);
            this.pendingPersistedBytes += bytes;
            logUserInputStage('persisted-buffered', trace, userResult.data.content.text, {
                persistedMessageId: message.id,
                persistedSequence: message.seq,
                bufferedInputs: this.pendingPersistedInputs.length,
            });
            void this.drainPersistedInputs();
        } else {
            this.emit('message', body);
            this.rememberDeliveredMessage(message);
            if (message.seq > this.lastObservedMessage.seq) {
                this.lastObservedMessage = { id: message.id, seq: message.seq };
            }
        }
        return true;
    }

    private drainPersistedInputs(): void {
        if (this.inputDrainRunning || this.closing || this.isTerminalTransport()) return;
        this.inputDrainRunning = true;
        try {
            while (this.pendingPersistedInputs.length > 0) {
                const input = this.pendingPersistedInputs[0]!;
                if (!this.pendingMessageCallback) return;
                const trace = createUserInputTrace(this.sessionId, input.message);
                logUserInputStage('provider-handoff-start', trace, input.message.content.text, {
                    persistedMessageId: input.row.id,
                    persistedSequence: input.row.seq,
                });
                try {
                    this.handoffUserMessage(input.message);
                } catch (error) {
                    logUserInputStage('provider-handoff-rejected', trace, input.message.content.text, {
                        persistedMessageId: input.row.id,
                        persistedSequence: input.row.seq,
                        reason: recoveryFailureReason(error),
                    });
                    throw error;
                }
                logUserInputStage('provider-handoff-accepted', trace, input.message.content.text, {
                    persistedMessageId: input.row.id,
                    persistedSequence: input.row.seq,
                });
                this.sendInputAcceptedReceipt(input.message);
                this.completePersistedInput(input);
            }
        } catch (error) {
            if (this.socket.connected && this.transportState === 'connected') {
                this.sendNotice('模型入口未接纳本次输入。');
            }
            diagnosticTrace('[INPUT] provider drain stopped', this.sessionId, recoveryFailureReason(error));
        } finally {
            this.inputDrainRunning = false;
        }
    }

    private completePersistedInput(input: PendingPersistedInput): void {
        const index = this.pendingPersistedInputs.indexOf(input);
        if (index < 0) return;
        this.pendingPersistedInputs.splice(index, 1);
        this.pendingPersistedBytes -= input.bytes;
        this.rememberDeliveredMessage(input.row);
        if (input.row.seq > this.lastObservedMessage.seq) {
            this.lastObservedMessage = { id: input.row.id, seq: input.row.seq };
        }
    }


    private decryptPersistedMessage(message: SessionRecoveryRow): Record<string, unknown> {
        let body: unknown;
        try {
            body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
        } catch {
            throw new Error('recovery_incomplete: persisted message cannot be decrypted');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('recovery_incomplete: persisted message body is invalid');
        }
        return body as Record<string, unknown>;
    }

    private isAlreadyObservedMessage(message: SessionRecoveryRow): boolean {
        const delivered = this.recentDeliveredMessages.get(message.id);
        if (delivered) {
            if (!sameDeliveredIdentity(delivered, message)) {
                throw new Error('recovery_incomplete: one delivered message id has conflicting persisted identity');
            }
            return true;
        }
        const pending = this.pendingPersistedInputs.find((input) => input.row.id === message.id);
        if (pending) {
            if (!sameRecoveryRow(pending.row, message)) {
                throw new Error('recovery_incomplete: one pending message id has conflicting persisted identity');
            }
            return true;
        }
        const pendingSeq = this.pendingPersistedInputs.find((input) => input.row.seq === message.seq);
        if (pendingSeq) {
            throw new Error('recovery_incomplete: one pending message sequence has conflicting ids');
        }
        return false;
    }

    private rememberDeliveredMessage(message: SessionRecoveryRow): void {
        this.recentDeliveredMessages.set(message.id, deliveredIdentity(message));
        if (this.recentDeliveredMessages.size <= MAX_RECENT_DELIVERED_MESSAGES) return;
        const oldest = this.recentDeliveredMessages.keys().next().value as string | undefined;
        if (oldest !== undefined) this.recentDeliveredMessages.delete(oldest);
    }

    private publishTransportState(state: SessionTransportHealthState, reason: string | null): void {
        const changed = state !== this.transportState;
        this.transportState = state;
        this.transportReason = reason === null ? null : boundedTransportReason(reason);
        const snapshot = this.getTransportSnapshot();
        if (changed && state === 'connected') void this.refreshDaemonSessionTracking();
        this.emit('transport-state', snapshot);
    }

    private refreshDaemonSessionTracking(): Promise<void> {
        if (!this.daemonTrackingEnabled || !this.metadata || this.closing) return Promise.resolve();
        this.nextDaemonRegistrationAt = Date.now() + DAEMON_REGISTRATION_INTERVAL_MS;
        if (this.daemonRegistration) return this.daemonRegistration;
        const metadata = { ...this.metadata, hostPid: process.pid };
        this.daemonRegistration = notifyDaemonSessionStarted(
            this.sessionId,
            metadata,
            this.daemonProviderSessionId,
            this.daemonTurnReport(),
        ).then((result) => {
            if (result?.error) {
                logger.debug('[API] Failed to refresh daemon session tracking:', boundedTransportReason(result.error));
            }
        }, (error) => {
            logger.debug('[API] Failed to refresh daemon session tracking:', boundedTransportReason(error));
        }).finally(() => {
            this.daemonRegistration = null;
        });
        return this.daemonRegistration;
    }

    private daemonTurnReport(): SessionTurnReport {
        return {
            sourceId: this.daemonTurnSourceId,
            sequence: this.daemonTurnSequence,
            state: this.daemonTurnState,
            token: this.daemonTurnToken,
        };
    }

    private syncDaemonTurn(): Promise<void> {
        const report = this.daemonTurnReport();
        const update = this.daemonTurnUpdate.then(async () => {
            if (!this.daemonTrackingEnabled || this.closing) return;
            const result = await notifyDaemonSessionTurn(this.sessionId, report);
            if (result?.error) logger.debug('[API] Failed to update daemon turn:', boundedTransportReason(result.error));
        }, async () => {
            if (!this.daemonTrackingEnabled || this.closing) return;
            const result = await notifyDaemonSessionTurn(this.sessionId, report);
            if (result?.error) logger.debug('[API] Failed to update daemon turn:', boundedTransportReason(result.error));
        });
        this.daemonTurnUpdate = update.catch((error) => {
            logger.debug('[API] Failed to update daemon turn:', boundedTransportReason(error));
        });
        return update;
    }

    async beginDaemonSessionTurn(): Promise<string> {
        if (this.daemonTurnState === 'running') return this.daemonTurnToken!;
        this.daemonTurnState = 'running';
        this.daemonTurnToken = `xc-turn-v1-${randomBytes(32).toString('hex')}`;
        this.daemonTurnSequence += 1;
        await this.syncDaemonTurn();
        return this.daemonTurnToken;
    }

    closeDaemonSessionTurn(_status: SessionTurnEndStatus = 'completed'): void {
        if (this.daemonTurnState !== 'running') return;
        this.daemonTurnState = 'idle';
        this.daemonTurnToken = null;
        this.daemonTurnSequence += 1;
        void this.syncDaemonTurn();
    }

    private failTransport(reason: string): void {
        if (this.isTerminalTransport()) return;
        this.publishTransportState('failed', reason);
        this.emit('transport-fatal', this.getTransportSnapshot());
        this.socket.disconnect();
    }

    private isTerminalTransport(): boolean {
        return this.transportState === 'failed' || this.transportState === 'ownership_conflict' ||
            this.transportState === 'closed';
    }

    private logPersistentSocketEmit(kind: string, bytes: number, delivery: 'direct' | 'queued-flush'): void {
        diagnosticTrace('[SERVER_SEND]', JSON.stringify({
            time: Date.now(),
            sessionId: this.sessionId,
            kind,
            bytes,
            delivery,
        }));
    }

    private sendPersistentMessage(encrypted: string, kind: string): void {
        const bytes = Buffer.byteLength(encrypted, 'utf8');
        if (this.socket.connected && this.transportState === 'connected') {
            const localId = `happy-cli-v1-${randomUUID()}`;
            this.logPersistentSocketEmit(kind, bytes, 'direct');
            this.socket.emit('message', { sid: this.sessionId, message: encrypted, localId });
            return;
        }
        if (this.transportState === 'failed' || this.transportState === 'ownership_conflict' ||
            this.transportState === 'closed') {
            logger.warn('[API] Persistent message rejected by terminal Happy transport:', this.transportState);
            this.emit('transport-fatal', this.getTransportSnapshot());
            throw new Error(`Happy persistent message rejected: transport is ${this.transportState}`);
        }
        if (this.outboundQueue.length >= MAX_OUTBOUND_QUEUE_MESSAGES ||
            this.outboundQueueBytes + bytes > MAX_OUTBOUND_QUEUE_BYTES) {
            this.failTransport('outbound_queue_overflow: persistent message recovery queue exceeded budget');
            throw new Error('Happy persistent message rejected: outbound_queue_overflow');
        }
        const localId = `happy-cli-v1-${randomUUID()}`;
        this.outboundQueue.push({ encrypted, localId, bytes, kind });
        this.outboundQueueBytes += bytes;
        this.publishTransportState(this.transportState, this.transportReason);
    }

    private flushOutboundQueue(): void {
        if (!this.socket.connected || this.transportState !== 'connected' || this.outboundQueue.length === 0) return;
        const queued = this.outboundQueue.splice(0);
        this.outboundQueueBytes = 0;
        for (const message of queued) {
            this.logPersistentSocketEmit(message.kind, message.bytes, 'queued-flush');
            this.socket.emit('message', { sid: this.sessionId, message: message.encrypted, localId: message.localId });
        }
        this.publishTransportState('connected', null);
    }

    private handoffUserMessage(message: UserMessage): void {
        const workspace = this.metadata?.path;
        const safeStop = ['app', 'web', 'android', 'ios', 'mac'].includes(message.meta?.sentFrom ?? '')
            && message.content.text.trim() === '@stop';
        if (safeStop && typeof workspace === 'string' && workspace) {
            void runProjectSessionStop({ workspace, nativeSessionId: this.sessionId,
                notify: (value) => this.sendSessionEvent({ type: 'message', message: value }) }).then((stopped) => {
                if (stopped === true) {
                    this.sendNotice('已请求安全停止；当前轮结束后停止。');
                } else if (stopped === null) {
                    this.sendNotice('当前工作区不支持安全停止。');
                }
            }, (error) => {
                logger.debug('[API] Safe stop failed:', boundedTransportReason(error));
                this.sendNotice('安全停止失败。');
            });
            return;
        }
        this.pendingMessageCallback!(message);
    }

    private sendInputAcceptedReceipt(message: UserMessage): void {
        if (!message.localKey) return;
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        try {
            this.sendSessionEvent({
                type: 'message',
                message: `${time} 已接收，正在投递`,
            }, inputAcceptedEventId(message.localKey));
            logUserInputStage('acceptance-receipt-emitted', createUserInputTrace(this.sessionId, message),
                message.content.text);
        } catch (error) {
            logger.debug('[API] Failed to persist input acceptance receipt:', boundedTransportReason(error));
        }
    }

    private sendNotice(message: string): void {
        try {
            this.sendSessionEvent({ type: 'message', message });
        } catch (error) {
            logger.debug('[API] Failed to send session notice:', boundedTransportReason(error));
        }
    }

    onUserMessage(callback: (data: UserMessage) => void): void {
        this.pendingMessageCallback = callback;
        this.drainPersistedInputs();
    }

    enableDaemonSessionTracking(providerSessionId?: string): void {
        this.daemonTrackingEnabled = true;
        this.daemonProviderSessionId = providerSessionId;
        void this.ensureProjectSessionStartup();
        void this.refreshDaemonSessionTracking();
    }

    getSummaryText(): string | null {
        return this.metadata?.summary?.text ?? null;
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        for (const envelope of mapped.envelopes) {
            if (envelope.ev.t === 'turn-start') void this.beginDaemonSessionTurn();
            else if (envelope.ev.t === 'turn-end') this.closeDaemonSessionTurn(envelope.ev.status);
        }
        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli'
                }
            };
        }

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.sendPersistentMessage(encrypted, `claude:${body.type}`);

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        if (mapped.envelopes.some((envelope) => envelope.ev.t === 'turn-end')) {
            this.closeDaemonSessionTurn(status);
        }
    }

    sendCodexMessage(body: any) {
        const content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));

        this.sendPersistentMessage(encrypted, `codex:${typeof body?.type === 'string' ? body.type : 'unknown'}`);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        const content = {
            role: envelope.role,
            content: {
                type: 'session',
                data: envelope
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));

        this.sendPersistentMessage(encrypted, `session:${envelope.ev.t}`);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode', body: ACPMessageData) {
        const content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.sendPersistentMessage(encrypted, `acp:${provider}:${body.type}`);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'options',
        message?: string,
        options: Array<{ label: string; value?: string; disabled?: boolean }>
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.sendPersistentMessage(encrypted, `event:${event.type}`);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        const now = Date.now();
        if (this.daemonTrackingEnabled && now >= this.nextDaemonRegistrationAt) {
            void this.refreshDaemonSessionTracking();
        }
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: now,
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        if (this.socket.connected && this.transportState === 'connected') {
            this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
        }
    }



    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(
        handler: (metadata: Metadata) => Metadata,
        options?: { rejectOnServerError?: boolean },
    ): Promise<void> {
        return this.metadataLock.inLock(async () => {
            if (!this.metadata) throw new Error('Session metadata is unavailable');
            const deadline = Date.now() + METADATA_UPDATE_TIMEOUT_MS;
            for (let attempt = 0; attempt < METADATA_UPDATE_ATTEMPTS; attempt += 1) {
                const currentMetadata = this.metadata;
                if (!currentMetadata) throw new Error('Session metadata is unavailable');
                const updated = handler(currentMetadata);
                const expectedVersion = this.metadataVersion;
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    if (options?.rejectOnServerError) throw new Error('Metadata update timed out');
                    return;
                }
                let answer;
                try {
                    answer = await this.socket.timeout(remaining).emitWithAck('update-metadata', {
                        sid: this.sessionId,
                        expectedVersion,
                        metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)),
                        claudeSessionId: updated.claudeSessionId,
                        summary: updated.summary?.text,
                        machineId: updated.machineId,
                    });
                } catch (error) {
                    // Socket.IO can lose the acknowledgement after the server has
                    // committed and broadcast the exact update. Accept only that
                    // byte-equivalent, strictly newer broadcast; otherwise retain
                    // the existing fail-closed behavior.
                    if (this.metadataVersion > expectedVersion && this.metadata &&
                        JSON.stringify(this.metadata) === JSON.stringify(updated)) {
                        return;
                    }
                    if (options?.rejectOnServerError) throw error;
                    return;
                }
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    return;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version >= this.metadataVersion) {
                        if (answer.version > this.metadataVersion) {
                            this.metadataVersion = answer.version;
                            this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        }
                        continue;
                    }
                    if (options?.rejectOnServerError) throw new Error('Metadata version mismatch');
                    return;
                } else if (answer.result === 'error') {
                    if (options?.rejectOnServerError) throw new Error('Metadata update failed');
                    return;
                }
            }
            if (options?.rejectOnServerError) throw new Error('Metadata version mismatch');
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        this.flushOutboundQueue();
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.closing = true;
        this.restoreReconciliationPending = false;
        this.stopPersistedInputReconciliation();
        const workspace = this.metadata?.path;
        if (typeof workspace === 'string' && workspace) {
            void runProjectSessionClose({ workspace, nativeSessionId: this.sessionId,
                notify: (message) => logger.debug('[API] Project close:', message) })
                .catch((error) => logger.debug('[API] Project close failed:', boundedTransportReason(error)));
        }
        const reason = this.outboundQueue.length > 0
            ? `explicit close rejected ${this.outboundQueue.length} queued persistent messages`
            : null;
        this.publishTransportState('closed', reason);
        this.outboundQueue = [];
        this.outboundQueueBytes = 0;
        this.socket.close();
    }
}

function boundedTransportReason(value: unknown): string {
    const text = (value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? 'unknown'))
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(authorization|token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]');
    let bounded = '';
    for (const character of text) {
        if (Buffer.byteLength(bounded + character, 'utf8') > 512) break;
        bounded += character;
    }
    return bounded;
}

function deliveredIdentity(row: SessionRecoveryRow): DeliveredPersistedIdentity {
    return {
        seq: row.seq,
        localId: row.localId,
        createdAt: row.createdAt,
        cipherDigest: createHash('sha256').update(row.content.c).digest('base64url'),
    };
}

function sameDeliveredIdentity(identity: DeliveredPersistedIdentity, row: SessionRecoveryRow): boolean {
    return identity.seq === row.seq && identity.localId === row.localId && identity.createdAt === row.createdAt
        && identity.cipherDigest === createHash('sha256').update(row.content.c).digest('base64url');
}

function recoveryFailureReason(value: unknown): string {
    const reason = boundedTransportReason(value);
    return reason.includes('recovery_incomplete') ? reason : `recovery_incomplete: ${reason}`;
}
