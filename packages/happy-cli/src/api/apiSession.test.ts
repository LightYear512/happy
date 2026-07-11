import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo, getMock } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    getMock: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));
vi.mock('axios', () => ({
    default: { get: getMock },
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
            volatile: { emit: vi.fn() },
        };

        mockIo.mockReturnValue(mockSocket);
        getMock.mockReset().mockResolvedValue({ data: { messages: [] } });

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
                happyToolsDir: '/home/user/.happy/tools'
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
        await vi.runAllTimersAsync();
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
        expect(delivered).toEqual(['ten']);

        mockSocket.connected = false;
        handlers.get('disconnect')?.('transport close');
        getMock.mockResolvedValue({ data: { messages: [row12, row10, row11] } });
        mockSocket.connected = true;
        handlers.get('connect')?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(delivered).toEqual(['ten', 'eleven', 'twelve']);
        expect(client.getTransportSnapshot().state).toBe('connected');
    });

    it('HSR deduplicates an exact restore row against a later live Socket delivery', () => {
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
        expect(delivered).toEqual(['once']);
        expect(client.injectPendingPersistedUserMessage(row)).toBe(false);
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
