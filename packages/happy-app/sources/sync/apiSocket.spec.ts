import { beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => {
    const handlers = new Map<string, () => void>();
    return {
        handlers,
        recovered: true,
        on: vi.fn((event: string, handler: () => void) => {
            handlers.set(event, handler);
        }),
        onAny: vi.fn(),
        disconnect: vi.fn(),
    };
});

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {} }));
vi.mock('./encryption/encryption', () => ({}));

describe('ApiSocket reconnect delivery', () => {
    beforeEach(() => {
        socket.handlers.clear();
        socket.on.mockClear();
        socket.onAny.mockClear();
        socket.disconnect.mockClear();
        socket.recovered = true;
        vi.resetModules();
    });

    it('retries durable outbound work even when Socket.IO recovered server events', async () => {
        const { apiSocket } = await import('./apiSocket');
        const listener = vi.fn();
        apiSocket.onReconnected(listener);
        apiSocket.initialize({ endpoint: 'ws://localhost', token: 'token' }, {} as never);

        socket.handlers.get('connect')?.();

        expect(listener).toHaveBeenCalledWith(true);
        apiSocket.disconnect();
    });

    it('runs a late subscriber immediately when the initial socket is already connected', async () => {
        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize({ endpoint: 'ws://localhost', token: 'token' }, {} as never);
        socket.handlers.get('connect')?.();
        const listener = vi.fn();

        apiSocket.onReconnected(listener);

        expect(listener).toHaveBeenCalledWith(true);
        apiSocket.disconnect();
    });

    it('marks a non-recovered reconnect so callers may refresh authoritative state', async () => {
        socket.recovered = false;
        const { apiSocket } = await import('./apiSocket');
        const listener = vi.fn();
        apiSocket.onReconnected(listener);
        apiSocket.initialize({ endpoint: 'ws://localhost', token: 'token' }, {} as never);

        socket.handlers.get('connect')?.();

        expect(listener).toHaveBeenCalledWith(false);
        apiSocket.disconnect();
    });
});
