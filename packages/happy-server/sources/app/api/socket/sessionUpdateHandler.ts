import { sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";

/** Threshold for detecting zombie sessions (CLI crashed without sending session-end).
 *  Must be > CACHE_WRITE_INTERVAL(30s) + BATCH_INTERVAL(5s) to avoid false positives. */
const ZOMBIE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/** TTL for the restoring lock to prevent duplicate spawn attempts. */
const RESTORING_LOCK_TTL_MS = 30 * 1000; // 30 seconds

/** In-memory map tracking sessions currently being restored. Value is the timestamp when restore started. */
const restoringLocks = new Map<string, number>();

/**
 * Check if a session needs restore (inactive or zombie) and trigger daemon spawn if so.
 * Returns true if restore was triggered, false otherwise.
 */
async function tryRestoreSession(
    userId: string,
    session: { id: string, active: boolean, lastActiveAt: Date, accountId: string, claudeSessionId: string | null, summary: string | null, plainMachineId: string | null },
    rpcListeners: Map<string, Socket>,
): Promise<boolean> {
    const now = Date.now();
    const isInactive = !session.active;
    const isZombie = session.active && (now - session.lastActiveAt.getTime()) > ZOMBIE_THRESHOLD_MS;

    if (!isInactive && !isZombie) {
        return false;
    }

    // Check heartbeat cache — session may be alive but DB hasn't flushed yet
    if (activityCache.isSessionAlive(session.id)) {
        return false;
    }

    // Check restoring lock
    const lockTime = restoringLocks.get(session.id);
    if (lockTime && (now - lockTime) < RESTORING_LOCK_TTL_MS) {
        return false; // Already restoring, message is stored in DB and will be pulled by CLI
    }

    // Set restoring lock
    restoringLocks.set(session.id, now);

    // If zombie, mark as inactive first
    if (isZombie) {
        await db.session.update({
            where: { id: session.id },
            data: { active: false },
        });
    }

    // Find the correct daemon socket via RPC listeners.
    // RPC methods are registered with machineId prefix (e.g., "machineId:spawn-happy-session").
    // If session has plainMachineId, match precisely. Otherwise fall back to first connected daemon.
    let daemonSocket: Socket | null = null;
    if (session.plainMachineId) {
        const machinePrefix = `${session.plainMachineId}:`;
        for (const [method, sock] of rpcListeners.entries()) {
            if (method.startsWith(machinePrefix) && sock.connected) {
                daemonSocket = sock;
                break;
            }
        }
    } else {
        // Fallback for sessions created before plainMachineId was added
        for (const [_method, sock] of rpcListeners.entries()) {
            if (sock.connected) {
                daemonSocket = sock;
                break;
            }
        }
    }
    if (!daemonSocket) {
        log({ module: 'restore' }, `No connected daemon found for session ${session.id} (machineId=${session.plainMachineId || 'unknown'})`);
        restoringLocks.delete(session.id);
        return false;
    }

    // Send restore request directly to daemon socket (plaintext, bypasses RPC encryption layer).
    // Server→Daemon socket is already authenticated (machine-scoped, token verified).
    log({ module: 'restore' }, `Triggering restore for session ${session.id}`);
    try {
        const response: any = await daemonSocket.timeout(20000).emitWithAck('server-restore-session', {
            sessionId: session.id,
            claudeSessionId: session.claudeSessionId,
            summary: session.summary,
        });
        if (!response.ok) {
            throw new Error(response.error || 'Daemon returned error');
        }
    } catch (error) {
        log({ module: 'restore', level: 'error' }, `Restore failed for session ${session.id}: ${error}`);
        restoringLocks.delete(session.id);
        return false;
    }

    return true;
}

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection, rpcListeners: Map<string, Socket>) {
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion, claudeSessionId, summary, machineId } = data;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Check version
            if (session.metadataVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Update metadata and plaintext fields for restore support
            const updateData: Record<string, any> = {
                metadata: metadata,
                metadataVersion: expectedVersion + 1,
            };
            if (typeof claudeSessionId === 'string') {
                updateData.claudeSessionId = claudeSessionId;
            }
            if (typeof summary === 'string') {
                updateData.summary = summary;
            }
            if (typeof machineId === 'string') {
                updateData.plainMachineId = machineId;
            }
            const { count } = await db.session.updateMany({
                where: { id: sid, metadataVersion: expectedVersion },
                data: updateData,
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Generate session metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, metadata: metadata });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: {
                    id: sid,
                    accountId: userId
                }
            });
            if (!session) {
                callback({ result: 'error' });
                return null;
            }

            // Check version
            if (session.agentStateVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Update agent state
            const { count } = await db.session.updateMany({
                where: { id: sid, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentState,
                    agentStateVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Generate session agent state update
            const updSeq = await allocateUserSeq(userId);
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), undefined, agentStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, agentState: agentState });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive' });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid, thinking } = data;

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Clear restoring lock if session is alive again
            restoringLocks.delete(sid);

            // Queue database update (will only update if time difference is significant)
            activityCache.queueSessionUpdate(sid, t);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                const { sid, message, localId } = data;

                log({ module: 'websocket' }, `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${message.length} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`);

                // Resolve session
                const session = await db.session.findUnique({
                    where: { id: sid, accountId: userId }
                });
                if (!session) {
                    return;
                }
                let useLocalId = typeof localId === 'string' ? localId : null;

                // Create encrypted message
                const msgContent: PrismaJson.SessionMessageContent = {
                    t: 'encrypted',
                    c: message
                };

                // Resolve seq
                const updSeq = await allocateUserSeq(userId);
                const msgSeq = await allocateSessionSeq(sid);

                // Check if message already exists
                if (useLocalId) {
                    const existing = await db.sessionMessage.findFirst({
                        where: { sessionId: sid, localId: useLocalId }
                    });
                    if (existing) {
                        return { msg: existing, update: null };
                    }
                }

                // Create message
                const msg = await db.sessionMessage.create({
                    data: {
                        sessionId: sid,
                        seq: msgSeq,
                        content: msgContent,
                        localId: useLocalId
                    }
                });

                // Emit new message update to relevant clients
                const updatePayload = buildNewMessageUpdate(msg, sid, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });

                // Try to restore session if inactive or zombie
                tryRestoreSession(userId, session, rpcListeners).catch((error) => {
                    log({ module: 'restore', level: 'error' }, `Error in tryRestoreSession: ${error}`);
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
            }
        });
    });

    socket.on('session-end', async (data: {
        sid: string;
        time: number;
    }) => {
        try {
            const { sid, time } = data;
            let t = time;
            if (typeof t !== 'number') {
                return;
            }
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Update last active at
            await db.session.update({
                where: { id: sid },
                data: { lastActiveAt: new Date(t), active: false }
            });

            // Clear heartbeat cache so tryRestoreSession won't be blocked
            activityCache.markSessionDead(sid);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
        }
    });

}