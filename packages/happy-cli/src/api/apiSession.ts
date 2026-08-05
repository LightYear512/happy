import { logger } from '@/ui/logger'
import axios from 'axios';
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage, modelFacingUserText } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
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
    mergeRecoveryMessages,
    recoveryRowBytes,
    sameRecoveryRow,
    selectRecoveryMessages,
    type SessionRecoveryAnchor,
    type SessionRecoveryRow,
} from './sessionMessageRecovery';
import {
    createSessionTransportHealthReporter,
    SESSION_TRANSPORT_HEALTH_HEARTBEAT_MS,
    type SessionTransportHealthRecord,
    type SessionTransportHealthReporter,
    type SessionTransportHealthState,
} from './sessionTransportHealth';
import { ensureProjectWatch, runProjectSessionClose, runProjectSessionInput, runProjectSessionStartup, runProjectSessionStop,
    runProjectSessionTurnEnd } from '@/utils/projectSessionStartup';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';

const MAX_OUTBOUND_QUEUE_MESSAGES = 256;
const MAX_OUTBOUND_QUEUE_BYTES = 1_048_576;
const MAX_SEEN_MESSAGE_IDS = 512;
const MAX_RECOVERY_BUFFER_ROWS = 512;

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
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private transportState: SessionTransportHealthState = 'connecting';
    private transportReason: string | null = null;
    private readonly transportHealth: SessionTransportHealthReporter | null;
    private latestTransportHealth: SessionTransportHealthRecord | null | undefined;
    private transportHealthHeartbeat: NodeJS.Timeout | null = null;
    private daemonRegistration: Promise<void> | null = null;
    private queuedDaemonRegistration: { metadata: Metadata;
        transportHealth: SessionTransportHealthRecord | null | undefined } | undefined;
    private hasConnected = false;
    private closing = false;
    private serverEvictionRecoveries = 0;
    private lastObservedMessage: SessionRecoveryAnchor;
    private reconciling = false;
    private recoveryBuffer: SessionRecoveryRow[] = [];
    private recoveryBufferBytes = 0;
    private seenMessagesById = new Map<string, SessionRecoveryRow>();
    private seenMessageIdBySeq = new Map<number, string>();
    private seenMessageOrder: string[] = [];
    private outboundQueue: QueuedPersistentMessage[] = [];
    private outboundQueueBytes = 0;
    private projectInputQueue: Promise<void> = Promise.resolve();
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
        this.transportHealth = safeTransportHealthReporter(this.metadata.path, this.sessionId);
        this.publishTransportState('connecting', null);

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
                    const [message] = mergeRecoveryMessages([], [data.body.message as SessionRecoveryRow]);
                    if (this.reconciling) {
                        const bytes = recoveryRowBytes(message);
                        if (this.recoveryBuffer.length >= MAX_RECOVERY_BUFFER_ROWS
                            || this.recoveryBufferBytes + bytes > MAX_RECOVERY_COLLECTION_BYTES) {
                            this.failTransport('recovery_incomplete: live recovery buffer exceeded budget');
                            return;
                        }
                        this.recoveryBuffer.push(message);
                        this.recoveryBufferBytes += bytes;
                    } else {
                        this.deliverPersistedMessage(message, message.localId);
                    }
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
                    this.failTransport(recoveryFailureReason(error));
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
        void this.ensureProjectSessionStartup();
        if (!this.hasConnected) {
            this.hasConnected = true;
            this.publishTransportState('connected', null);
            this.flushOutboundQueue();
            return;
        }
        void this.reconcileAfterReconnect();
    }

    private ensureProjectSessionStartup(): Promise<boolean> {
        if (this.projectStartup) return this.projectStartup;
        const workspace = this.metadata?.path;
        if (typeof workspace !== 'string' || !workspace) return Promise.resolve(true);
        this.projectStartup = runProjectSessionStartup({ workspace, nativeSessionId: this.sessionId,
            notify: (message) => this.sendSessionEvent({ type: 'message', message }) });
        void this.projectStartup.then((success) => { if (!success) this.projectStartup = null; },
            () => { this.projectStartup = null; });
        return this.projectStartup;
    }

    private recordProjectTurnEnd(status: SessionTurnEndStatus): void {
        const workspace = this.metadata?.path;
        if (typeof workspace !== 'string' || !workspace) return;
        this.projectInputQueue = this.projectInputQueue.then(() => runProjectSessionTurnEnd({ workspace,
            nativeSessionId: this.sessionId, status: status === 'failed' ? 'error' : status,
            notify: (message) => logger.debug('[API] Project turn end:', message) }))
            .catch((error) => logger.debug('[API] Project turn end failed:', boundedTransportReason(error)));
    }

    private handleSocketDisconnect(reason: string): void {
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
            this.resetRecovery();
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

    private async reconcileAfterReconnect(): Promise<void> {
        if (this.reconciling || this.closing) return;
        this.reconciling = true;
        this.publishTransportState('reconciling', this.transportReason);
        const anchor = { ...this.lastObservedMessage };
        try {
            const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${this.sessionId}/messages`, {
                headers: { Authorization: `Bearer ${this.token}` },
                timeout: 10_000,
                maxContentLength: MAX_RECOVERY_RESPONSE_BYTES,
            });
            if (this.isTerminalTransport()) return;
            if (!Array.isArray(response.data?.messages)) throw new Error('recovery_incomplete: message collection is invalid');
            const recovery = selectRecoveryMessages(response.data.messages, anchor);
            for (const message of mergeRecoveryMessages(recovery, this.recoveryBuffer.splice(0))) {
                this.deliverPersistedMessage(message, message.localId);
            }
            this.recoveryBufferBytes = 0;
            if (this.isTerminalTransport()) return;
            this.reconciling = false;
            this.publishTransportState('connected', null);
            this.flushOutboundQueue();
        } catch (error) {
            this.resetRecovery();
            this.failTransport(recoveryFailureReason(error));
        }
    }

    private deliverPersistedMessage(message: SessionRecoveryRow, localId: string | null = null): void {
        if (this.isAlreadyObservedMessage(message)) return;
        if (message.seq <= this.lastObservedMessage.seq) {
            throw new Error('recovery_incomplete: persisted delivery does not advance the exact message anchor');
        }
        const body = this.decryptPersistedMessage(message);
        if (localId) body.localKey = localId;
        logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)
        const userResult = UserMessageSchema.safeParse(body);
        if (userResult.success) {
            if (this.pendingMessageCallback) this.pendingMessageCallback(userResult.data);
            else this.pendingMessages.push(userResult.data);
        } else if ((body as Record<string, unknown>).role === 'user') {
            throw new Error('recovery_incomplete: persisted user message body is invalid');
        } else {
            this.emit('message', body);
        }
        this.rememberPersistedMessage(message);
        this.lastObservedMessage = { id: message.id, seq: message.seq };
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
        const existing = this.seenMessagesById.get(message.id);
        if (existing) {
            if (!sameRecoveryRow(existing, message)) {
                throw new Error('recovery_incomplete: one delivered message id has conflicting persisted identity');
            }
            return true;
        }
        const seqOwner = this.seenMessageIdBySeq.get(message.seq);
        if (seqOwner && seqOwner !== message.id) {
            throw new Error('recovery_incomplete: one delivered message sequence has conflicting ids');
        }
        return false;
    }

    private rememberPersistedMessage(message: SessionRecoveryRow): void {
        this.seenMessagesById.set(message.id, message);
        this.seenMessageIdBySeq.set(message.seq, message.id);
        this.seenMessageOrder.push(message.id);
        if (this.seenMessageOrder.length > MAX_SEEN_MESSAGE_IDS) {
            const removed = this.seenMessageOrder.shift();
            if (removed) {
                const removedMessage = this.seenMessagesById.get(removed);
                this.seenMessagesById.delete(removed);
                if (removedMessage) this.seenMessageIdBySeq.delete(removedMessage.seq);
            }
        }
    }

    private publishTransportState(state: SessionTransportHealthState, reason: string | null): void {
        const changed = state !== this.transportState;
        this.transportState = state;
        this.transportReason = reason === null ? null : boundedTransportReason(reason);
        const snapshot = this.getTransportSnapshot();
        const health = this.writeTransportHealth(state, snapshot);
        if (state === 'connected') this.startTransportHealthHeartbeat();
        else this.stopTransportHealthHeartbeat();
        if (changed && state !== 'connecting') void this.refreshDaemonSessionTracking(health);
        this.emit('transport-state', snapshot);
    }

    private writeTransportHealth(
        state: SessionTransportHealthState,
        snapshot: SessionTransportSnapshot,
    ): SessionTransportHealthRecord | null | undefined {
        if (!this.transportHealth) {
            this.latestTransportHealth = undefined;
            return undefined;
        }
        try {
            this.latestTransportHealth = this.transportHealth.write(state, {
                reconnectCount: snapshot.reconnectCount,
                queueMessages: snapshot.queueMessages,
                queueBytes: snapshot.queueBytes,
                reason: snapshot.reason,
            });
        } catch (error) {
            this.latestTransportHealth = null;
            logger.warn('[API] Failed to publish Happy transport health:', boundedTransportReason(error));
        }
        return this.latestTransportHealth;
    }

    private startTransportHealthHeartbeat(): void {
        if (this.transportHealthHeartbeat) return;
        this.transportHealthHeartbeat = setInterval(() => {
            if (this.transportState === 'connected') {
                const health = this.writeTransportHealth('connected', this.getTransportSnapshot());
                void this.refreshDaemonSessionTracking(health);
            }
        }, SESSION_TRANSPORT_HEALTH_HEARTBEAT_MS);
        this.transportHealthHeartbeat.unref();
    }

    private refreshDaemonSessionTracking(
        transportHealth: SessionTransportHealthRecord | null | undefined = this.latestTransportHealth,
    ): Promise<void> {
        if (!this.metadata) return Promise.resolve();
        this.queuedDaemonRegistration = {
            metadata: { ...this.metadata, hostPid: process.pid },
            transportHealth,
        };
        if (this.daemonRegistration) return this.daemonRegistration;
        const drain = async () => {
            while (this.queuedDaemonRegistration !== undefined) {
                const registration = this.queuedDaemonRegistration;
                this.queuedDaemonRegistration = undefined;
                try {
                    const result = await notifyDaemonSessionStarted(this.sessionId,
                        registration.metadata, undefined, registration.transportHealth);
                    if (result?.error) logger.debug('[API] Failed to refresh daemon session tracking:',
                        boundedTransportReason(result.error));
                } catch (error) {
                    logger.debug('[API] Failed to refresh daemon session tracking:', boundedTransportReason(error));
                }
            }
        };
        this.daemonRegistration = drain().finally(() => {
            this.daemonRegistration = null;
            if (this.queuedDaemonRegistration !== undefined) {
                void this.refreshDaemonSessionTracking(this.queuedDaemonRegistration.transportHealth);
            }
        });
        return this.daemonRegistration;
    }

    private stopTransportHealthHeartbeat(): void {
        if (!this.transportHealthHeartbeat) return;
        clearInterval(this.transportHealthHeartbeat);
        this.transportHealthHeartbeat = null;
    }

    private failTransport(reason: string): void {
        if (this.isTerminalTransport()) return;
        this.resetRecovery();
        this.publishTransportState('failed', reason);
        this.emit('transport-fatal', this.getTransportSnapshot());
        this.socket.disconnect();
    }

    private resetRecovery(): void {
        this.reconciling = false;
        this.recoveryBuffer = [];
        this.recoveryBufferBytes = 0;
    }

    private isTerminalTransport(): boolean {
        return this.transportState === 'failed' || this.transportState === 'ownership_conflict' ||
            this.transportState === 'closed';
    }

    private sendPersistentMessage(encrypted: string): void {
        if (this.socket.connected && this.transportState === 'connected') {
            const localId = `happy-cli-v1-${randomUUID()}`;
            this.socket.emit('message', { sid: this.sessionId, message: encrypted, localId });
            return;
        }
        if (this.transportState === 'failed' || this.transportState === 'ownership_conflict' ||
            this.transportState === 'closed') {
            logger.warn('[API] Persistent message rejected by terminal Happy transport:', this.transportState);
            this.emit('transport-fatal', this.getTransportSnapshot());
            throw new Error(`Happy persistent message rejected: transport is ${this.transportState}`);
        }
        const bytes = Buffer.byteLength(encrypted, 'utf8');
        if (this.outboundQueue.length >= MAX_OUTBOUND_QUEUE_MESSAGES ||
            this.outboundQueueBytes + bytes > MAX_OUTBOUND_QUEUE_BYTES) {
            this.failTransport('outbound_queue_overflow: persistent message recovery queue exceeded budget');
            throw new Error('Happy persistent message rejected: outbound_queue_overflow');
        }
        const localId = `happy-cli-v1-${randomUUID()}`;
        this.outboundQueue.push({ encrypted, localId, bytes });
        this.outboundQueueBytes += bytes;
        this.publishTransportState(this.transportState, this.transportReason);
    }

    private flushOutboundQueue(): void {
        if (!this.socket.connected || this.transportState !== 'connected' || this.outboundQueue.length === 0) return;
        const queued = this.outboundQueue.splice(0);
        this.outboundQueueBytes = 0;
        for (const message of queued) {
            this.socket.emit('message', { sid: this.sessionId, message: message.encrypted, localId: message.localId });
        }
        this.publishTransportState('connected', null);
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        const deliver = (message: UserMessage) => {
            const workspace = this.metadata?.path;
            if (typeof workspace === 'string' && workspace) {
                const safeStop = ['app', 'web', 'android', 'ios', 'mac'].includes(message.meta?.sentFrom ?? '')
                    && message.content.text.trim() === '@stop';
                if (!safeStop) void ensureProjectWatch({ workspace }).catch((error) => {
                    logger.debug('[API] Failed to ensure project Watch:', boundedTransportReason(error)); });
                this.projectInputQueue = this.projectInputQueue.then(async () => {
                    if (safeStop) {
                        const stopped = await runProjectSessionStop({ workspace, nativeSessionId: this.sessionId,
                            notify: (value) => this.sendSessionEvent({ type: 'message', message: value }) });
                        if (stopped === true) {
                            this.sendSessionEvent({ type: 'message',
                                message: '已请求安全停止；当前轮结束后停止。' });
                        }
                        if (stopped !== null) return;
                    }
                    const modelText = modelFacingUserText(message);
                    await this.refreshDaemonSessionTracking();
                    await this.ensureProjectSessionStartup();
                    const context = await runProjectSessionInput({ workspace, nativeSessionId: this.sessionId,
                        ...(message.localKey ? { localId: message.localKey } : {}), messageText: modelText,
                        notify: (value) => this.sendSessionEvent({ type: 'message', message: value }) });
                    callback(context ? { ...message, meta: { ...message.meta, modelText: `${context}\n\n${modelText}` } } : message);
                }).catch((error) => {
                    logger.debug('[API] Project input rejected:', boundedTransportReason(error));
                    this.sendSessionEvent({ type: 'ready' });
                });
                return;
            }
            callback(message);
        };
        this.pendingMessageCallback = deliver;
        while (this.pendingMessages.length > 0) {
            deliver(this.pendingMessages.shift()!);
        }
    }

    /**
     * Inject a message into the pending queue (used after restore to deliver
     * the trigger message that arrived before this socket connected).
     */
    injectPendingMessage(message: UserMessage) {
        if (this.pendingMessageCallback) {
            this.pendingMessageCallback(message);
        } else {
            this.pendingMessages.push(message);
        }
    }

    /** Injects one persisted external user row exactly once across restore/query and live Socket races. */
    injectPendingPersistedUserMessage(rawRow: unknown): boolean {
        const [message] = mergeRecoveryMessages([], [rawRow as SessionRecoveryRow]);
        if (this.isAlreadyObservedMessage(message)) return false;
        const body = this.decryptPersistedMessage(message);
        if (message.localId) body.localKey = message.localId;
        const parsed = UserMessageSchema.safeParse(body);
        if (!parsed.success) {
            throw new Error('recovery_incomplete: pending persisted user message is invalid');
        }
        this.rememberPersistedMessage(message);
        this.injectPendingMessage(parsed.data);
        return true;
    }

    markRestoreRecoveryFailed(error: unknown): void {
        if (this.closing || this.transportState === 'closed' || this.transportState === 'ownership_conflict') return;
        const reason = boundedTransportReason(error);
        this.failTransport(reason.includes('recovery_incomplete') ? reason : `recovery_incomplete: ${reason}`);
    }

    getSummaryText(): string | null {
        return this.metadata?.summary?.text ?? null;
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
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
        this.sendPersistentMessage(encrypted);

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
        this.recordProjectTurnEnd(status);
        // No-op: turn lifecycle is managed by the caller via sendSessionEvent({ type: 'ready' })
        // Session protocol turn-end envelopes are not understood by the mobile app in legacy mode
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

        this.sendPersistentMessage(encrypted);
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

        this.sendPersistentMessage(encrypted);
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
        this.sendPersistentMessage(encrypted);
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
        if (event.type === 'ready') this.recordProjectTurnEnd('completed');
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.sendPersistentMessage(encrypted);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
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
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)),
                    claudeSessionId: updated.claudeSessionId,
                    summary: updated.summary?.text,
                    machineId: updated.machineId,
                });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    if (options?.rejectOnServerError) throw new Error('Metadata update failed');
                }
            });
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
        if (this.daemonRegistration) await this.daemonRegistration;
        const workspace = this.metadata?.path;
        if (typeof workspace === 'string' && workspace) await runProjectSessionClose({ workspace,
            nativeSessionId: this.sessionId, notify: (message) => logger.debug('[API] Project close:', message) });
        this.stopTransportHealthHeartbeat();
        const reason = this.outboundQueue.length > 0
            ? `explicit close rejected ${this.outboundQueue.length} queued persistent messages`
            : null;
        this.publishTransportState('closed', reason);
        while (this.daemonRegistration) await this.daemonRegistration;
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

function recoveryFailureReason(value: unknown): string {
    const reason = boundedTransportReason(value);
    return reason.includes('recovery_incomplete') ? reason : `recovery_incomplete: ${reason}`;
}

function safeTransportHealthReporter(workspace: string, sessionId: string): SessionTransportHealthReporter | null {
    try {
        return createSessionTransportHealthReporter(workspace, sessionId);
    } catch (error) {
        logger.warn('[API] Happy transport health reporting is unavailable:', boundedTransportReason(error));
        return null;
    }
}
