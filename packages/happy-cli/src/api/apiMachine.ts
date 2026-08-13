/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { traceHappyServerSocket } from './serverOperationTrace';

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
    'server-rollback-restored-session': (data: { sessionId: string }, callback: (response: {
        ok: boolean;
        sessionId?: string;
        error?: string;
    }) => void) => void;
    'server-publish-session-error': (data: PublishSessionErrorParams, callback: (response: {
        ok: boolean;
        sessionId?: string;
        eventId?: string;
        error?: string;
    }) => void) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

export interface RestoreSessionParams {
    sessionId: string;
    claudeSessionId: string | null;
    summary: string | null;
}

export interface PublishSessionErrorParams {
    sessionId: string;
    eventId: string;
    source: string;
    code: string;
    message: string;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<boolean>;
    rollbackRestoredSession: (sessionId: string) => Promise<boolean>;
    publishSessionError: (params: PublishSessionErrorParams) => Promise<boolean>;
    requestShutdown: () => void;
    restoreSession: (params: RestoreSessionParams) => Promise<SpawnSessionResult>;
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private restoreSessionHandler: ((params: RestoreSessionParams) => Promise<SpawnSessionResult>) | null = null;
    private rollbackRestoredSessionHandler: ((sessionId: string) => Promise<boolean>) | null = null;
    private publishSessionErrorHandler: ((params: PublishSessionErrorParams) => Promise<boolean>) | null = null;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        rollbackRestoredSession,
        publishSessionError,
        requestShutdown,
        restoreSession
    }: MachineRpcHandlers) {
        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token, environmentVariables, resume } = params || {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token, environmentVariables, resume });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'superseded':
                    logger.debug(`[API MACHINE] Session superseded by a newer resume`);
                    return { type: 'success', sessionId: 'superseded' };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', async (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = await stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });

        // Store restore handler for direct socket event (not encrypted RPC)
        this.restoreSessionHandler = restoreSession;
        this.rollbackRestoredSessionHandler = rollbackRestoredSession;
        this.publishSessionErrorHandler = publishSessionError;
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });
        traceHappyServerSocket(this.socket, `machine:${this.machine.id}`);

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));


            // Register all handlers
            this.rpcHandlerManager.onSocketConnect(this.socket);

            // Start keep-alive
            this.startKeepAlive();
        });

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Direct (unencrypted) restore-session handler for Server-initiated restore.
        // Server→Daemon socket is already authenticated (machine-scoped, token verified).
        // Uses a separate event to bypass RpcHandlerManager's encryption layer.
        this.socket.on('server-restore-session' as any, async (data: RestoreSessionParams, callback: (response: any) => void) => {
            logger.debug(`[API MACHINE] Received server-restore-session: sessionId=${data.sessionId}`);
            if (!this.restoreSessionHandler) {
                callback({ ok: false, error: 'Restore handler not registered' });
                return;
            }
            try {
                const result = await this.restoreSessionHandler(data);
                if (result.type !== 'success') {
                    const error = result.type === 'error'
                        ? result.errorMessage
                        : result.type === 'requestToApproveDirectoryCreation'
                            ? 'Restore requires directory approval'
                            : 'Restore was superseded';
                    callback({ ok: false, error, result });
                    return;
                }
                if (result.sessionId !== data.sessionId) {
                    callback({ ok: false, error: 'Restored session identity mismatch', result });
                    return;
                }
                callback({ ok: true, result });
            } catch (error) {
                const msg = error instanceof Error ? error.message : 'Restore failed';
                logger.debug(`[API MACHINE] Restore failed: ${msg}`);
                callback({ ok: false, error: msg });
            }
        });

        this.socket.on('server-rollback-restored-session', async (data, callback) => {
            if (!data?.sessionId || !this.rollbackRestoredSessionHandler) {
                callback({ ok: false, error: 'Restore rollback handler is unavailable' });
                return;
            }
            try {
                const stopped = await this.rollbackRestoredSessionHandler(data.sessionId);
                callback(stopped
                    ? { ok: true, sessionId: data.sessionId }
                    : { ok: false, error: 'Restored session was not terminated' });
            } catch (error) {
                callback({ ok: false, error: error instanceof Error ? error.message : 'Rollback failed' });
            }
        });

        this.socket.on('server-publish-session-error', async (data, callback) => {
            if (!data?.sessionId || !data.eventId || !this.publishSessionErrorHandler) {
                callback({ ok: false, error: 'Session error publisher is unavailable' });
                return;
            }
            try {
                const published = await this.publishSessionErrorHandler(data);
                callback(published
                    ? { ok: true, sessionId: data.sessionId, eventId: data.eventId }
                    : { ok: false, error: 'Session error was not published' });
            } catch (error) {
                callback({ ok: false, error: error instanceof Error ? error.message : 'Session error publication failed' });
            }
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    /**
     * Notify the server that a session has ended (used for graceful cleanup on Windows
     * where SIGTERM cannot trigger child process cleanup handlers)
     */
    sendSessionEnd(sessionId: string) {
        if (this.socket) {
            (this.socket as any).emit('session-end', { sid: sessionId, time: Date.now() });
            logger.debug(`[API MACHINE] Sent session-end for ${sessionId}`);
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
