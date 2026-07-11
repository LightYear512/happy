import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionMetadataClient } from './apiSessionMetadata';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mockIo }));

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
                result: 'success',
                version: 8,
                metadata: ''
            })
        };
        mockIo.mockReturnValue(socket);
        session = {
            id: 'session-1',
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools'
            },
            metadataVersion: 7,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy'
        };
    });

    it('uses a user-scoped socket and does not register session lifecycle handlers', () => {
        new ApiSessionMetadataClient('token', session);

        expect(mockIo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            auth: { token: 'token', clientType: 'user-scoped' },
            autoConnect: false,
            reconnection: false
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

        expect(socket.timeout).toHaveBeenCalledWith(500);
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(socket.emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({
            sid: 'session-1',
            expectedVersion: 7,
            summary: 'next title'
        }));
        expect(result.version).toBe(8);
    });

    it('does not retry a metadata version conflict', async () => {
        socket.emitWithAck.mockResolvedValue({
            result: 'version-mismatch',
            version: 8,
            metadata: ''
        });
        const client = new ApiSessionMetadataClient('token', session);

        await expect(client.updateSummaryOnce('next title', 500)).rejects.toThrow('Metadata version mismatch');

        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    });
});
