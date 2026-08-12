import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { inputAcceptedEventId } from './inputAcceptanceReceipt';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo, getMock, ensureProjectWatchMock, runProjectSessionStartupMock,
    runProjectSessionStopMock, runProjectSessionCloseMock, notifyDaemonSessionStartedMock,
    loggerTraceMock } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    getMock: vi.fn(),
    ensureProjectWatchMock: vi.fn(),
    runProjectSessionStartupMock: vi.fn(),
    runProjectSessionStopMock: vi.fn(),
    runProjectSessionCloseMock: vi.fn(),
    notifyDaemonSessionStartedMock: vi.fn(),
    loggerTraceMock: vi.fn(),
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
    runProjectSessionStop: runProjectSessionStopMock,
    runProjectSessionClose: runProjectSessionCloseMock,
}));
vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: notifyDaemonSessionStartedMock,
}));
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        trace: loggerTraceMock,
        warn: vi.fn(),
    },
}));

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
            io: { engine: { close: vi.fn() } },
            emitWithAck: vi.fn(),
            timeout: vi.fn(),
            volatile: { emit: vi.fn() },
        };
        mockSocket.timeout.mockReturnValue(mockSocket);

        mockIo.mockReturnValue(mockSocket);
        getMock.mockReset().mockResolvedValue({ data: { messages: [] } });
        ensureProjectWatchMock.mockReset().mockResolvedValue(undefined);
        runProjectSessionStartupMock.mockReset().mockResolvedValue(true);
        runProjectSessionStopMock.mockReset().mockResolvedValue(true);
        runProjectSessionCloseMock.mockReset().mockResolvedValue(undefined);
        notifyDaemonSessionStartedMock.mockReset().mockResolvedValue({ status: 'ok' });
        loggerTraceMock.mockReset();

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

    const persistedUserRow = (id: string, seq: number, text: string, sentFrom = 'app',
        localId: string | null = null) => ({
        id,
        seq,
        localId,
        createdAt: 1_000 + seq,
        content: {
            t: 'encrypted' as const,
            c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                role: 'user', content: { type: 'text', text }, meta: { sentFrom },
            })),
        },
    });

    const persistedAgentEventRow = (id: string, seq: number, eventId: string) => ({
        id,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            t: 'encrypted' as const,
            c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                role: 'agent',
                content: { type: 'event', id: eventId, data: { type: 'message', message: 'accepted' } },
            })),
        },
    });

    it('bounds metadata acknowledgement waiting to fifteen seconds', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const updatedMetadata = { ...mockSession.metadata, name: 'ready' };
        mockSocket.emitWithAck.mockResolvedValue({
            result: 'success',
            version: 1,
            metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, updatedMetadata)),
        });

        await expect(client.updateMetadata(() => updatedMetadata, { rejectOnServerError: true }))
            .resolves.toBeUndefined();
        expect(mockSocket.timeout.mock.calls[0]![0]).toBeGreaterThan(0);
        expect(mockSocket.timeout.mock.calls[0]![0]).toBeLessThanOrEqual(15_000);
        expect(mockSocket.emitWithAck).toHaveBeenCalledOnce();
    });

    it('retries one newer metadata version and never loops indefinitely', async () => {
        const now = vi.spyOn(Date, 'now')
            .mockReturnValueOnce(10_000)
            .mockReturnValueOnce(10_000)
            .mockReturnValueOnce(14_000);
        const client = new ApiSessionClient('fake-token', mockSession);
        const serverMetadata = { ...mockSession.metadata, name: 'concurrent' };
        const finalMetadata = { ...serverMetadata, name: 'ready' };
        mockSocket.emitWithAck
            .mockResolvedValueOnce({
                result: 'version-mismatch',
                version: 1,
                metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, serverMetadata)),
            })
            .mockResolvedValueOnce({
                result: 'success',
                version: 2,
                metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, finalMetadata)),
            });

        try {
            await expect(client.updateMetadata((metadata) => ({ ...metadata, name: 'ready' }),
                { rejectOnServerError: true })).resolves.toBeUndefined();
            expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2);
            expect(mockSocket.timeout.mock.calls).toEqual([[15_000], [11_000]]);
        } finally {
            now.mockRestore();
        }
    });

    it('retries when the matching version-mismatch broadcast arrived before its acknowledgement', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const concurrentMetadata = { ...mockSession.metadata, summary: { text: 'concurrent' } };
        const finalMetadata = { ...concurrentMetadata, name: 'ready' };
        mockSocket.emitWithAck
            .mockImplementationOnce(async () => {
                handlers.get('update')?.({
                    body: { t: 'update-session', metadata: {
                        version: 1,
                        value: encodeBase64(encrypt(
                            mockSession.encryptionKey,
                            mockSession.encryptionVariant,
                            concurrentMetadata,
                        )),
                    } },
                });
                return {
                    result: 'version-mismatch',
                    version: 1,
                    metadata: encodeBase64(encrypt(
                        mockSession.encryptionKey,
                        mockSession.encryptionVariant,
                        concurrentMetadata,
                    )),
                };
            })
            .mockResolvedValueOnce({
                result: 'success',
                version: 2,
                metadata: encodeBase64(encrypt(
                    mockSession.encryptionKey,
                    mockSession.encryptionVariant,
                    finalMetadata,
                )),
            });

        await expect(client.updateMetadata(
            (metadata) => ({ ...metadata, name: 'ready' }),
            { rejectOnServerError: true },
        )).resolves.toBeUndefined();
        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2);
    });

    it('bounds ordinary metadata failure without rejecting fire-and-forget callers', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.emitWithAck.mockRejectedValue(new Error('ack timeout'));

        await expect(client.updateMetadata((metadata) => ({ ...metadata, name: 'ordinary' })))
            .resolves.toBeUndefined();
        await expect(client.updateMetadata((metadata) => ({ ...metadata, name: 'final' }),
            { rejectOnServerError: true })).rejects.toThrow('ack timeout');
    });

    it('accepts an exact newer metadata broadcast when only the acknowledgement is lost', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const updatedMetadata = { ...mockSession.metadata, claudeSessionId: 'provider-1' };
        mockSocket.emitWithAck.mockImplementation(async () => {
            handlers.get('update')?.({
                body: {
                    t: 'update-session',
                    metadata: {
                        version: 1,
                        value: encodeBase64(encrypt(
                            mockSession.encryptionKey,
                            mockSession.encryptionVariant,
                            updatedMetadata,
                        )),
                    },
                },
            });
            throw new Error('operation has timed out');
        });

        await expect(client.updateMetadata(() => updatedMetadata, { rejectOnServerError: true }))
            .resolves.toBeUndefined();
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

    it('re-registers final input readiness from the existing keepalive after daemon replacement', async () => {
        vi.useFakeTimers();
        try {
            const client = new ApiSessionClient('fake-token', mockSession);
            mockSocket.connected = true;
            handlers.get('connect')?.();
            await vi.waitFor(() => expect(notifyDaemonSessionStartedMock).toHaveBeenCalledOnce());
            expect(notifyDaemonSessionStartedMock).toHaveBeenLastCalledWith(
                'test-session-id',
                expect.objectContaining({ hostPid: process.pid }),
            );
            client.enableDaemonSessionTracking();
            await vi.waitFor(() => expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(2));
            await vi.advanceTimersByTimeAsync(30_000);
            expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(2);
            client.keepAlive(false, 'remote');
            await vi.waitFor(() => expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(3));
            client.keepAlive(false, 'remote');
            expect(notifyDaemonSessionStartedMock).toHaveBeenCalledTimes(3);
            await client.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes without waiting on daemon registration', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        await client.close();
        expect(runProjectSessionCloseMock).toHaveBeenCalledOnce();
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

    it('does not query message history on a normal first Socket connection', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));

        mockSocket.connected = true;
        handlers.get('connect')?.();
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('first-live', 1, 'first') } });

        await vi.waitFor(() => expect(delivered).toEqual(['first']));
        expect(getMock).not.toHaveBeenCalled();
    });

    it('keeps live input available when reconnect reconciliation fails', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        mockSocket.connected = true;
        handlers.get('connect')?.();
        const beforeRow = persistedUserRow('before-reconnect', 10, 'before');
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: beforeRow } });
        await vi.waitFor(() => expect(delivered).toEqual(['before']));

        mockSocket.connected = false;
        handlers.get('disconnect')?.('transport close');
        const duringRow = persistedUserRow('during-reconnect', 11, 'after');
        getMock.mockRejectedValueOnce(new Error('temporary 500'));
        mockSocket.connected = true;
        handlers.get('connect')?.();
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: duringRow } });
        await vi.waitFor(() => expect(delivered).toEqual(['before', 'after']));
        expect(client.getTransportSnapshot().state).toBe('connected');
        expect((client as any).pendingPersistedInputs).toHaveLength(0);
        expect(getMock).toHaveBeenCalledOnce();
        expect(mockSocket.io.engine.close).not.toHaveBeenCalled();
        expect(mockSocket.disconnect).not.toHaveBeenCalled();
        await client.close();
    });

    it('initial restore and a later live Socket delivery share one deduplicating reader', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
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
        client.onUserMessage((message) => delivered.push(message.content.text));
        getMock.mockResolvedValueOnce({ data: { messages: [row] } });
        void client.reconcilePersistedInputs('restore');
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row } });
        await vi.waitFor(() => expect(delivered).toEqual(['once']));
        expect((client as any).pendingPersistedInputs).toHaveLength(0);
    });


    it('retains a persisted input until the provider callback is registered', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('before-provider', 17, 'first') } });

        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        await vi.waitFor(() => expect(delivered).toEqual(['first']));
    });

    it('deduplicates a live replay after synchronous provider acceptance', async () => {
        const delivered: string[] = [];
        const client = new ApiSessionClient('fake-token', mockSession);
        client.onUserMessage((message) => delivered.push(message.content.text));
        const row = persistedUserRow('pending-replay', 18, 'once');

        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row } });
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row } });

        await vi.waitFor(() => expect(delivered).toEqual(['once']));
        expect((client as any).lastObservedMessage).toEqual({
            id: 'pending-replay', seq: 18,
        });
        const cachedIdentity = (client as any).recentDeliveredMessages.get('pending-replay');
        expect(cachedIdentity).toEqual(expect.objectContaining({
            seq: 18,
            localId: null,
            createdAt: 1_018,
            cipherDigest: expect.any(String),
        }));
        expect(cachedIdentity).not.toHaveProperty('content');
    });

    it('does not hold live input behind a pending restore lookup', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));

        let finishLookup!: (value: unknown) => void;
        getMock.mockReturnValueOnce(new Promise((resolve) => { finishLookup = resolve; }));
        const reconciliation = client.reconcilePersistedInputs('restore');

        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('restore-live-input', 18, 'live') } });

        await vi.waitFor(() => expect(delivered).toEqual(['live']));
        finishLookup({ data: { messages: [] } });
        await reconciliation;
    });

    it('keeps live input immediate and deduplicates the later restore result', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        mockSocket.connected = true;
        handlers.get('connect')?.();
        client.onUserMessage((message) => delivered.push(message.content.text));

        const liveRow = persistedUserRow('initial-live', 19, 'newer');
        let finishLookup!: (value: unknown) => void;
        getMock.mockReturnValueOnce(new Promise((resolve) => { finishLookup = resolve; }));
        const reconciliation = client.reconcilePersistedInputs('restore');
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: liveRow } });
        await vi.waitFor(() => expect(delivered).toEqual(['newer']));

        finishLookup({ data: { messages: [
            persistedUserRow('initial-restore', 18, 'older'),
            liveRow,
        ] } });
        await reconciliation;
        expect(delivered).toEqual(['newer', 'older']);
    });

    it('shows the at-least-once notice only when initial restore actually replays input', async () => {
        const empty = new ApiSessionClient('fake-token', mockSession);
        const emptyNotice = vi.spyOn(empty, 'sendSessionEvent');
        mockSocket.connected = true;
        handlers.get('connect')?.();
        getMock.mockResolvedValueOnce({ data: { messages: [] } });
        await empty.reconcilePersistedInputs('restore');
        expect(emptyNotice).not.toHaveBeenCalled();

        const replay = new ApiSessionClient('fake-token', mockSession);
        const replayNotice = vi.spyOn(replay, 'sendSessionEvent');
        replay.onUserMessage(() => {});
        getMock.mockResolvedValueOnce({ data: { messages: [
            persistedUserRow('actual-replay', 20, 'retry me'),
        ] } });
        await replay.reconcilePersistedInputs('restore');
        expect(replayNotice).toHaveBeenCalledTimes(1);
        expect(replayNotice).toHaveBeenCalledWith({
            type: 'message',
            message: '正在恢复进程异常退出前未确认完成的输入；该输入可能已部分执行，本次按 at-least-once 语义重新提交。',
        });
    });

    it('does not show a restore replay notice for input already accepted from the live Socket', async () => {
        const row = persistedUserRow('already-live-before-restore', 21, 'once');
        const client = new ApiSessionClient('fake-token', mockSession);
        const notice = vi.spyOn(client, 'sendSessionEvent');
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: row } });
        await vi.waitFor(() => expect(delivered).toEqual(['once']));

        mockSocket.connected = true;
        getMock.mockResolvedValueOnce({ data: { messages: [row] } });
        await expect(client.reconcilePersistedInputs('restore')).resolves.toBe('complete');
        expect(notice).not.toHaveBeenCalledWith({
            type: 'message',
            message: '正在恢复进程异常退出前未确认完成的输入；该输入可能已部分执行，本次按 at-least-once 语义重新提交。',
        });
        expect(delivered).toEqual(['once']);
    });

    it('replays an accepted-but-unconsumed input after process restart', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        mockSocket.connected = true;
        handlers.get('connect')?.();
        client.onUserMessage((message) => delivered.push(message.content.text));
        const localId = 'accepted-before-process-exit';
        getMock.mockResolvedValueOnce({ data: { messages: [
            persistedUserRow('accepted-before-exit', 24, 'must replay', 'app', localId),
            persistedAgentEventRow('accepted-receipt', 25, inputAcceptedEventId(localId)),
        ] } });

        await expect(client.reconcilePersistedInputs('restore')).resolves.toBe('complete');
        expect(delivered).toEqual(['must replay']);
    });

    it('defers an explicit restore lookup until the first Socket connection', async () => {
        getMock.mockResolvedValueOnce({ data: { messages: [] } });
        const client = new ApiSessionClient('fake-token', mockSession);

        await expect(client.reconcilePersistedInputs('restore')).resolves.toBe('stopped');
        expect(getMock).not.toHaveBeenCalled();

        mockSocket.connected = true;
        handlers.get('connect')?.();
        await vi.waitFor(() => expect(getMock).toHaveBeenCalledOnce());
    });

    it('preserves restore reconciliation across a Socket disconnect', async () => {
        mockSession.seq = 5;
        const pending = persistedUserRow('restore-after-reconnect', 5, 'resume me');
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        mockSocket.connected = true;
        handlers.get('connect')?.();
        expect(getMock).not.toHaveBeenCalled();

        getMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
        })).mockResolvedValueOnce({ data: { messages: [pending] } });
        const interruptedRestore = client.reconcilePersistedInputs('restore');
        await vi.waitFor(() => expect(getMock).toHaveBeenCalledOnce());
        mockSocket.connected = false;
        handlers.get('disconnect')?.('transport close');
        await expect(interruptedRestore).resolves.toBe('stopped');

        mockSocket.connected = true;
        handlers.get('connect')?.();
        await vi.waitFor(() => expect(delivered).toEqual(['resume me']));
        expect(getMock).toHaveBeenCalledTimes(2);
    });

    it('does not loop a failed restore lookup and keeps live input available', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        mockSocket.connected = true;
        handlers.get('connect')?.();
        client.onUserMessage((message) => delivered.push(message.content.text));
        expect(getMock).not.toHaveBeenCalled();
        getMock.mockRejectedValueOnce(new Error('temporary 500'));

        const recovery = client.reconcilePersistedInputs('restore');
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('live-during-retry', 27, 'live') } });
        await vi.waitFor(() => expect(delivered).toEqual(['live']));
        await expect(recovery).resolves.toBe('retryable');

        expect(getMock).toHaveBeenCalledOnce();
        expect(delivered).toEqual(['live']);
        expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('does not retry a deterministically invalid recovery snapshot', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        expect(getMock).not.toHaveBeenCalled();
        getMock.mockResolvedValue({ data: { messages: [{}] } });

        await client.reconcilePersistedInputs('restore');

        expect(getMock).toHaveBeenCalledOnce();
        expect(loggerTraceMock.mock.calls.flat().join(' ')).toContain('reconciliation rejected');
        expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('keeps persisted human input FIFO through synchronous provider acceptance', async () => {
        const delivered: string[] = [];
        const client = new ApiSessionClient('fake-token', mockSession);
        client.onUserMessage((message) => delivered.push(message.content.text));
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('fifo-head', 18, 'first') } });
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('fifo-tail', 19, 'second') } });

        await vi.waitFor(() => expect(delivered).toEqual(['first', 'second']));
    });

    it('does not wait for XC startup, Watch or daemon refresh on ordinary input', async () => {
        runProjectSessionStartupMock.mockImplementationOnce(() => new Promise(() => {}));
        ensureProjectWatchMock.mockImplementationOnce(() => new Promise(() => {}));
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();

        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('direct-input', 20, 'direct') } });

        await vi.waitFor(() => expect(delivered).toEqual(['direct']));
        expect(ensureProjectWatchMock).not.toHaveBeenCalled();
    });

    it('hands a persisted human input to the provider callback within 200ms', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        mockSocket.emit.mockClear();
        let resolveDelivery = (_elapsed: number) => {};
        const delivered = new Promise<number>((resolve) => { resolveDelivery = resolve; });
        const startedAt = performance.now();
        client.onUserMessage(() => resolveDelivery(performance.now() - startedAt));
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('latency-boundary', 21, 'direct') } });

        const elapsed = await Promise.race([delivered, new Promise<number>((_resolve, reject) => {
            setTimeout(() => reject(new Error('provider callback exceeded 200ms')), 200);
        })]);
        expect(elapsed).toBeLessThan(200);
    });

    it('emits one deterministic visible receipt after synchronous provider acceptance', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        mockSocket.emit.mockClear();
        const order: string[] = [];
        mockSocket.emit.mockImplementation((event: string) => {
            if (event === 'message') order.push('receipt');
        });
        client.onUserMessage(() => order.push('provider'));
        const localId = 'mobile-input-accepted-1';

        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('accepted-input', 22, 'hello', 'app', localId) } });

        await vi.waitFor(() => expect(order).toEqual(['provider', 'receipt']));
        const payload = mockSocket.emit.mock.calls.find(([event]: [string]) => event === 'message')?.[1];
        const receipt = decrypt(mockSession.encryptionKey, mockSession.encryptionVariant,
            decodeBase64(payload.message));
        expect(receipt).toEqual({
            role: 'agent',
            content: {
                id: inputAcceptedEventId(localId),
                type: 'event',
                data: { type: 'message', message: expect.stringMatching(/^\d{2}:\d{2} 已接收，正在投递$/u) },
            },
        });
    });

    it('does not roll back accepted input when its receipt cannot be sent', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));
        vi.spyOn(client, 'sendSessionEvent').mockImplementationOnce(() => {
            throw new Error('receipt unavailable');
        });

        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('accepted-without-receipt', 23, 'continue', 'app', 'mobile-23') } });

        await vi.waitFor(() => expect(delivered).toEqual(['continue']));
        expect((client as any).lastObservedMessage).toEqual({ id: 'accepted-without-receipt', seq: 23 });
    });

    it('handles exact human @stop as a bounded safe stop instead of model input', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));

        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('direct-stop', 24, '@stop') } });
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('next-input', 25, 'next') } });

        await vi.waitFor(() => expect(delivered).toEqual(['next']));
        expect(runProjectSessionStopMock).toHaveBeenCalledOnce();
    });

    it('reports unavailable @stop locally without sending it to the model', async () => {
        runProjectSessionStopMock.mockResolvedValueOnce(null);
        const client = new ApiSessionClient('fake-token', mockSession);
        const delivered: string[] = [];
        client.onUserMessage((message) => delivered.push(message.content.text));

        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('no-xc-stop', 24, '@stop') } });

        await vi.waitFor(() => expect(runProjectSessionStopMock).toHaveBeenCalledOnce());
        expect(delivered).toEqual([]);
    });

    it('makes provider handoff failure visible without killing the live Socket', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        mockSocket.emit.mockClear();
        client.onUserMessage(() => { throw new Error('provider queue rejected input'); });
        handlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id,
            message: persistedUserRow('provider-failure', 20, 'fail', 'app', 'provider-failure-local') } });

        await vi.waitFor(() => expect((client as any).pendingPersistedInputs).toHaveLength(1));
        expect(client.getTransportSnapshot().state).toBe('connected');
        expect(mockSocket.disconnect).not.toHaveBeenCalled();
        expect((client as any).lastObservedMessage).toEqual({ id: null, seq: 0 });
        const notices = mockSocket.emit.mock.calls
            .filter(([event]: [string]) => event === 'message')
            .map(([, payload]: [string, { message: string }]) => decrypt(mockSession.encryptionKey,
                mockSession.encryptionVariant, decodeBase64(payload.message)));
        expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
                type: 'event',
                data: { type: 'message', message: '模型入口未接纳本次输入。' },
            }),
        })]));
        expect(notices).not.toEqual(expect.arrayContaining([expect.objectContaining({
            content: expect.objectContaining({ id: inputAcceptedEventId('provider-failure-local') }),
        })]));
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

    it('rejects one conflicting live identity without killing the session', () => {
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
        expect(client.getTransportSnapshot().state).toBe('connected');
        expect((client as any).pendingPersistedInputs).toHaveLength(1);
        expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('HSR redacts credential-shaped retryable recovery reasons', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        mockSocket.connected = true;
        handlers.get('connect')?.();
        getMock.mockRejectedValueOnce(new Error('Bearer private-token token=second-secret'));
        await client.reconcilePersistedInputs('reconnect');
        const trace = loggerTraceMock.mock.calls.flat().join(' ');
        expect(trace).not.toContain('private-token');
        expect(trace).not.toContain('second-secret');
        expect(trace).toContain('[redacted]');
        expect(client.getTransportSnapshot().state).toBe('connected');
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
});
