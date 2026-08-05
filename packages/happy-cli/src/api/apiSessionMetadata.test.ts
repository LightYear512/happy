import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIo, getMock, encryptMock } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    getMock: vi.fn(),
    encryptMock: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', () => ({ default: { get: getMock } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://happy.test' } }));
vi.mock('./encryption', () => ({
    encrypt: encryptMock,
    encodeBase64: vi.fn(() => 'encrypted-metadata'),
    decodeBase64: vi.fn((value: string) => value),
    decrypt: vi.fn((_key: Uint8Array, _variant: string, value: string) => {
        if (value === 'fresh-metadata') {
            return {
                path: '/tmp', host: 'localhost', homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools', concurrentField: 'preserve-me',
            };
        }
        return {};
    }),
}));

import { ApiSessionMetadataClient } from './apiSessionMetadata';

describe('ApiSessionMetadataClient', () => {
    let socket: any;
    let session: any;

    beforeEach(() => {
        socket = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn(),
            once: vi.fn(),
            off: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn().mockReturnThis(),
            emitWithAck: vi.fn().mockResolvedValue({
                result: 'success', version: 8, metadata: 'encrypted-metadata',
            }),
        };
        mockIo.mockReset().mockReturnValue(socket);
        getMock.mockReset();
        encryptMock.mockReset().mockReturnValue(new Uint8Array([1, 2, 3]));
        session = {
            id: 'session-1',
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools',
            },
            metadataVersion: 7,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
        };
    });

    it('uses a user-scoped socket and does not register session lifecycle handlers', () => {
        new ApiSessionMetadataClient('token', session);

        expect(mockIo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            auth: { token: 'token', clientType: 'user-scoped' },
            autoConnect: false,
            reconnection: false,
        }));
        const registeredEvents = socket.on.mock.calls.map(([event]: [string]) => event);
        expect(registeredEvents).not.toContain('rpc-request');
        expect(registeredEvents).not.toContain('update');
        expect(registeredEvents).not.toContain('disconnect');
        expect(registeredEvents).not.toContain('session-alive');
        expect(registeredEvents).not.toContain('session-end');
    });

    it('performs one bounded metadata update and returns the acknowledged version', async () => {
        const client = new ApiSessionMetadataClient('token', session);

        const result = await client.updateSummaryOnce('next title', 500);

        expect(socket.timeout).toHaveBeenCalled();
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(socket.emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            sid: 'session-1', expectedVersion: 7, summary: 'next title',
        }));
        expect(result.version).toBe(8);
        expect(encryptMock).toHaveBeenCalledWith(
            session.encryptionKey,
            session.encryptionVariant,
            expect.objectContaining({ name: 'tmp', summary: expect.objectContaining({ text: 'next title' }) }),
        );
    });

    it('preserves an existing stable Happy name across summary updates', async () => {
        session.metadata.name = 'my happy';
        const client = new ApiSessionMetadataClient('token', session);
        await client.updateSummaryOnce('[x-000001] my happy', 500);
        expect(encryptMock).toHaveBeenCalledWith(
            session.encryptionKey,
            session.encryptionVariant,
            expect.objectContaining({ name: 'my happy' }),
        );
    });

    it('metadata update rejects invalid result before emit', async () => {
        const client = new ApiSessionMetadataClient('token', session);
        await expect(client.updateMetadataOnce(
            (metadata) => ({ ...metadata, invalid: new Date() } as any),
            500,
        )).rejects.toThrow(/plain JSON/);
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('metadata update rejects zero timeout before emit', async () => {
        const client = new ApiSessionMetadataClient('token', session);
        await expect(client.updateMetadataOnce((metadata) => metadata, 0)).rejects.toThrow(/timeout/);
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('metadata update rejects oversized result before emit', async () => {
        const client = new ApiSessionMetadataClient('token', session);
        await expect(client.updateMetadataOnce(
            (metadata) => ({ ...metadata, oversized: 'x'.repeat(300_000) }),
            500,
        )).rejects.toThrow(/size/);
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('metadata update refreshes a version conflict without overwriting concurrent fields', async () => {
        socket.emitWithAck
            .mockResolvedValueOnce({ result: 'version-mismatch', version: 8, metadata: 'stale-metadata' })
            .mockResolvedValueOnce({ result: 'success', version: 9, metadata: 'encrypted-metadata' });
        getMock.mockResolvedValue({
            data: { session: { metadata: 'fresh-metadata', metadataVersion: 8 } },
        });
        const client = new ApiSessionMetadataClient('token', session);

        const result = await client.updateMetadataOnce(
            (metadata) => ({ ...metadata, htaskSidebar: { task_id: 'AT-0004' } }),
            1_000,
        );

        expect(result.version).toBe(9);
        expect(getMock).toHaveBeenCalledWith(
            'https://happy.test/v1/sessions/session-1',
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
        );
        expect(encryptMock).toHaveBeenLastCalledWith(
            session.encryptionKey,
            session.encryptionVariant,
            expect.objectContaining({
                concurrentField: 'preserve-me',
                htaskSidebar: { task_id: 'AT-0004' },
            }),
        );
    });

    it('metadata update treats an ambiguously acknowledged applied result as success', async () => {
        socket.emitWithAck.mockRejectedValueOnce(new Error('ack timeout'));
        getMock.mockResolvedValue({
            data: {
                session: {
                    metadata: 'fresh-metadata',
                    metadataVersion: 8,
                },
            },
        });
        const client = new ApiSessionMetadataClient('token', session);
        const result = await client.updateMetadataOnce(
            (metadata) => ({ ...metadata, concurrentField: 'preserve-me' }),
            1_000,
        );

        expect(result.version).toBe(8);
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    });
});
