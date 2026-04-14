import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbMock, cacheMock, eventRouterMock, logMock } = vi.hoisted(() => ({
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
    },
    logMock: vi.fn(),
}));

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/presence/sessionCache', () => ({ activityCache: cacheMock }));
vi.mock('@/app/events/eventRouter', () => ({
    buildSessionActivityEphemeral: (sid: string, active: boolean, activeAt: number, thinking: boolean) => ({
        sid, active, activeAt, thinking,
    }),
    buildNewMessageUpdate: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
    eventRouter: eventRouterMock,
}));
vi.mock('@/utils/log', () => ({ log: logMock }));
vi.mock('@/app/monitoring/metrics2', () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/storage/seq', () => ({
    allocateSessionSeq: vi.fn(),
    allocateUserSeq: vi.fn(),
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

function makeDaemonSocket(emitAckResult: any = { ok: true }): Socket {
    const emitWithAck = vi.fn().mockResolvedValue(emitAckResult);
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
        expect(dbMock.session.update).not.toHaveBeenCalled();
    });

    it('returns false when no daemon socket is connected for the session machine', async () => {
        const session = makeSession({ active: false, plainMachineId: 'machine-nope' });
        // Empty listeners — no daemon reachable
        const result = await tryRestoreSession(USER_ID, session, new Map());
        expect(result).toBe(false);
        expect(dbMock.session.update).not.toHaveBeenCalled();
        expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    });

    it('returns false when daemon RPC returns error', async () => {
        const session = makeSession({ active: false });
        const daemonSocket = makeDaemonSocket({ ok: false, error: 'spawn failed' });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(false);
        // DB update / cache invalidate / broadcast must NOT happen on failure
        expect(dbMock.session.update).not.toHaveBeenCalled();
        expect(cacheMock.invalidateSession).not.toHaveBeenCalled();
        expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    });

    it('success path: daemon ack → DB active=true, cache invalidated, ephemeral emitted', async () => {
        const session = makeSession({ active: false });
        const daemonSocket = makeDaemonSocket({ ok: true });
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
        const daemonSocket = makeDaemonSocket({ ok: true });
        const listeners = makeRpcListeners(session.plainMachineId!, daemonSocket);

        const result = await tryRestoreSession(USER_ID, session, listeners);
        expect(result).toBe(true);
        expect(dbMock.session.update).toHaveBeenCalled();
        expect(cacheMock.invalidateSession).toHaveBeenCalled();
    });

});
