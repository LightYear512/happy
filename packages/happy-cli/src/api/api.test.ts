import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import { ApiSessionMessageClient } from './apiSessionMessage';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockPost, mockGet, mockIsAxiosError, loggerDebug } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockGet: vi.fn(),
    mockIsAxiosError: vi.fn(() => true),
    loggerDebug: vi.fn()
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        get: mockGet,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: loggerDebug
    }
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn((data: any) => data),
    decrypt: vi.fn((data: any) => data),
    encrypt: vi.fn((data: any) => data)
}));

// Mock configuration
vi.mock('./configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com'
    }
}));

// Mock libsodium encryption
vi.mock('./libsodiumEncryption', () => ({
    libsodiumEncryptForPublicKey: vi.fn((data: any) => new Uint8Array(32))
}));

// Global test metadata
const testMetadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools'
};

const testMachineMetadata = {
    host: 'localhost',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib'
};

describe('Api server error handling', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset(); // Reset offline state between tests

        // Create a mock credential
        const mockCredential = {
            token: 'fake-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32)
            }
        };

        api = await ApiClient.create(mockCredential);
    });

    describe('getOrCreateSession', () => {
        it('shares one in-flight create for concurrent callers with the same tag', async () => {
            mockPost.mockResolvedValue({
                data: {
                    session: {
                        id: 'session-1',
                        seq: 1,
                        metadata: 'metadata',
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                    },
                },
            });
            const request = { tag: 'same-tag', metadata: testMetadata, state: null };

            const [first, second] = await Promise.all([
                api.getOrCreateSession(request),
                api.getOrCreateSession(request),
            ]);

            expect(first?.id).toBe('session-1');
            expect(second?.id).toBe('session-1');
            expect(mockPost).toHaveBeenCalledOnce();
        });

        it('should return null when Happy server is unreachable (ECONNREFUSED)', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Session creation failed: 404')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when server returns 500 Internal Server Error', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 500 error
            mockPost.mockRejectedValue({
                response: { status: 500 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should return null when server returns 503 Service Unavailable', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 503 error
            mockPost.mockRejectedValue({
                response: { status: 503 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should re-throw non-connection errors', async () => {
            // Mock axios to throw a different type of error (e.g., authentication error)
            const authError = new Error('Invalid API key');
            (authError as any).code = 'UNAUTHORIZED';
            mockPost.mockRejectedValue(authError);

            await expect(
                api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
            ).rejects.toThrow('Failed to get or create session: Invalid API key');

            // Should not show the offline mode message
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });
    });

    describe('getOrCreateMachine', () => {
        it('should return minimal machine object when server is unreachable (ECONNREFUSED)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'running',
                    pid: 1234
                }
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: {
                    status: 'running',
                    pid: 1234
                },
                daemonStateVersion: 0,
            });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return minimal machine object when server endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            });

            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 404')
            );

            consoleSpy.mockRestore();
        });
    });
});

