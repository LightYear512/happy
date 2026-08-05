import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbMock, cacheMock, eventRouterMock, logMock, allocateUserSeqMock } = vi.hoisted(() => ({
    dbMock: {
        session: {
            update: vi.fn(),
        },
    },
    cacheMock: {
        isSessionAlive: vi.fn(),
        invalidateSession: vi.fn(),
    },
    eventRouterMock: {
        emitEphemeral: vi.fn(),
        emitUpdate: vi.fn(),
    },
    logMock: vi.fn(),
    allocateUserSeqMock: vi.fn(),
}));

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/presence/sessionCache', () => ({ activityCache: cacheMock }));
vi.mock('@/app/events/eventRouter', () => ({
    buildSessionActivityEphemeral: (sid: string, active: boolean, activeAt: number, thinking: boolean) => ({
        sid, active, activeAt, thinking,
    }),
    buildSessionSystemMessageEphemeral: (sid: string, message: string) => ({
        type: 'session-message',
        id: sid,
        eventId: 'restore-failed-event',
        message,
        timestamp: 1,
    }),
    buildNewMessageUpdate: vi.fn(),
    buildUpdateSessionUpdate: (
        sessionId: string,
        seq: number,
        id: string,
        _metadata: unknown,
        _agentState: unknown,
    ) => ({ id, seq, body: { t: 'update-session', id: sessionId }, createdAt: 1 }),
    eventRouter: eventRouterMock,
}));
vi.mock('@/utils/log', () => ({ log: logMock }));
vi.mock('@/app/monitoring/metrics2', () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/storage/seq', () => ({
    allocateSessionSeq: vi.fn(),
    allocateUserSeq: allocateUserSeqMock,
}));

import { tryRestoreSession } from './sessionUpdateHandler';
import type { Socket } from 'socket.io';

const USER_ID = 'user-1';

function makeSession(overrides: Partial<{
    id: string;
    active: boolean;
    lastActiveAt: Date;
    claudeSessionId: string | null;
    summary: string | null;
    plainMachineId: string | null;
}> = {}) {
    return {
        id: overrides.id ?? `sess-${Math.random().toString(36).slice(2, 10)}`,
        accountId: USER_ID,
        active: overrides.active ?? false,
        lastActiveAt: overrides.lastActiveAt ?? new Date(Date.now() - 60 * 1000),
        claudeSessionId: overrides.claudeSessionId ?? null,
        summary: overrides.summary ?? null,
        plainMachineId: overrides.plainMachineId ?? 'machine-1',
    };
}

function makeDaemonSocket(emitAckResult: any | ((event: string, data: any) => any)): Socket {
    const emitWithAck = vi.fn().mockImplementation(async (event: string, data: any) =>
        typeof emitAckResult === 'function' ? emitAckResult(event, data) : emitAckResult);
    const socket: any = {
        connected: true,
        timeout: vi.fn(() => ({ emitWithAck })),
        __emitWithAck: emitWithAck, // expose for assertions
    };
    return socket;
}

function makeRpcListeners(machineId: string, socket: Socket): Map<string, Socket> {
    // RPC methods are registered with prefix `${machineId}:${method}`
    return new Map([[`${machineId}:spawn-happy-session`, socket]]);
}

