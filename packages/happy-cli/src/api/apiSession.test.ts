import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { modelFacingUserText } from './types';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo, getMock, ensureProjectWatchMock, runProjectSessionStartupMock,
    runProjectSessionInputMock, runProjectSessionStopMock, runProjectSessionCloseMock, notifyDaemonSessionStartedMock } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    getMock: vi.fn(),
    ensureProjectWatchMock: vi.fn(),
    runProjectSessionStartupMock: vi.fn(),
    runProjectSessionInputMock: vi.fn(),
    runProjectSessionStopMock: vi.fn(),
    runProjectSessionCloseMock: vi.fn(),
    notifyDaemonSessionStartedMock: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));
vi.mock('axios', () => ({
    default: { get: getMock },
}));
vi.mock('@/utils/projectSessionStartup', () => ({
    ensureProjectWatch: ensureProjectWatchMock,
    runProjectSessionStartup: runProjectSessionStartupMock,
    runProjectSessionInput: runProjectSessionInputMock,
    runProjectSessionStop: runProjectSessionStopMock,
    runProjectSessionClose: runProjectSessionCloseMock,
}));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: notifyDaemonSessionStartedMock }));

describe('ApiSessionClient connection handling', () => {
    let mockSocket: any;
    let consoleSpy: any;
    let mockSession: any;
    let handlers: Map<string, (...args: any[]) => any>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        handlers = new Map();
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
            once: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
            off: vi.fn(),
            emit: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            volatile: { emit: vi.fn() },
        };

        mockIo.mockReturnValue(mockSocket);
        getMock.mockReset().mockResolvedValue({ data: { messages: [] } });
        ensureProjectWatchMock.mockReset().mockResolvedValue(undefined);
        runProjectSessionStartupMock.mockReset().mockResolvedValue(true);
        runProjectSessionInputMock.mockReset().mockResolvedValue(null);
        runProjectSessionStopMock.mockReset().mockResolvedValue(true);
        runProjectSessionCloseMock.mockReset().mockResolvedValue(undefined);
        notifyDaemonSessionStartedMock.mockReset().mockResolvedValue({ status: 'ok' });

        // Create a proper mock session with metadata
        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools',
                hostPid: 123,
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            new ApiSessionClient('fake-token', mockSession);
        }).not.toThrow();
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('re-registers an idle connected session with the current process identity', async () => {
        vi.useFakeTimers();
        let finish = (_value: { status: string }) => {};
        notifyDaemonSessionStartedMock.mockImplementationOnce(() =>
            new Promise((resolve) => { finish = resolve; }));
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        await Promise.resolve();
        expect(notifyDaemonSessionStartedMock).toHaveBeenCalledWith(mockSession.id, {
            ...mockSession.metadata,
            hostPid: process.pid,
        }, undefined, undefined);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(1);
        finish({ status: 'ok' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(notifyDaemonSessionStartedMock).toHaveBeenCalledWith(mockSession.id, {
            ...mockSession.metadata,
            hostPid: process.pid,
        }, undefined, undefined);
        expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(3);
        expect(runProjectSessionInputMock).not.toHaveBeenCalled();
        await client.close();
    });

    it('waits for an in-flight daemon registration before closing the provider', async () => {
        let finish = (_value: { status: string }) => {};
        notifyDaemonSessionStartedMock.mockImplementationOnce(() =>
            new Promise((resolve) => { finish = resolve; }));
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        const closing = client.close();
        await Promise.resolve();
        expect(runProjectSessionCloseMock).not.toHaveBeenCalled();
        finish({ status: 'ok' });
        await closing;
        expect(runProjectSessionCloseMock).toHaveBeenCalledOnce();
    });

    it('pushes connected and terminal input health through the existing daemon webhook', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happy-api-health-push-'));
        try {
            await mkdir(join(workspace, '.virtual-session'));
            mockSession.metadata.path = workspace;
            const client = new ApiSessionClient('fake-token', mockSession);
            mockSocket.connected = true;
            handlers.get('connect')?.();
            await vi.waitFor(() => expect(notifyDaemonSessionStartedMock).toHaveBeenCalled());
            expect(notifyDaemonSessionStartedMock.mock.calls.at(-1)?.[3]).toMatchObject({
                schema: 'xc.happy-session-transport-health.v1',
                nativeSessionId: mockSession.id,
                processId: process.pid,
                state: 'connected',
            });
            await client.close();
            expect(notifyDaemonSessionStartedMock.mock.calls.at(-1)?.[3]).toMatchObject({
                nativeSessionId: mockSession.id,
                processId: process.pid,
                state: 'closed',
            });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('blocks reconnect while the project close hook is still running', async () => {
        let finishClose = () => {};
        runProjectSessionCloseMock.mockImplementation(() => new Promise<void>((resolve) => { finishClose = resolve; }));
        const client = new ApiSessionClient('fake-token', mockSession);
        const closing = client.close();
        await vi.waitFor(() => expect(runProjectSessionCloseMock).toHaveBeenCalledOnce());

        mockSocket.connected = true;
        handlers.get('connect')?.();
        expect(mockSocket.disconnect).toHaveBeenCalledOnce();

        finishClose();
        await closing;
    });

    it('should send session protocol messages wrapped in session content envelope', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        mockSocket.emit.mockClear();
        const envelope = {
            id: 'env-1',
            time: 1000,
            role: 'agent' as const,
            turn: 'turn-1',
            ev: { t: 'text' as const, text: 'Hello from session protocol' },
        };

        client.sendSessionProtocolMessage(envelope);

        expect(mockSocket.emit).toHaveBeenCalledTimes(1);
        const [eventName, payload] = mockSocket.emit.mock.calls[0];
        expect(eventName).toBe('message');
        expect(payload.sid).toBe('test-session-id');

        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message)
        );

        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                type: 'session',
                data: envelope
            },
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('HSR performs one delayed reclaim after server eviction and reports a second eviction as conflict', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        expect(client.getTransportSnapshot().state).toBe('connected');

        mockSocket.connected = false;
        handlers.get('disconnect')?.('io server disconnect');
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({ state: 'recovering', reconnectCount: 1 }));
        const initialConnectCalls = mockSocket.connect.mock.calls.length;
        await vi.advanceTimersByTimeAsync(6_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(initialConnectCalls + 1);

        mockSocket.connected = true;
        handlers.get('connect')?.();
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(client.getTransportSnapshot().state).toBe('connected');

        mockSocket.connected = false;
        handlers.get('disconnect')?.('io server disconnect');
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({ state: 'ownership_conflict', reconnectCount: 1 }));
        vi.useRealTimers();
    });

    it('HSR reconciles missed user messages in sequence order without duplicate delivery', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        mockSocket.connected = true;
        handlers.get('connect')?.();
        const makeRow = (id: string, seq: number, text: string) => ({
            id,
            seq,
            createdAt: 1_000 + seq,
            content: {
                t: 'encrypted' as const,
                c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                    role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'app' },
                })),
            },
        });
        const row10 = makeRow('m-10', 10, 'ten');
        const row11 = makeRow('m-11', 11, 'eleven');
        const row12 = makeRow('m-12', 12, 'twelve');
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row10 } });
        await vi.waitFor(() => expect(delivered).toEqual(['ten']));

        mockSocket.connected = false;
        handlers.get('disconnect')?.('transport close');
        getMock.mockResolvedValue({ data: { messages: [row12, row10, row11] } });
        mockSocket.connected = true;
        handlers.get('connect')?.();
        await vi.waitFor(() => expect(delivered).toEqual(['ten', 'eleven', 'twelve']));
        expect(client.getTransportSnapshot().state).toBe('connected');
    });

    it('HSR deduplicates an exact restore row against a later live Socket delivery', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        mockSocket.connected = true;
        handlers.get('connect')?.();
        const row = {
            id: 'restore-live-race',
            seq: 15,
            createdAt: 1_015,
            content: {
                t: 'encrypted' as const,
                c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                    role: 'user', content: { type: 'text', text: 'once' }, meta: { sentFrom: 'app' },
                })),
            },
        };
        expect(client.injectPendingPersistedUserMessage(row)).toBe(true);
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row } });
        await vi.waitFor(() => expect(delivered).toEqual(['once']));
        expect(client.injectPendingPersistedUserMessage(row)).toBe(false);
    });

    it('HSR admits a persisted Mail input with the same local identity as live delivery', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        const localId = `xc-msg-v1-${'c'.repeat(64)}`;
        const row = {
            id: 'restore-mail-input', seq: 16, localId, createdAt: 1_016,
            content: { t: 'encrypted' as const, c: encodeBase64(encrypt(mockSession.encryptionKey,
                mockSession.encryptionVariant, { role: 'user', content: { type: 'text', text: 'Mail display' },
                    meta: { sentFrom: 'cli', presentation: 'compact', modelText: 'verified command' } })) },
        };
        expect(client.injectPendingPersistedUserMessage(row)).toBe(true);
        await vi.waitFor(() => expect(delivered).toEqual(['verified command']));
        expect(runProjectSessionInputMock).toHaveBeenCalledWith(expect.objectContaining({
            workspace: '/tmp', nativeSessionId: mockSession.id, localId, messageText: 'verified command',
        }));
    });

    it('wakes the project Watch for queued recovery and live user input', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const recovered = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'recovered' },
            meta: { sentFrom: 'app' as const },
        };
        const live = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'live' },
            meta: { sentFrom: 'app' as const },
        };
        const delivered: string[] = [];
        client.injectPendingMessage(recovered);
        client.onUserMessage((message) => delivered.push(message.content.text));
        client.injectPendingMessage(live);
        await vi.waitFor(() => expect(delivered).toEqual(['recovered', 'live']));
        expect(ensureProjectWatchMock).toHaveBeenCalledTimes(2);
        expect(ensureProjectWatchMock).toHaveBeenCalledWith({ workspace: '/tmp' });
        expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(2);
        expect(notifyDaemonSessionStartedMock).toHaveBeenCalledWith(mockSession.id, {
            ...mockSession.metadata,
            hostPid: process.pid,
        }, undefined, undefined);
    });

    it('intercepts an exact human @stop before model delivery but preserves CLI messages', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: ' @stop\n' },
            meta: { sentFrom: 'app' } });
        await vi.waitFor(() => expect(runProjectSessionStopMock).toHaveBeenCalledOnce());
        expect(ensureProjectWatchMock).not.toHaveBeenCalled();
        expect(notifyDaemonSessionStartedMock).not.toHaveBeenCalled();
        expect(runProjectSessionStartupMock).not.toHaveBeenCalled();
        expect(runProjectSessionInputMock).not.toHaveBeenCalled();
        expect(delivered).toEqual([]);

        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: '@stop' },
            meta: { sentFrom: 'cli' } });
        await vi.waitFor(() => expect(delivered).toEqual(['@stop']));
        expect(runProjectSessionInputMock).toHaveBeenCalledOnce();
        expect(runProjectSessionStopMock).toHaveBeenCalledOnce();
    });

    it('keeps @stop as ordinary model input outside an XC project', async () => {
        runProjectSessionStopMock.mockResolvedValueOnce(null);
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: '@stop' },
            meta: { sentFrom: 'app' } });
        await vi.waitFor(() => expect(delivered).toEqual(['@stop']));
        expect(runProjectSessionInputMock).toHaveBeenCalledOnce();
    });

    it('keeps a failed XC @stop out of the model without running startup work', async () => {
        runProjectSessionStopMock.mockResolvedValueOnce(false);
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: '@stop' },
            meta: { sentFrom: 'app' } });
        await vi.waitFor(() => expect(runProjectSessionStopMock).toHaveBeenCalledOnce());
        expect(ensureProjectWatchMock).not.toHaveBeenCalled();
        expect(notifyDaemonSessionStartedMock).not.toHaveBeenCalled();
        expect(runProjectSessionStartupMock).not.toHaveBeenCalled();
        expect(runProjectSessionInputMock).not.toHaveBeenCalled();
        expect(delivered).toEqual([]);
    });

    it('keeps non-human @stop text as ordinary model input', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: '@stop' },
            meta: { sentFrom: 'happy-agent' } });
        await vi.waitFor(() => expect(delivered).toEqual(['@stop']));
        expect(runProjectSessionStopMock).not.toHaveBeenCalled();
        expect(runProjectSessionInputMock).toHaveBeenCalledOnce();
    });

    it('never delivers a model turn when XC input admission fails', async () => {
        runProjectSessionInputMock.mockRejectedValueOnce(new Error('XC input failed'));
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: 'unsafe without context' },
            meta: { sentFrom: 'app' } });
        await vi.waitFor(() => expect(runProjectSessionInputMock).toHaveBeenCalledOnce());
        expect(delivered).toEqual([]);
    });

    it.each(['web', 'android', 'ios', 'mac'])('intercepts @stop from the %s client', async (source) => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: '@stop' },
            meta: { sentFrom: source } });
        await vi.waitFor(() => expect(runProjectSessionStopMock).toHaveBeenCalledOnce());
        expect(runProjectSessionInputMock).not.toHaveBeenCalled();
        expect(delivered).toEqual([]);
    });

    it('never derives @stop authority from model-facing metadata', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: 'continue' },
            meta: { sentFrom: 'ios', modelText: '@stop' } });
        await vi.waitFor(() => expect(delivered).toEqual(['@stop']));
        expect(runProjectSessionStopMock).not.toHaveBeenCalled();
        expect(runProjectSessionInputMock).toHaveBeenCalledOnce();
    });

    it('registers with the daemon before XC input and preserves delivery when registration is unavailable', async () => {
        let finish = (_value: { error: string }) => {};
        notifyDaemonSessionStartedMock.mockImplementationOnce(() =>
            new Promise((resolve) => { finish = resolve; }));
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        client.injectPendingMessage({ role: 'user', content: { type: 'text', text: 'live' },
            meta: { sentFrom: 'app' } });
        await Promise.resolve();
        expect(runProjectSessionInputMock).not.toHaveBeenCalled();
        finish({ error: 'daemon unavailable' });
        await vi.waitFor(() => expect(delivered).toEqual(['live']));
        expect(runProjectSessionInputMock).toHaveBeenCalledOnce();
    });

    it('admits a live persisted Mail input before delivery and prepends shared project context', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        runProjectSessionInputMock.mockResolvedValue('SHARED_CONTEXT');
        client.onUserMessage((message) => delivered.push(modelFacingUserText(message)));
        const localId = `xc-msg-v1-${'b'.repeat(64)}`;
        const row = {
            id: 'mail-input', seq: 21, createdAt: 1_021, localId,
            content: { t: 'encrypted' as const, c: encodeBase64(encrypt(mockSession.encryptionKey,
                mockSession.encryptionVariant, { role: 'user', content: { type: 'text', text: 'Mail display' },
                    meta: { sentFrom: 'cli', presentation: 'compact', modelText: 'verified command' } })) },
        };
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row } });
        await vi.waitFor(() => expect(delivered).toEqual(['SHARED_CONTEXT\n\nverified command']));
        expect(runProjectSessionInputMock).toHaveBeenCalledWith(expect.objectContaining({
            workspace: '/tmp', nativeSessionId: mockSession.id, localId, messageText: 'verified command',
        }));
    });

    it('HSR queues persistent output while disconnected and flushes it only after connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendCodexMessage({ type: 'message', message: 'queued' });
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({ state: 'connecting', queueMessages: 1 }));
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.anything());

        mockSocket.connected = true;
        handlers.get('connect')?.();
        expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ sid: mockSession.id }));
        expect(mockSocket.emit.mock.calls.find(([event]: [string]) => event === 'message')?.[1].localId)
            .toMatch(/^happy-cli-v1-/);
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({ state: 'connected', queueMessages: 0 }));
    });

    it('HSR fails explicitly when the bounded persistent output queue overflows', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        for (let index = 0; index < 256; index += 1) {
            client.sendCodexMessage({ type: 'message', message: `queued-${index}` });
        }
        expect(() => client.sendCodexMessage({ type: 'message', message: 'queued-overflow' }))
            .toThrow(/outbound_queue_overflow/);
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({
            state: 'failed',
            reason: expect.stringContaining('outbound_queue_overflow'),
        }));
    });

    it('HSR enforces the disconnected persistent-output byte budget before the count budget', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        let accepted = 0;
        expect(() => {
            for (; accepted < 256; accepted += 1) {
                client.sendCodexMessage({ type: 'message', message: 'x'.repeat(10_000) });
            }
        }).toThrow(/outbound_queue_overflow/);
        expect(accepted).toBeLessThan(256);
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({ state: 'failed' }));
    });

    it('HSR fails terminally on a conflicting live persisted identity', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        const message = {
            id: 'same-id',
            seq: 10,
            createdAt: 1_010,
            content: {
                t: 'encrypted' as const,
                c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                    role: 'user', content: { type: 'text', text: 'first' }, meta: { sentFrom: 'app' },
                })),
            },
        };
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message } });
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: { ...message, seq: 11 } } });
        expect(client.getTransportSnapshot()).toEqual(expect.objectContaining({
            state: 'failed',
            reason: expect.stringContaining('recovery_incomplete'),
        }));
        expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('HSR redacts credential-shaped transport failure reasons', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        client.markRestoreRecoveryFailed(new Error('Bearer private-token token=second-secret'));
        const reason = client.getTransportSnapshot().reason ?? '';
        expect(reason).not.toContain('private-token');
        expect(reason).not.toContain('second-secret');
        expect(reason).toContain('[redacted]');
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
});