describe('session lookup log privacy', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        api = await ApiClient.create({
            token: 'fake-token',
            encryption: { type: 'legacy' as const, secret: new Uint8Array(32) }
        });
    });

    it('sanitizes getSessionById Axios errors', async () => {
        mockGet.mockRejectedValue({
            code: 'ERR_BAD_RESPONSE',
            response: { status: 500, data: { payload: 'private-body' } },
            config: { headers: { Authorization: 'Bearer secret-token' } }
        });
        await expect(api.getSessionById('session-1')).resolves.toBeNull();
        const serialized = JSON.stringify(loggerDebug.mock.calls);
        expect(serialized).toContain('ERR_BAD_RESPONSE');
        expect(serialized).toContain('500');
        expect(serialized).not.toContain('private-body');
        expect(serialized).not.toContain('secret-token');
    });

    it('constructs a one-shot message client from stable session identity without a server lookup', () => {
        const client = api.sessionMessageClient('session-1');
        expect(client).toBeInstanceOf(ApiSessionMessageClient);
        expect(mockGet).not.toHaveBeenCalled();
    });

    it('sanitizes getSessionMessages Axios errors', async () => {
        mockGet.mockRejectedValue({
            code: 'ECONNRESET',
            request: { headers: { Authorization: 'Bearer another-secret' } }
        });
        await expect(api.getSessionMessages('session-1')).rejects.toThrow('session_message_lookup_failed');
        const serialized = JSON.stringify(loggerDebug.mock.calls);
        expect(serialized).toContain('ECONNRESET');
        expect(serialized).not.toContain('another-secret');
        expect(mockGet).toHaveBeenCalledOnce();
    });

    it('allows the bounded recovery response budget enough transfer time', async () => {
        mockGet.mockResolvedValue({ data: { messages: [] } });

        await expect(api.getSessionMessages('session-1')).resolves.toEqual([]);
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringMatching(/\/v1\/sessions\/session-1\/messages$/),
            expect.objectContaining({ timeout: 20_000 })
        );
    });

    it('fails closed when an exact restore lookup fails', async () => {
        mockGet.mockRejectedValue({ code: 'ECONNRESET' });

        await expect(api.restoreSessionById('session-1'))
            .rejects.toThrow('happy_session_restore_failed');
        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('retries a transient exact restore lookup without replacing the session', async () => {
        mockGet
            .mockRejectedValueOnce({ code: 'ECONNABORTED' })
            .mockResolvedValueOnce({
                data: {
                    session: {
                        id: 'session-1',
                        seq: 1,
                        metadata: 'metadata',
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                        dataEncryptionKey: null,
                        lastActiveAt: Date.now(),
                    },
                },
            });

        await expect(api.restoreSessionById('session-1'))
            .resolves.toMatchObject({ id: 'session-1' });
        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('shares one in-flight exact-session lookup between concurrent restores', async () => {
        mockGet.mockResolvedValue({
            data: {
                session: {
                    id: 'session-1',
                    seq: 1,
                    metadata: 'metadata',
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastActiveAt: Date.now(),
                },
            },
        });

        const [first, second] = await Promise.all([
            api.restoreSessionById('session-1'),
            api.restoreSessionById('session-1'),
        ]);

        expect(first.id).toBe('session-1');
        expect(second.id).toBe('session-1');
        expect(mockGet).toHaveBeenCalledOnce();
    });

    it('shares one in-flight message lookup', async () => {
        mockGet.mockResolvedValue({ data: { messages: [] } });

        const [first, second] = await Promise.all([
            api.getSessionMessages('session-1'),
            api.getSessionMessages('session-1'),
        ]);

        expect(first).toEqual([]);
        expect(second).toEqual([]);
        expect(mockGet).toHaveBeenCalledOnce();
    });

    it('does not multiply a transient message lookup inside one restore', async () => {
        mockGet.mockRejectedValue({ code: 'ECONNRESET' });

        await expect(api.getSessionMessages('session-1'))
            .rejects.toThrow('session_message_lookup_failed');
        expect(mockGet).toHaveBeenCalledOnce();
    });

    it('does not retry a cancelled message lookup', async () => {
        mockGet.mockRejectedValue({ code: 'ERR_CANCELED' });

        await expect(api.getSessionMessages('session-1'))
            .rejects.toThrow('session_message_lookup_failed');
        expect(mockGet).toHaveBeenCalledOnce();
    });

    it('does not retry a non-transient exact restore rejection', async () => {
        mockGet.mockRejectedValue({
            code: 'ERR_BAD_REQUEST',
            response: { status: 404 },
        });

        await expect(api.restoreSessionById('session-1'))
            .rejects.toThrow('happy_session_restore_failed');
        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('rejects a restore response carrying a replacement session id', async () => {
        mockGet.mockResolvedValue({
            data: {
                session: {
                    id: 'replacement-session',
                    seq: 1,
                    metadata: 'metadata',
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null,
                    lastActiveAt: Date.now(),
                },
            },
        });

        await expect(api.restoreSessionById('session-1'))
            .rejects.toThrow('happy_session_restore_failed');
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('returns the original record when the restore id matches exactly', async () => {
        mockGet.mockResolvedValue({
            data: {
                session: {
                    id: 'session-1',
                    seq: 1,
                    metadata: 'metadata',
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null,
                    lastActiveAt: Date.now(),
                },
            },
        });

        await expect(api.restoreSessionById('session-1'))
            .resolves.toMatchObject({ id: 'session-1' });
        expect(mockPost).not.toHaveBeenCalled();
    });
});