describe('tryRestoreSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cacheMock.isSessionAlive.mockReturnValue(false);
        dbMock.session.update.mockResolvedValue({});
        allocateUserSeqMock.mockResolvedValue(1);
    });

    it('returns false when session is active and not a zombie', async () => {
        const session = makeSession({ active: true, lastActiveAt: new Date(Date.now() - 10_000) });
        const result = await tryRestoreSession(USER_ID, session, new Map());
        expect(result).toBe(false);
        expect(dbMock.session.update).not.toHaveBeenCalled();
    });

    it('returns false when session is reported alive by heartbeat cache', async () => {
        cacheMock.isSessionAlive.mockReturnValue(true);
        const session = makeSession({ active: false });
        const result = await tryRestoreSession(USER_ID, session, new Map());
        expect(result).toBe(false);
        expect(dbMock.session.update).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ active: true }),
        }));
    });

    it('returns false when no daemon socket is connected for the session machine', async () => {
        const session = makeSession({ active: false, plainMachineId: 'machine-nope' });
        // Empty listeners — no daemon reachable
        const result = await tryRestoreSession(USER_ID, session, new Map());
        expect(result).toBe(false);
        expect(dbMock.session.update).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ active: true }),
        }));
        expect(eventRouterMock.emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER_ID,
            payload: expect.objectContaining({
                type: 'session-message',
                id: session.id,
                message: expect.stringContaining('会话恢复失败'),
            }),
        }));
    });

    it('publishes daemon restore errors through the unified persistent message RPC', async () => {
        const session = makeSession({ active: false });
        const daemonSocket = makeDaemonSocket((event: string, payload: any) => {
            if (event === 'server-restore-session') return { ok: false, error: 'spawn failed' };
            if (event === 'server-publish-session-error') {
                return { ok: true, sessionId: session.id, eventId: payload.eventId };
            }
            throw new Error(`Unexpected event ${event}`);
        });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(false);
        // DB update / cache invalidate / broadcast must NOT happen on failure
        expect(dbMock.session.update).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ active: true }),
        }));
        expect(cacheMock.invalidateSession).not.toHaveBeenCalled();
        expect((daemonSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'server-publish-session-error',
            expect.objectContaining({ sessionId: session.id, source: 'happy.restore', code: 'happy.restore.failed' }),
        );
        expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    });

    it('rolls back the daemon and publishes a unified visible error when post-ack activation fails', async () => {
        const session = makeSession({ active: false });
        dbMock.session.update.mockRejectedValueOnce(new Error('database unavailable'));
        const daemonSocket = makeDaemonSocket((event: string, payload: any) => {
            if (event === 'server-restore-session') {
                return { ok: true, result: { type: 'success', sessionId: session.id } };
            }
            if (event === 'server-rollback-restored-session') {
                return { ok: true, sessionId: session.id };
            }
            if (event === 'server-publish-session-error') {
                return { ok: true, sessionId: session.id, eventId: payload.eventId };
            }
            throw new Error(`Unexpected event ${event}`);
        });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(false);
        expect((daemonSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'server-rollback-restored-session',
            { sessionId: session.id },
        );
        expect((daemonSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'server-publish-session-error', expect.objectContaining({ sessionId: session.id }));
        expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    });

    it('rejects a typed daemon failure even when the transport ack is ok', async () => {
        const session = makeSession({ active: false });
        const daemonSocket = makeDaemonSocket((event: string, payload: any) => {
            if (event === 'server-restore-session') {
                return { ok: true, result: { type: 'error', errorMessage: 'restore failed' } };
            }
            if (event === 'server-publish-session-error') {
                return { ok: true, sessionId: session.id, eventId: payload.eventId };
            }
            throw new Error(`Unexpected event ${event}`);
        });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(false);
        expect(cacheMock.invalidateSession).not.toHaveBeenCalled();
        expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    });

    it('rejects a restored session with a different Happy session id', async () => {
        const session = makeSession({ active: false });
        const daemonSocket = makeDaemonSocket((event: string, payload: { sessionId: string }) => {
            if (event === 'server-restore-session') {
                return { ok: true, result: { type: 'success', sessionId: 'replacement-session' } };
            }
            if (event === 'server-rollback-restored-session') {
                return { ok: true, sessionId: payload.sessionId };
            }
            if (event === 'server-publish-session-error') {
                return { ok: true, sessionId: session.id, eventId: (payload as any).eventId };
            }
            throw new Error(`Unexpected event ${event}`);
        });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(false);
        expect(cacheMock.invalidateSession).not.toHaveBeenCalled();
        expect((daemonSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'server-rollback-restored-session',
            { sessionId: 'replacement-session' },
        );
        expect((daemonSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'server-rollback-restored-session',
            { sessionId: session.id },
        );
        expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    });

    it('success path: daemon ack → DB active=true, cache invalidated, ephemeral emitted', async () => {
        const session = makeSession({ active: false });
        const daemonSocket = makeDaemonSocket({
            ok: true,
            result: { type: 'success', sessionId: session.id },
        });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(true);

        // 1. server-restore-session RPC was sent to daemon
        expect((daemonSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'server-restore-session',
            expect.objectContaining({
                sessionId: session.id,
                claudeSessionId: session.claudeSessionId,
                summary: session.summary,
            }),
        );

        // 2. DB was explicitly updated to active=true with fresh lastActiveAt
        expect(dbMock.session.update).toHaveBeenCalledTimes(1);
        const dbCall = dbMock.session.update.mock.calls[0][0];
        expect(dbCall.where).toEqual({ id: session.id });
        expect(dbCall.data.active).toBe(true);
        expect(dbCall.data.lastActiveAt).toBeInstanceOf(Date);
        // 3. Cache was invalidated so next validate re-fetches fresh DB state
        expect(cacheMock.invalidateSession).toHaveBeenCalledWith(session.id);

        // 4. Ephemeral broadcast was emitted for user-scoped clients
        expect(eventRouterMock.emitEphemeral).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: USER_ID,
                payload: expect.objectContaining({
                    sid: session.id,
                    active: true,
                }),
                recipientFilter: { type: 'user-scoped-only' },
            }),
        );
    });

    it('zombie session (active=true, stale lastActiveAt) triggers restore flow', async () => {
        // active=true but lastActiveAt > ZOMBIE_THRESHOLD (2 min) ago
        const session = makeSession({ active: true, lastActiveAt: new Date(Date.now() - 5 * 60 * 1000) });
        const daemonSocket = makeDaemonSocket({
            ok: true,
            result: { type: 'success', sessionId: session.id },
        });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(true);
        expect(dbMock.session.update).toHaveBeenCalled();
        expect(cacheMock.invalidateSession).toHaveBeenCalled();
    });

});
